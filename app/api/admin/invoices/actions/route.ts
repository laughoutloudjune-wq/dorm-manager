import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  resolvePaymentMethodForTenant,
  autoBillUnbilledLateFees,
  syncInvoiceLedger,
  getCarryForwardCandidatesForTarget,
  snapshotFromPaymentMethodRow,
  calculateLateFeeAmount,
  resolveFullyPaidAtDate,
  OPEN_INVOICE_STATUSES,
} from "@/lib/invoice-ledger";
import {
  isLateFeeBreakdownRow,
  isInvoiceDetailEditable,
  buildRuleBreakdown,
  isNonCashPaymentSource,
} from "@/lib/invoice-utils";
import { chargesFromInvoiceRow, computeInvoiceTotal } from "@/lib/invoice-total";
import { roundTo2, toLocalDateString, toNumber } from "@/lib/format";
import {
  getInvoiceBalance,
  type BalanceAllocation,
  type BalanceInvoice,
  type BalanceTenant,
  type BalanceWaiver,
  type ManualInvoiceStatus,
} from "@/lib/invoice-balance";
import { bangkokYmd } from "@/lib/move-out-notice";
import { generateInvoicesForPeriod } from "@/lib/invoice-generation";
import { syncPointsForTenant } from "@/lib/points-ledger";
import { notifyTenantPointsEarned } from "@/lib/points-notify";
import { declinePaymentSlip } from "@/lib/slip-review";
import { notifyTenantSlipDeclined } from "@/lib/slip-notify";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Award any newly-earned rewards points (on-time payment, streak bonus) after
 * a successful payment allocation, and push a LINE notification for whatever
 * was newly earned. Never lets a points-sync/notify failure fail the payment
 * response itself — the payment already succeeded.
 */
async function syncPointsAfterPayment(supabase: SupabaseClient, invoiceId: string) {
  try {
    const { data } = await supabase.from("invoices").select("tenant_id").eq("id", invoiceId).maybeSingle();
    const tenantId = (data as any)?.tenant_id;
    if (tenantId) {
      const result = await syncPointsForTenant(supabase, tenantId);
      await notifyTenantPointsEarned(supabase, tenantId, result.awardedEntries);
    }
  } catch (err) {
    console.error("[rewards] Failed to sync points after payment for invoice:", invoiceId, err);
  }
}

// ─── Money RPCs (record_payment / void_payment) ──────────────────────────────
//
// Recording and voiding money goes through the Postgres functions
// `record_payment` and `void_payment` (docs/audit/2026-09-29-late-fee-and-overdue-design.md
// B3): one transaction, tenant row locked, compare-and-swap on the facts each
// split line's balance was computed from. This route only (a) computes each
// bill's amount due with the pure engine (lib/invoice-balance.ts, B2), (b)
// freezes the receiving account, and (c) hands both to the function. It never
// writes a money column itself.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column `getInvoiceBalance` needs for either fee model, plus the owner. */
const BALANCE_INVOICE_COLUMNS =
  "id,tenant_id,status,fee_model,kind,total_amount,carry_forward_amount,paid_amount,due_date," +
  "late_fee_start_date,late_fee_per_day,late_fee_paused_from,locked_late_fee_amount,late_fee_billed_at";

/** The shape the client already reads back (`updatedInvoices`) after a payment. */
const UPDATED_INVOICE_COLUMNS =
  "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount";

/**
 * Codes raised as `[code] message` by the money functions that mean "the
 * request, or the data it was based on, is wrong" rather than a server fault.
 */
const RPC_CLIENT_ERROR_CODES = new Set([
  "bad_request",
  "stale_balance",
  "over_allocation",
  "split_mismatch",
  "amount_due_implausible",
  "not_payable",
  "idempotency_key_conflict",
  "idempotency_key_voided",
  "settlement_batch",
]);

/** A request error the money actions report with a specific HTTP status. */
class MoneyRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

const moneyErrorResponse = (err: MoneyRouteError) =>
  NextResponse.json({ error: err.message, code: err.code }, { status: err.status });

/** Map a `raise exception '[code] message'` from an RPC to an HTTP response. */
function rpcErrorResponse(error: { message?: string | null } | null) {
  const raw = String(error?.message ?? "Database error.");
  const match = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(raw);
  const code = match ? match[1] : null;
  const message = match && match[2] ? match[2] : raw;
  const status =
    code === "not_found" ? 404 : code && RPC_CLIENT_ERROR_CODES.has(code) ? 400 : 500;
  return NextResponse.json({ error: message, code }, { status });
}

const MANUAL_STATUSES: ReadonlySet<string> = new Set(["draft", "cancelled", "closed_unpaid"]);

/** A live `invoices` row (BALANCE_INVOICE_COLUMNS) + its tenant → the engine's input. */
function toBalanceInvoice(row: any, tenant: BalanceTenant): BalanceInvoice {
  const status = String(row.status ?? "");
  const common = {
    id: String(row.id),
    manual_status: MANUAL_STATUSES.has(status) ? (status as ManualInvoiceStatus) : null,
    is_verifying: status === "verifying",
    tenant,
  };
  const nullableNumber = (value: unknown) => (value == null ? null : toNumber(value as any));
  if (row.fee_model === "v2") {
    if (row.kind !== "monthly" && row.kind !== "move_out") {
      throw new MoneyRouteError(500, `Invoice ${row.id} has an unknown kind: ${row.kind}`);
    }
    return {
      ...common,
      fee_model: "v2",
      kind: row.kind,
      total_amount: toNumber(row.total_amount),
      due_date: String(row.due_date),
      late_fee_start_date: row.late_fee_start_date ?? null,
      late_fee_per_day: nullableNumber(row.late_fee_per_day),
      late_fee_paused_from: row.late_fee_paused_from ?? null,
    };
  }
  if (row.fee_model === "legacy") {
    return {
      ...common,
      fee_model: "legacy",
      total_amount: nullableNumber(row.total_amount),
      carry_forward_amount: nullableNumber(row.carry_forward_amount),
      due_date: row.due_date ?? null,
      locked_late_fee_amount: nullableNumber(row.locked_late_fee_amount),
      late_fee_billed_at: row.late_fee_billed_at ?? null,
    };
  }
  throw new MoneyRouteError(500, `Invoice ${row.id} has an unknown fee_model: ${row.fee_model}`);
}

type SplitRequestLine = { invoiceId: string; amount: number };

/** One `p_split` element, exactly as `record_payment` reads it. */
type RpcSplitLine = {
  invoice_id: string;
  amount: number;
  expected_amount_due: number;
  expected_paid_sum: number;
  expected_waived_sum: number;
};

/**
 * Build `p_split` for `record_payment`: each line's amount as the admin
 * entered it, plus the engine's amount due for that bill as of the transfer
 * date and the two compare-and-swap stamps (Σ non-voided allocations, Σ
 * non-voided waivers) that figure was computed from.
 *
 * Validates only the request's SHAPE. Whether an amount fits is the database
 * function's decision (`[over_allocation]`), and it must stay that way: a
 * retried request replays its original result inside the function before any
 * balance check, so rejecting "nothing owed" here would break the retry.
 */
