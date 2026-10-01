import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { dailyRentRate } from "@/lib/invoice-utils";
import { computeInvoiceTotal } from "@/lib/invoice-total";
import { pickFields } from "@/lib/pick-fields";
import {
  applyInvoicePaymentAllocation,
  planAbandonCredit,
  snapshotFromPaymentMethodRow,
} from "@/lib/invoice-ledger";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInvoiceBalance, type BalanceTenant, type InvoiceBalance } from "@/lib/invoice-balance";
import {
  BALANCE_INVOICE_COLUMNS,
  MoneyRouteError,
  RPC_CLIENT_ERROR_CODES,
  UUID_RE,
  loadBalanceAllocationsAndWaivers,
  moneyErrorResponse,
  rpcErrorResponse,
  toBalanceInvoice,
} from "@/lib/money-rpc";
import {
  olderBillPlanLine,
  planMoveOutSettlement,
  type MoveOutOlderBillLine,
  type SettlementPlan,
} from "@/lib/move-out-settlement";
import { bangkokYmd } from "@/lib/move-out-notice";

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const roundTo2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

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

// ─── New move-out flow (B5): unlock_room → prepare_move_out_bill → settle ─────
//
// Thin wrappers over the live Postgres functions unlock_room,
// prepare_move_out_bill, settle_move_out and mark_refund_paid
// (docs/audit/2026-09-29-late-fee-and-overdue-design.md A5/B5). The only
// thing computed here is `p_older_bills` for settle_move_out: each of the
// tenant's other open bills with the balance engine's charges_due / fee_due as
// of today (Bangkok) and the compare-and-swap stamps. It is always rebuilt
// server-side at call time; amounts from the client are never forwarded.

/** Every `[code]` the move-out functions (and record_payment inside settle) raise for a bad request or stale/invalid state. */
const MOVE_OUT_RPC_CLIENT_CODES: ReadonlySet<string> = new Set([
  ...RPC_CLIENT_ERROR_CODES,
  "already_settled",
  "not_unlocked",
  "bad_state",
  "unsent_monthly_draft",
  "room_transfer",
  "missing_meter_reading",
  "meter_went_backwards",
  "move_out_bill_exists",
  "no_move_out_bill",
  "slip_pending",
  "bad_plan",
  "refund_already_paid",
]);

/** settle_move_out's "open bill" set: it must receive every one of these except the move-out bill. */
const SETTLE_OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "partial", "overdue"]);

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

type SettlementIssue = { code: string; message: string };

type SettlementState = {
  asOf: string;
  tenant: {
    id: string;
    status: string | null;
    room_id: string | null;
    handover_date: string | null;
    tenancy_end_date: string | null;
    move_out_date: string | null;
    security_deposit_amount: number | null;
    advance_rent_amount: number | null;
  };
  alreadySettled: boolean;
  /** Conditions under which settle_move_out would raise instead of settling. */
  blockers: SettlementIssue[];
  /** Worth showing the admin, but settle would still run. */
  warnings: SettlementIssue[];
  moveOutBill: {
    id: string;
    status: string;
    total_amount: number;
    paid_sum: number;
    start_date: string | null;
    end_date: string | null;
    due_date: string | null;
  } | null;
  olderBills: Array<{
    invoice_id: string;
    status: string;
    fee_model: string;
    kind: string | null;
    start_date: string | null;
    end_date: string | null;
    due_date: string | null;
    total_amount: number;
    paid_amount: number;
    engine: InvoiceBalance;
    line: MoveOutOlderBillLine;
  }>;
  /** Exactly what settle_move_out receives as p_older_bills. */
  pOlderBills: MoveOutOlderBillLine[];
  plan: SettlementPlan;
};

/**
 * Read the tenant, their bills and the money on them, and compute what
 * settle_move_out would do right now. Read-only.
 */
