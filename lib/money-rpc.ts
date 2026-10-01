/**
 * Server-side helpers shared by the admin routes that call the money RPCs
 * (record_payment / void_payment in app/api/admin/invoices/actions, and the
 * move-out functions in app/api/admin/tenants/actions).
 *
 * Moved out of app/api/admin/invoices/actions/route.ts unchanged so both
 * routes feed the balance engine (lib/invoice-balance.ts) from the same
 * columns and the same allocation/waiver reads, and map `[code] message`
 * RPC errors the same way.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "./format";
import type {
  BalanceAllocation,
  BalanceInvoice,
  BalanceTenant,
  BalanceWaiver,
  ManualInvoiceStatus,
} from "./invoice-balance";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column `getInvoiceBalance` needs for either fee model, plus the owner. */
export const BALANCE_INVOICE_COLUMNS =
  "id,tenant_id,status,fee_model,kind,total_amount,carry_forward_amount,paid_amount,due_date," +
  "late_fee_start_date,late_fee_per_day,late_fee_paused_from,locked_late_fee_amount,late_fee_billed_at";

/**
 * Codes raised as `[code] message` by the money functions that mean "the
 * request, or the data it was based on, is wrong" rather than a server fault.
 */
export const RPC_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
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
export class MoneyRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export const moneyErrorResponse = (err: MoneyRouteError) =>
  NextResponse.json({ error: err.message, code: err.code }, { status: err.status });

/**
 * Map a `raise exception '[code] message'` from an RPC to an HTTP response:
 * `not_found` → 404, a code in `clientCodes` → 400, anything else → 500.
 */
export function rpcErrorResponse(
  error: { message?: string | null } | null,
  clientCodes: ReadonlySet<string> = RPC_CLIENT_ERROR_CODES,
) {
  const raw = String(error?.message ?? "Database error.");
  const match = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(raw);
  const code = match ? match[1] : null;
  const message = match && match[2] ? match[2] : raw;
  const status =
    code === "not_found" ? 404 : code && clientCodes.has(code) ? 400 : 500;
  return NextResponse.json({ error: message, code }, { status });
}

const MANUAL_STATUSES: ReadonlySet<string> = new Set(["draft", "cancelled", "closed_unpaid"]);

/** A live `invoices` row (BALANCE_INVOICE_COLUMNS) + its tenant → the engine's input. */
export function toBalanceInvoice(row: any, tenant: BalanceTenant): BalanceInvoice {
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

/**
 * The allocation and waiver rows for `ids`, grouped per invoice, in the
 * engine's input shape. Allocations carry their batch's paid_at / voided_at —
 * the same join `_dm_paid_sum` uses, so Σ of the non-voided ones is exactly
 * what the database functions compare `expected_paid_sum` against.
 */
export async function loadBalanceAllocationsAndWaivers(
  supabase: SupabaseClient,
  ids: readonly string[],
): Promise<{
  allocationsById: Map<string, BalanceAllocation[]>;
  waiversById: Map<string, BalanceWaiver[]>;
}> {
  const { data: allocRows, error: allocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount,payment_batch_id")
    .in("invoice_id", ids as string[]);
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
    .in("invoice_id", ids as string[]);
  if (waiverError) throw new MoneyRouteError(500, waiverError.message);
  const waiversById = new Map<string, BalanceWaiver[]>(ids.map((id) => [id, []]));
  for (const row of (waiverRows ?? []) as any[]) {
    waiversById.get(String(row.invoice_id))?.push({
      invoice_id: String(row.invoice_id),
      amount: toNumber(row.amount),
      voided_at: row.voided_at ?? null,
    });
  }

  return { allocationsById, waiversById };
}
