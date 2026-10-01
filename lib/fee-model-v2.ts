/**
 * The switch-over to the new late-fee rules (docs/audit/2026-09-29-late-fee-and-overdue-design.md,
 * A6 / B1 / B8) and the small amount of glue every server route needs to read
 * a `v2` bill through the balance engine (lib/invoice-balance.ts).
 *
 * CLIENT-SAFE ON PURPOSE: lib/invoice-ledger.ts imports this, and several
 * "use client" components import lib/invoice-ledger.ts. So nothing here may
 * import `next/server` (which is why this does not reuse lib/money-rpc.ts).
 *
 * The rules, in one place:
 *   - Bills created on/after V2_FEE_MODEL_CUTOVER_DATE (Bangkok) are `v2`.
 *     Everything earlier stays `legacy` and is never edited (decision C3).
 *   - A `v2` bill's `total_amount` is its own charges only. No carry-forward,
 *     no late-fee line, nothing locked/billed: its late fee lives on itself
 *     and is derived by the engine from allocations, waivers and the pause.
 *   - A `v2` bill's `status` is a cache of the engine's answer, refreshed by
 *     `refreshV2InvoiceStatuses` (and by record_payment / void_payment in SQL).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { roundTo2, toNumber } from "./format";
import { bangkokYmd } from "./move-out-notice";
import { toInvoiceMoneyColumns, type InvoiceMoneyColumns } from "./invoice-total";
import {
  getInvoiceBalance,
  type BalanceAllocation,
  type BalanceInvoice,
  type BalanceTenant,
  type BalanceWaiver,
  type InvoiceBalance,
  type InvoiceBalanceStatus,
  type ManualInvoiceStatus,
} from "./invoice-balance";

// ─── Cut-over ────────────────────────────────────────────────────────────────

/**
 * The first day (Bangkok) on which monthly bill generation creates `v2` bills:
 * the 25 Oct 2026 billing cycle (decision C3 / design B8). The ONLY place this
 * date is written down.
 */
export const V2_FEE_MODEL_CUTOVER_DATE = "2026-10-25";

export type FeeModel = "legacy" | "v2";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Which fee model a bill created on `todayBangkok` (YYYY-MM-DD) gets. */
export function feeModelForCreationDate(todayBangkok: string): FeeModel {
  if (!YMD.test(todayBangkok)) {
    throw new Error(`fee-model-v2: todayBangkok must be YYYY-MM-DD, got ${todayBangkok}`);
  }
  return todayBangkok >= V2_FEE_MODEL_CUTOVER_DATE ? "v2" : "legacy";
}

/**
 * The fee model a generation run uses. Decided by the run date, never by the
 * billing period: generating a missed September bill on 26 Oct makes a `v2`
 * bill, because it is created under the new rules.
 *
 * `forceFeeModel` exists only so a DRY RUN can preview the v2 output before the
 * cut-over. It is ignored on a real (writing) run, so nothing in production can
 * start writing v2 bills before 25 Oct by passing a flag.
 */
export function resolveGenerationFeeModel(params: {
  todayBangkok: string;
  dryRun: boolean;
  forceFeeModel?: FeeModel | null;
}): FeeModel {
  if (params.dryRun && (params.forceFeeModel === "v2" || params.forceFeeModel === "legacy")) {
    return params.forceFeeModel;
  }
  return feeModelForCreationDate(params.todayBangkok);
}

/**
 * The stored money columns of a new `v2` monthly bill: own charges only. Goes
 * through the one totals engine with every relay term explicitly zero, so the
 * five columns cannot disagree with each other.
 */
export function v2MonthlyMoneyColumns(parts: {
  rent: number;
  water: number;
  electricity: number;
  commonFee: number;
  /** Other additional fees (never a late-fee line, never carried debt). */
  fees: number;
  /** Discounts as a positive number. */
  discount: number;
}): InvoiceMoneyColumns {
  return toInvoiceMoneyColumns({
    rent: toNumber(parts.rent),
    water: toNumber(parts.water),
    electricity: toNumber(parts.electricity),
    commonFee: toNumber(parts.commonFee),
    nativeLateFee: 0,
    lateFeeItems: 0,
    fees: toNumber(parts.fees),
    carryForward: 0,
    discount: toNumber(parts.discount),
  });
}

