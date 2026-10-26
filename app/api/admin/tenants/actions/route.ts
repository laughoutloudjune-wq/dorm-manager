import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { dailyRentRate } from "@/lib/invoice-utils";
import { pickFields } from "@/lib/pick-fields";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMoneyEvent } from "@/lib/money-events";
import { planMoveOutSettlement, type MoveOutSettlementPlan } from "@/lib/money/settlement";
import {
  MOVE_OUT_DEBT_STATUSES,
  buildFinalSettlementRpcPayload,
  buildMoveOutPlanInput,
  computeMoveOutRentPeriod,
  moveOutLateFeeLabel,
  type MoveOutLateFees,
  resolveHeldCredit,
  type HeldCredit,
  type OpenInvoiceRow,
} from "@/lib/money/move-out-settlement-input";

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};


const calculateTransferRentProration = (
  transferDate: string,
  moveInDate: string | null | undefined,
  oldRoomRate: number,
  newRoomRate: number
) => {
  const transferDateObj = new Date(transferDate);
  const transferYear = transferDateObj.getFullYear();
  const transferMonth = transferDateObj.getMonth();
  const periodStart = new Date(transferYear, transferMonth, 1);
  const periodEnd = new Date(transferYear, transferMonth + 1, 0);
  const billingStart = moveInDate ? new Date(moveInDate) : periodStart;
  const effectiveBillingStart = billingStart > periodStart ? billingStart : periodStart;
  const effectiveTransferDate = transferDateObj > effectiveBillingStart ? transferDateObj : effectiveBillingStart;
  const oldSegmentEnd = new Date(
    effectiveTransferDate.getFullYear(),
    effectiveTransferDate.getMonth(),
    effectiveTransferDate.getDate() - 1
  );
  const oldRoomDays =
    effectiveTransferDate > effectiveBillingStart
      ? Math.floor((oldSegmentEnd.getTime() - effectiveBillingStart.getTime()) / 86400000) + 1
      : 0;
  const newRoomDays =
    periodEnd >= effectiveTransferDate
      ? Math.floor((periodEnd.getTime() - effectiveTransferDate.getTime()) / 86400000) + 1
      : 0;
  // Same fixed-30-day, floor-down-to-whole-baht convention as calculateProratedRentByBillingDay
  // (lib/invoice-utils.ts) — this used to divide unrounded, giving a different total than
  // the other two proration paths for the same scenario.
  const dailyOldRate = dailyRentRate(oldRoomRate);
  const dailyNewRate = dailyRentRate(newRoomRate);

  return {
    oldRoomAmount: dailyOldRate * oldRoomDays,
    newRoomAmount: dailyNewRate * newRoomDays,
  };
};

// ── Move-out settlement helpers (final_move_out + abandon_room) ─────────────
// Both actions plan with lib/money/settlement.ts and write through the one
// atomic, idempotent database function public.final_settle_move_out
// (migration 20261002000600). Nothing here writes to the database directly.

type SettlementContext = {
  held: HeldCredit;
  openInvoices: OpenInvoiceRow[];
  lastBilledEndDate: string | null;
  billingDay: number;
  monthlyRent: number;
  electricityRate: number;
  waterRate: number;
  previousElectricity: number;
  previousWater: number;
};