async function buildRecordPaymentSplit(
  supabase: SupabaseClient,
  tenantId: string,
  lines: SplitRequestLine[],
  paidAtIso: string,
): Promise<RpcSplitLine[]> {
  const ids = lines.map((line) => line.invoiceId);

  const { data: invoiceRows, error: invoiceError } = await supabase
    .from("invoices")
    .select(BALANCE_INVOICE_COLUMNS)
    .in("id", ids);
  if (invoiceError) throw new MoneyRouteError(500, invoiceError.message);
  const invoiceById = new Map(((invoiceRows ?? []) as any[]).map((row) => [String(row.id), row]));
  for (const id of ids) {
    const row = invoiceById.get(id);
    if (!row) throw new MoneyRouteError(404, `Invoice ${id} not found.`, "not_found");
    if (String(row.tenant_id) !== tenantId) {
      throw new MoneyRouteError(
        400,
        "ใบแจ้งหนี้ที่เลือกต้องเป็นของผู้เช่าคนเดียวกันทั้งหมด",
        "bad_request",
      );
    }
  }

  const { data: tenantRow, error: tenantError } = await supabase
    .from("tenants")
    .select("id,status,handover_date,tenancy_end_date")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw new MoneyRouteError(500, tenantError.message);
  if (!tenantRow) throw new MoneyRouteError(404, `Tenant ${tenantId} not found.`, "not_found");
  const tenant: BalanceTenant = {
    status: (tenantRow as any).status ?? null,
    handover_date: (tenantRow as any).handover_date ?? null,
    tenancy_end_date: (tenantRow as any).tenancy_end_date ?? null,
  };

  // Allocations carry their batch's paid_at / voided_at — the same join
  // `_dm_paid_sum` uses, so the stamps below match what the function re-reads.
  const { data: allocRows, error: allocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount,payment_batch_id")
    .in("invoice_id", ids);
  if (allocError) throw new MoneyRouteError(500, allocError.message);
  const batchIds = [
    ...new Set(((allocRows ?? []) as any[]).map((row) => String(row.payment_batch_id))),
  ];
  const batchById = new Map<string, { paid_at: string; voided_at: string | null }>();
  if (batchIds.length > 0) {
    const { data: batchRows, error: batchError } = await supabase
      .from("payment_batches")
      .select("id,paid_at,voided_at")
      .in("id", batchIds);
    if (batchError) throw new MoneyRouteError(500, batchError.message);
    for (const row of (batchRows ?? []) as any[]) {
      batchById.set(String(row.id), {
        paid_at: String(row.paid_at),
        voided_at: row.voided_at ?? null,
      });
    }
  }
  const allocationsById = new Map<string, BalanceAllocation[]>(ids.map((id) => [id, []]));
  for (const row of (allocRows ?? []) as any[]) {
    const batch = batchById.get(String(row.payment_batch_id));
    if (!batch) continue; // `_dm_paid_sum` inner-joins the batch; so do we.
    allocationsById.get(String(row.invoice_id))?.push({
      invoice_id: String(row.invoice_id),
      amount: toNumber(row.amount),
      paid_at: batch.paid_at,
      voided_at: batch.voided_at,
    });
  }

  const { data: waiverRows, error: waiverError } = await supabase
    .from("late_fee_waivers")
    .select("invoice_id,amount,voided_at")
    .in("invoice_id", ids);
  if (waiverError) throw new MoneyRouteError(500, waiverError.message);
  const waiversById = new Map<string, BalanceWaiver[]>(ids.map((id) => [id, []]));
  for (const row of (waiverRows ?? []) as any[]) {
    waiversById.get(String(row.invoice_id))?.push({
      invoice_id: String(row.invoice_id),
      amount: toNumber(row.amount),
      voided_at: row.voided_at ?? null,
    });
  }

  // B3: a line may not exceed the bill's amount due AS OF THE TRANSFER DATE
  // (Bangkok), the same day `record_payment` derives from p_paid_at.
  const asOf = bangkokYmd(new Date(paidAtIso));

  return lines.map((line) => {
    const row = invoiceById.get(line.invoiceId);
    const invoice = toBalanceInvoice(row, tenant);
    const allocations = allocationsById.get(line.invoiceId) ?? [];
    const waivers = waiversById.get(line.invoiceId) ?? [];

    const atTransfer = getInvoiceBalance(invoice, allocations, waivers, asOf);

    // `getInvoiceBalance` ignores money transferred after `asOf`, which is
    // right for the fee but not for the cap: a backdated payment must not be
    // allowed to pay for charges a LATER-dated payment already covered. Count
    // those later payments as if they landed on `asOf` — the fee (which only
    // looks at when charges were covered, up to asOf) is unchanged, and the
    // money already received is subtracted in full. Identical to `atTransfer`
    // whenever nothing is dated after the transfer (the normal case).
    const countingLater = getInvoiceBalance(
      invoice,
      allocations.map((a) =>
        a.voided_at == null && bangkokYmd(new Date(a.paid_at)) > asOf
          ? { ...a, paid_at: asOf }
          : a,
      ),
      waivers,
      asOf,
    );
    let expectedAmountDue = Math.min(atTransfer.amountDue, countingLater.amountDue);

    // Legacy only: 22 legacy rows have `paid_amount` ≠ Σ allocations, mostly
    // money recorded before the allocation table existed (e.g. 109/2 Feb:
    // paid_amount 2,521, no allocations). The engine counts allocations only,
    // so it would call that bill fully unpaid and let the same money be
    // recorded twice. Never allow more than the stored running balance says
    // is left either. v2 rows keep paid_amount = Σ allocations, so this is a
    // no-op there and is skipped.
    if (invoice.fee_model === "legacy") {
      const storedOutstanding = Math.max(
        0,
        roundTo2(
          toNumber(row.total_amount) +
            countingLater.feeAccrued -
            countingLater.feeWaived -
            toNumber(row.paid_amount),
        ),
      );
      expectedAmountDue = Math.min(expectedAmountDue, storedOutstanding);
    }

    const paidSum = roundTo2(
      allocations
        .filter((a) => a.voided_at == null)
        .reduce((sum, a) => sum + toNumber(a.amount), 0),
    );
    const waivedSum = roundTo2(
      waivers
        .filter((w) => w.voided_at == null)
        .reduce((sum, w) => sum + Math.max(0, toNumber(w.amount)), 0),
    );

    return {
      invoice_id: line.invoiceId,
      amount: line.amount,
      expected_amount_due: roundTo2(expectedAmountDue),
      expected_paid_sum: paidSum,
      expected_waived_sum: waivedSum,
    };
  });
}

/**
 * Validate the shared payment fields, build p_split, freeze the receiving
 * account and call `record_payment`. Returns the function's jsonb result.
 */
async function callRecordPaymentRpc(
  supabase: SupabaseClient,
  params: {
    tenantId: string;
    lines: SplitRequestLine[];
    payment: any;
    createdBy: string;
  },
): Promise<{ data: any } | { response: NextResponse }> {
  const { tenantId, lines, payment, createdBy } = params;

  for (const line of lines) {
    if (!UUID_RE.test(line.invoiceId)) {
      throw new MoneyRouteError(400, `Invalid invoice id: ${line.invoiceId}`, "bad_request");
    }
    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      throw new MoneyRouteError(400, "จำนวนเงินต้องมากกว่า 0", "bad_request");
    }
  }

  const paidAtIso = String(payment?.paid_at ?? "");
  if (!paidAtIso || Number.isNaN(new Date(paidAtIso).getTime())) {
    throw new MoneyRouteError(400, "Missing or invalid payment date (paid_at).", "bad_request");
  }
  const source = String(payment?.source ?? "admin_webapp");
  const slipUrl = payment?.slip_url ? String(payment.slip_url) : null;
  const idempotencyKey = payment?.idempotency_key ? String(payment.idempotency_key) : null;

  const split = await buildRecordPaymentSplit(supabase, tenantId, lines, paidAtIso);

  // Frozen now, never re-resolved (CLAUDE.md). Non-cash credit has no account.
  const snapshot = isNonCashPaymentSource(source)
    ? null
    : (await resolvePaymentMethodForTenant(supabase, tenantId)).snapshot;

  const { data, error } = await supabase.rpc("record_payment", {
    p_tenant_id: tenantId,
    // Each line is validated to 2 decimals by the function; rounding the SUM
    // only removes float noise from adding them up here.
    p_amount_received: roundTo2(lines.reduce((sum, line) => sum + line.amount, 0)),
    p_paid_at: paidAtIso,
    p_slip_url: slipUrl,
    p_source: source,
    p_split: split,
    p_payment_method_snapshot: snapshot,
    p_idempotency_key: idempotencyKey,
    p_created_by: createdBy,
  });
  if (error) return { response: rpcErrorResponse(error) };
  return { data };
}