async function buildSettlementState(
  supabase: SupabaseClient,
  tenantId: string,
  forfeitDeposit: boolean,
): Promise<SettlementState> {
  const asOf = bangkokYmd(new Date());

  const { data: tenantRow, error: tenantError } = await supabase
    .from("tenants")
    .select(
      "id,status,room_id,handover_date,tenancy_end_date,move_out_date,security_deposit_amount,advance_rent_amount",
    )
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw new MoneyRouteError(500, tenantError.message);
  if (!tenantRow) throw new MoneyRouteError(404, `Tenant ${tenantId} not found.`, "not_found");
  const t = tenantRow as any;
  const nullableNumber = (value: unknown) => (value == null ? null : toNumber(value));
  const tenant: SettlementState["tenant"] = {
    id: String(t.id),
    status: t.status ?? null,
    room_id: t.room_id ?? null,
    handover_date: t.handover_date ?? null,
    tenancy_end_date: t.tenancy_end_date ?? null,
    move_out_date: t.move_out_date ?? null,
    security_deposit_amount: nullableNumber(t.security_deposit_amount),
    advance_rent_amount: nullableNumber(t.advance_rent_amount),
  };
  const balanceTenant: BalanceTenant = {
    status: tenant.status,
    handover_date: tenant.handover_date,
    tenancy_end_date: tenant.tenancy_end_date,
  };

  const { data: invoiceRows, error: invoiceError } = await supabase
    .from("invoices")
    .select(`${BALANCE_INVOICE_COLUMNS},start_date,end_date,created_at`)
    .eq("tenant_id", tenantId);
  if (invoiceError) throw new MoneyRouteError(500, invoiceError.message);
  const invoices = (invoiceRows ?? []) as any[];

  const blockers: SettlementIssue[] = [];
  const warnings: SettlementIssue[] = [];

  // Same order of checks as settle_move_out.
  const alreadySettled = tenant.status === "inactive" && tenant.room_id == null;
  if (alreadySettled) {
    blockers.push({
      code: "already_settled",
      message: "This tenant's move-out is already settled; settle_move_out would change nothing.",
    });
  } else if (tenant.status !== "inactive" || tenant.handover_date == null || tenant.room_id == null) {
    blockers.push({ code: "not_unlocked", message: "Run unlock_room for this tenant first." });
  }

  const moveOutRows = invoices.filter(
    (row) => row.kind === "move_out" && row.fee_model === "v2" && String(row.status) !== "cancelled",
  );
  if (moveOutRows.length === 0) {
    blockers.push({
      code: "no_move_out_bill",
      message: "Run prepare_move_out_bill for this tenant first.",
    });
  } else if (moveOutRows.length > 1) {
    blockers.push({ code: "bad_state", message: "This tenant has more than one move-out bill." });
  } else if (String(moveOutRows[0].status) === "closed_unpaid") {
    blockers.push({ code: "bad_state", message: "The move-out bill is closed_unpaid." });
  }
  const moveOutRow = moveOutRows.length === 1 ? moveOutRows[0] : null;

  if (invoices.some((row) => String(row.status) === "verifying")) {
    blockers.push({
      code: "slip_pending",
      message: "A payment slip is waiting for review; approve or decline it before settling.",
    });
  }

  for (const row of invoices) {
    if (String(row.status) === "draft" && row.kind !== "move_out") {
      warnings.push({
        code: "monthly_draft",
        message: `Bill ${row.id} (${row.start_date} – ${row.end_date}) is an unsent draft; settlement ignores it. prepare_move_out_bill refuses while a monthly draft is newer than the last billed month.`,
      });
    }
  }

  // settle_move_out excludes only the one move-out bill; with zero or several
  // it raises before the plan is used, so excluding nothing then is harmless.
  const olderRows = invoices.filter(
    (row) => SETTLE_OPEN_STATUSES.has(String(row.status)) && row.id !== moveOutRow?.id,
  );

  const ids = [...olderRows, ...(moveOutRow ? [moveOutRow] : [])].map((row) => String(row.id));
  const { allocationsById, waiversById } =
    ids.length > 0
      ? await loadBalanceAllocationsAndWaivers(supabase, ids)
      : { allocationsById: new Map(), waiversById: new Map() };

  const paidSumOf = (id: string) =>
    roundTo2(
      (allocationsById.get(id) ?? [])
        .filter((a: any) => a.voided_at == null)
        .reduce((sum: number, a: any) => sum + toNumber(a.amount), 0),
    );
  const waivedSumOf = (id: string) =>
    roundTo2(
      (waiversById.get(id) ?? [])
        .filter((w: any) => w.voided_at == null)
        .reduce((sum: number, w: any) => sum + Math.max(0, toNumber(w.amount)), 0),
    );

  const olderBills: SettlementState["olderBills"] = olderRows.map((row) => {
    const id = String(row.id);
    const engine = getInvoiceBalance(
      toBalanceInvoice(row, balanceTenant),
      allocationsById.get(id) ?? [],
      waiversById.get(id) ?? [],
      asOf,
    );
    const line = olderBillPlanLine({
      invoiceId: id,
      feeModel: row.fee_model === "v2" ? "v2" : "legacy",
      totalAmount: toNumber(row.total_amount),
      storedPaidAmount: toNumber(row.paid_amount),
      engineChargesDue: engine.chargesDue,
      engineFeeDue: engine.feeDue,
      paidSum: paidSumOf(id),
      waivedSum: waivedSumOf(id),
    });
    if (line.charges_due < engine.chargesDue) {
      warnings.push({
        code: "charges_capped",
        message: `Bill ${id}: the engine says ${engine.chargesDue} of charges is unpaid, but the stored paid_amount/allocations leave only ${line.charges_due}; the deposit is applied to ${line.charges_due} at most.`,
      });
    }
    return {
      invoice_id: id,
      status: String(row.status),
      fee_model: String(row.fee_model),
      kind: row.kind ?? null,
      start_date: row.start_date ?? null,
      end_date: row.end_date ?? null,
      due_date: row.due_date ?? null,
      total_amount: toNumber(row.total_amount),
      paid_amount: toNumber(row.paid_amount),
      engine,
      line,
    };
  });

  const moveOutBill: SettlementState["moveOutBill"] = moveOutRow
    ? {
        id: String(moveOutRow.id),
        status: String(moveOutRow.status),
        total_amount: toNumber(moveOutRow.total_amount),
        paid_sum: paidSumOf(String(moveOutRow.id)),
        start_date: moveOutRow.start_date ?? null,
        end_date: moveOutRow.end_date ?? null,
        due_date: moveOutRow.due_date ?? null,
      }
    : null;

  const plan = planMoveOutSettlement({
    securityDeposit: tenant.security_deposit_amount,
    advanceRent: tenant.advance_rent_amount,
    forfeitDeposit,
    moveOutBill: moveOutBill
      ? {
          invoiceId: moveOutBill.id,
          totalAmount: moveOutBill.total_amount,
          paidSum: moveOutBill.paid_sum,
        }
      : null,
    olderBills: olderRows.map((row, index) => ({
      invoiceId: String(row.id),
      dueDate: row.due_date ?? null,
      startDate: row.start_date ?? null,
      createdAt: row.created_at ?? null,
      line: olderBills[index].line,
    })),
  });

  // Present the older bills in the order settle consumes credit.
  const order = new Map(plan.olderBills.map((bill, index) => [bill.invoiceId, index]));
  olderBills.sort((a, b) => (order.get(a.invoice_id) ?? 0) - (order.get(b.invoice_id) ?? 0));

  return {
    asOf,
    tenant,
    alreadySettled,
    blockers,
    warnings,
    moveOutBill,
    olderBills,
    pOlderBills: olderBills.map((bill) => bill.line),
    plan,
  };
}