async function loadSettlementContext(
  supabase: SupabaseClient,
  tenantId: string,
  roomId: string
): Promise<SettlementContext | { error: string; status: number }> {
  const [tenantRes, roomRes, settingsRes, lastInvoiceRes, openRes, ledgerRes, meterRes] = await Promise.all([
    supabase
      .from("tenants")
      .select("id,room_id,security_deposit_amount,advance_rent_amount,initial_electricity_reading,initial_water_reading")
      .eq("id", tenantId)
      .maybeSingle(),
    supabase.from("rooms").select("id,price_month").eq("id", roomId).maybeSingle(),
    supabase.from("settings").select("*").maybeSingle(),
    supabase
      .from("invoices")
      .select("end_date")
      .eq("tenant_id", tenantId)
      .neq("status", "draft")
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("invoices")
      .select("id,start_date,status,total_amount,paid_amount,carry_forward_amount")
      .eq("tenant_id", tenantId)
      .in("status", [...MOVE_OUT_DEBT_STATUSES]),
    supabase.from("tenant_credits").select("bucket,amount").eq("tenant_id", tenantId),
    // Read-only: meter_readings is written only by the two meter routes.
    supabase
      .from("meter_readings")
      .select("current_electricity,current_water")
      .eq("room_id", roomId)
      .order("reading_month", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  for (const res of [tenantRes, roomRes, lastInvoiceRes, openRes, ledgerRes, meterRes]) {
    if (res.error) return { error: res.error.message, status: 500 };
  }
  const tenant = tenantRes.data as any;
  if (!tenant?.id) return { error: "Tenant not found.", status: 404 };
  if (!roomRes.data?.id) return { error: "Room not found.", status: 404 };

  const openInvoices = (openRes.data ?? []) as OpenInvoiceRow[];
  if (openInvoices.some((inv) => inv.status === "verifying")) {
    return {
      error: "มีใบแจ้งหนี้ที่รอตรวจสลิป กรุณาอนุมัติหรือปฏิเสธสลิปก่อนสรุปยอดย้ายออก",
      status: 409,
    };
  }
  const settings = settingsRes.data as any;
  const meter = meterRes.data as any;
  return {
    held: resolveHeldCredit(tenant, (ledgerRes.data ?? []) as any[]),
    openInvoices,
    lastBilledEndDate: (lastInvoiceRes.data as any)?.end_date ?? null,
    billingDay: Math.max(1, Math.min(28, Number(settings?.billing_day) || 25)),
    monthlyRent: toNumber((roomRes.data as any)?.price_month),
    electricityRate: toNumber(settings?.electricity_rate),
    waterRate: toNumber(settings?.water_rate),
    previousElectricity: toNumber(meter?.current_electricity ?? tenant.initial_electricity_reading ?? 0),
    previousWater: toNumber(meter?.current_water ?? tenant.initial_water_reading ?? 0),
  };
}

/**
 * Forfeiture from a request: `forfeitAmount` + `forfeitReason`. The legacy
 * boolean (`forfeitDeposit` / `forfeit_security_deposit`) means the whole
 * deposit. Either way a reason is required.
 */
function resolveForfeitInput(
  src: any,
  depositHeld: number
): { amount: number; reason: string | null } | { error: string } {
  const legacy = Boolean(src?.forfeitDeposit ?? src?.forfeit_security_deposit);
  const amount = src?.forfeitAmount != null ? toNumber(src.forfeitAmount) : legacy ? depositHeld : 0;
  const reason = String(src?.forfeitReason ?? "").trim() || null;
  if (amount < 0) return { error: "จำนวนเงินประกันที่ริบต้องไม่ติดลบ" };
  if (amount > 0 && !reason) return { error: "กรุณาระบุเหตุผลการริบเงินประกัน" };
  return { amount, reason };
}

async function findSettlementReplay(supabase: SupabaseClient, tenantId: string, key: string) {
  const { data } = await supabase
    .from("move_out_settlements")
    .select("id,final_invoice_id,settlement")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (!data?.id) return null;
  return {
    success: true,
    replayed: true,
    settlementId: data.id as string,
    finalInvoiceId: (data.final_invoice_id as string | null) ?? null,
    settlement: data.settlement as MoveOutSettlementPlan,
  };
}

type MoveOutLateFeeCandidate = {
  invoiceId: string;
  periodStart: string;
  periodEnd: string | null;
  daysOverdue: number | null;
  dailyRate: number;
  amount: number;
  locked: boolean;
  label: string;
};

/** Unbilled late fees on the tenant's older invoices, as of a date (read-only SQL function). */
async function loadMoveOutLateFeeCandidates(
  supabase: any,
  tenantId: string,
  asOf: string
): Promise<{ candidates: MoveOutLateFeeCandidate[] } | { error: string }> {
  const { data, error } = await supabase.rpc("move_out_late_fee_candidates", {
    p_tenant: tenantId,
    p_as_of: asOf,
  });
  if (error) return { error: error.message };
  const candidates = ((data as any[]) ?? [])
    .map((r) => {
      const daysOverdue = r.days_overdue == null ? null : toNumber(r.days_overdue);
      const dailyRate = toNumber(r.daily_rate);
      const periodStart = String(r.period_start ?? "").slice(0, 10);
      return {
        invoiceId: String(r.invoice_id),
        periodStart,
        periodEnd: r.period_end ? String(r.period_end).slice(0, 10) : null,
        daysOverdue,
        dailyRate,
        amount: toNumber(r.amount),
        locked: Boolean(r.locked),
        label: moveOutLateFeeLabel({ periodStart, daysOverdue, dailyRate }),
      };
    })
    .filter((c) => c.amount > 0);
  return { candidates };
}

function settlementRpcError(message: string) {
  const conflict = /^(LATE_FEE_MISMATCH|ALREADY_SETTLED|STALE_|HELD_MISMATCH|VERIFYING_INVOICE|ROOM_MISMATCH|INVOICE_NOT_OPEN|OVERPAY)/;
  const invalid = /^(LATE_FEE_VOID_REASON_REQUIRED|FORFEIT_REASON_REQUIRED|PLAN_|ENGINE_MISMATCH|INVOICE_TENANT_MISMATCH)/;
  const status = conflict.test(message) ? 409 : invalid.test(message) ? 400 : 500;
  const friendly = message.startsWith("ALREADY_SETTLED")
    ? "ผู้เช่ารายนี้สรุปยอดย้ายออกไปแล้ว"
    : message.startsWith("LATE_FEE_MISMATCH")
      ? `ค่าปรับล่าช้าของผู้เช่ารายนี้เปลี่ยนไประหว่างทำรายการ กรุณาโหลดหน้าใหม่แล้วตรวจสอบอีกครั้ง (${message})`
      : message.startsWith("LATE_FEE_VOID_REASON_REQUIRED")
        ? "กรุณาระบุเหตุผลที่ยกเลิกค่าปรับล่าช้าทุกรายการ"
        : /^(STALE_|HELD_MISMATCH)/.test(message)
      ? `ข้อมูลยอดเงินเปลี่ยนไประหว่างทำรายการ กรุณาโหลดหน้าใหม่ (${message})`
      : message;
  return NextResponse.json({ error: friendly }, { status });
}

/** Keeps the response shape MoveOutProcessingModal already reads for abandon_room. */
function abandonResponse(settlement: MoveOutSettlementPlan, replayed: boolean) {
  const lines = (settlement?.debtPayments ?? []).map((d) => ({
    invoiceId: d.invoiceId,
    owed: d.outstandingBefore,
    applied: d.paidFromCredit,
    // Still owed on the invoice — NOT written off.
    writtenOff: d.outstandingAfter,
    outcome:
      d.outstandingAfter <= 0 ? "paid" : d.paidFromCredit > 0 ? "partial" : "unpaid",
  }));
  return {
    success: true,
    replayed,
    settlement,
    summary: {
      creditPool: settlement.creditAvailable,
      totalOwed: settlement.totalOwed,
      creditApplied: settlement.creditApplied,
      // Kept for older clients; the debt remains owed, it is not written off.
      writtenOff: settlement.balanceStillOwed,
      balanceStillOwed: settlement.balanceStillOwed,
      advanceRentAbsorbed: settlement.advanceRentAbsorbed,
      depositForfeited: settlement.depositForfeited,
      refundableCredit: settlement.refundDue,
      lines,
    },
    creditApplied: settlement.creditApplied,
    refundableCredit: settlement.refundDue,
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const rawPayload = body?.payload ?? {};
      // Whitelisted to exactly what the tenant editor modal sends. In
      // particular this excludes `line_user_id` — that has its own dedicated
      // "tenant.line.manage" permission and its own action (`unlink_line`)
      // below; spreading the raw payload here let a tenant.edit-only caller
      // change it too, bypassing that boundary. See
      // docs/audit/2026-09-29-system-audit-detailed.md finding H12.
      const payload = pickFields(rawPayload, [
        "full_name",
        "address",
        "phone_number",
        "room_id",
        "move_in_date",
        "move_out_date",
        "status",
        "lease_months",
        "initial_electricity_reading",
        "initial_water_reading",
        "advance_rent_amount",
        "security_deposit_amount",
        "deposit_slip_url",
        "final_electricity_reading",
        "final_water_reading",
        "forfeit_security_deposit",
        "custom_payment_method",
        "custom_receipt_profile",
      ]) as any;
      payload.id = rawPayload?.id ? String(rawPayload.id) : crypto.randomUUID();
      const transferPayload = (body?.transferPayload ?? null) as any;
      const roomId = body?.roomId ? String(body.roomId) : "";
      const tenantId = String(payload.id);

      let previousTenant: any = null;
      if (tenantId) {
        const { data } = await auth.supabase
          .from("tenants")
          .select("id,room_id,move_in_date,full_name")
          .eq("id", tenantId)
          .maybeSingle();
        previousTenant = data ?? null;
      }

      if (roomId) {
        const { data: existingTenant, error: existingTenantError } = await auth.supabase
          .from("tenants")
          .select("id,full_name")
          .eq("room_id", roomId)
          .eq("status", "active")
          .neq("id", tenantId)
          .limit(1)
          .maybeSingle();

        if (existingTenantError) {
          return NextResponse.json({ error: existingTenantError.message }, { status: 500 });
        }

        if (existingTenant?.id) {
          return NextResponse.json(
            {
              error: `ห้องนี้มีผู้เช่าอยู่แล้ว (${existingTenant.full_name ?? "ไม่ทราบชื่อ"}) กรุณาย้ายออกหรือเปลี่ยนห้องก่อนเพิ่มผู้เช่าใหม่`,
            },
            { status: 400 }
          );
        }
      }

      let tenantError = null;
      if (previousTenant) {
        const { error } = await auth.supabase.from("tenants").update(payload).eq("id", tenantId);
        tenantError = error;
      } else {
        const { error } = await auth.supabase.from("tenants").insert(payload);
        tenantError = error;
      }
      if (tenantError) return NextResponse.json({ error: tenantError.message }, { status: 500 });

      const effectiveTenantId = tenantId;
      const moveInDate = payload?.move_in_date 
        ? String(payload.move_in_date) 
        : (previousTenant?.move_in_date ? String(previousTenant.move_in_date) : null);
      const fullName = payload?.full_name 
        ? String(payload.full_name) 
        : (previousTenant?.full_name ? String(previousTenant.full_name) : null);

      const shouldLogMoveIn =
        !!roomId &&
        !!moveInDate &&
        !!fullName &&
        (!previousTenant ||
          String(previousTenant.room_id ?? "") !== roomId ||
          String(previousTenant.move_in_date ?? "") !== moveInDate);

      const roomChanged =
        !!previousTenant &&
        !!previousTenant.room_id &&
        String(previousTenant.room_id) !== roomId;

      if (roomChanged) {
        const closeDate = moveInDate || new Date().toISOString().slice(0, 10);
        const { error: closeOldLogError } = await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: closeDate, updated_at: new Date().toISOString() })
          .eq("room_id", String(previousTenant.room_id))
          .eq("tenant_id", tenantId)
          .is("move_out_date", null);
        if (closeOldLogError) {
          return NextResponse.json({ error: closeOldLogError.message }, { status: 500 });
        }

        // `no_fee` is a mid-month move with no proration at all — e.g. the move
        // effectively lines up with the invoice cycle, so the tenant should
        // just be billed the new room's full rate starting next cycle instead
        // of a split old/new rent + old-room utility line. Skipping the
        // tenant_room_transfers insert is sufficient: the monthly invoice
        // generator only applies the old/new split when a row exists for this
        // tenant's billing month, and falls back to the new room's plain
        // price_month and its own normal meter_readings otherwise. The
        // move-in log below still uses transfer_date regardless, so room
        // occupancy history stays accurate either way.
        if (transferPayload?.transfer_date && !transferPayload?.no_fee) {
          const roomIds = [String(previousTenant.room_id), roomId];
          const { data: roomRates, error: roomRatesError } = await auth.supabase
            .from("rooms")
            .select("id,price_month")
            .in("id", roomIds);

          if (roomRatesError) {
            return NextResponse.json({ error: roomRatesError.message }, { status: 500 });
          }

          const oldRoomRate =
            roomRates?.find((room) => String(room.id) === String(previousTenant.room_id))?.price_month ?? 0;
          const newRoomRate =
            roomRates?.find((room) => String(room.id) === roomId)?.price_month ?? 0;
          const transferRent = calculateTransferRentProration(
            String(transferPayload.transfer_date),
            previousTenant?.move_in_date ? String(previousTenant.move_in_date) : null,
            toNumber(oldRoomRate),
            toNumber(newRoomRate)
          );

          const transferInsert = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            from_room_id: String(previousTenant.room_id),
            to_room_id: roomId,
            transfer_date: String(transferPayload.transfer_date),
            billing_month: String(
              transferPayload.billing_month ??
                `${String(transferPayload.transfer_date).slice(0, 7)}-01`
            ),
            old_prev_electricity: Number(transferPayload.old_prev_electricity ?? 0),
            old_curr_electricity: Number(transferPayload.old_curr_electricity ?? 0),
            old_prev_water: Number(transferPayload.old_prev_water ?? 0),
            old_curr_water: Number(transferPayload.old_curr_water ?? 0),
            new_prev_electricity: Number(transferPayload.new_prev_electricity ?? 0),
            new_curr_electricity: Number(transferPayload.new_curr_electricity ?? 0),
            new_prev_water: Number(transferPayload.new_prev_water ?? 0),
            new_curr_water: Number(transferPayload.new_curr_water ?? 0),
            old_electric_usage: Number(transferPayload.old_electric_usage ?? 0),
            old_water_usage: Number(transferPayload.old_water_usage ?? 0),
            old_rent_amount: transferRent.oldRoomAmount,
            new_rent_amount: transferRent.newRoomAmount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          const { error: transferInsertError } = await auth.supabase
            .from("tenant_room_transfers")
            .insert(transferInsert);
          if (transferInsertError) {
            return NextResponse.json({ error: transferInsertError.message }, { status: 500 });
          }
        }
      }

      if (shouldLogMoveIn) {
        const { error: moveInLogError } = await auth.supabase.from("room_tenant_logs").upsert(
          {
            room_id: roomId,
            tenant_id: effectiveTenantId || null,
            tenant_name: fullName,
            move_in_date: transferPayload?.transfer_date ? String(transferPayload.transfer_date) : moveInDate,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "room_id,tenant_id,move_in_date" }
        );
        if (moveInLogError) {
          return NextResponse.json({ error: moveInLogError.message }, { status: 500 });
        }
      }

      if (roomId) {
        // Editing an inactive tenant who's still mid-settlement (room_id stays set
        // between "vacate" and "settle", see final_move_out) must not re-occupy the
        // room just because roomId is present on the payload — only an active
        // tenant actually occupies it.
        const nextRoomStatus = payload.status === "active" ? "occupied" : "available";
        const { error: roomStatusError } = await auth.supabase
          .from("rooms")
          .update({ status: nextRoomStatus })
          .eq("id", roomId);
        if (roomStatusError) {
          return NextResponse.json({ error: roomStatusError.message }, { status: 500 });
        }
        if (shouldLogMoveIn) {
          const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
            room_id: roomId,
            event_type: "move_in",
            created_at: new Date().toISOString(),
          });
          if (roomLogError) {
            console.warn("room_logs insert failed:", roomLogError.message);
          }
        }
      }
      return NextResponse.json({ success: true });
    }

    if (action === "autosave_move_out_draft") {
      // Debounced draft save from the move-out settlement wizard, so meter
      // readings/amounts entered mid-wizard survive a closed modal or a
      // browser refresh instead of only persisting once "confirm" is
      // clicked. Only touches the specific draft columns the wizard owns —
      // never room/status fields — so it can safely fire on every edit.
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }
      const payload = (body?.payload ?? {}) as Record<string, unknown>;
      const updatePayload: Record<string, unknown> = {};
      if (payload.final_electricity_reading !== undefined) {
        updatePayload.final_electricity_reading = toNumber(payload.final_electricity_reading);
      }
      if (payload.final_water_reading !== undefined) {
        updatePayload.final_water_reading = toNumber(payload.final_water_reading);
      }
      if (payload.advance_rent_amount !== undefined) {
        updatePayload.advance_rent_amount = toNumber(payload.advance_rent_amount);
      }
      if (payload.security_deposit_amount !== undefined) {
        updatePayload.security_deposit_amount = toNumber(payload.security_deposit_amount);
      }
      if (payload.forfeit_security_deposit !== undefined) {
        updatePayload.forfeit_security_deposit = Boolean(payload.forfeit_security_deposit);
      }
      if (Object.keys(updatePayload).length === 0) {
        return NextResponse.json({ success: true });
      }
      const { data: draftBefore } = await auth.supabase
        .from("tenants")
        .select(Object.keys(updatePayload).join(","))
        .eq("id", tenantId)
        .maybeSingle();
      const { error } = await auth.supabase.from("tenants").update(updatePayload).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (
        "advance_rent_amount" in updatePayload ||
        "security_deposit_amount" in updatePayload ||
        "forfeit_security_deposit" in updatePayload
      ) {
        await recordMoneyEvent(auth.supabase, {
          action: "tenant.move_out_draft_money",
          actorUserId: auth.user.id,
          tenantId,
          before: draftBefore ?? null,
          after: updatePayload,
          source: "admin_webapp",
        });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "delete_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { data: tenantBefore } = await auth.supabase
        .from("tenants")
        .select("id,room_id,status,full_name,security_deposit_amount,advance_rent_amount")
        .eq("id", tenantId)
        .maybeSingle();
      const { error } = await auth.supabase.from("tenants").delete().eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await recordMoneyEvent(auth.supabase, {
        action: "tenant.delete",
        actorUserId: auth.user.id,
        tenantId,
        roomId: (tenantBefore as any)?.room_id ?? null,
        before: tenantBefore ?? null,
        source: "admin_webapp",
      });
      return NextResponse.json({ success: true });
    }

    if (action === "get_move_outs_page_data") {
      // Powers app/(admin)/move-outs/page.tsx — 3 parallel reads (move-out
      // requests, tenants with a move-out date set, and the "pending
      // settlement" list per CLAUDE.md's move-out flow: status='inactive'
      // AND room_id IS NOT NULL) used to run directly from the browser with
      // the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const [reqRes, tenRes, settlementRes] = await Promise.all([
        auth.supabase
          .from("move_out_requests")
          .select(
            "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,status,request_note,created_at,tenants(full_name,room_id,rooms(room_number,buildings(name)))"
          )
          .order("created_at", { ascending: false }),
        auth.supabase
          .from("tenants")
          .select("id,full_name,move_out_date,room_id,rooms(room_number,buildings(name))")
          .not("move_out_date", "is", null)
          .eq("status", "active")
          .order("move_out_date", { ascending: true }),
        auth.supabase
          .from("tenants")
          .select("id,full_name,move_out_date,room_id,rooms(room_number,buildings(name))")
          .not("move_out_date", "is", null)
          .not("room_id", "is", null)
          .eq("status", "inactive")
          .order("move_out_date", { ascending: true }),
      ]);
      if (reqRes.error) return NextResponse.json({ error: reqRes.error.message }, { status: 500 });
      if (tenRes.error) return NextResponse.json({ error: tenRes.error.message }, { status: 500 });
      if (settlementRes.error) return NextResponse.json({ error: settlementRes.error.message }, { status: 500 });
      return NextResponse.json({
        requests: reqRes.data ?? [],
        tenantsWithDate: tenRes.data ?? [],
        pendingSettlementTenants: settlementRes.data ?? [],
      });
    }

    if (action === "get_movable_tenants") {
      // Powers AddManualMoveOutModal.tsx's tenant picker — active tenants
      // who haven't given move-out notice yet, used to be read directly
      // from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("tenants")
        .select("id, full_name, rooms(room_number)")
        .eq("status", "active")
        .is("move_out_date", null)
        .order("full_name");
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ tenants: data ?? [] });
    }

    if (action === "get_move_out_requests") {
      // Powers useMoveOutRequests in lib/hooks/use-data.ts (finding C1) —
      // the pending/approved move-out request list used to be read
      // directly from the browser with the anon key.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("move_out_requests")
        .select(
          "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at"
        )
        .in("status", ["requested", "approved"])
        .order("created_at", { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ requests: data ?? [] });
    }

    if (action === "get_tenants") {
      // Powers tenant-editor-modal.tsx's loadTenants — the full tenant list
      // used to be read directly from the browser with the anon key
      // (finding C1). Same "tenant.view" gate as this file's other
      // read-only actions.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("tenants")
        .select(
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
        )
        .order("move_in_date", { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ tenants: data ?? [] });
    }

    if (action === "get_tenant") {
      // Single-tenant fetch by id — powers openModalById and the
      // post-save refresh in tenant-editor-modal.tsx (same finding as
      // get_tenants above).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }
      const { data, error } = await auth.supabase
        .from("tenants")
        .select(
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
        )
        .eq("id", tenantId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      return NextResponse.json({ tenant: data });
    }

    if (action === "get_tenant_invoice_history") {
      // Powers tenant-editor-modal.tsx's "payments" tab — used to read
      // directly from the browser with the anon key (finding C1). Same
      // "tenant.view" gate as get_tenant above.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }
      const { data, error } = await auth.supabase
        .from("invoices")
        .select(
          "id,start_date,end_date,total_amount,paid_amount,carry_forward_amount,status,slip_url,slip_uploaded_at,payment_history,created_at"
        )
        .eq("tenant_id", tenantId)
        .order("start_date", { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_move_out_data") {
      // Powers MoveOutProcessingModal.tsx, which used to run 5 parallel
      // direct-anon-key reads (plus a follow-up meter_readings read) from
      // the browser (finding C1). Same "tenant.view" gate as the other
      // read-only actions this session added, since every admin role needs
      // to view this to process a move-out.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }

      const [tenantRes, invoicesRes, ratesRes, requestsRes, invoiceHistoryRes] = await Promise.all([
        auth.supabase.from("tenants").select("*, rooms(room_number, price_month, buildings(name))").eq("id", tenantId).single(),
        auth.supabase
          .from("invoices")
          .select("*")
          .eq("tenant_id", tenantId)
          .in("status", ["pending", "overdue", "partial", "verifying", "draft"]),
        auth.supabase.from("settings").select("*").single(),
        auth.supabase.from("move_out_requests").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
        auth.supabase.from("invoices").select("*").eq("tenant_id", tenantId).order("start_date", { ascending: false }),
      ]);

      if (tenantRes.error) return NextResponse.json({ error: tenantRes.error.message }, { status: 500 });
      const tenant = tenantRes.data as any;

      const { data: meterData } = await auth.supabase
        .from("meter_readings")
        .select("current_electricity,current_water")
        .eq("room_id", tenant.room_id)
        .order("reading_month", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Same held-credit rule the settlement uses (ledger per bucket once it
      // has rows, else the tenant columns), so the preview matches the write.
      const { data: ledgerRows } = await auth.supabase
        .from("tenant_credits")
        .select("bucket,amount")
        .eq("tenant_id", tenantId);
      const { data: settledRow } = await auth.supabase
        .from("move_out_settlements")
        .select("id,final_invoice_id,settlement,created_at")
        .eq("tenant_id", tenantId)
        .is("voided_at", null)
        .maybeSingle();

      return NextResponse.json({
        tenant,
        heldCredit: resolveHeldCredit(tenant, (ledgerRows ?? []) as any[]),
        existingSettlement: settledRow ?? null,
        unpaidInvoices: invoicesRes.data || [],
        rates: ratesRes.data || { electricity_rate: 0, water_rate: 0 },
        moveOutRequests: requestsRes.data || [],
        invoiceHistory: invoiceHistoryRes.data || [],
        meterReading: meterData || null,
      });
    }

    if (action === "unlink_line") {
      const auth = await requireAdminPermission(req, "tenant.line.manage");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").update({ line_user_id: null }).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const rawPayload = body?.payload ?? {};
      const moveOutDate = rawPayload?.move_out_date
        ? String(rawPayload.move_out_date)
        : new Date().toISOString().slice(0, 10);
      // Vacate is deliberately just a status + date flip (see CLAUDE.md's
      // move-out flow) — it must not become a side channel for changing any
      // other tenant column, which spreading the raw payload used to allow.
      const updateTenantPayload = {
        status: "inactive",
        move_out_date: moveOutDate,
      };

      const { error } = await auth.supabase
        .from("tenants")
        .update(updateTenantPayload)
        .eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const { data: openLog, error: openLogError } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLogError) return NextResponse.json({ error: openLogError.message }, { status: 500 });
      if (openLog?.id) {
        const { error: closeLogError } = await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
        if (closeLogError) return NextResponse.json({ error: closeLogError.message }, { status: 500 });
      }

      const { error: roomStatusError } = await auth.supabase
        .from("rooms")
        .update({ status: "available" })
        .eq("id", roomId);
      if (roomStatusError) return NextResponse.json({ error: roomStatusError.message }, { status: 500 });

      const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });
      if (roomLogError) {
        // Non-fatal: room is already freed; the journal entry is only for reporting.
        console.warn("room_logs insert failed:", roomLogError.message);
      }
      return NextResponse.json({ success: true });
    }

    if (action === "manage_move_out_request") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const requestId = String(body?.requestId ?? "");
      const requestStatus = String(body?.requestStatus ?? "");
      const adminNote = body?.adminNote != null ? String(body.adminNote) : null;

      if (!requestId || !requestStatus) {
        return NextResponse.json({ error: "Missing requestId or requestStatus." }, { status: 400 });
      }

      const allowedStatuses = new Set(["requested", "approved", "rejected", "completed", "cancelled"]);
      if (!allowedStatuses.has(requestStatus)) {
        return NextResponse.json({ error: "Invalid request status." }, { status: 400 });
      }

      const { data: requestRow, error: requestFetchError } = await auth.supabase
        .from("move_out_requests")
        .select("id,tenant_id,requested_move_out_date")
        .eq("id", requestId)
        .maybeSingle();

      if (requestFetchError) {
        return NextResponse.json({ error: requestFetchError.message }, { status: 500 });
      }
      if (!requestRow?.id) {
        return NextResponse.json({ error: "Move-out request not found." }, { status: 404 });
      }

      // Approval always locks in the tenant's own requested date — there's no
      // separate admin-chosen date. If the date is wrong, the tenant re-requests.
      const approvedMoveOutDate = String(requestRow.requested_move_out_date ?? "");

      const nowIso = new Date().toISOString();
      const updatePayload: Record<string, unknown> = {
        status: requestStatus,
        admin_note: adminNote,
        updated_at: nowIso,
      };
      if (requestStatus === "approved") {
        updatePayload.approved_move_out_date = approvedMoveOutDate;
      }

      const { error: updateRequestError } = await auth.supabase
        .from("move_out_requests")
        .update(updatePayload)
        .eq("id", requestId);

      if (updateRequestError) {
        return NextResponse.json({ error: updateRequestError.message }, { status: 500 });
      }

      if (requestStatus === "approved" && approvedMoveOutDate) {
        const tenantId = String(requestRow.tenant_id);

        const { error: updateTenantError } = await auth.supabase
          .from("tenants")
          .update({ move_out_date: approvedMoveOutDate })
          .eq("id", tenantId);

        if (updateTenantError) {
          return NextResponse.json({ error: updateTenantError.message }, { status: 500 });
        }

      }

      return NextResponse.json({ success: true });
    }

    if (action === "get_move_out_late_fees") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      const loaded = await loadMoveOutLateFeeCandidates(auth.supabase, tenantId, new Date().toISOString().slice(0, 10));
      if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
      return NextResponse.json({ lateFees: loaded.candidates });
    }

    if (action === "final_move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      if (!tenantId || !roomId) {
        return NextResponse.json({ error: "Missing tenantId or roomId." }, { status: 400 });
      }
      const moveOutDate =
        payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);
      const idempotencyKey =
        String(payload?.idempotencyKey ?? body?.idempotencyKey ?? "").trim() || `final:${tenantId}:${moveOutDate}`;

      // A retried request (double click, network retry) replays the original
      // settlement instead of computing a second one from changed state.
      const replay = await findSettlementReplay(auth.supabase, tenantId, idempotencyKey);
      if (replay) return NextResponse.json(replay);

      const ctx = await loadSettlementContext(auth.supabase, tenantId, roomId);
      if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

      // Previous readings come ONLY from meter_readings (CLAUDE.md: the two
      // writers own that table; everyone else reads the latest row). The
      // screen shows the same value; if it changed since the admin looked, stop
      // rather than bill against a number they never saw.
      const meterData = payload?.meterData ?? {};

      // The one exception: the admin may type a previous reading in the wizard.
      // It overrides meter_readings for THIS settlement only (usage and the final
      // invoice's meter start) and is never written to meter_readings.
      const parseManualPrev = (raw: unknown): { value: number | null } | { error: true } => {
        if (raw == null || raw === "") return { value: null };
        const n = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(n) && n >= 0 ? { value: n } : { error: true };
      };
      const manualElec = parseManualPrev(meterData.manual_previous_electricity);
      const manualWater = parseManualPrev(meterData.manual_previous_water);
      if ("error" in manualElec || "error" in manualWater) {
        return NextResponse.json({ error: "เลขมิเตอร์ครั้งก่อนที่กรอกเองไม่ถูกต้อง" }, { status: 400 });
      }
      const manualPrevElec = manualElec.value;
      const manualPrevWater = manualWater.value;

      // Stale-reading check only applies to a utility using the meter_readings value.
      const sentPrevElec = meterData.initial_electricity;
      const sentPrevWater = meterData.initial_water;
      if (
        (manualPrevElec == null && sentPrevElec != null && toNumber(sentPrevElec) !== ctx.previousElectricity) ||
        (manualPrevWater == null && sentPrevWater != null && toNumber(sentPrevWater) !== ctx.previousWater)
      ) {
        return NextResponse.json(
          {
            error: `เลขมิเตอร์ครั้งก่อนเปลี่ยนไป (ไฟ ${ctx.previousElectricity}, น้ำ ${ctx.previousWater}) กรุณาโหลดหน้าใหม่แล้วตรวจสอบอีกครั้ง`,
          },
          { status: 409 }
        );
      }
      const previousElectricity = manualPrevElec ?? ctx.previousElectricity;
      const previousWater = manualPrevWater ?? ctx.previousWater;

      const forfeit = resolveForfeitInput(payload, ctx.held.deposit);
      if ("error" in forfeit) return NextResponse.json({ error: forfeit.error }, { status: 400 });

      // Late fees on older invoices: every candidate is either billed on the
      // final invoice or voided by the admin (reason required). Amounts always
      // come from the server-side candidate, never from the client.
      const paidAt = new Date().toISOString();
      const lateLoaded = await loadMoveOutLateFeeCandidates(auth.supabase, tenantId, paidAt.slice(0, 10));
      if ("error" in lateLoaded) {
        return NextResponse.json({ error: `โหลดค่าปรับล่าช้าไม่สำเร็จ: ${lateLoaded.error}` }, { status: 500 });
      }
      const voidedRequests = new Map<string, string>();
      for (const v of Array.isArray(payload?.voidedLateFees) ? payload.voidedLateFees : []) {
        const id = String(v?.invoiceId ?? "");
        if (id) voidedRequests.set(id, String(v?.reason ?? "").trim());
      }
      const lateBilled: MoveOutLateFees["billed"] = [];
      const lateVoided: MoveOutLateFees["voided"] = [];
      for (const c of lateLoaded.candidates) {
        if (voidedRequests.has(c.invoiceId)) {
          const reason = voidedRequests.get(c.invoiceId) ?? "";
          if (!reason) {
            return NextResponse.json(
              { error: `กรุณาระบุเหตุผลที่ยกเลิกค่าปรับล่าช้า งวด ${c.periodStart}` },
              { status: 400 }
            );
          }
          lateVoided.push({ invoiceId: c.invoiceId, amount: c.amount, reason });
        } else {
          lateBilled.push({
            invoiceId: c.invoiceId,
            amount: c.amount,
            label: c.label,
            periodStart: c.periodStart,
            daysOverdue: c.daysOverdue,
            dailyRate: c.dailyRate,
          });
        }
      }

      const period = computeMoveOutRentPeriod({
        lastBilledEndDate: ctx.lastBilledEndDate,
        moveOutDate,
        billingDay: ctx.billingDay,
        monthlyRent: ctx.monthlyRent,
        useProrate: payload?.useProrate !== false,
      });
      const plan = planMoveOutSettlement(
        buildMoveOutPlanInput({
          period,
          lateFeeLines: lateBilled.map((l) => ({ invoiceId: l.invoiceId, label: l.label, amount: l.amount })),
          previousElectricity,
          currentElectricity: toNumber(meterData.final_electricity),
          previousWater,
          currentWater: toNumber(meterData.final_water),
          electricityRate: ctx.electricityRate,
          waterRate: ctx.waterRate,
          feeLines: (Array.isArray(payload?.moveOutFeeLines) ? payload.moveOutFeeLines : []).map((l: any) => ({
            label: String(l?.label ?? ""),
            amount: toNumber(l?.amount),
          })),
          openInvoices: ctx.openInvoices,
          held: ctx.held,
          forfeitAmount: forfeit.amount,
          forfeitReason: forfeit.reason,
        })
      );
      if (plan.errors.length > 0) {
        return NextResponse.json({ error: plan.errors.join("; "), settlement: plan }, { status: 400 });
      }

      const today = new Date().toISOString().slice(0, 10);
      const moveOutDateObj = new Date(moveOutDate);
      const dueDate = new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate() + 7);
      const p = buildFinalSettlementRpcPayload({
        tenantId,
        roomId,
        idempotencyKey,
        moveOutDate,
        createdBy: auth.user.id,
        paidAt,
        plan,
        period,
        openInvoices: ctx.openInvoices,
        source: "credit",
        lateFees: { billed: lateBilled, voided: lateVoided },
        finalInvoice: {
          id: crypto.randomUUID(),
          issueDate: today,
          dueDate: `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}-${String(dueDate.getDate()).padStart(2, "0")}`,
          notes: plan.depositForfeited > 0
            ? `ย้ายออก (ริบเงินประกัน ฿${plan.depositForfeited}: ${plan.forfeitReason})`
            : "ย้ายออก (Final Statement)",
          meter: {
            electricityStart: previousElectricity,
            electricityEnd: toNumber(meterData.final_electricity),
            waterStart: previousWater,
            waterEnd: toNumber(meterData.final_water),
          },
        },
      });

      const { data: rpcResult, error: rpcError } = await auth.supabase.rpc("final_settle_move_out", { p });
      if (rpcError) return settlementRpcError(rpcError.message);
      return NextResponse.json({
        success: true,
        replayed: Boolean((rpcResult as any)?.replayed),
        settlementId: (rpcResult as any)?.settlement_id ?? null,
        finalInvoiceId: (rpcResult as any)?.final_invoice_id ?? null,
        settlement: (rpcResult as any)?.settlement ?? plan,
      });
    }

    if (action === "cancel_move_out_process") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }

      const { data: tenantRow, error: tenantFetchError } = await auth.supabase
        .from("tenants")
        .select("id,status")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantFetchError) {
        return NextResponse.json({ error: tenantFetchError.message }, { status: 500 });
      }
      if (!tenantRow?.id) {
        return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      }
      if (String(tenantRow.status) !== "active") {
        return NextResponse.json(
          { error: "ยกเลิกได้เฉพาะผู้เช่าที่ยังสถานะ active" },
          { status: 400 }
        );
      }

      const nowIso = new Date().toISOString();

      const { error: clearDateError } = await auth.supabase
        .from("tenants")
        .update({ move_out_date: null, updated_at: nowIso })
        .eq("id", tenantId)
        .eq("status", "active");

      if (clearDateError) {
        return NextResponse.json({ error: clearDateError.message }, { status: 500 });
      }

      const { error: cancelRequestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "cancelled", updated_at: nowIso })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);

      if (cancelRequestsError) {
        return NextResponse.json({ error: cancelRequestsError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    if (action === "abandon_room") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const moveOutDate = body?.moveOutDate
        ? String(body.moveOutDate)
        : new Date().toISOString().slice(0, 10);

      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }
      const idempotencyKey = String(body?.idempotencyKey ?? "").trim() || `abandon:${tenantId}:${moveOutDate}`;
      const replay = await findSettlementReplay(auth.supabase, tenantId, idempotencyKey);
      if (replay) return NextResponse.json(abandonResponse(replay.settlement, true));

      const { data: tenantRow, error: tenantErr } = await auth.supabase
        .from("tenants")
        .select("id,room_id,status")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantErr) return NextResponse.json({ error: tenantErr.message }, { status: 500 });
      if (!tenantRow?.id) return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      if (String(tenantRow.status) !== "active") {
        return NextResponse.json({ error: "ผู้เช่าไม่ได้อยู่ในสถานะ active" }, { status: 400 });
      }
      if (!tenantRow.room_id) {
        return NextResponse.json({ error: "ผู้เช่าไม่มีห้องที่ผูกอยู่" }, { status: 400 });
      }
      const roomId = String(tenantRow.room_id);

      const ctx = await loadSettlementContext(auth.supabase, tenantId, roomId);
      if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

      const forfeit = resolveForfeitInput(body, ctx.held.deposit);
      if ("error" in forfeit) return NextResponse.json({ error: forfeit.error }, { status: 400 });

      // Same planner and the same atomic write as a normal final settlement, with
      // no final bill: held credit (advance rent first, then deposit) is applied
      // to the existing debt oldest-first as a NON-CASH receipt (source
      // 'abandon_room'). Debt the credit cannot reach stays owed on its invoice
      // with its status unchanged — nothing is written off here; a write-off is
      // a separate, explicit decision. Leftover advance rent is absorbed (not
      // refundable); only leftover deposit is refund due.
      const period = computeMoveOutRentPeriod({
        lastBilledEndDate: ctx.lastBilledEndDate,
        moveOutDate,
        billingDay: ctx.billingDay,
        monthlyRent: 0,
        useProrate: false,
      });
      const plan = planMoveOutSettlement(
        buildMoveOutPlanInput({
          period,
          previousElectricity: 0,
          currentElectricity: 0,
          previousWater: 0,
          currentWater: 0,
          electricityRate: 0,
          waterRate: 0,
          feeLines: [],
          openInvoices: ctx.openInvoices,
          held: ctx.held,
          forfeitAmount: forfeit.amount,
          forfeitReason: forfeit.reason,
          debtOnly: true,
        })
      );
      if (plan.errors.length > 0) {
        return NextResponse.json({ error: plan.errors.join("; "), settlement: plan }, { status: 400 });
      }

      const p = buildFinalSettlementRpcPayload({
        tenantId,
        roomId,
        idempotencyKey,
        moveOutDate,
        createdBy: auth.user.id,
        paidAt: new Date().toISOString(),
        plan,
        period,
        openInvoices: ctx.openInvoices,
        source: "abandon_room",
        finalInvoice: null,
      });
      const { data: rpcResult, error: rpcError } = await auth.supabase.rpc("final_settle_move_out", { p });
      if (rpcError) return settlementRpcError(rpcError.message);
      return NextResponse.json(
        abandonResponse((rpcResult as any)?.settlement ?? plan, Boolean((rpcResult as any)?.replayed))
      );
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