// ─── Reading a bill through the engine ───────────────────────────────────────

/** Every column the engine needs for either fee model, plus pause details. */
export const V2_BALANCE_COLUMNS =
  "id,tenant_id,status,fee_model,kind,total_amount,carry_forward_amount,paid_amount,due_date," +
  "late_fee_start_date,late_fee_per_day,late_fee_paused_from,late_fee_paused_reason," +
  "locked_late_fee_amount,late_fee_billed_at";

const MANUAL_STATUSES: ReadonlySet<string> = new Set(["draft", "cancelled", "closed_unpaid"]);

/** An `invoices` row (V2_BALANCE_COLUMNS) + its tenant → the engine's input. */
export function rowToBalanceInvoice(row: any, tenant: BalanceTenant): BalanceInvoice {
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
      throw new Error(`Invoice ${row.id} has an unknown kind: ${row.kind}`);
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
  throw new Error(`Invoice ${row.id} has an unknown fee_model: ${row.fee_model}`);
}

/** Everything a screen needs to show a v2 bill's late fee. */
export type V2LateFeeState = {
  invoiceId: string;
  /** The Bangkok date the balance was computed for. */
  asOf: string;
  kind: "monthly" | "move_out";
  status: string;
  lateFeePerDay: number;
  lateFeeStartDate: string | null;
  pausedFrom: string | null;
  pausedReason: string | null;
  balance: InvoiceBalance;
  /** Σ non-voided allocations — the compare-and-swap stamp record_payment checks. */
  paidSum: number;
  /** Σ non-voided waivers — the other stamp. */
  waivedSum: number;
};

/**
 * Allocations (with their batch's paid_at / voided_at) and waivers for `ids`,
 * grouped per invoice. Same join as `_dm_paid_sum`, so Σ non-voided matches
 * what `record_payment` compares against.
 */