/**
 * Shape `record_payment`'s jsonb result into what `use-invoices-state.ts`
 * already reads: `paymentBatchId`, `idempotentReplay`, `allocationBreakdown`
 * and `updatedInvoices` (with `payment_history`, which the function's result
 * does not carry — re-read after commit, as the old ledger code did).
 */
async function paymentResponseFromRpc(supabase: SupabaseClient, rpc: any) {
  const states: any[] = Array.isArray(rpc?.invoices) ? rpc.invoices : [];
  const stateById = new Map(states.map((s) => [String(s.id), s]));
  const allocations: any[] = Array.isArray(rpc?.allocations) ? rpc.allocations : [];

  let updatedInvoices: any[] = states.map((s) => ({
    id: String(s.id),
    paid_amount: s.paid_amount,
    status: s.status,
    total_amount: s.total_amount,
  }));
  if (states.length > 0) {
    const { data: rows, error } = await supabase
      .from("invoices")
      .select(UPDATED_INVOICE_COLUMNS)
      .in(
        "id",
        states.map((s) => String(s.id)),
      );
    if (error) {
      // The money is already recorded; a failed re-read must not turn a
      // successful payment into an error the admin would retry.
      console.error("[record_payment] Recorded, but re-reading invoices failed:", error);
    } else {
      updatedInvoices = rows ?? [];
    }
  }

  return {
    success: true,
    result: rpc?.result ?? null,
    paymentBatchId: rpc?.batch_id ? String(rpc.batch_id) : null,
    idempotentReplay: rpc?.replay === true,
    appliedAmount: toNumber(rpc?.amount_allocated),
    paymentMethod: {
      id: rpc?.payment_method_id ? String(rpc.payment_method_id) : null,
      snapshot: rpc?.payment_method_snapshot ?? null,
    },
    updatedInvoices,
    allocationBreakdown: allocations.map((a) => {
      const state = stateById.get(String(a.invoice_id));
      return {
        invoiceId: String(a.invoice_id),
        allocatedAmount: toNumber(a.amount),
        newPaidAmount: toNumber(state?.paid_amount),
        newStatus: String(state?.status ?? ""),
      };
    }),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "update_status") {
      const auth = await requireAdminPermission(req, "invoice.status.update");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const status = String(body?.status ?? "");
      if (!invoiceId || !status) {
        return NextResponse.json({ error: "Missing invoiceId or status." }, { status: 400 });
      }

      // Changing status NEVER creates a payment — not even to "paid", and not
      // even when a slip is sitting there awaiting review. Status is a
      // bookkeeping label; money is recorded only through the Payments tab
      // (`record_payment`), where an admin enters a real amount, or by
      // confirming a tenant's slip in that same tab.
      //
      // This endpoint used to call applyInvoicePaymentAllocation with the
      // entire outstanding balance whenever someone picked "paid", inventing a
      // payment_batches row for money nobody had received and copying the
      // invoice's existing slip image onto it so it looked evidenced. That
      // produced ฿150,000+ of fake receipts before it was found. Every status
      // is now freely selectable and none of them move money.

      // Needed to detect a PAID -> not-paid transition below, so rewards
      // points earned for this invoice get revoked, not just awarded.
      const { data: beforeRow } = await auth.supabase
        .from("invoices")
        .select("status,tenant_id")
        .eq("id", invoiceId)
        .maybeSingle();
      const wasPaid = String((beforeRow as any)?.status ?? "") === "paid";

      const updatePayload: Record<string, unknown> = { status };

      if (status === "paid") {
        // Re-freeze the late fee if it is currently unfrozen. Flipping an
        // invoice away from paid clears `locked_late_fee_amount`, which puts
        // the fee back on a live ฿/day calculation; leaving it unfrozen would
        // let an old invoice's fee keep growing from its original due date.
        // `syncInvoiceLedger` normally freezes it on the transition to paid,
        // but it skips invoices already marked paid, so it cannot recover this
        // afterwards. Freezing a fee is bookkeeping, not a payment.
        const { data: feeRow } = await auth.supabase
          .from("invoices")
          .select(
            "locked_late_fee_amount,late_fee_start_date,late_fee_per_day,waived_late_fee_amount,payment_history,slip_uploaded_at",
          )
          .eq("id", invoiceId)
          .maybeSingle();
        if (feeRow && (feeRow as any).locked_late_fee_amount == null) {
          updatePayload.locked_late_fee_amount = calculateLateFeeAmount(
            feeRow as any,
            resolveFullyPaidAtDate(
              feeRow as any,
              new Date().toISOString().slice(0, 10),
            ),
          );
        }
      } else if (!["verifying", "cancelled"].includes(status)) {
        // Leaving paid must clear the freeze, same as `save_details` below —
        // otherwise a fee frozen (even at 0) by an earlier accidental "paid"
        // flip stays stuck forever: `applyInvoicePaymentAllocation` and this
        // same "paid" branch both treat any non-null value as "already
        // frozen, don't touch," so a later real payment's actual date never
        // gets a chance to recompute it.
        updatePayload.locked_late_fee_amount = null;
      }

      const { error } = await auth.supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // A freshly-frozen, still-unbilled late fee should land on the
      // tenant's next invoice right away, not wait for someone to notice it
      // in a checklist. No-ops when this invoice wasn't actually the "paid"
      // branch above, or had nothing new to bill.
      if (status === "paid") {
        const tenantId = String((beforeRow as any)?.tenant_id ?? "");
        if (tenantId) {
          await autoBillUnbilledLateFees(auth.supabase, tenantId, [invoiceId]);
        }
      }

      // Rewards points are derived entirely from invoice status
      // (syncPointsForTenant reads status='paid' to award on-time/streak
      // points, and revokes anything no longer justified). Re-sync on BOTH
      // directions: becoming paid awards; LEAVING paid must revoke, or a
      // tenant keeps points for a bill the system no longer calls settled.
      // Room 119/2's July invoice sat as `draft` while still holding 32
      // "on-time rent" points from when it was briefly marked paid, because
      // this used to only fire on the -> paid direction.
      if (status === "paid" || wasPaid) {
        await syncPointsAfterPayment(auth.supabase, invoiceId);
      }

      return NextResponse.json({ success: true });
    }

    if (action === "save_details") {
      const authEdit = await requireAdminPermission(req, "invoice.edit");
      if ("error" in authEdit) return authEdit.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const payload = body?.payload ?? {};
      if (!invoiceId || !payload || typeof payload !== "object") {
        return NextResponse.json({ error: "Invalid save payload." }, { status: 400 });
      }
      let wasPaidBeforeSave = false;
      if ("status" in payload) {
        const authStatus = await requireAdminPermission(req, "invoice.status.update");
        if ("error" in authStatus) return authStatus.error;
        if (!["paid", "verifying", "cancelled"].includes(String(payload.status))) {
          payload.locked_late_fee_amount = null;
        }
        const { data: beforeRow } = await authEdit.supabase
          .from("invoices")
          .select("status")
          .eq("id", invoiceId)
          .maybeSingle();
        wasPaidBeforeSave = String((beforeRow as any)?.status ?? "") === "paid";
      }
      const { error } = await authEdit.supabase.from("invoices").update(payload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Same rewards-revocation gap as update_status: this form can also move
      // status away from "paid" (or into it), and points must follow.
      if (
        "status" in payload &&
        (String(payload.status) === "paid" || wasPaidBeforeSave)
      ) {
        await syncPointsAfterPayment(authEdit.supabase, invoiceId);
      }
      if ("additional_fees_breakdown" in payload) {
        const rows = Array.isArray((payload as any).additional_fees_breakdown)
          ? ((payload as any).additional_fees_breakdown as any[])
          : [];
        const carryRows = rows.filter(
          (row) => String(row?.item_type ?? row?.type ?? "").toLowerCase() === "carry_forward"
        );
        const { error: deleteCarryError } = await authEdit.supabase
          .from("invoice_carry_forwards")
          .delete()
          .eq("target_invoice_id", invoiceId);
        if (deleteCarryError) {
          return NextResponse.json({ error: deleteCarryError.message }, { status: 500 });
        }
        const carryMap = new Map<string, number>();
        for (const row of carryRows) {
          const sourceInvoiceId = row?.source_invoice_id ? String(row.source_invoice_id) : "";
          if (!sourceInvoiceId) continue;
          carryMap.set(
            sourceInvoiceId,
            (carryMap.get(sourceInvoiceId) ?? 0) + Number(row?.total_amount ?? row?.amount ?? 0)
          );
        }
        const insertRows = [...carryMap.entries()].map(([source_invoice_id, amount]) => ({
          source_invoice_id,
          target_invoice_id: invoiceId,
          amount,
        }));
        if (insertRows.length > 0) {
          const { error: insertCarryError } = await authEdit.supabase
            .from("invoice_carry_forwards")
            .upsert(insertRows, { onConflict: "source_invoice_id,target_invoice_id" });
          if (insertCarryError) {
            return NextResponse.json({ error: insertCarryError.message }, { status: 500 });
          }
        }

        // Every source invoice whose late fee just became a real line item on
        // THIS invoice is now billed — mark it so a later invoice generation
        // (or another recalculate) can never pick the same fee up again. This
        // is what actually gets a late fee billed for a tenant who paid a bit
        // late and settled their invoice before the next monthly cycle ever
        // looked at it: recalculating here (after the payment) is what first
        // makes the now-eligible paid invoice show up as a candidate at all.
        const lateFeeSourceIds = [
          ...new Set(
            rows
              .filter(
                (row) =>
                  isLateFeeBreakdownRow(row) &&
                  Number(row?.total_amount ?? row?.amount ?? 0) > 0 &&
                  row?.source_invoice_id
              )
              .map((row) => String(row.source_invoice_id))
          ),
        ];
        if (lateFeeSourceIds.length > 0) {
          const { error: markBilledError } = await authEdit.supabase
            .from("invoices")
            .update({ late_fee_billed_at: new Date().toISOString() })
            .in("id", lateFeeSourceIds)
            .is("late_fee_billed_at", null);
          if (markBilledError) {
            return NextResponse.json({ error: markBilledError.message }, { status: 500 });
          }
        }
      }

      // NOT re-deriving allocations here yet. `reallocatePaymentsForInvoice`
      // treats each invoice's `total_amount` as its capacity, but a
      // carry-forward target's total already BUNDLES its source's debt (206/1
      // March: total 11,753 = own charge 7,942 + 3,811 carried from February).
      // Replaying against the bundled figure counts the source payment twice.
      // Enabling this needs the capacity model switched to each invoice's own
      // charge — and `paid_amount` is not consistent about which of the two it
      // means across existing rows, so that has to be settled first.
      return NextResponse.json({ success: true });
    }

    if (action === "record_payment") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const payload = body?.payload ?? {};
      const payment = body?.payment ?? null;
      if (!invoiceId || ((!payload || typeof payload !== "object") && !payment)) {
        return NextResponse.json({ error: "Invalid payment payload." }, { status: 400 });
      }
      if (payment && typeof payment === "object") {
        // One bill, one split line, recorded by the `record_payment` database
        // function (B3). The money goes to THIS bill only, capped at what the
        // engine says it owes on the transfer date — no carry-forward chain,
        // no server-side oldest-first split. To spread one transfer over
        // several bills, use record_split_payment. `payment.mode` is ignored:
        // the function derives full/partial from the amounts.
        try {
          if (!UUID_RE.test(invoiceId)) {
            throw new MoneyRouteError(400, "Invalid invoiceId.", "bad_request");
          }
          const { data: owner, error: ownerError } = await auth.supabase
            .from("invoices")
            .select("tenant_id")
            .eq("id", invoiceId)
            .maybeSingle();
          if (ownerError) throw new MoneyRouteError(500, ownerError.message);
          if (!owner) throw new MoneyRouteError(404, "Invoice not found.", "not_found");

          const outcome = await callRecordPaymentRpc(auth.supabase, {
            tenantId: String((owner as any).tenant_id),
            lines: [{ invoiceId, amount: Number((payment as any).amount) }],
            payment,
            createdBy: auth.user.id,
          });
          if ("response" in outcome) return outcome.response;

          const responseBody = await paymentResponseFromRpc(auth.supabase, outcome.data);
          await syncPointsAfterPayment(auth.supabase, invoiceId);
          return NextResponse.json(responseBody);
        } catch (err) {
          if (err instanceof MoneyRouteError) return moneyErrorResponse(err);
          throw err;
        }
      }
      const { error } = await auth.supabase.from("invoices").update(payload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "record_split_payment") {
      // Same money-recording path as record_payment, except one transfer is
      // split across several of the tenant's bills, with the admin choosing
      // exactly how much goes to each. Built for a tenant catching up on
      // real arrears in a lump sum or installments.
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const payment = body?.payment ?? null;
      const allocations = Array.isArray(body?.allocations) ? body.allocations : [];
      if (!tenantId || !payment || typeof payment !== "object" || allocations.length === 0) {
        return NextResponse.json({ error: "Invalid split payment payload." }, { status: 400 });
      }
      // One transfer, one `record_payment` call, one split line per bill with
      // that bill's own freshly computed amount due (B3). The admin's split is
      // final: the function refuses a split that doesn't add up, a line over
      // a bill's amount due, or a bill that changed since it was read.
      if (!UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: "Invalid tenantId.", code: "bad_request" }, { status: 400 });
      }
      try {
        const outcome = await callRecordPaymentRpc(auth.supabase, {
          tenantId,
          lines: allocations.map((row: any) => ({
            invoiceId: String(row?.invoiceId ?? ""),
            amount: Number(row?.amount),
          })),
          payment,
          createdBy: auth.user.id,
        });
        if ("response" in outcome) return outcome.response;

        const responseBody = await paymentResponseFromRpc(auth.supabase, outcome.data);
        const triggerInvoiceId = responseBody.allocationBreakdown[0]?.invoiceId;
        if (triggerInvoiceId) {
          await syncPointsAfterPayment(auth.supabase, triggerInvoiceId);
        }
        return NextResponse.json(responseBody);
      } catch (err) {
        if (err instanceof MoneyRouteError) return moneyErrorResponse(err);
        throw err;
      }
    }

    if (action === "delete_payment_batch") {
      // "Delete" on a payment in the invoice's Payments tab. Nothing is
      // deleted any more: the `void_payment` database function (B3) stamps
      // the batch voided (with who and why), strips its payment_history
      // display entries, and refreshes paid_amount/status on every bill the
      // batch was split across — in one transaction. The batch and its
      // allocation rows stay as the record; everything that counts money
      // must skip `payment_batches.voided_at IS NOT NULL`.
      //
      // Same permission as recording a payment: voiding a bad record needs
      // the same authority as creating a good one. A reason is required.
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const paymentBatchId = String(body?.paymentBatchId ?? "");
      const reason = String(body?.reason ?? "").trim();
      if (!paymentBatchId || !UUID_RE.test(paymentBatchId)) {
        return NextResponse.json(
          { error: "Missing or invalid paymentBatchId.", code: "bad_request" },
          { status: 400 },
        );
      }
      if (!reason) {
        return NextResponse.json(
          { error: "กรุณาระบุเหตุผลในการยกเลิกรายการชำระเงิน", code: "bad_request" },
          { status: 400 },
        );
      }

      const { data: rpc, error: voidError } = await auth.supabase.rpc("void_payment", {
        p_batch_id: paymentBatchId,
        p_reason: reason,
        p_voided_by: auth.user.id,
      });
      if (voidError) return rpcErrorResponse(voidError);

      // `invoices` in the result is the post-void state of every bill the
      // batch touched. `allocation_paid_sum` already excludes voided batches,
      // so this is the same "paid_amount no longer matches the remaining
      // allocations" warning the client has always shown — for legacy bills
      // whose paid_amount was never Σ allocations to begin with.
      const states: any[] = Array.isArray((rpc as any)?.invoices) ? (rpc as any).invoices : [];
      const touchedInvoiceIds = states.map((s) => String(s.id));
      const mismatches = states
        .map((s) => ({
          invoiceId: String(s.id),
          paidAmount: toNumber(s.paid_amount),
          allocationSum: toNumber(s.allocation_paid_sum),
        }))
        .filter((m) => Math.abs(m.paidAmount - m.allocationSum) > 0.005);

      const result = String((rpc as any)?.result ?? "");
      // A void can take a bill out of "paid"; rewards points follow status in
      // both directions (see update_status), so re-sync. Per tenant, so one
      // touched invoice is enough.
      if (result === "voided" && touchedInvoiceIds[0]) {
        await syncPointsAfterPayment(auth.supabase, touchedInvoiceIds[0]);
      }

      return NextResponse.json({
        success: true,
        result,
        alreadyVoided: result === "already_voided",
        paymentBatchId,
        touchedInvoiceIds,
        mismatches,
      });
    }

    if (action === "decline_slip") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const reason = String(body?.reason ?? "");
      if (!invoiceId) {
        return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      }
      try {
        const result = await declinePaymentSlip(auth.supabase, {
          invoiceId,
          reason,
          reviewedBy: auth.user.id,
        });
        await notifyTenantSlipDeclined(auth.supabase, {
          tenantId: result.tenantId,
          invoiceId,
          reason: result.reason,
        });
        return NextResponse.json({ success: true, ...result });
      } catch (err: any) {
        return NextResponse.json(
          { error: err?.message ?? "Failed to decline the payment slip." },
          { status: 400 },
        );
      }
    }

    if (action === "sync_period_statuses") {
      // Same two transitions the invoice list used to write directly from the
      // browser with the anon key (docs/audit/2026-09-29-system-audit-detailed.md
      // finding C1, sites use-invoices-state.ts:292/309). Gated on
      // "tenant.view" — the lowest permission every role has by default —
      // because this ran unconditionally for every viewer who opened the
      // list; a narrower gate here would silently stop viewers from ever
      // seeing these transitions, which is a regression, not a relocation.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const periodStart = String(body?.periodStart ?? "");
      const periodEnd = String(body?.periodEnd ?? "");
      if (!periodStart || !periodEnd) {
        return NextResponse.json({ error: "Missing periodStart or periodEnd." }, { status: 400 });
      }
      // Same toLocalDateString(new Date()) call this replaces used in the
      // browser, where it read the admin's own clock. Here it reads the
      // server's — the same not-yet-fixed UTC-vs-Bangkok gap CLAUDE.md
      // documents in ~38 other places already (finding M10), not introduced
      // by this move.
      const today = toLocalDateString(new Date());

      const { error: overdueError } = await auth.supabase
        .from("invoices")
        .update({ status: "overdue" })
        .eq("status", "pending")
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .is("slip_url", null)
        .lt("due_date", today);
      if (overdueError) return NextResponse.json({ error: overdueError.message }, { status: 500 });

      const { error: verifyingError } = await auth.supabase
        .from("invoices")
        .update({ status: "verifying" })
        .in("status", ["pending", "overdue"])
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .eq("paid_amount", 0)
        .not("slip_url", "is", null);
      if (verifyingError) return NextResponse.json({ error: verifyingError.message }, { status: 500 });

      return NextResponse.json({ success: true });
    }

    if (action === "sync_period_discounts") {
      // Recalculates each invoice's discount/total against the current
      // discount rules — moved server-side from
      // lib/hooks/use-invoices-state.ts's syncMonthInvoicesWithSettings
      // (finding C1, site use-invoices-state.ts:430). Same "tenant.view"
      // gate as sync_period_statuses, same reason: ran for every viewer
      // unconditionally before.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const year = Number(body?.year);
      const month = Number(body?.month);
      if (!year || !month) {
        return NextResponse.json({ error: "Missing year or month." }, { status: 400 });
      }

      const periodStart = toLocalDateString(new Date(year, month - 1, 1));
      const periodEnd = toLocalDateString(new Date(year, month, 0));
      const monthKey = toLocalDateString(new Date(year, month - 1, 1));

      const { data: settingsRow } = await auth.supabase
        .from("settings")
        .select("additional_discounts")
        .eq("id", 1)
        .maybeSingle();
      const discountRules = Array.isArray((settingsRow as any)?.additional_discounts)
        ? ((settingsRow as any).additional_discounts as any[])
        : [];

      const { data: invoicesInMonth, error: invoiceError } = await auth.supabase
        .from("invoices")
        .select(
          "id,room_id,status,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,carry_forward_amount,additional_fees_total,additional_fees_breakdown,discount_amount,discount_breakdown,total_amount"
        )
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd);

      if (invoiceError) return NextResponse.json({ error: invoiceError.message }, { status: 500 });
      if (!invoicesInMonth || invoicesInMonth.length === 0) {
        return NextResponse.json({ success: true, updated: 0 });
      }

      const roomIds = [...new Set(invoicesInMonth.map((row: any) => row.room_id).filter(Boolean))];
      const { data: readings } = await auth.supabase
        .from("meter_readings")
        .select("room_id,electricity_usage,water_usage,usage")
        .eq("reading_month", monthKey)
        .in("room_id", roomIds.length > 0 ? roomIds : ["00000000-0000-0000-0000-000000000000"]);
      const readingMap = new Map((readings ?? []).map((row: any) => [row.room_id, row]));

      const updates = (invoicesInMonth as any[])
        .map((invoice) => {
          if (!isInvoiceDetailEditable(String(invoice.status ?? ""))) return null;
          const reading = readingMap.get(invoice.room_id) ?? {};
          const elecUnits = toNumber(reading.electricity_usage);
          const waterUnits = toNumber(reading.water_usage ?? reading.usage);
          const freshRuleItems = buildRuleBreakdown(discountRules, elecUnits, waterUnits);
          const existingBreakdown = Array.isArray(invoice.discount_breakdown)
            ? (invoice.discount_breakdown as any[])
            : [];
          const preservedItems = existingBreakdown.filter((item: any) => item?.source !== "rule");
          const discountBreakdown = [...freshRuleItems, ...preservedItems];
          const discountAmount = discountBreakdown.reduce(
            (sum, fee: any) => sum + toNumber(fee.amount ?? fee.total_amount),
            0
          );
          const totalAmount = computeInvoiceTotal({
            ...chargesFromInvoiceRow(invoice as any),
            discount: discountAmount,
          });

          const currentDiscount = toNumber(invoice.discount_amount);
          const currentTotal = toNumber(invoice.total_amount);
          if (
            Math.abs(currentDiscount - discountAmount) < 0.0001 &&
            Math.abs(currentTotal - totalAmount) < 0.0001
          ) {
            return null;
          }

          return {
            id: invoice.id as string,
            discount_amount: discountAmount,
            discount_breakdown: discountBreakdown,
            total_amount: totalAmount,
          };
        })
        .filter(Boolean) as { id: string; discount_amount: number; discount_breakdown: any[]; total_amount: number }[];

      for (const update of updates) {
        const { error: updateError } = await auth.supabase
          .from("invoices")
          .update({
            discount_amount: update.discount_amount,
            discount_breakdown: update.discount_breakdown,
            total_amount: update.total_amount,
          })
          .eq("id", update.id);
        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, updated: updates.length });
    }

    if (action === "get_assignable_payment_methods") {
      // Powers InvoiceDetailModal.tsx's "attach an account to an old
      // payment" picker, which used to read payment_methods directly from
      // the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("payment_methods")
        .select("id,label,bank_name,account_name,account_number")
        .order("label", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ methods: data ?? [] });
    }

    if (action === "get_payment_chains") {
      // Powers InvoiceDetailModal.tsx's Payments tab, which used to read
      // invoice_payment_allocations and payment_batches directly from the
      // browser with the anon key (finding C1). The FK hint is required —
      // invoice_payment_allocations has two foreign keys to invoices
      // (invoice_id and trigger_invoice_id), so a bare embed is ambiguous.
      // Returns the same raw shape the client used to fetch directly; the
      // grouping-into-chains logic stays client-side, unchanged.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });

      const { data: mine, error: mineError } = await auth.supabase
        .from("invoice_payment_allocations")
        .select("payment_batch_id")
        .eq("invoice_id", invoiceId);
      if (mineError) return NextResponse.json({ error: mineError.message }, { status: 500 });

      const batchIds = [...new Set((mine ?? []).map((row: any) => String(row.payment_batch_id ?? "")).filter(Boolean))];
      if (batchIds.length === 0) {
        return NextResponse.json({ allocations: [], batches: [] });
      }

      const [allocationsRes, batchesRes] = await Promise.all([
        auth.supabase
          .from("invoice_payment_allocations")
          .select(
            "id,payment_batch_id,invoice_id,amount,paid_at,slip_url,payment_method_snapshot," +
              "invoice:invoices!invoice_payment_allocations_invoice_id_fkey(id,start_date,rooms(room_number))"
          )
          .in("payment_batch_id", batchIds),
        auth.supabase
          .from("payment_batches")
          .select("id,amount_received,paid_at,slip_url,source,trigger_invoice_id,payment_method_snapshot,voided_at")
          .in("id", batchIds),
      ]);
      if (allocationsRes.error) return NextResponse.json({ error: allocationsRes.error.message }, { status: 500 });
      if (batchesRes.error) return NextResponse.json({ error: batchesRes.error.message }, { status: 500 });

      // A voided payment (delete_payment_batch → void_payment) is no longer
      // money received; keep it off the Payments tab, as a deleted one was.
      const voidedBatchIds = new Set(
        ((batchesRes.data ?? []) as any[])
          .filter((row) => row.voided_at != null)
          .map((row) => String(row.id)),
      );
      return NextResponse.json({
        allocations: ((allocationsRes.data ?? []) as any[]).filter(
          (row) => !voidedBatchIds.has(String(row.payment_batch_id)),
        ),
        batches: ((batchesRes.data ?? []) as any[]).filter(
          (row) => !voidedBatchIds.has(String(row.id)),
        ),
      });
    }

    if (action === "get_overdue_invoices") {
      // Powers OverdueRoomsTab.tsx, which used to read every open invoice
      // directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select(
          "id,tenant_id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date,move_out_date,status),rooms(room_number,price_month,buildings(name))"
        )
        .in("status", ["pending", "partial", "overdue", "verifying"])
        .order("start_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_invoice_activity_snapshot") {
      // Powers useRealtimeInvoices (lib/hooks/use-realtime-invoices.ts,
      // mounted app-wide from AdminShell.tsx) — a lightweight snapshot
      // polled on an interval to detect "slip just uploaded" / "just
      // entered verifying" and pop a toast, replacing a Realtime
      // subscription that connected straight to the database with the
      // admin's own browser session (finding C1). Same status list as
      // get_overdue_invoices above — those are the only statuses either
      // transition is possible from.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("id,room_id,slip_url,status")
        .in("status", ["pending", "partial", "overdue", "verifying"]);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_carry_forward_candidates") {
      // Powers the "older unpaid bills" list shown when opening an invoice's
      // detail, and when recalculating its carry-forward lines. Moved
      // server-side because getCarryForwardCandidatesForTarget has a write
      // side effect (it calls syncInvoiceLedger internally) that used to run
      // against `invoices` with the browser's anon-key client (finding C1,
      // use-invoices-state.ts:1502/1980). Same "tenant.view" gate as the two
      // sync actions above, for the same reason.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const beforeStartDate = String(body?.beforeStartDate ?? "");
      const targetInvoiceId = body?.targetInvoiceId ? String(body.targetInvoiceId) : null;
      const valuationDate = body?.valuationDate ? String(body.valuationDate) : null;
      if (!tenantId || !beforeStartDate) {
        return NextResponse.json({ error: "Missing tenantId or beforeStartDate." }, { status: 400 });
      }
      try {
        const candidates = await getCarryForwardCandidatesForTarget(
          auth.supabase,
          tenantId,
          beforeStartDate,
          targetInvoiceId,
          valuationDate
        );
        return NextResponse.json({ candidates });
      } catch (error: any) {
        return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
      }
    }

    if (action === "get_latest_invoice_month") {
      // Powers use-invoices-state.ts's initial month selection, which used
      // to read directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("start_date")
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ startDate: (data as any)?.start_date ?? null });
    }

    if (action === "get_invoices_for_period") {
      // Powers loadInvoices in use-invoices-state.ts — the main invoice
      // list query, the "does this tenant have an earlier invoice" check
      // used for the "new tenant" badge, and the slip-recovery fallback
      // (list the storage folder when slip_url is empty) all used to run
      // directly from the browser with the anon key (finding C1). Every
      // query/filter is copied verbatim; the client's own normalize/sort/
      // badge logic is unchanged.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const periodStart = String(body?.periodStart ?? "");
      const periodEnd = String(body?.periodEnd ?? "");
      if (!periodStart || !periodEnd) {
        return NextResponse.json({ error: "Missing periodStart or periodEnd." }, { status: 400 });
      }

      const { data, error: fetchError } = await auth.supabase
        .from("invoices")
        .select(
          "id,tenant_id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,slip_rejections,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date,move_out_date,status),rooms(room_number,price_month,buildings(name))"
        )
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .order("issue_date", { ascending: false });
      if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });

      const invoices = data ?? [];
      const tenantIds = [...new Set(invoices.map((row: any) => String(row.tenant_id)))];
      const { data: allTenantInvoices, error: tenantInvoicesError } =
        tenantIds.length > 0
          ? await auth.supabase
              .from("invoices")
              .select("tenant_id,start_date")
              .in("tenant_id", tenantIds)
              .neq("status", "cancelled")
          : { data: [] as any[], error: null as any };
      if (tenantInvoicesError) {
        return NextResponse.json({ error: tenantInvoicesError.message }, { status: 500 });
      }

      const recoveredSlipUrlById: Record<string, string> = {};
      await Promise.all(
        invoices
          .filter((row: any) => !row.slip_url)
          .map(async (row: any) => {
            const { data: files } = await auth.supabase.storage
              .from("payment_slips")
              .list(String(row.id), { limit: 1, sortBy: { column: "name", order: "desc" } });
            if (!files || files.length === 0) return;
            const latest = files[0];
            const { data: publicData } = auth.supabase.storage
              .from("payment_slips")
              .getPublicUrl(`${row.id}/${latest.name}`);
            recoveredSlipUrlById[String(row.id)] = publicData.publicUrl;
          })
      );

      return NextResponse.json({
        invoices,
        tenantInvoicesForNewCheck: allTenantInvoices ?? [],
        recoveredSlipUrls: recoveredSlipUrlById,
      });
    }

    if (action === "get_print_config") {
      // Powers loadPrintConfig in use-invoices-state.ts, which used to read
      // settings and payment_methods directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const [settingsRes, paymentRes] = await Promise.all([
        auth.supabase
          .from("settings")
          .select(
            "dorm_name,dorm_address,water_rate,electricity_rate,water_min_units,water_min_price,billing_day,due_day,late_fee_start_day,additional_discounts"
          )
          .eq("id", 1)
          .maybeSingle(),
        auth.supabase
          .from("payment_methods")
          .select("label,bank_name,account_name,account_number,qr_url")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      if (settingsRes.error) return NextResponse.json({ error: settingsRes.error.message }, { status: 500 });
      if (paymentRes.error) return NextResponse.json({ error: paymentRes.error.message }, { status: 500 });
      return NextResponse.json({
        settings: settingsRes.data ?? null,
        defaultPaymentMethod: paymentRes.data ?? null,
      });
    }

    if (action === "get_move_out_warnings") {
      // Powers loadMoveOutWarnings in use-invoices-state.ts, which used to
      // read move_out_requests directly from the browser with the anon key
      // (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const monthStart = String(body?.monthStart ?? "");
      const monthEnd = String(body?.monthEnd ?? "");
      if (!monthStart || !monthEnd) {
        return NextResponse.json({ error: "Missing monthStart or monthEnd." }, { status: 400 });
      }
      const { data, error } = await auth.supabase
        .from("move_out_requests")
        .select("id,tenant_id,requested_move_out_date,status,tenants(full_name,rooms(room_number))")
        .in("status", ["requested", "approved"])
        .gte("requested_move_out_date", monthStart)
        .lte("requested_move_out_date", monthEnd)
        .order("requested_move_out_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ warnings: data ?? [] });
    }

    if (action === "get_pending_move_out_count") {
      // Powers the pending-move-out badge in use-invoices-state.ts, which
      // used to read move_out_requests and tenants directly from the
      // browser with the anon key (finding C1) — and, until now, kept
      // doing so live via a Supabase Realtime subscription; this is polled
      // instead now.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const [requestsRes, tenantsRes] = await Promise.all([
        auth.supabase.from("move_out_requests").select("tenant_id").eq("status", "requested"),
        auth.supabase.from("tenants").select("id").not("move_out_date", "is", null).eq("status", "active"),
      ]);
      if (requestsRes.error) return NextResponse.json({ error: requestsRes.error.message }, { status: 500 });
      if (tenantsRes.error) return NextResponse.json({ error: tenantsRes.error.message }, { status: 500 });
      const ids = new Set<string>();
      for (const row of requestsRes.data ?? []) {
        const id = String((row as any).tenant_id ?? "");
        if (id) ids.add(id);
      }
      for (const row of tenantsRes.data ?? []) {
        const id = String((row as any).id ?? "");
        if (id) ids.add(id);
      }
      return NextResponse.json({ count: ids.size });
    }

    if (action === "get_open_invoices_for_tenant") {
      // Powers openSplitPaymentModal in use-invoices-state.ts, which used
      // to read directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("id,start_date,total_amount,paid_amount,status")
        .eq("tenant_id", tenantId)
        .in("status", OPEN_INVOICE_STATUSES as unknown as string[])
        .order("start_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_invoice_snapshot") {
      // Powers submitSplitPayment's post-payment refresh of the active
      // invoice in use-invoices-state.ts, which used to read directly from
      // the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("invoices")
        .select(
          "id,paid_amount,status,total_amount,carry_forward_amount,additional_fees_total,additional_fees_breakdown,payment_history"
        )
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoice: data ?? null });
    }

    if (action === "get_invoice_reading_and_arrears") {
      // Powers both the invoice-detail modal's meter/arrears hydration and
      // getInvoicePrintDetail in use-invoices-state.ts — two identical
      // reads that used to run directly from the browser with the anon key
      // (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const roomId = String(body?.roomId ?? "");
      const readingMonth = String(body?.readingMonth ?? "");
      if (!invoiceId || !roomId || !readingMonth) {
        return NextResponse.json({ error: "Missing invoiceId, roomId, or readingMonth." }, { status: 400 });
      }
      const [readingRes, snapshotRes] = await Promise.all([
        auth.supabase
          .from("meter_readings")
          .select(
            "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
          )
          .eq("room_id", roomId)
          .eq("reading_month", readingMonth)
          .maybeSingle(),
        auth.supabase
          .from("invoice_arrears_snapshots")
          .select("id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate")
          .eq("target_invoice_id", invoiceId)
          .order("created_at", { ascending: true }),
      ]);
      if (readingRes.error) return NextResponse.json({ error: readingRes.error.message }, { status: 500 });
      if (snapshotRes.error) return NextResponse.json({ error: snapshotRes.error.message }, { status: 500 });
      return NextResponse.json({
        reading: readingRes.data ?? null,
        arrearsSnapshots: snapshotRes.data ?? [],
      });
    }

    if (action === "get_transfer_recalc_data") {
      // Powers recalculateTransferBreakdown in use-invoices-state.ts, which
      // used to run 3 sequential reads directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      const billingMonth = String(body?.billingMonth ?? "");
      const transferDate = String(body?.transferDate ?? "");
      if (!roomId || !billingMonth || !transferDate) {
        return NextResponse.json(
          { error: "Missing roomId, billingMonth, or transferDate." },
          { status: 400 }
        );
      }
      const { data: transferRows, error: transferError } = await auth.supabase
        .from("tenant_room_transfers")
        .select(
          "from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,new_prev_electricity,new_prev_water"
        )
        .eq("to_room_id", roomId)
        .eq("billing_month", billingMonth)
        .eq("transfer_date", transferDate)
        .order("transfer_date", { ascending: false })
        .limit(1);
      if (transferError) return NextResponse.json({ error: transferError.message }, { status: 500 });

      const transferRow = (transferRows ?? [])[0] ?? null;
      if (!transferRow) {
        return NextResponse.json({ transferRow: null, roomRows: [], reading: null });
      }

      const roomIds = [(transferRow as any).from_room_id, (transferRow as any).to_room_id];
      const [roomsRes, readingRes] = await Promise.all([
        auth.supabase.from("rooms").select("id,price_month").in("id", roomIds),
        auth.supabase
          .from("meter_readings")
          .select("current_electricity,current_water,electricity_usage,water_usage")
          .eq("room_id", roomId)
          .eq("billing_month", billingMonth)
          .limit(1),
      ]);
      if (roomsRes.error) return NextResponse.json({ error: roomsRes.error.message }, { status: 500 });

      return NextResponse.json({
        transferRow,
        roomRows: roomsRes.data ?? [],
        reading: (readingRes.data ?? [])[0] ?? null,
      });
    }

    if (action === "delete_payment_slip_files") {
      // Powers deletePaymentSlip in use-invoices-state.ts, which used to
      // list and remove storage objects directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      const { data: files, error: listError } = await auth.supabase.storage
        .from("payment_slips")
        .list(invoiceId, { limit: 1000 });
      if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
      const paths = (files ?? []).map((file) => `${invoiceId}/${file.name}`);
      if (paths.length > 0) {
        const { error: removeError } = await auth.supabase.storage.from("payment_slips").remove(paths);
        if (removeError) return NextResponse.json({ error: removeError.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, removedCount: paths.length });
    }

    if (action === "generate_invoices") {
      // The full implementation lives in lib/invoice-generation.ts,
      // specifically so it can also be called directly (service-role
      // client, dryRun: true) from a verification script without needing a
      // real admin session — see that file's own header comment. This is
      // the last remaining C1 item
      // (docs/audit/2026-09-29-system-audit-detailed.md): monthly invoice
      // generation had no server-side version at all before this.
      const auth = await requireAdminPermission(req, "invoice.create");
      if ("error" in auth) return auth.error;

      const year = Number(body?.year);
      const month = Number(body?.month);
      try {
        const result = await generateInvoicesForPeriod(auth.supabase, {
          year,
          month,
          dryRun: Boolean(body?.dryRun),
          dryRunIncludeExisting: Boolean(body?.dryRunIncludeExisting),
        });
        return NextResponse.json(result);
      } catch (error: any) {
        return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
      }
    }

    if (action === "sync_overdue") {
      const auth = await requireAdminPermission(req, "invoice.edit");
      if ("error" in auth) return auth.error;
      const invoiceIds = Array.isArray(body?.invoiceIds) ? (body.invoiceIds as string[]) : [];
      const tenantIds = Array.isArray(body?.tenantIds) ? (body.tenantIds as string[]) : [];
      const beforeStartDate = body?.beforeStartDate ? String(body.beforeStartDate) : undefined;
      const result = await syncInvoiceLedger(auth.supabase, { invoiceIds, tenantIds, beforeStartDate });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "delete_many") {
      const auth = await requireAdminPermission(req, "invoice.delete");
      if ("error" in auth) return auth.error;
      const invoiceIds = Array.isArray(body?.invoiceIds) ? (body.invoiceIds as string[]) : [];
      if (invoiceIds.length === 0) {
        return NextResponse.json({ error: "Missing invoiceIds." }, { status: 400 });
      }

      const { data: rows, error: checkError } = await auth.supabase
        .from("invoices")
        .select("id,status,slip_url")
        .in("id", invoiceIds);
      if (checkError) return NextResponse.json({ error: checkError.message }, { status: 500 });

      const blocked = (rows ?? []).filter((row: any) => {
        if (String(row.status) === "draft") return false;
        return !!row.slip_url || row.status === "verifying" || row.status === "paid";
      });
      if (blocked.length > 0) {
        return NextResponse.json(
          { error: "Cannot delete invoices with payment slip or paid/verifying status." },
          { status: 400 }
        );
      }

      const { error } = await auth.supabase.from("invoices").delete().in("id", invoiceIds);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    // Manually attach the real receiving account to a payment recorded before
    // payment_method_snapshot existed (or otherwise never resolved), when the
    // admin actually knows which account it went to — e.g. checking an old
    // bank statement. Same permission as recording the payment in the first
    // place: this is correcting an existing record, not creating a new one.
    // Applies to every allocation in the batch, since one transfer only ever
    // lands in one account regardless of how many invoices it settled.
    if (action === "assign_payment_batch_method") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const paymentBatchId = body?.paymentBatchId ? String(body.paymentBatchId) : null;
      // Alternative entry point for a payment recorded BEFORE payment_batches
      // existed: it has a payment_history entry but no batch/allocation row at
      // all, so there is nothing for the paymentBatchId path to update. Room
      // 210/1's March invoice is exactly this — paid via slip in March, before
      // the ledger tables were introduced, so it has no source and no way to
      // attach a receiving account.
      const invoiceId = body?.invoiceId ? String(body.invoiceId) : null;
      const methodId = String(body?.methodId ?? "");
      if ((!paymentBatchId && !invoiceId) || !methodId) {
        return NextResponse.json(
          { error: "Missing paymentBatchId (or invoiceId) or methodId." },
          { status: 400 },
        );
      }

      const { data: methodRow, error: methodError } = await auth.supabase
        .from("payment_methods")
        .select("id,label,bank_name,account_name,account_number,qr_url")
        .eq("id", methodId)
        .maybeSingle();
      if (methodError) return NextResponse.json({ error: methodError.message }, { status: 500 });
      if (!methodRow) {
        return NextResponse.json({ error: "Payment method not found." }, { status: 404 });
      }

      const resolved = snapshotFromPaymentMethodRow(methodRow as any);

      if (paymentBatchId) {
        const { error: batchError } = await auth.supabase
          .from("payment_batches")
          .update({
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
          })
          .eq("id", paymentBatchId);
        if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 });

        const { error: allocationError } = await auth.supabase
          .from("invoice_payment_allocations")
          .update({
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
          })
          .eq("payment_batch_id", paymentBatchId);
        if (allocationError) {
          return NextResponse.json({ error: allocationError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, paymentMethod: resolved });
      }

      // Backfill path: build a real payment_batches row (and one allocation)
      // for every payment_history entry that predates the ledger, then attach
      // the chosen account to each. This is the only place a batch is created
      // retroactively for money that was NEVER unaccounted for — the
      // invoice's own paid_amount already reflects it; only the batch/
      // allocation/source records were missing. Source defaults to
      // "admin_webapp" when the entry predates that field existing, since
      // every pre-ledger entry inspected so far was in fact recorded that way.
      const { data: invoiceRow, error: invoiceError } = await auth.supabase
        .from("invoices")
        .select("id,tenant_id,payment_history")
        .eq("id", invoiceId as string)
        .maybeSingle();
      if (invoiceError) return NextResponse.json({ error: invoiceError.message }, { status: 500 });
      if (!invoiceRow) {
        return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
      }

      const history = Array.isArray((invoiceRow as any).payment_history)
        ? [...(invoiceRow as any).payment_history]
        : [];
      const legacyIndexes = history
        .map((entry: any, index: number) => ({ entry, index }))
        .filter(({ entry }) => !entry?.payment_batch_id);

      if (legacyIndexes.length === 0) {
        return NextResponse.json(
          { error: "ไม่พบรายการชำระเงินที่ยังไม่มีบันทึกการโอนสำหรับใบแจ้งหนี้นี้" },
          { status: 404 },
        );
      }

      const newBatchIds: string[] = [];
      for (const { entry, index } of legacyIndexes) {
        const amount = Number(entry?.amount ?? 0);
        if (!(amount > 0)) continue;
        const paidAt = String(entry?.paid_at ?? entry?.created_at ?? new Date().toISOString());
        const source = entry?.source ? String(entry.source) : "admin_webapp";
        const slipUrl = entry?.slip_url ? String(entry.slip_url) : null;
        const newBatchId = crypto.randomUUID();

        const { error: insertBatchError } = await auth.supabase
          .from("payment_batches")
          .insert({
            id: newBatchId,
            tenant_id: (invoiceRow as any).tenant_id ?? null,
            trigger_invoice_id: invoiceId,
            amount_received: amount,
            amount_allocated: amount,
            paid_at: paidAt,
            mode: entry?.mode ?? "full",
            source,
            slip_url: slipUrl,
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
            created_at: entry?.created_at ?? new Date().toISOString(),
          });
        if (insertBatchError) {
          return NextResponse.json({ error: insertBatchError.message }, { status: 500 });
        }

        const { error: insertAllocError } = await auth.supabase
          .from("invoice_payment_allocations")
          .insert({
            payment_batch_id: newBatchId,
            trigger_invoice_id: invoiceId,
            invoice_id: invoiceId,
            amount,
            paid_at: paidAt,
            slip_url: slipUrl,
            source,
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
            created_at: new Date().toISOString(),
          });
        if (insertAllocError) {
          return NextResponse.json({ error: insertAllocError.message }, { status: 500 });
        }

        history[index] = {
          ...entry,
          source,
          payment_batch_id: newBatchId,
          trigger_invoice_id: invoiceId,
          payment_method: resolved.snapshot,
          payment_method_id: resolved.id,
        };
        newBatchIds.push(newBatchId);
      }

      const { error: historyError } = await auth.supabase
        .from("invoices")
        .update({ payment_history: history })
        .eq("id", invoiceId as string);
      if (historyError) {
        return NextResponse.json({ error: historyError.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        paymentMethod: resolved,
        backfilledBatchIds: newBatchIds,
      });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error." },
      { status: 500 }
    );
  }
}