/** The preview response — also returned with a 409 when settle's re-check differs. */
const settlementPreviewBody = (state: SettlementState, forfeitDeposit: boolean) => ({
  asOf: state.asOf,
  tenant: state.tenant,
  forfeitDeposit,
  canSettle: state.blockers.length === 0,
  blockers: state.blockers,
  warnings: state.warnings,
  moveOutBill: state.moveOutBill
    ? {
        ...state.moveOutBill,
        amountDue: state.plan.moveOutBill?.amountDue ?? 0,
        creditApplied: state.plan.moveOutBill?.creditApplied ?? 0,
        remainingDue: state.plan.moveOutBill?.remainingDue ?? 0,
      }
    : null,
  olderBills: state.olderBills.map((bill) => {
    const planned = state.plan.olderBills.find((p) => p.invoiceId === bill.invoice_id);
    return {
      invoice_id: bill.invoice_id,
      status: bill.status,
      fee_model: bill.fee_model,
      kind: bill.kind,
      start_date: bill.start_date,
      end_date: bill.end_date,
      due_date: bill.due_date,
      total_amount: bill.total_amount,
      paid_amount: bill.paid_amount,
      charges_due: bill.line.charges_due,
      fee_due: bill.line.fee_due,
      fee_to_waive: planned?.feeWaived ?? 0,
      credit_applied: planned?.creditApplied ?? 0,
      remaining_due: planned?.remainingDue ?? 0,
      engine: bill.engine,
    };
  }),
  credit: state.plan.credit,
  projected: {
    creditToMoveOutBill: state.plan.moveOutBill?.creditApplied ?? 0,
    creditToOlderBills: roundTo2(
      state.plan.olderBills.reduce((sum, bill) => sum + bill.creditApplied, 0),
    ),
    creditApplied: state.plan.creditApplied,
    feesWaived: state.plan.totalFeeWaived,
    refund: state.plan.refund,
    remainingOwed: state.plan.remainingOwed,
  },
  p_older_bills: state.pOlderBills,
});

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
      const { error } = await auth.supabase.from("tenants").update(updatePayload).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "delete_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").delete().eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
          .select(
            "id,full_name,move_out_date,handover_date,tenancy_end_date,room_id,rooms(room_number,buildings(name))"
          )
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

      return NextResponse.json({
        tenant,
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

    if (action === "final_move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const {
        forfeitDeposit,
        forfeit_security_deposit,
        useProrate = true,
        meterData: extractedMeterData,
        moveOutFeeLines: extractedMoveOutFeeLines,
        ...restPayload
      } = payload;
      
      const isForfeit = forfeitDeposit ?? forfeit_security_deposit ?? false;
      const moveOutDate =
        payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);

      // Fetch tenant + room data and compute the whole settlement BEFORE touching
      // the tenant/room/logs below. The invoice insert used to happen last, so a
      // failure there (e.g. a missing column) still left the tenant marked
      // inactive and the room freed with no settlement invoice ever created —
      // an orphaned record with no way to recover the numbers that were entered.
      // Now nothing is mutated until the invoice is safely in the database.
      const { data: tenant, error: tenantFetchError } = await auth.supabase
        .from("tenants")
        .select("id,room_id,advance_rent_amount,security_deposit_amount,rooms(id,price_month,room_number)")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenantFetchError) {
        return NextResponse.json({ error: tenantFetchError.message }, { status: 500 });
      }
      if (!tenant?.id) {
        return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      }

      const { data: settings } = await auth.supabase.from("settings").select("*").maybeSingle();
      const billingDay = Math.max(1, Math.min(28, Number(settings?.billing_day) || 25));
      const dueDay = Math.max(1, Math.min(28, Number(settings?.due_day) || 10));

      const { data: lastInvoice } = await auth.supabase
        .from("invoices")
        .select("end_date")
        .eq("tenant_id", tenantId)
        .neq("status", "draft")
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      const moveOutDateObj = new Date(moveOutDate);
      let masterStartDateObj = lastInvoice?.end_date ? new Date(lastInvoice.end_date) : new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth() - 1, billingDay);
      
      // Calculate full months and prorate days
      // E.g., start: May 25, moveOut: June 28 -> 1 full month + 3 days
      // or start: June 25, moveOut: June 28 -> 0 full month + 3 days
      let currentEnd = new Date(masterStartDateObj);
      currentEnd.setMonth(currentEnd.getMonth() + 1);
      
      let fullMonths = 0;
      let tempStart = new Date(masterStartDateObj);
      while (currentEnd <= moveOutDateObj) {
        fullMonths++;
        tempStart = new Date(currentEnd);
        currentEnd.setMonth(currentEnd.getMonth() + 1);
      }
      
      // Calculate remaining prorate days
      const msPerDay = 86400000;
      const tempStartUtc = Date.UTC(tempStart.getFullYear(), tempStart.getMonth(), tempStart.getDate());
      const moveOutUtc = Date.UTC(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate());
      const prorateDays = Math.floor((moveOutUtc - tempStartUtc) / msPerDay); // Exclusive of start date

      const roomRel = Array.isArray(tenant?.rooms) ? tenant?.rooms[0] : tenant?.rooms;
      const priceMonth = toNumber(roomRel?.price_month ?? 0);
      const dailyRate = dailyRentRate(priceMonth);

      const baseRent = useProrate ? (priceMonth * fullMonths) : 0;
      const proratedRent = useProrate ? dailyRate * prorateDays : 0;
      const totalRent = baseRent + proratedRent;

      // Utilities
      const meterData = payload?.meterData ?? {};
      const electricityUsage = Math.max(toNumber(meterData.final_electricity) - toNumber(meterData.initial_electricity), 0);
      const waterUsage = Math.max(toNumber(meterData.final_water) - toNumber(meterData.initial_water), 0);
      
      const elecRate = toNumber(settings?.electricity_rate ?? 0);
      const waterRate = toNumber(settings?.water_rate ?? 0);
      const electricityBill = electricityUsage * elecRate;
      const waterBill = waterUsage * waterRate;

      // Additional Fees
      const moveOutFeeLines = Array.isArray(payload?.moveOutFeeLines) ? payload.moveOutFeeLines : [];
      let additionalFeesTotal = 0;
      const additionalBreakdown = moveOutFeeLines.map((line: any) => {
        const amt = toNumber(line.amount);
        additionalFeesTotal += amt;
        return {
          item_type: "custom",
          label: line.label || "ค่าใช้จ่ายเพิ่มเติม",
          amount: amt,
        };
      });

      if (proratedRent > 0) {
        additionalBreakdown.unshift({
          item_type: "prorate_rent",
          label: `ค่าเช่าส่วนเกิน ${prorateDays} วัน (Pro-rate)`,
          amount: proratedRent,
        });
        additionalFeesTotal += proratedRent;
      }

      // Deductions
      const checkForfeit = Boolean(payload?.forfeitDeposit ?? payload?.forfeit_security_deposit);
      const depositRefund = checkForfeit ? 0 : toNumber(tenant?.security_deposit_amount ?? 0);
      const advanceRentRefund = toNumber(tenant?.advance_rent_amount ?? 0);
      const totalDiscount = depositRefund + advanceRentRefund;

      // Numerically identical to the hand-rolled sum this replaces
      // (baseRent + waterBill + electricityBill + additionalFeesTotal -
      // totalDiscount) — commonFee/lateFee/carryForward are explicitly zero
      // here, matching the same zeros already hardcoded below in the insert,
      // so a future move-out settlement that adds one of those won't have
      // its total silently omit it the way three other hand-rolled sums in
      // this codebase already did.
      const totalAmount = computeInvoiceTotal({
        rent: baseRent,
        water: waterBill,
        electricity: electricityBill,
        commonFee: 0,
        nativeLateFee: 0,
        lateFeeItems: 0,
        fees: additionalFeesTotal,
        carryForward: 0,
        discount: totalDiscount,
      });

      const toYmd = (d: Date) => d.toISOString().slice(0, 10);
      const dueDateObj = new Date(moveOutDateObj.getFullYear(), moveOutDateObj.getMonth(), moveOutDateObj.getDate() + 7);

      // Save the Master Final Invoice
      const { error: finalInvoiceError } = await auth.supabase.from("invoices").insert({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        room_id: roomId,
        status: "pending",
        start_date: toYmd(masterStartDateObj),
        end_date: moveOutDate,
        issue_date: new Date().toISOString().slice(0, 10),
        due_date: toYmd(dueDateObj),
        rent_amount: baseRent,
        water_bill: waterBill,
        electricity_bill: electricityBill,
        common_fee: 0,
        discount_amount: totalDiscount,
        late_fee_amount: 0,
        carry_forward_amount: 0,
        additional_fees_total: additionalFeesTotal,
        additional_fees_breakdown: additionalBreakdown,
        total_amount: totalAmount,
        paid_amount: 0,
        electricity_reading_start: toNumber(meterData.initial_electricity),
        electricity_reading_end: toNumber(meterData.final_electricity),
        water_reading_start: toNumber(meterData.initial_water),
        water_reading_end: toNumber(meterData.final_water),
        notes: checkForfeit ? "ย้ายออก (ริบเงินประกัน)" : "ย้ายออก (Final Statement)",
        created_at: new Date().toISOString(),
      });
      if (finalInvoiceError) {
        return NextResponse.json({ error: finalInvoiceError.message }, { status: 500 });
      }

      // The settlement invoice exists now — safe to mutate tenant/room state.
      const updatePayload = {
        ...restPayload,
        forfeit_security_deposit: isForfeit,
        status: "inactive",
        room_id: null,
      };
      const { error: tenantUpdateError } = await auth.supabase
        .from("tenants")
        .update(updatePayload)
        .eq("id", tenantId);
      if (tenantUpdateError) return NextResponse.json({ error: tenantUpdateError.message }, { status: 500 });

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
        console.warn("room_logs insert failed:", roomLogError.message);
      }

      const { error: requestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "completed", updated_at: new Date().toISOString(), actual_move_out_date: moveOutDate })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);
      if (requestsError) return NextResponse.json({ error: requestsError.message }, { status: 500 });
      return NextResponse.json({ success: true });
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
      const forfeitDeposit = Boolean(body?.forfeitDeposit);
      const moveOutDate = body?.moveOutDate
        ? String(body.moveOutDate)
        : new Date().toISOString().slice(0, 10);

      if (!tenantId) {
        return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      }

      // Fetch tenant with room info
      const { data: tenant, error: tenantErr } = await auth.supabase
        .from("tenants")
        .select("id,room_id,advance_rent_amount,security_deposit_amount,status,rooms(id,price_month,room_number)")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantErr) return NextResponse.json({ error: tenantErr.message }, { status: 500 });
      if (!tenant?.id) return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
      if (String(tenant.status) !== "active") {
        return NextResponse.json({ error: "ผู้เช่าไม่ได้อยู่ในสถานะ active" }, { status: 400 });
      }

      const nowIso = new Date().toISOString();

      // Build available credit pool
      let remainingCredit = toNumber(tenant.advance_rent_amount ?? 0);
      if (!forfeitDeposit) {
        remainingCredit += toNumber(tenant.security_deposit_amount ?? 0);
      }

      // Fetch every open invoice for this tenant, FINAL PERIOD FIRST. A tenant
      // moving out has their closing bill settled before anything else; only
      // credit left over after that reaches earlier periods.
      const { data: unpaidInvoices, error: invErr } = await auth.supabase
        .from("invoices")
        .select("id,total_amount,paid_amount,carry_forward_amount,status,start_date")
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "overdue", "partial", "verifying", "draft"])
        .order("start_date", { ascending: false });

      if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

      const openInvoices = unpaidInvoices ?? [];

      // Spend the credit against each invoice's OWN charge, never its bundled
      // total. An invoice that carried an earlier bill forward already contains
      // that bill's amount in `total_amount`, so measuring both by
      // `total_amount - paid_amount` counts the carried debt twice and burns
      // credit the tenant never owed. `getInvoiceOwnOutstanding` is the same
      // figure the move-out screens show the admin.
      //
      // Allocation itself goes through applyInvoicePaymentAllocation so the
      // credit lands in `payment_history` and `invoice_payment_allocations`
      // like every other payment, instead of a bare `paid_amount` write.
      const plan = planAbandonCredit(openInvoices as any, remainingCredit);

      // Stays true while every invoice so far has been settled in full. Once the
      // credit falls short, nothing later in the chain can be considered clear —
      // a pure carry-forward invoice with no own charge of its own is clear only
      // if everything it carried was cleared.
      let chainFunded = true;
      for (const line of plan.lines) {
        if (line.applied > 0) {
          try {
            await applyInvoicePaymentAllocation(auth.supabase, {
              invoiceId: line.invoiceId,
              amount: line.applied,
              paidAt: nowIso,
              mode: "credit",
              source: "abandon_room",
              // No bank account received this — it is the tenant's own deposit
              // being spent. Recording their transfer account here would put
              // money in a cash-basis report that never hit the bank.
              paymentMethod: {
                id: null,
                snapshot: {
                  type: "credit",
                  label: "เครดิตจากการทิ้งห้อง (Abandon Room)",
                },
              },
              // A retried request replays the original allocation instead of
              // spending the deposit a second time.
              idempotencyKey: `abandon:${tenantId}:${moveOutDate}:${line.invoiceId}`,
              createdBy: auth.user.id,
            });
          } catch (allocationError: any) {
            return NextResponse.json(
              { error: allocationError?.message ?? "Failed to apply abandon credit." },
              { status: 500 }
            );
          }
        }

        const covered = line.writtenOff <= 0 && chainFunded;
        if (!covered) chainFunded = false;

        // No credit reached this invoice at all — it KEEPS its debt and its
        // current status (overdue stays overdue, so it keeps showing up in
        // arrears). Only an invoice the credit actually touched gets relabelled.
        if (line.applied <= 0) {
          continue;
        }

        // Label from what the plan applied, not from a re-read of paid_amount.
        // When a chain settles, the carried portion's cash sits on the SOURCE
        // invoice's row, so the target's own paid_amount stays short of its
        // bundled total for good — re-deriving "still owed" from the row would
        // cancel an invoice the credit had in fact covered in full.
        //
        // Status "abandoned" (not "paid"/"partial") on ANY invoice the credit
        // touched — fully covered or not — so a deposit/advance-rent write-off
        // never reads as if real cash was collected. `writtenOff` tells you
        // whether real debt still remains.
        //
        // `invoices` has no updated_at column — writing one makes PostgREST
        // reject the whole update.
        const payload = {
          status: "abandoned",
          notes: covered
            ? "ชำระโดยเครดิตจากการทิ้งห้อง (Abandon Room)"
            : "ชำระบางส่วนโดยเครดิตจากการทิ้งห้อง (Abandon Room) — ยังมียอดค้างชำระ",
        };

        const { error: labelError } = await auth.supabase
          .from("invoices")
          .update(payload)
          .eq("id", line.invoiceId);
        if (labelError) {
          return NextResponse.json({ error: labelError.message }, { status: 500 });
        }
      }

      // Mark tenant inactive and clear room
      const { error: abandonTenantError } = await auth.supabase
        .from("tenants")
        .update({
          status: "inactive",
          move_out_date: moveOutDate,
          forfeit_security_deposit: forfeitDeposit,
          room_id: null,
          updated_at: nowIso,
        })
        .eq("id", tenantId);
      if (abandonTenantError) {
        return NextResponse.json({ error: abandonTenantError.message }, { status: 500 });
      }

      // Close the open room_tenant_log
      const roomId = String(tenant.room_id ?? "");
      if (roomId) {
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
            .update({ move_out_date: moveOutDate, updated_at: nowIso })
            .eq("id", openLog.id);
          if (closeLogError) return NextResponse.json({ error: closeLogError.message }, { status: 500 });
        }

        // Free the room and log the event
        const { error: roomStatusError } = await auth.supabase
          .from("rooms")
          .update({ status: "available" })
          .eq("id", roomId);
        if (roomStatusError) return NextResponse.json({ error: roomStatusError.message }, { status: 500 });

        const { error: roomLogError } = await auth.supabase.from("room_logs").insert({
          room_id: roomId,
          event_type: "move_out",
          created_at: nowIso,
        });
        if (roomLogError) {
          console.warn("room_logs insert failed:", roomLogError.message);
        }
      }

      // Mark any pending move-out requests as completed
      const { error: closeRequestsError } = await auth.supabase
        .from("move_out_requests")
        .update({ status: "completed", updated_at: nowIso, actual_move_out_date: moveOutDate })
        .eq("tenant_id", tenantId)
        .in("status", ["requested", "approved"]);
      if (closeRequestsError) {
        return NextResponse.json({ error: closeRequestsError.message }, { status: 500 });
      }

      // Credit left after the real debt is covered belongs to the tenant. The
      // old loop silently discarded it; surface it so the admin can refund.
      return NextResponse.json({
        success: true,
        summary: {
          creditPool: roundTo2(plan.creditPool),
          totalOwed: roundTo2(plan.totalOwed),
          creditApplied: roundTo2(plan.creditApplied),
          writtenOff: roundTo2(plan.writtenOff),
          refundableCredit: roundTo2(plan.refundableCredit),
          lines: plan.lines,
        },
        creditApplied: roundTo2(plan.creditApplied),
        refundableCredit: roundTo2(plan.refundableCredit),
      });
    }

    // ── New move-out flow (B5). The old move_out / final_move_out above stay
    //    in place until the UI switches over. ─────────────────────────────────

    if (action === "unlock_room") {
      // ปลดล็อกห้องทันที: tenant inactive + handover date, room freed (unless
      // already re-let), room_id kept so the tenant waits to be settled.
      // Same permission as the old vacate (`move_out`).
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const handoverDate = String(body?.handoverDate ?? "");
      if (!UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: "Invalid tenantId.", code: "bad_request" }, { status: 400 });
      }
      if (!YMD_RE.test(handoverDate)) {
        return NextResponse.json(
          { error: "handoverDate must be a YYYY-MM-DD date.", code: "bad_request" },
          { status: 400 },
        );
      }
      const { data, error } = await auth.supabase.rpc("unlock_room", {
        p_tenant_id: tenantId,
        p_handover_date: handoverDate,
      });
      if (error) return rpcErrorResponse(error, MOVE_OUT_RPC_CLIENT_CODES);
      return NextResponse.json({ success: true, result: (data as any)?.result ?? null, rpc: data });
    }

    if (action === "prepare_move_out_bill") {
      // Creates (or re-prepares, while still an untouched draft) the tenant's
      // kind=move_out bill from the key-return meter readings. Same permission
      // as the old settlement (`final_move_out`). Reads meter_readings only;
      // the readings typed here land on the bill and the tenant row, never in
      // meter_readings (CLAUDE.md: two writers only).
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const finalElectricity = Number(body?.finalElectricity);
      const finalWater = Number(body?.finalWater);
      if (!UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: "Invalid tenantId.", code: "bad_request" }, { status: 400 });
      }
      if (
        body?.finalElectricity == null ||
        body?.finalWater == null ||
        !Number.isFinite(finalElectricity) ||
        !Number.isFinite(finalWater) ||
        finalElectricity < 0 ||
        finalWater < 0
      ) {
        return NextResponse.json(
          { error: "finalElectricity and finalWater are required non-negative numbers.", code: "bad_request" },
          { status: 400 },
        );
      }
      const { data, error } = await auth.supabase.rpc("prepare_move_out_bill", {
        p_tenant_id: tenantId,
        p_final_electricity: finalElectricity,
        p_final_water: finalWater,
        // The admin chooses whether leftover days beyond whole months are
        // charged (the prorate button); the system never decides a grace.
        p_use_prorate: body?.useProrate !== false,
      });
      if (error) return rpcErrorResponse(error, MOVE_OUT_RPC_CLIENT_CODES);
      return NextResponse.json({ success: true, result: (data as any)?.result ?? null, rpc: data });
    }

    if (action === "get_settlement_preview") {
      // Read-only: what settle_move_out would do right now, computed with the
      // balance engine as of today (Bangkok), plus the exact p_older_bills
      // settle would be called with. Same gate as the other read-only tenant
      // views (get_move_out_data).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: "Invalid tenantId.", code: "bad_request" }, { status: 400 });
      }
      const forfeitDeposit = body?.forfeitDeposit === true;
      try {
        const state = await buildSettlementState(auth.supabase, tenantId, forfeitDeposit);
        return NextResponse.json(settlementPreviewBody(state, forfeitDeposit));
      } catch (err) {
        if (err instanceof MoneyRouteError) return moneyErrorResponse(err);
        throw err;
      }
    }

    if (action === "settle_move_out") {
      // Deposit + advance → move-out bill → older bills oldest first, older
      // bills' late fees waived, remainder a pending refund; room_id cleared.
      // One transaction inside the function. p_older_bills is rebuilt here
      // from the engine at call time — the client sends only the tenant, the
      // forfeit choice and (optionally) the refund it was shown.
      // Same permission as the old settlement (`final_move_out`).
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: "Invalid tenantId.", code: "bad_request" }, { status: 400 });
      }
      if (typeof body?.forfeitDeposit !== "boolean") {
        return NextResponse.json(
          { error: "forfeitDeposit must be true or false.", code: "bad_request" },
          { status: 400 },
        );
      }
      const forfeitDeposit: boolean = body.forfeitDeposit;
      const expectedRefund =
        body?.expectedRefund == null ? null : Number(body.expectedRefund);
      if (expectedRefund != null && !Number.isFinite(expectedRefund)) {
        return NextResponse.json(
          { error: "expectedRefund must be a number when given.", code: "bad_request" },
          { status: 400 },
        );
      }
      try {
        const state = await buildSettlementState(auth.supabase, tenantId, forfeitDeposit);
        // The admin confirmed a preview; if the money has moved since (a
        // payment, a void, a re-prepared move-out bill), show the new figures
        // instead of settling on different ones than they saw.
        if (
          !state.alreadySettled &&
          expectedRefund != null &&
          Math.abs(roundTo2(expectedRefund) - state.plan.refund) > 0.005
        ) {
          return NextResponse.json(
            {
              error: "ยอดเงินเปลี่ยนไปหลังจากแสดงตัวอย่าง กรุณาตรวจสอบอีกครั้ง",
              code: "preview_changed",
              preview: settlementPreviewBody(state, forfeitDeposit),
            },
            { status: 409 },
          );
        }
        const { data, error } = await auth.supabase.rpc("settle_move_out", {
          p_tenant_id: tenantId,
          p_forfeit_deposit: forfeitDeposit,
          p_created_by: auth.user.id,
          p_older_bills: state.pOlderBills,
        });
        if (error) return rpcErrorResponse(error, MOVE_OUT_RPC_CLIENT_CODES);
        return NextResponse.json({
          success: true,
          result: (data as any)?.result ?? null,
          rpc: data,
          submittedOlderBills: state.pOlderBills,
        });
      } catch (err) {
        if (err instanceof MoneyRouteError) return moneyErrorResponse(err);
        throw err;
      }
    }

    if (action === "mark_refund_paid") {
      // Money OUT. Gated on BOTH invoice.payment.record (the money permission
      // record_payment/void_payment use) and tenant.edit (the move-out
      // permission): the refund is the tail of a settlement, which only
      // tenant.edit can run, and staff hold invoice.payment.record by default
      // but not tenant.edit — paying out deposit money is not a staff task.
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const authTenant = await requireAdminPermission(req, "tenant.edit");
      if ("error" in authTenant) return authTenant.error;

      const refundId = String(body?.refundId ?? "");
      const paidAt = String(body?.paidAt ?? "");
      const method = String(body?.method ?? "").trim();
      const paymentMethodId = body?.paymentMethodId ? String(body.paymentMethodId) : null;
      if (!UUID_RE.test(refundId)) {
        return NextResponse.json({ error: "Invalid refundId.", code: "bad_request" }, { status: 400 });
      }
      if (!paidAt || Number.isNaN(new Date(paidAt).getTime())) {
        return NextResponse.json(
          { error: "Missing or invalid paidAt.", code: "bad_request" },
          { status: 400 },
        );
      }
      if (!method) {
        return NextResponse.json({ error: "Missing method.", code: "bad_request" }, { status: 400 });
      }
      if (paymentMethodId != null && !UUID_RE.test(paymentMethodId)) {
        return NextResponse.json(
          { error: "Invalid paymentMethodId.", code: "bad_request" },
          { status: 400 },
        );
      }

      // The account the refund left from, frozen now from the payment_methods
      // row (never a client-supplied snapshot, never re-resolved later).
      // No account (e.g. cash): p_account stays null.
      let account: Record<string, unknown> | null = null;
      if (paymentMethodId) {
        const { data: methodRow, error: methodError } = await auth.supabase
          .from("payment_methods")
          .select("id,label,bank_name,account_name,account_number,qr_url")
          .eq("id", paymentMethodId)
          .maybeSingle();
        if (methodError) return NextResponse.json({ error: methodError.message }, { status: 500 });
        if (!methodRow) {
          return NextResponse.json(
            { error: "Payment method not found.", code: "not_found" },
            { status: 404 },
          );
        }
        account = snapshotFromPaymentMethodRow(methodRow as any).snapshot as Record<string, unknown>;
      }

      const { data, error } = await auth.supabase.rpc("mark_refund_paid", {
        p_refund_id: refundId,
        p_paid_at: new Date(paidAt).toISOString(),
        p_method: method,
        p_account: account,
      });
      if (error) return rpcErrorResponse(error, MOVE_OUT_RPC_CLIENT_CODES);
      return NextResponse.json({ success: true, result: (data as any)?.result ?? null, rpc: data });
    }

    if (action === "get_refunds") {
      // Read-only list of move-out refunds (pending + paid) for the Refunds
      // section on the move-outs page. The room comes from the move-out bill
      // the refund was created against: settle_move_out clears
      // tenants.room_id, so the tenant row no longer knows it.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("refunds")
        .select(
          "id,tenant_id,invoice_id,amount,status,paid_at,method,payment_method_snapshot,note,created_at," +
            "tenants(full_name),invoice:invoices(room_id,rooms(room_number,buildings(name)))",
        )
        .order("created_at", { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ refunds: data ?? [] });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