export async function loadAllocationsAndWaivers(
  supabase: SupabaseClient,
  ids: readonly string[],
): Promise<{
  allocationsById: Map<string, BalanceAllocation[]>;
  waiversById: Map<string, BalanceWaiver[]>;
}> {
  const allocationsById = new Map<string, BalanceAllocation[]>(ids.map((id) => [id, []]));
  const waiversById = new Map<string, BalanceWaiver[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return { allocationsById, waiversById };

  const { data: allocRows, error: allocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount,payment_batch_id")
    .in("invoice_id", ids as string[]);
  if (allocError) throw new Error(allocError.message);
  const batchIds = [
    ...new Set(((allocRows ?? []) as any[]).map((row) => String(row.payment_batch_id))),
  ];
  const batchById = new Map<string, { paid_at: string; voided_at: string | null }>();
  if (batchIds.length > 0) {
    const { data: batchRows, error: batchError } = await supabase
      .from("payment_batches")
      .select("id,paid_at,voided_at")
      .in("id", batchIds);
    if (batchError) throw new Error(batchError.message);
    for (const row of (batchRows ?? []) as any[]) {
      batchById.set(String(row.id), { paid_at: String(row.paid_at), voided_at: row.voided_at ?? null });
    }
  }
  for (const row of (allocRows ?? []) as any[]) {
    const batch = batchById.get(String(row.payment_batch_id));
    if (!batch) continue;
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
  if (waiverError) throw new Error(waiverError.message);
  for (const row of (waiverRows ?? []) as any[]) {
    waiversById.get(String(row.invoice_id))?.push({
      invoice_id: String(row.invoice_id),
      amount: toNumber(row.amount),
      voided_at: row.voided_at ?? null,
    });
  }
  return { allocationsById, waiversById };
}

const sumLive = (rows: readonly { amount: number; voided_at: string | null }[]) =>
  roundTo2(
    rows
      .filter((row) => row.voided_at == null)
      .reduce((sum, row) => sum + Math.max(0, toNumber(row.amount)), 0),
  );

/**
 * The engine's view of every `v2` invoice among `invoiceIds`, as of
 * `asOfBangkok` (default: today in Bangkok). Legacy ids are silently left out
 * — callers keep their existing legacy display for those.
 */
export async function loadV2LateFeeStates(
  supabase: SupabaseClient,
  invoiceIds: readonly string[],
  asOfBangkok: string = bangkokYmd(),
): Promise<Map<string, V2LateFeeState>> {
  const result = new Map<string, V2LateFeeState>();
  const ids = [...new Set(invoiceIds.map(String).filter(Boolean))];
  if (ids.length === 0) return result;

  const { data: rows, error } = await supabase
    .from("invoices")
    .select(V2_BALANCE_COLUMNS)
    .in("id", ids)
    .eq("fee_model", "v2");
  if (error) throw new Error(error.message);
  const v2Rows = (rows ?? []) as any[];
  if (v2Rows.length === 0) return result;

  const tenantIds = [...new Set(v2Rows.map((row) => String(row.tenant_id)))];
  const { data: tenantRows, error: tenantError } = await supabase
    .from("tenants")
    .select("id,status,handover_date,tenancy_end_date")
    .in("id", tenantIds);
  if (tenantError) throw new Error(tenantError.message);
  const tenantById = new Map<string, BalanceTenant>(
    ((tenantRows ?? []) as any[]).map((row) => [
      String(row.id),
      {
        status: row.status ?? null,
        handover_date: row.handover_date ?? null,
        tenancy_end_date: row.tenancy_end_date ?? null,
      },
    ]),
  );

  const v2Ids = v2Rows.map((row) => String(row.id));
  const { allocationsById, waiversById } = await loadAllocationsAndWaivers(supabase, v2Ids);

  for (const row of v2Rows) {
    const id = String(row.id);
    const tenant = tenantById.get(String(row.tenant_id)) ?? {
      status: null,
      handover_date: null,
      tenancy_end_date: null,
    };
    const allocations = allocationsById.get(id) ?? [];
    const waivers = waiversById.get(id) ?? [];
    const balance = getInvoiceBalance(rowToBalanceInvoice(row, tenant), allocations, waivers, asOfBangkok);
    result.set(id, {
      invoiceId: id,
      asOf: asOfBangkok,
      kind: row.kind === "move_out" ? "move_out" : "monthly",
      status: String(row.status ?? ""),
      lateFeePerDay: toNumber(row.late_fee_per_day),
      lateFeeStartDate: row.late_fee_start_date ?? null,
      pausedFrom: row.late_fee_paused_from ?? null,
      pausedReason: row.late_fee_paused_reason ?? null,
      balance,
      paidSum: sumLive(allocations),
      waivedSum: sumLive(waivers),
    });
  }
  return result;
}

// ─── Status cache ────────────────────────────────────────────────────────────

/** Statuses the system (not a person) owns on a v2 bill. */
const SYSTEM_STATUSES: ReadonlySet<string> = new Set(["pending", "partial", "overdue", "paid"]);

/**
 * The status to write onto a v2 bill's `status` cache, or null to leave it.
 * Only moves between the four money-derived states: never touches a draft,
 * a cancelled / closed bill, or one with a slip waiting for review.
 */
export function nextCachedV2Status(
  current: string,
  computed: InvoiceBalanceStatus,
): InvoiceBalanceStatus | null {
  if (!SYSTEM_STATUSES.has(current)) return null;
  if (!SYSTEM_STATUSES.has(computed)) return null;
  return computed === current ? null : computed;
}

/**
 * Bring every matching v2 bill's `status` in line with the engine (B4): this is
 * what moves a v2 bill from pending to overdue the day after its due date, and
 * back out of paid if a waiver is voided. Compare-and-swap on the status read,
 * so a concurrent change (a slip arriving, a payment) is never overwritten.
 *
 * Writes `status` only. Never total_amount, paid_amount or any fee column.
 */
export async function refreshV2InvoiceStatuses(
  supabase: SupabaseClient,
  options: {
    invoiceIds?: string[];
    tenantIds?: string[];
    /** Only bills whose start_date is before this date. */
    beforeStartDate?: string;
    /** Only bills of exactly this period. */
    periodStart?: string;
    periodEnd?: string;
    asOfBangkok?: string;
  } = {},
): Promise<{ updatedIds: string[] }> {
  let query = supabase
    .from("invoices")
    .select("id,status")
    .eq("fee_model", "v2")
    .in("status", [...SYSTEM_STATUSES]);
  if (options.invoiceIds && options.invoiceIds.length > 0) query = query.in("id", options.invoiceIds);
  if (options.tenantIds && options.tenantIds.length > 0) query = query.in("tenant_id", options.tenantIds);
  if (options.beforeStartDate) query = query.lt("start_date", options.beforeStartDate);
  if (options.periodStart) query = query.eq("start_date", options.periodStart);
  if (options.periodEnd) query = query.eq("end_date", options.periodEnd);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; status: string }[];
  if (rows.length === 0) return { updatedIds: [] };

  const states = await loadV2LateFeeStates(
    supabase,
    rows.map((row) => String(row.id)),
    options.asOfBangkok ?? bangkokYmd(),
  );
  const updatedIds: string[] = [];
  for (const row of rows) {
    const state = states.get(String(row.id));
    if (!state) continue;
    const next = nextCachedV2Status(String(row.status), state.balance.status);
    if (!next) continue;
    const { data: updated, error: updateError } = await supabase
      .from("invoices")
      .update({ status: next })
      .eq("id", row.id)
      .eq("fee_model", "v2")
      .eq("status", row.status)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    if ((updated ?? []).length > 0) updatedIds.push(String(row.id));
  }
  return { updatedIds };
}

// ─── Waive / pause request validation ────────────────────────────────────────

/** Why a bill cannot have its late fee waived/paused, or null if it can. */
export function lateFeeActionBlockReason(row: {
  fee_model?: string | null;
  kind?: string | null;
  status?: string | null;
}): string | null {
  if (row.fee_model !== "v2") {
    return "บิลนี้ใช้กติกาค่าปรับแบบเดิม (ก่อนรอบ 25 ต.ค. 2569) ค่าปรับถูกล็อกเป็นยอดคงที่แล้ว จึงยกเว้นหรือหยุดนับจากหน้านี้ไม่ได้";
  }
  if (row.kind !== "monthly") {
    return "บิลย้ายออกไม่มีค่าปรับล่าช้า";
  }
  if (row.status === "cancelled") {
    return "บิลนี้ถูกยกเลิกแล้ว";
  }
  return null;
}

/** Validate a waiver request against the engine's current fee due. */
export function validateWaiverRequest(params: {
  amount: number;
  reason: string;
  feeDue: number;
}): string | null {
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "จำนวนเงินที่ยกเว้นต้องมากกว่า 0";
  if (roundTo2(amount) !== amount) return "จำนวนเงินที่ยกเว้นต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง";
  if (!String(params.reason ?? "").trim()) return "กรุณาระบุเหตุผลในการยกเว้นค่าปรับ";
  const feeDue = roundTo2(Math.max(0, toNumber(params.feeDue)));
  if (feeDue <= 0) return "บิลนี้ไม่มีค่าปรับค้างให้ยกเว้น";
  if (amount > feeDue) {
    return `ยกเว้นได้ไม่เกินค่าปรับที่ค้างอยู่ ${feeDue.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`;
  }
  return null;
}

/** Validate a pause request. */
export function validatePauseRequest(params: {
  fromDate: string;
  reason: string;
}): string | null {
  const fromDate = String(params.fromDate ?? "");
  if (!YMD.test(fromDate) || Number.isNaN(new Date(`${fromDate}T00:00:00Z`).getTime())) {
    return "กรุณาระบุวันที่หยุดนับค่าปรับ (YYYY-MM-DD)";
  }
  if (!String(params.reason ?? "").trim()) return "กรุณาระบุเหตุผลในการหยุดนับค่าปรับ";
  return null;
}
