import { buildManualSplitPayload } from "@/lib/money/manual-split-payload";
import { paymentPayloadHash } from "@/lib/money/payment-payload-hash";
import {
  settledCarriedInAmount,
  isPaidWithCarriedIn,
  isLegacyInflatedPaid,
  type CarryInLink,
  type CarryInSource,
} from "@/lib/money/carry-in";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeInvoiceTotal } from "./invoice-total";
import { bangkokToday } from "@/lib/money/action-queue";
import { autoPostLateFees, resolveLateFeeMode } from "@/lib/money/late-fee-posting";
import {
  buildLateFeeLineDetail,
  isCarryForwardBreakdownRow,
  isInvoiceDetailEditable,
  isLateFeeBreakdownRow,
  toChargeFeeRows,
} from "./invoice-utils";

export const OPEN_INVOICE_STATUSES = [
  "pending",
  "partial",
  "overdue",
  "verifying",
] as const;

type InvoiceLike = {
  id: string;
  tenant_id: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string | null;
  payment_history: any[] | null;
  slip_url?: string | null;
  slip_uploaded_at?: string | null;
  late_fee_amount?: number | null;
  late_fee_per_day?: number | null;
  late_fee_start_date?: string | null;
  due_date?: string | null;
  waived_late_fee_amount?: number | null;
  locked_late_fee_amount?: number | null;
  carry_forward_amount?: number | null;
};

export type SyncLedgerOptions = {
  invoiceIds?: string[];
  tenantIds?: string[];
  beforeStartDate?: string;
};

/**
 * A frozen copy of the account money was paid into. Snapshotted at payment time
 * and never re-resolved: `payment_methods` rows are edited in place and a
 * tenant's `custom_payment_method` can be re-assigned at any time, so deriving
 * the account at read time silently rewrites the history of every past month.
 */
export type PaymentMethodSnapshot = {
  type?: string | null;
  methodId?: string | null;
  label?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  qr_url?: string | null;
};

export type ResolvedPaymentMethod = {
  id: string | null;
  snapshot: PaymentMethodSnapshot | null;
};

export type ApplyPaymentOptions = {
  invoiceId: string;
  amount: number;
  paidAt: string;
  slipUrl?: string | null;
  mode?: string;
  source?: string;
  /** Same key on retry returns the original allocation result (no double charge). */
  idempotencyKey?: string | null;
  /**
   * Receiving account. Omit and it is resolved from the tenant (their custom
   * account, else the default) at the moment the payment is applied.
   */
  paymentMethod?: ResolvedPaymentMethod | null;
  /** Admin user id, or `line:<userId>` for the LIFF admin. */
  createdBy?: string | null;
  /**
   * When true, money received beyond what is owed is kept as tenant credit
   * (receipt = amount entered). Default false: the receipt is capped at what
   * is owed, which callers passing a "pay everything" sentinel rely on.
   */
  keepExcessAsCredit?: boolean;
};

export type AllocationBreakdownRow = {
  invoiceId: string;
  allocatedAmount: number;
  newPaidAmount: number;
  newStatus: string;
};

export type ApplyPaymentResult = {
  paymentBatchId: string;
  paymentMethod?: ResolvedPaymentMethod | null;
  appliedAmount: number;
  updatedInvoices: any[];
  allocationBreakdown: AllocationBreakdownRow[];
  idempotentReplay?: boolean;
};

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Round to 2 decimals (satang), the precision of every money column. */
export const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const toDateOnly = (value: string) => {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

export const dayDiffInclusive = (left: Date, right: Date) => {
  const leftUtc = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const rightUtc = Date.UTC(
    right.getFullYear(),
    right.getMonth(),
    right.getDate(),
  );
  return Math.floor((rightUtc - leftUtc) / 86400000) + 1;
};

export const getInvoiceOutstanding = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount">,
) =>
  Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount));

export type ChainAllocationInput = {
  id: string;
  total_amount: number | null | undefined;
  paid_amount: number | null | undefined;
  /** Debt bundled into total_amount from an earlier invoice; not this row's own charge. */
  carry_forward_amount?: number | null;
};

/**
 * What a payment can still put onto THIS row: its own charge minus what the row
 * has received. paid_amount only ever grows by own-share allocations, so the
 * carried-in portion is excluded from the cap (total - carry - paid), never
 * double counted. Rounded to satang.
 */
export const getChainOwnOutstanding = (invoice: ChainAllocationInput) => {
  const total = toNumber(invoice.total_amount);
  const paid = roundMoney(toNumber(invoice.paid_amount));
  const carry = Math.max(0, toNumber(invoice.carry_forward_amount));
  // Row written before the own-share fix: paid_amount already includes the carried part,
  // so plain total - paid is what is left (see isLegacyInflatedPaid in lib/money/carry-in.ts).
  if (carry > 0 && paid > roundMoney(total - carry)) return Math.max(0, roundMoney(total - paid));
  return Math.max(0, roundMoney(total - carry - paid));
};

export type ChainAllocationResult = {
  id: string;
  allocated: number;
  nextPaidAmount: number;
};

/**
 * Splits one payment across an ordered (oldest-first) carry-forward chain,
 * capping each invoice's own `paid_amount` increase at that invoice's own
 * outstanding balance. This is the one place that decides how much of a
 * payment each invoice in the chain absorbs.
 *
 * Pulled out of `applyInvoicePaymentAllocation` and unit-tested on its own so
 * the rule "an invoice's paid_amount can only grow by its own share, never a
 * different invoice's" can't silently regress. It regressed once already: a
 * past version of `applyInvoicePaymentAllocation` accumulated the source
 * invoice's allocated share onto the target's `paid_amount` too, so a single
 * payment that legitimately settled an old debt AND part of a new invoice
 * made the target look paid for money it never actually received on its own
 * row. Several invoices in production still carry that stale, inflated
 * `paid_amount` from before the fix (left alone deliberately — correcting
 * them now would flip settled-looking invoices back to owing money, which is
 * a business decision, not a code fix).
 */
export const allocatePaymentAcrossChain = (
  invoices: ChainAllocationInput[],
  amount: number,
): ChainAllocationResult[] => {
  // Everything is rounded to whole satang (2 decimals): record_payment_batch
  // rejects amounts with more decimals and requires, per invoice, that
  // nextPaidAmount == paid_amount + allocated exactly. Raw float arithmetic
  // (0.1 + 0.2) would otherwise fail those checks or drift from numeric(10,2).
  let remaining = Math.max(0, roundMoney(toNumber(amount)));
  const results: ChainAllocationResult[] = [];
  for (const invoice of invoices) {
    const paid = roundMoney(toNumber(invoice.paid_amount));
    const outstanding = getChainOwnOutstanding(invoice);
    if (outstanding <= 0 || remaining <= 0) continue;
    const allocated = roundMoney(Math.min(outstanding, remaining));
    const nextPaidAmount = roundMoney(paid + allocated);
    results.push({ id: invoice.id, allocated, nextPaidAmount });
    remaining = roundMoney(remaining - allocated);
  }
  return results;
};

/** Sum of allocations, rounded to 2 decimals (equals record_payment_batch's own sum). */
export const sumAllocated = (rows: Array<{ allocated: number }>) =>
  roundMoney(rows.reduce((sum, row) => sum + roundMoney(row.allocated), 0));

/**
 * How much of THIS invoice's own charge (excluding whatever it already carried in
 * from an earlier invoice) is still unpaid. Summing this across every open invoice
 * in a tenant's carry-forward chain gives the true total owed — summing raw
 * `getInvoiceOutstanding` instead double/triple-counts, since each invoice's total
 * already bundles the debt from the invoice before it.
 */
export const getInvoiceOwnOutstanding = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "carry_forward_amount">,
) =>
  // One rule everywhere (payment allocator, dashboards, move-out settlement and the
  // final_settle_move_out SQL): max(0, total - carry - paid). paid_amount is the
  // invoice's OWN share; the old min(total - carry, total - paid) re-counted the
  // carried amount after the own share was paid (finding 177).
  getChainOwnOutstanding({
    id: "",
    total_amount: invoice.total_amount,
    paid_amount: invoice.paid_amount,
    carry_forward_amount: invoice.carry_forward_amount,
  } as ChainAllocationInput);

/**
 * The true amount still owed across a set of invoices — e.g. every open
 * invoice on a dashboard, or every open invoice for one tenant/room. Sums
 * `getInvoiceOwnOutstanding` rather than raw `total_amount - paid_amount`,
 * so a carry-forward chain's debt is counted once, not once per invoice it
 * was bundled into. Requires `carry_forward_amount` in the caller's SELECT —
 * without it every invoice's own-outstanding silently equals its bundled
 * outstanding, which is the exact bug this function exists to avoid.
 */
export const sumOwnOutstanding = (
  invoices: Array<Pick<InvoiceLike, "total_amount" | "paid_amount" | "carry_forward_amount">>,
) => invoices.reduce((sum, invoice) => sum + getInvoiceOwnOutstanding(invoice), 0);

export type AbandonCreditLine = {
  invoiceId: string;
  /** This invoice's own charge still unpaid — never its bundled total. */
  owed: number;
  applied: number;
  writtenOff: number;
  /**
   * `paid` — own charge fully covered by credit.
   * `partial` — some credit applied, a real balance remains.
   * `unpaid` — no credit reached it; it still owes everything.
   * `already_clear` — nothing was owed to begin with.
   * Nothing is ever written off: an unpaid invoice stays a debt.
   */
  outcome: "paid" | "partial" | "unpaid" | "already_clear";
};

export type AbandonCreditPlan = {
  lines: AbandonCreditLine[];
  creditPool: number;
  totalOwed: number;
  creditApplied: number;
  /**
   * Debt the credit could not reach. NOT written off — the invoices keep it and
   * stay overdue; this is only the total for reporting.
   */
  writtenOff: number;
  /** Credit left once the real debt is covered — the tenant's to get back. */
  refundableCredit: number;
};

/**
 * Work out how an abandoning tenant's deposit + advance rent lands across their
 * open invoices. Shared by the abandon API route and the move-out screen so the
 * preview an admin approves is the arithmetic that actually runs.
 *
 * Every invoice is measured by its OWN charge (`getInvoiceOwnOutstanding`).
 * Measuring by `total_amount - paid_amount` counts a carried-forward debt once
 * on the invoice that owns it and again on the invoice that carried it,
 * spending credit against money the tenant never owed.
 *
 * `invoices` must be ordered FINAL INVOICE FIRST. A tenant who moves out has
 * their closing bill settled before anything else; whatever credit is left then
 * goes to the remaining periods. Ordering is the caller's job so the preview an
 * admin approves is the order that actually runs.
 *
 * Credit never cancels a debt. An invoice the credit could not cover keeps its
 * balance and its existing status (overdue stays overdue) — `writtenOff` is
 * reported for visibility only, never applied.
 */
export function planAbandonCredit(
  invoices: Array<
    Pick<InvoiceLike, "total_amount" | "paid_amount" | "carry_forward_amount"> & {
      id: string;
    }
  >,
  creditPool: number,
): AbandonCreditPlan {
  let remaining = Math.max(0, toNumber(creditPool));
  let totalOwed = 0;
  let creditApplied = 0;
  let writtenOff = 0;

  const lines: AbandonCreditLine[] = invoices.map((invoice) => {
    const owed = getInvoiceOwnOutstanding(invoice);
    totalOwed += owed;

    if (owed <= 0) {
      return {
        invoiceId: String(invoice.id),
        owed: 0,
        applied: 0,
        writtenOff: 0,
        outcome: "already_clear" as const,
      };
    }

    const applied = Math.min(owed, remaining);
    remaining -= applied;
    creditApplied += applied;
    const shortfall = owed - applied;
    writtenOff += shortfall;

    return {
      invoiceId: String(invoice.id),
      owed,
      applied,
      writtenOff: shortfall,
      outcome:
        shortfall <= 0
          ? ("paid" as const)
          : applied > 0
            ? ("partial" as const)
            : ("unpaid" as const),
    };
  });

  return {
    lines,
    creditPool: Math.max(0, toNumber(creditPool)),
    totalOwed,
    creditApplied,
    writtenOff,
    refundableCredit: remaining,
  };
}

export const calculateLateFeeAmount = (
  invoice: Pick<
    InvoiceLike,
    | "late_fee_start_date"
    | "late_fee_per_day"
    | "waived_late_fee_amount"
    | "locked_late_fee_amount"
  >,
  asOfDateText: string,
) => {
  if (
    invoice.locked_late_fee_amount !== null &&
    invoice.locked_late_fee_amount !== undefined
  ) {
    return Math.max(0, toNumber(invoice.locked_late_fee_amount));
  }
  if (!invoice.late_fee_start_date) return 0;
  const rate = Math.max(0, toNumber(invoice.late_fee_per_day));
  if (rate <= 0) return 0;
  const startDate = toDateOnly(invoice.late_fee_start_date);
  const asOfDate = toDateOnly(asOfDateText);
  if (asOfDate < startDate) return 0;

  const rawLateFee = dayDiffInclusive(startDate, asOfDate) * rate;
  const waived = Math.max(0, toNumber(invoice.waived_late_fee_amount));
  return Math.max(0, rawLateFee - waived);
};

const addCalendarDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const toDateOnlyText = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export type LateFeeSnapshot = {
  amount: number;
  days: number;
  /** The date this snapshot's day-count runs through, for display and for
   * deriving the accrual window's start date (asOf minus days, plus one). */
  asOf: string | null;
};

/**
 * The ONE place that decides an invoice's late-fee snapshot for carrying it
 * onto a new invoice — used by both the single-invoice recalculate flow and
 * the bulk monthly generator, so the two can't drift into computing this two
 * different ways (which is how they ended up writing two different
 * `item_type` strings for the same kind of line item).
 *
 * A PAID invoice never gets a live day-count guess against `asOfDateText` —
 * only whatever was actually frozen at payment time
 * (`invoice.locked_late_fee_amount`). Guessing "days since late_fee_start_date
 * until today" for an invoice settled months ago would wildly overstate a fee
 * the tenant was never told about. If a paid invoice has no frozen amount
 * (predates the payment-time freeze, or the freeze never fired), its
 * snapshot is honestly nothing — amount 0 — rather than a fabricated number.
 */
export const computeLateFeeSnapshot = (
  invoice: Pick<
    InvoiceLike,
    | "status"
    | "late_fee_start_date"
    | "late_fee_per_day"
    | "waived_late_fee_amount"
    | "locked_late_fee_amount"
  >,
  asOfDateText: string,
): LateFeeSnapshot => {
  const isPaid = String(invoice.status ?? "") === "paid";
  const rate = Math.max(0, toNumber(invoice.late_fee_per_day));

  if (isPaid) {
    if (invoice.locked_late_fee_amount === null || invoice.locked_late_fee_amount === undefined) {
      return { amount: 0, days: 0, asOf: null };
    }
    const amount = Math.max(0, toNumber(invoice.locked_late_fee_amount));
    const days = rate > 0 ? Math.round(amount / rate) : 0;
    const asOf =
      days > 0 && invoice.late_fee_start_date
        ? toDateOnlyText(addCalendarDays(toDateOnly(invoice.late_fee_start_date), days - 1))
        : null;
    return { amount, days, asOf };
  }

  const amount = calculateLateFeeAmount(invoice, asOfDateText);
  let days = 0;
  if (invoice.late_fee_start_date) {
    const startDate = toDateOnly(invoice.late_fee_start_date);
    const asOfDate = toDateOnly(asOfDateText);
    if (asOfDate >= startDate) days = dayDiffInclusive(startDate, asOfDate);
  }
  return { amount, days, asOf: amount > 0 ? asOfDateText.slice(0, 10) : null };
};

/**
 * The date an invoice actually finished being paid — the latest entry in its
 * payment history, falling back to the slip upload date, then to `fallbackDate`.
 *
 * This is the "as of" date a late fee must be frozen at. Freezing at today's
 * date instead would keep inflating an old invoice's fee by ฿/day for every day
 * since, long after the tenant settled it.
 */
export const resolveFullyPaidAtDate = (
  invoice: Pick<InvoiceLike, "payment_history" | "slip_uploaded_at">,
  fallbackDate: string,
) => {
  const paymentHistory = Array.isArray(invoice.payment_history)
    ? invoice.payment_history
    : [];
  let fullyPaidAt = invoice.slip_uploaded_at
    ? String(invoice.slip_uploaded_at)
    : fallbackDate;

  if (paymentHistory.length > 0) {
    const latestPayment = [...paymentHistory].sort(
      (a: any, b: any) =>
        new Date(b.paid_at || b.created_at).getTime() -
        new Date(a.paid_at || a.created_at).getTime(),
    )[0];
    if (latestPayment && (latestPayment.paid_at || latestPayment.created_at)) {
      fullyPaidAt = String(latestPayment.paid_at || latestPayment.created_at);
    }
  }

  return fullyPaidAt.slice(0, 10);
};

export const resolveInvoiceStatus = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "due_date">,
  asOfDateText: string,
) => {
  const outstanding = getInvoiceOutstanding(invoice);
  if (outstanding <= 0) return "paid";
  const paidAmount = toNumber(invoice.paid_amount);
  if (
    invoice.due_date &&
    toDateOnly(asOfDateText) > toDateOnly(invoice.due_date)
  ) {
    return paidAmount > 0 ? "partial" : "overdue";
  }
  return paidAmount > 0 ? "partial" : "pending";
};

export { settledCarriedInAmount };
export type { CarryInLink, CarryInSource };

/** resolveInvoiceStatus plus the carried-in rule (own paid > 0 and own paid + settled carried-in >= total). */
export const resolveInvoiceStatusWithCarry = (
  invoice: Pick<InvoiceLike, "total_amount" | "paid_amount" | "due_date"> & {
    carry_forward_amount?: number | string | null;
  },
  asOfDateText: string,
  carriedInSettled: number,
) => {
  if (
    toNumber(invoice.paid_amount) < toNumber(invoice.total_amount) &&
    isPaidWithCarriedIn(invoice.total_amount, invoice.paid_amount, carriedInSettled, invoice.carry_forward_amount ?? undefined)
  ) {
    return "paid";
  }
  return resolveInvoiceStatus(invoice, asOfDateText);
};

/**
 * Loads carry-forward links into the given targets AND, transitively, into their sources
 * (so the recursive "settled" rule can see a whole chain A -> B -> C), plus every source row.
 */
const loadCarryInContext = async (supabase: SupabaseClient, targetIds: string[]) => {
  const linksByTarget = new Map<string, CarryInLink[]>();
  const sources = new Map<string, CarryInSource>();
  const targets = new Map<string, { total: number; paid: number; carry: number }>();
  if (targetIds.length === 0) return { linksByTarget, sources, targets };
  {
    const { data: trows, error: terr } = await supabase
      .from("invoices")
      .select("id,total_amount,paid_amount,carry_forward_amount")
      .in("id", [...new Set(targetIds)]);
    if (terr) throw new Error(terr.message);
    for (const r of (trows ?? []) as any[]) {
      targets.set(String(r.id), {
        total: toNumber(r.total_amount),
        paid: toNumber(r.paid_amount),
        carry: toNumber(r.carry_forward_amount),
      });
    }
  }
  const seenTargets = new Set<string>();
  let frontier = [...new Set(targetIds)];
  const allSourceIds = new Set<string>();
  for (let round = 0; round < 12 && frontier.length > 0; round++) {
    frontier.forEach((id) => seenTargets.add(id));
    const { data: links, error } = await supabase
      .from("invoice_carry_forwards")
      .select("source_invoice_id,target_invoice_id,amount")
      .in("target_invoice_id", frontier);
    if (error) throw new Error(error.message);
    const next = new Set<string>();
    for (const l of (links ?? []) as any[]) {
      const key = String(l.target_invoice_id);
      const list = linksByTarget.get(key) ?? [];
      list.push({ source_invoice_id: String(l.source_invoice_id), amount: toNumber(l.amount) });
      linksByTarget.set(key, list);
      allSourceIds.add(String(l.source_invoice_id));
      if (!seenTargets.has(String(l.source_invoice_id))) next.add(String(l.source_invoice_id));
    }
    frontier = [...next];
  }
  if (allSourceIds.size > 0) {
    const { data: rows, error: srcError } = await supabase
      .from("invoices")
      .select("id,total_amount,paid_amount,status")
      .in("id", [...allSourceIds]);
    if (srcError) throw new Error(srcError.message);
    for (const r of (rows ?? []) as any[]) sources.set(String(r.id), r);
  }
  return { linksByTarget, sources, targets };
};

/** Settled carried-in amount per invoice id (0 when none). */
export async function getSettledCarriedInByInvoice(
  supabase: SupabaseClient,
  invoiceIds: string[],
  overrides: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  const ctx = await loadCarryInContext(supabase, invoiceIds);
  const out = new Map<string, number>();
  for (const id of invoiceIds) {
    const row = ctx.targets.get(id);
    // Legacy-inflated row: its paid_amount already includes the carried part; never add it again.
    if (row && isLegacyInflatedPaid(row.total, row.paid, row.carry)) {
      out.set(id, 0);
      continue;
    }
    out.set(
      id,
      settledCarriedInAmount(ctx.linksByTarget.get(id) ?? [], ctx.sources, overrides, ctx.linksByTarget),
    );
  }
  return out;
}

/**
 * Status for existing invoices under the same rule record_payment_batch uses
 * (resolveInvoiceStatusWithCarry). Used by syncInvoiceLedger and slip decline so
 * a later sync cannot undo, or fail to reach, the status a valid payment produced.
 */
export async function resolveStatusesWithCarry(
  supabase: SupabaseClient,
  invoices: Array<{ id: unknown; total_amount: unknown; paid_amount: unknown; due_date?: unknown }>,
  todayText: string,
): Promise<Map<string, string>> {
  const ids = invoices.map((i) => String(i.id));
  const carried = await getSettledCarriedInByInvoice(supabase, ids);
  const out = new Map<string, string>();
  for (const inv of invoices) {
    out.set(
      String(inv.id),
      resolveInvoiceStatusWithCarry(
        {
          total_amount: inv.total_amount as any,
          paid_amount: inv.paid_amount as any,
          due_date: (inv.due_date as any) ?? null,
        },
        todayText,
        carried.get(String(inv.id)) ?? 0,
      ),
    );
  }
  return out;
}

type InvoiceRowSnapshot = {
  paid_amount: number;
  payment_history: any[];
  status: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
  locked_late_fee_amount: number | null;
};

/**
 * The account a tenant's money is expected to land in, right now: their assigned
 * account if they have one, otherwise the house default (the oldest
 * `payment_methods` row — the same one the tenant-facing payment page and the
 * printed invoice fall back to).
 *
 * Call this ONCE, at the moment a payment is recorded, and store what it returns.
 * Never call it to describe a payment that already happened.
 */
/** Turn a `payment_methods` row into the frozen shape stored on batches/allocations. */
export const snapshotFromPaymentMethodRow = (row: {
  id?: string | null;
  label?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  qr_url?: string | null;
}): ResolvedPaymentMethod => ({
  id: row.id ? String(row.id) : null,
  snapshot: {
    type: row.qr_url ? "qr" : "bank",
    methodId: row.id ? String(row.id) : null,
    label: row.label ?? null,
    bank_name: row.bank_name ?? null,
    account_name: row.account_name ?? null,
    account_number: row.account_number ?? null,
    qr_url: row.qr_url ?? null,
  },
});

export async function resolvePaymentMethodForTenant(
  supabase: SupabaseClient,
  tenantId: string | null | undefined,
): Promise<ResolvedPaymentMethod> {
  const empty: ResolvedPaymentMethod = { id: null, snapshot: null };

  if (tenantId) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("custom_payment_method")
      .eq("id", tenantId)
      .maybeSingle();
    const custom = (tenant as any)?.custom_payment_method;
    if (custom && typeof custom === "object") {
      return {
        id: custom.methodId ? String(custom.methodId) : null,
        snapshot: custom as PaymentMethodSnapshot,
      };
    }
    // A legacy free-text method is still better than nothing — keep the label.
    if (typeof custom === "string" && custom.trim()) {
      return { id: null, snapshot: { label: custom } };
    }
  }

  const { data: fallback } = await supabase
    .from("payment_methods")
    .select("id,label,bank_name,account_name,account_number,qr_url")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!fallback) return empty;
  return snapshotFromPaymentMethodRow(fallback as any);
}

/**
 * Locate the batch a previous request with this idempotency key created.
 * `payment_batches` is the record; the `payment_history` JSON scan behind it is
 * only there so keys replayed from before the batch table existed still resolve.
 */
async function findIdempotentBatchId(
  supabase: SupabaseClient,
  triggerInvoiceId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const { data: batch } = await supabase
    .from("payment_batches")
    .select("id")
    .eq("trigger_invoice_id", triggerInvoiceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if ((batch as any)?.id) return String((batch as any).id);

  const { data: inv, error } = await supabase
    .from("invoices")
    .select("payment_history")
    .eq("id", triggerInvoiceId)
    .maybeSingle();
  if (error || !inv) return null;
  const history = Array.isArray((inv as any).payment_history)
    ? (inv as any).payment_history
    : [];
  const entry = history.find((e: any) => e?.idempotency_key === idempotencyKey);
  return entry?.payment_batch_id ? String(entry.payment_batch_id) : null;
}

async function findIdempotentPaymentResult(
  supabase: SupabaseClient,
  triggerInvoiceId: string,
  idempotencyKey: string,
  payloadHash: string | null = null,
): Promise<ApplyPaymentResult | null> {
  const batchId = await findIdempotentBatchId(
    supabase,
    triggerInvoiceId,
    idempotencyKey,
  );
  if (!batchId) return null;

  // Same key, different request: refuse instead of replaying someone else's
  // receipt (record_payment_batch applies the same rule under its locks).
  if (payloadHash) {
    const { data: batchRow, error: batchError } = await supabase
      .from("payment_batches")
      .select("payload_hash")
      .eq("id", batchId)
      .maybeSingle();
    const storedHash = batchError ? null : ((batchRow as any)?.payload_hash ?? null);
    if (storedHash && storedHash !== payloadHash) {
      throw new Error(
        `IDEMPOTENCY_CONFLICT key ${idempotencyKey} on invoice ${triggerInvoiceId} was already used for a different payment (batch ${batchId}); use a new key`,
      );
    }
  }

  const { data: allocRows, error: allocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount,payment_method_id,payment_method_snapshot")
    .eq("payment_batch_id", batchId);
  if (allocError) return null;

  const appliedAmount = (allocRows ?? []).reduce(
    (sum, row: any) => sum + toNumber(row.amount),
    0,
  );
  const invoiceIds = [
    ...new Set((allocRows ?? []).map((r: any) => String(r.invoice_id))),
  ];
  if (invoiceIds.length === 0) return null;

  const { data: updatedInvoices, error: invError } = await supabase
    .from("invoices")
    .select(
      "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount",
    )
    .in("id", invoiceIds);
  if (invError) return null;

  const byId = new Map(
    (updatedInvoices ?? []).map((u: any) => [String(u.id), u]),
  );
  const breakdown: AllocationBreakdownRow[] = (allocRows ?? []).map(
    (row: any) => {
      const id = String(row.invoice_id);
      const inv = byId.get(id) as any;
      return {
        invoiceId: id,
        allocatedAmount: toNumber(row.amount),
        newPaidAmount: toNumber(inv?.paid_amount),
        newStatus: String(inv?.status ?? ""),
      };
    },
  );

  const replayedMethodRow = (allocRows ?? []).find(
    (row: any) => row.payment_method_snapshot || row.payment_method_id,
  ) as any;

  return {
    paymentBatchId: batchId,
    paymentMethod: replayedMethodRow
      ? {
          id: replayedMethodRow.payment_method_id
            ? String(replayedMethodRow.payment_method_id)
            : null,
          snapshot: replayedMethodRow.payment_method_snapshot ?? null,
        }
      : null,
    appliedAmount,
    updatedInvoices: updatedInvoices ?? [],
    allocationBreakdown: breakdown,
    idempotentReplay: true,
  };
}

export async function syncInvoiceLedger(
  supabase: SupabaseClient,
  options: SyncLedgerOptions = {},
) {
  let query = supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date,waived_late_fee_amount,locked_late_fee_amount",
    )
    .not("status", "in", '("draft","paid","cancelled")');

  if (options.invoiceIds && options.invoiceIds.length > 0) {
    query = query.in("id", options.invoiceIds);
  }
  if (options.tenantIds && options.tenantIds.length > 0) {
    query = query.in("tenant_id", options.tenantIds);
  }
  if (options.beforeStartDate) {
    query = query.lt("start_date", options.beforeStartDate);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const todayText = new Date().toISOString().slice(0, 10);
  const rows = (data ?? []) as (InvoiceLike & { start_date?: string | null })[];
  const updatedIds: string[] = [];
  const carryAwareStatus = await resolveStatusesWithCarry(supabase, rows, todayText);

  for (const invoice of rows) {
    /** Do not auto-change status while a slip is awaiting admin verification. */
    if (String(invoice.status ?? "") === "verifying") {
      continue;
    }

    // The new logic requires that the current month's invoice DOES NOT dynamically increment its late fee.
    // Late fees are only calculated at the end of the month and applied to the NEXT month's invoice as a line item.
    // Therefore, we do not update `late_fee_amount` here.

    // For status resolution, use the stored total_amount as-is.
    // Same rule as record_payment_batch (carried-in debt settled on its source counts
    // as paid), so a sync neither undoes nor misses the status a payment produced.
    const nextStatus =
      carryAwareStatus.get(String(invoice.id)) ??
      resolveInvoiceStatus(
        {
          total_amount: invoice.total_amount,
          paid_amount: invoice.paid_amount,
          due_date: invoice.due_date ?? null,
        },
        todayText,
      );

    const updatePayload: any = {};
    if (nextStatus !== String(invoice.status ?? "")) {
      updatePayload.status = nextStatus;
      
      // If the invoice is fully paid, we lock the late fee so it doesn't get carried forward anymore.
      // We must calculate the accrued late fee up to the date it was paid.
      if (nextStatus === "paid") {
        updatePayload.locked_late_fee_amount = calculateLateFeeAmount(
          invoice,
          resolveFullyPaidAtDate(invoice, todayText),
        );
      } else if (
        nextStatus === "partial" ||
        nextStatus === "overdue" ||
        nextStatus === "pending"
      ) {
        updatePayload.locked_late_fee_amount = null;
      }
    }

    if (Object.keys(updatePayload).length > 0) {
      const { error: updateError } = await supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoice.id);
      if (updateError) throw new Error(updateError.message);
      updatedIds.push(invoice.id);
    }
  }

  return { updatedIds };
}

/**
 * Overdue / unpaid invoices from prior periods that can be rolled into a new invoice.
 * Each candidate is reported at its own unbundled amount (its total minus whatever it
 * already carried in from an earlier invoice), so every still-open period in the chain
 * can be listed side by side without double counting — whether or not that period was
 * previously carried into some other invoice.
 * @param valuationDateForLateFee Optional "as of" date for late-fee preview (e.g. new invoice issue_date); defaults to beforeStartDate.
 */
export async function getCarryForwardCandidatesForTarget(
  supabase: SupabaseClient,
  tenantId: string,
  beforeStartDate: string,
  targetInvoiceId?: string | null,
  valuationDateForLateFee?: string | null,
) {
  await syncInvoiceLedger(supabase, { tenantIds: [tenantId], beforeStartDate });

  const asOfLateFee = String(valuationDateForLateFee || beforeStartDate).slice(
    0,
    10,
  );

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,start_date,due_date,total_amount,paid_amount,status,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,carry_forward_amount,late_fee_billed_at",
    )
    .eq("tenant_id", tenantId)
    .lt("start_date", beforeStartDate)
    // Still-open invoices (there's principal and/or a late fee left to carry),
    // OR a PAID invoice whose late fee was frozen at payment time but never
    // made it onto a bill yet. Without that second branch, a tenant who pays
    // a few days late — settling the invoice before the next generation cycle
    // ever looks at it — has their correctly-calculated late fee silently
    // dropped forever, since nothing else ever re-examines a paid invoice.
    .or(
      `status.in.(${OPEN_INVOICE_STATUSES.join(",")}),and(status.eq.paid,late_fee_billed_at.is.null)`,
    )
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);

  const candidateIds = (invoices ?? []).map((row: any) => String(row.id));
  if (candidateIds.length === 0) return [];

  // Each invoice's own new charge (its total_amount minus whatever it already
  // carried in from an even earlier invoice) is a fixed amount that never overlaps
  // with a different period's own charge. So every still-open invoice in the chain
  // can be shown as its own candidate — regardless of whether it was previously
  // carried into a later invoice — without double counting, as long as we always
  // report each invoice's own portion rather than its bundled total.
  //
  // "Own portion still outstanding" has to account for partial payments too: a
  // payment on a bundled invoice pays down the total, not a specific line item, so
  // we can't know for certain whether it paid off the carried-in portion or the
  // invoice's own portion first. We assume payments retire the invoice's own charge
  // first (min of own charge vs. current outstanding) — see room 114/1 case where a
  // partial April payment left exactly its own 244 baht outstanding.
  //
  // A paid invoice's own outstanding principal is always 0 (paid_amount ==
  // total_amount), so it never contributes a carry-forward line — only its
  // late fee, via `computeLateFeeSnapshot`, can still be candidate.
  const candidates = (invoices ?? []).map((row: any) => {
    const lateFeeSnapshot = computeLateFeeSnapshot(row, asOfLateFee);
    const outstanding = getInvoiceOwnOutstanding(row);

    return {
      ...row,
      outstanding_amount: outstanding,
      late_fee_snapshot_amount: lateFeeSnapshot.amount,
      late_fee_snapshot_days: lateFeeSnapshot.days,
      late_fee_snapshot_as_of: lateFeeSnapshot.asOf,
    };
  });

  // Late-fee approval mode (a late_fee_policies row exists): a source whose fee
  // has already gone through the approval flow (any late_fee_charges row) must
  // not ALSO be offered as a legacy late-fee candidate, or the manual
  // recalculate / carry-forward checkbox adds a second fee line for the same
  // lateness. If the charges cannot be read, offer no late fee at all rather
  // than risk billing one twice; the principal is still offered.
  const { mode } = await resolveLateFeeMode(supabase);
  let chargedSourceIds: Set<string> | "all" = new Set();
  if (mode === "approval") {
    const { data: chargeRows, error: chargeError } = await supabase
      .from("late_fee_charges")
      .select("source_invoice_id")
      .in("source_invoice_id", candidateIds);
    chargedSourceIds = chargeError
      ? "all"
      : new Set((chargeRows ?? []).map((c: any) => String(c.source_invoice_id)));
  }

  return excludeAlreadyChargedLateFees(candidates, chargedSourceIds).filter(
    (row: any) => row.outstanding_amount > 0 || row.late_fee_snapshot_amount > 0,
  );
}

/**
 * Zero the late-fee snapshot of every candidate whose source already has a
 * `late_fee_charges` row (approval mode), so the legacy candidate path cannot
 * bill a second fee for it. `"all"` zeroes every candidate's late fee.
 * Principal (`outstanding_amount`) is untouched.
 */
export function excludeAlreadyChargedLateFees<
  T extends { id: string; late_fee_snapshot_amount: number; late_fee_snapshot_days?: number },
>(candidates: T[], chargedSourceIds: Set<string> | "all"): T[] {
  return candidates.map((row) =>
    chargedSourceIds === "all" || chargedSourceIds.has(String(row.id))
      ? { ...row, late_fee_snapshot_amount: 0, late_fee_snapshot_days: 0 }
      : row,
  );
}

export async function getCarryForwardCandidates(
  supabase: SupabaseClient,
  tenantId: string,
  beforeStartDate: string,
) {
  return getCarryForwardCandidatesForTarget(
    supabase,
    tenantId,
    beforeStartDate,
    null,
  );
}

/**
 * After a payment changes one or more invoices' own outstanding balance,
 * any LATER invoice that carries one of those invoices as a bundled debt
 * needs its carry-forward/late-fee lines and total refreshed to match —
 * otherwise it keeps showing pre-payment figures until someone happens to
 * open it and click "recalculate" by hand.
 *
 * Scoped deliberately narrow: only refreshes lines whose `source_invoice_id`
 * is one of `paidSourceInvoiceIds`, using the same candidate computation
 * (`getCarryForwardCandidatesForTarget`) the manual recalculate button uses.
 * Everything else already on the target — a manual fee, a transfer
 * breakdown, a carried line from an unrelated invoice — is left exactly as
 * stored. Targets that are paid, cancelled, or still a draft are skipped
 * entirely; this only touches invoices still open for editing.
 */
export async function refreshCarryForwardTargets(
  supabase: SupabaseClient,
  tenantId: string,
  paidSourceInvoiceIds: string[],
): Promise<{ refreshedInvoiceIds: string[] }> {
  if (paidSourceInvoiceIds.length === 0) {
    return { refreshedInvoiceIds: [] };
  }

  const { data: carryRows, error: carryError } = await supabase
    .from("invoice_carry_forwards")
    .select("target_invoice_id")
    .in("source_invoice_id", paidSourceInvoiceIds);
  if (carryError) throw new Error(carryError.message);

  const targetIds = [
    ...new Set((carryRows ?? []).map((row: any) => String(row.target_invoice_id))),
  ];
  if (targetIds.length === 0) {
    return { refreshedInvoiceIds: [] };
  }

  const { data: targets, error: targetsError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,status,start_date,issue_date,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,additional_fees_breakdown,discount_amount,total_amount",
    )
    .in("id", targetIds);
  if (targetsError) throw new Error(targetsError.message);

  const refreshedInvoiceIds: string[] = [];

  for (const target of (targets ?? []) as any[]) {
    if (!isInvoiceDetailEditable(String(target.status ?? ""))) continue;

    const valuationDate = target.issue_date || target.start_date;
    const candidates = await getCarryForwardCandidatesForTarget(
      supabase,
      tenantId,
      target.start_date,
      String(target.id),
      valuationDate,
    );
    const freshBySource = new Map(candidates.map((c: any) => [String(c.id), c]));

    const existingBreakdown: any[] = Array.isArray(target.additional_fees_breakdown)
      ? target.additional_fees_breakdown
      : [];
    const untouched = existingBreakdown.filter(
      (row) => !isCarryForwardBreakdownRow(row) && !isLateFeeBreakdownRow(row),
    );
    const existingCarryItems = existingBreakdown.filter(isCarryForwardBreakdownRow);
    const existingLateItems = existingBreakdown.filter(isLateFeeBreakdownRow);

    let changed = false;

    const nextCarryItems = existingCarryItems
      .map((item: any) => {
        const sourceId = String(item.source_invoice_id ?? "");
        if (!sourceId || !paidSourceInvoiceIds.includes(sourceId)) return item;
        changed = true;
        const fresh = freshBySource.get(sourceId);
        const outstanding = fresh ? toNumber(fresh.outstanding_amount) : 0;
        if (outstanding <= 0) return null;
        return {
          ...item,
          total_amount: outstanding,
          amount: outstanding,
          price_per_unit: outstanding,
        };
      })
      .filter((item: any) => item !== null);

    const nextLateItems = existingLateItems
      .map((item: any) => {
        const sourceId = String(item.source_invoice_id ?? "");
        if (!sourceId || !paidSourceInvoiceIds.includes(sourceId)) return item;
        // A line posted through the approval flow mirrors a late_fee_charges row
        // and its waivers; it is never recomputed here (that would silently
        // re-price an approved fee and drop its waived_amount).
        if (item.late_fee_charge_id) return item;
        changed = true;
        const fresh = freshBySource.get(sourceId);
        const feeAmount = fresh ? toNumber(fresh.late_fee_snapshot_amount) : 0;
        if (feeAmount <= 0) return null;
        const daysOverdue = toNumber(fresh?.late_fee_snapshot_days);
        const dailyRate = toNumber(fresh?.late_fee_per_day);
        const windowAsOf = fresh?.late_fee_snapshot_as_of ?? valuationDate;
        const detail = buildLateFeeLineDetail(
          String(fresh?.start_date ?? ""),
          daysOverdue,
          dailyRate,
          windowAsOf,
        );
        return {
          ...item,
          detail,
          label: detail,
          total_amount: feeAmount,
          amount: feeAmount,
          days_overdue: daysOverdue,
          daily_rate: dailyRate,
          snapshot_as_of: windowAsOf,
          original_amount: feeAmount,
        };
      })
      .filter((item: any) => item !== null);

    if (!changed) continue;

    const carryForwardAmount = nextCarryItems.reduce(
      (sum: number, item: any) => sum + toNumber(item.total_amount),
      0,
    );
    const lateFeeItemsTotal = nextLateItems.reduce(
      (sum: number, item: any) => sum + toNumber(item.total_amount),
      0,
    );
    const otherFeesTotal = toChargeFeeRows(untouched).reduce(
      (sum: number, item: any) => sum + toNumber(item.total_amount ?? item.amount),
      0,
    );
    const nativeLateFee = computeLateFeeSnapshot(target, valuationDate).amount;

    const totalAmount = computeInvoiceTotal({
      rent: toNumber(target.rent_amount),
      water: toNumber(target.water_bill),
      electricity: toNumber(target.electricity_bill),
      commonFee: toNumber(target.common_fee),
      nativeLateFee,
      lateFeeItems: lateFeeItemsTotal,
      fees: otherFeesTotal,
      carryForward: carryForwardAmount,
      discount: toNumber(target.discount_amount),
    });

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        carry_forward_amount: carryForwardAmount,
        late_fee_amount: nativeLateFee + lateFeeItemsTotal,
        additional_fees_total: otherFeesTotal + lateFeeItemsTotal,
        additional_fees_breakdown: [...untouched, ...nextCarryItems, ...nextLateItems],
        total_amount: totalAmount,
      })
      .eq("id", target.id);
    if (updateError) throw new Error(updateError.message);

    refreshedInvoiceIds.push(String(target.id));
  }

  return { refreshedInvoiceIds };
}

/**
 * Whenever an invoice becomes fully PAID and freezes a late fee nobody has
 * billed yet, push that fee straight onto the tenant's next invoice — IF one
 * already exists and is still open for editing — instead of waiting for an
 * admin to notice it sitting in the "pull arrears from last month" checklist.
 *
 * This is the gap `refreshCarryForwardTargets` deliberately doesn't cover:
 * that function only refreshes a late-fee line that's already been added to a
 * target invoice, it never adds a brand-new one. Before this existed, a
 * tenant who paid an old invoice late — AFTER the next invoice had already
 * been generated for the new period — had their late fee sitting frozen and
 * correctly calculated, but invisible until someone opened that next invoice
 * and manually checked a box. The bulk monthly generator already does this
 * automatically for invoices it is creating for the first time (see
 * `generateInvoices` in use-invoices-state.ts); this is the equivalent for an
 * invoice that already exists.
 *
 * Deliberately narrow: only lands on an invoice whose status is still
 * `isInvoiceDetailEditable` (draft/pending/partial/overdue) — never `paid`,
 * `cancelled`, or `verifying` (a tenant-submitted slip is mid-review there;
 * silently changing the total out from under it would make the slip amount
 * stop matching). If no eligible target exists yet, the fee is simply left
 * unbilled — exactly as before — for the next generation cycle or a manual
 * recalculate to pick up once one does.
 */
export async function autoBillUnbilledLateFees(
  supabase: SupabaseClient,
  tenantId: string,
  paidInvoiceIds: string[],
): Promise<{ billedSourceIds: string[]; updatedTargetIds: string[] }> {
  const empty = { billedSourceIds: [], updatedTargetIds: [] };
  if (!tenantId || paidInvoiceIds.length === 0) return empty;

  // Late-fee approval rule (migration 20261002000800). With NO late_fee_policies
  // row (or no table) this function behaves exactly as before. Once the owner
  // creates a policy, a fee is no longer added silently: it waits on the
  // late-fee page for an admin, unless the governing policy opted in with
  // auto_post, in which case it is posted through post_late_fee_charge under
  // the identity "automation:auto_bill_on_paid".
  const { mode, policies } = await resolveLateFeeMode(supabase);
  if (mode === "approval") {
    const result = await autoPostLateFees(supabase, {
      tenantId,
      sourceInvoiceIds: paidInvoiceIds,
      policies,
      automationName: "auto_bill_on_paid",
      today: bangkokToday(),
      onlyPaid: true,
    });
    return { billedSourceIds: result.postedSourceIds, updatedTargetIds: [] };
  }

  const { data: sourceRows, error: sourceError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,status,start_date,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,late_fee_billed_at",
    )
    .in("id", paidInvoiceIds);
  if (sourceError) throw new Error(sourceError.message);

  const eligibleSources = (sourceRows ?? []).filter(
    (row: any) =>
      String(row.status ?? "") === "paid" &&
      row.late_fee_billed_at == null &&
      toNumber(row.locked_late_fee_amount) > 0,
  );
  if (eligibleSources.length === 0) return empty;

  const { data: tenantInvoices, error: targetError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,status,start_date,issue_date,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount,additional_fees_breakdown,discount_amount,total_amount",
    )
    .eq("tenant_id", tenantId)
    .order("start_date", { ascending: true });
  if (targetError) throw new Error(targetError.message);

  const editableTargets = ((tenantInvoices ?? []) as any[]).filter((row) =>
    isInvoiceDetailEditable(String(row.status ?? "")),
  );

  const billedSourceIds: string[] = [];
  const newItemsByTarget = new Map<string, any[]>();
  const targetById = new Map(editableTargets.map((row) => [String(row.id), row]));

  for (const source of eligibleSources) {
    // The tenant's very next invoice chronologically, among those still open
    // for editing — matching the same "one step forward" rule the manual
    // checkbox and the bulk generator both use. An already-closed invoice for
    // the immediately-following period is skipped over, not blocked on;
    // that's consistent with `getCarryForwardCandidatesForTarget`, which
    // likewise never restricts a candidate to only the very next period.
    const target = editableTargets.find(
      (row) => String(row.start_date) > String(source.start_date),
    );
    if (!target) continue;

    const feeAmount = toNumber(source.locked_late_fee_amount);
    if (feeAmount <= 0) continue;

    const dailyRate = toNumber(source.late_fee_per_day);
    const daysOverdue = dailyRate > 0 ? Math.round(feeAmount / dailyRate) : 0;
    const valuationDate = target.issue_date || target.start_date;
    const windowAsOf =
      daysOverdue > 0 && source.late_fee_start_date
        ? toDateOnlyText(
            addCalendarDays(toDateOnly(source.late_fee_start_date), daysOverdue - 1),
          )
        : valuationDate;
    const detail = buildLateFeeLineDetail(
      String(source.start_date ?? ""),
      daysOverdue,
      dailyRate,
      windowAsOf,
    );

    const targetId = String(target.id);
    const items = newItemsByTarget.get(targetId) ?? [];
    items.push({
      item_type: "late_fee_line",
      source_invoice_id: String(source.id),
      label: detail,
      detail,
      unit: daysOverdue,
      price_per_unit: dailyRate,
      total_amount: feeAmount,
      amount: feeAmount,
      days_overdue: daysOverdue,
      daily_rate: dailyRate,
      snapshot_as_of: windowAsOf,
      original_amount: feeAmount,
      waived_amount: 0,
    });
    newItemsByTarget.set(targetId, items);
    billedSourceIds.push(String(source.id));
  }

  const updatedTargetIds: string[] = [];
  for (const [targetId, newItems] of newItemsByTarget) {
    const target = targetById.get(targetId);
    if (!target) continue;

    const existingBreakdown: any[] = Array.isArray(target.additional_fees_breakdown)
      ? target.additional_fees_breakdown
      : [];
    const nextBreakdown = [...existingBreakdown, ...newItems];

    const lateFeeItemsTotal = toChargeFeeRows(
      nextBreakdown.filter(isLateFeeBreakdownRow),
    ).reduce((sum: number, item: any) => sum + toNumber(item.total_amount ?? item.amount), 0);
    const carryForwardAmount = toChargeFeeRows(
      nextBreakdown.filter(isCarryForwardBreakdownRow),
    ).reduce((sum: number, item: any) => sum + toNumber(item.total_amount ?? item.amount), 0);
    const otherFeesTotal = toChargeFeeRows(
      nextBreakdown.filter(
        (row) => !isCarryForwardBreakdownRow(row) && !isLateFeeBreakdownRow(row),
      ),
    ).reduce((sum: number, item: any) => sum + toNumber(item.total_amount ?? item.amount), 0);

    const valuationDate = target.issue_date || target.start_date;
    const nativeLateFee = computeLateFeeSnapshot(target, valuationDate).amount;

    const totalAmount = computeInvoiceTotal({
      rent: toNumber(target.rent_amount),
      water: toNumber(target.water_bill),
      electricity: toNumber(target.electricity_bill),
      commonFee: toNumber(target.common_fee),
      nativeLateFee,
      lateFeeItems: lateFeeItemsTotal,
      fees: otherFeesTotal,
      carryForward: carryForwardAmount,
      discount: toNumber(target.discount_amount),
    });

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        additional_fees_breakdown: nextBreakdown,
        late_fee_amount: nativeLateFee + lateFeeItemsTotal,
        additional_fees_total: otherFeesTotal + lateFeeItemsTotal,
        total_amount: totalAmount,
      })
      .eq("id", targetId);
    if (updateError) throw new Error(updateError.message);

    updatedTargetIds.push(targetId);
  }

  if (billedSourceIds.length > 0) {
    const { error: markError } = await supabase
      .from("invoices")
      .update({ late_fee_billed_at: new Date().toISOString() })
      .in("id", billedSourceIds)
      .is("late_fee_billed_at", null);
    if (markError) throw new Error(markError.message);
  }

  return { billedSourceIds, updatedTargetIds };
}

/**
 * Total still owed across an invoice and every invoice carried forward into it —
 * the same set `applyInvoicePaymentAllocation` would allocate against, and so
 * the amount it has left to work with.
 *
 * Callers that mark an invoice paid as a STATUS change (rather than because new
 * money arrived) must check this first. Flipping a paid invoice to another
 * status only rewrites `status`; it never reverses `paid_amount`, so the money
 * is still recorded. Sending that invoice back through the allocation path finds
 * nothing left to allocate and throws "This invoice chain is already fully
 * paid", which is correct for a payment but wrong for a status correction.
 *
 * Read-only: no `syncInvoiceLedger` call, because sync only touches `status` and
 * `locked_late_fee_amount`, neither of which affects this sum.
 */
export type ReplayInvoice = {
  id: string;
  total_amount: number | null;
  /** Oldest first. */
  start_date?: string | null;
  /**
   * Money already on this invoice that NO allocation row accounts for — a
   * payment recorded before `invoice_payment_allocations` existed, or written
   * straight to `paid_amount`. There is no batch to replay for it, so replay
   * treats it as a floor: it stays put, and only the remainder of the invoice
   * is open to allocation. Without this, replaying a chain that happens to
   * include a legacy-paid invoice would wipe that payment.
   */
  legacy_paid?: number | null;
};

export type ReplayBatch = {
  id: string;
  amount_received: number | null;
  paid_at: string;
  trigger_invoice_id?: string | null;
  slip_url?: string | null;
  source?: string | null;
  payment_method_id?: string | null;
  payment_method_snapshot?: any;
};

export type ReplayAllocation = {
  payment_batch_id: string;
  trigger_invoice_id: string | null;
  invoice_id: string;
  amount: number;
  paid_at: string;
  slip_url: string | null;
  source: string | null;
  payment_method_id: string | null;
  payment_method_snapshot: any;
};

/**
 * Divide already-received payments across invoices using their CURRENT amounts:
 * each batch in turn, oldest batch first, filling the oldest unpaid invoice
 * first — the same order `applyInvoicePaymentAllocation` uses when the money
 * first arrives.
 *
 * Pure, so the arithmetic is testable without a database. `invoices` must be
 * oldest period first and must already exclude cancelled invoices.
 */
export function planPaymentReplay(
  invoices: ReplayInvoice[],
  batches: ReplayBatch[],
): {
  allocations: ReplayAllocation[];
  paidByInvoiceId: Map<string, number>;
  /** Received money that no longer fits anywhere, because invoices were edited down. */
  unallocated: number;
} {
  // Legacy (unbacked) money is the starting balance, not zero — see
  // `ReplayInvoice.legacy_paid`.
  const paidByInvoiceId = new Map<string, number>(
    invoices.map((row) => [
      String(row.id),
      Math.max(0, toNumber(row.legacy_paid)),
    ]),
  );
  const allocations: ReplayAllocation[] = [];
  let unallocated = 0;

  for (const batch of batches) {
    let remaining = toNumber(batch.amount_received);
    for (const invoice of invoices) {
      if (remaining <= 0) break;
      const id = String(invoice.id);
      const outstanding = Math.max(
        0,
        toNumber(invoice.total_amount) - (paidByInvoiceId.get(id) ?? 0),
      );
      if (outstanding <= 0) continue;
      const allocated = Math.min(outstanding, remaining);
      paidByInvoiceId.set(id, (paidByInvoiceId.get(id) ?? 0) + allocated);
      remaining -= allocated;
      allocations.push({
        payment_batch_id: String(batch.id),
        trigger_invoice_id: batch.trigger_invoice_id
          ? String(batch.trigger_invoice_id)
          : null,
        invoice_id: id,
        amount: allocated,
        paid_at: batch.paid_at,
        slip_url: batch.slip_url ?? null,
        source: batch.source ?? null,
        payment_method_id: batch.payment_method_id ?? null,
        payment_method_snapshot: batch.payment_method_snapshot ?? null,
      });
    }
    // Money with nowhere left to go. Reported so the caller can surface it
    // rather than it vanishing silently.
    unallocated += Math.max(0, remaining);
  }

  return { allocations, paidByInvoiceId, unallocated };
}

/**
 * Re-derive how already-received money is split across a group of invoices,
 * using their CURRENT amounts.
 *
 * An allocation is computed once, when the payment is recorded, against the
 * invoice totals as they stood at that moment. Edit an invoice afterwards and
 * the split silently stops matching reality: room 116/1 took ฿6,481 against an
 * April invoice then worth ฿6,144, April was later corrected down to ฿3,244,
 * and the allocation still claimed ฿6,144 had gone to it — more than the
 * invoice was worth.
 *
 * What is immutable is the `payment_batches` row: the tenant really did
 * transfer that amount on that day into that account. How it divides across
 * invoices is derived, so it is safe — and necessary — to recompute.
 *
 * Replays every batch touching this group in date order, oldest invoice first,
 * exactly as `applyInvoicePaymentAllocation` would have. Returns without
 * writing if the result is identical to what is already stored.
 */
export async function reallocatePaymentsForInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{
  changed: boolean;
  /** Batch data could not be trusted; nothing written. See the guard below. */
  needsReview?: boolean;
  invoiceIds: string[];
  batchIds: string[];
  unallocated: number;
}> {
  // 1. Expand to the full settlement group: everything linked by carry-forward
  //    (in either direction) and everything sharing a payment batch with it.
  //    Iterated to a fixed point so a longer chain is captured whole.
  const invoiceIds = new Set<string>([invoiceId]);
  const batchIds = new Set<string>();

  for (let pass = 0; pass < 6; pass += 1) {
    const beforeInvoices = invoiceIds.size;
    const beforeBatches = batchIds.size;
    const ids = [...invoiceIds];

    const [carryForward, carryBack, allocs] = await Promise.all([
      supabase
        .from("invoice_carry_forwards")
        .select("source_invoice_id,target_invoice_id")
        .in("target_invoice_id", ids),
      supabase
        .from("invoice_carry_forwards")
        .select("source_invoice_id,target_invoice_id")
        .in("source_invoice_id", ids),
      supabase
        .from("invoice_payment_allocations")
        .select("payment_batch_id")
        .in("invoice_id", ids),
    ]);
    if (carryForward.error) throw new Error(carryForward.error.message);
    if (carryBack.error) throw new Error(carryBack.error.message);
    if (allocs.error) throw new Error(allocs.error.message);

    for (const row of [...(carryForward.data ?? []), ...(carryBack.data ?? [])]) {
      invoiceIds.add(String((row as any).source_invoice_id));
      invoiceIds.add(String((row as any).target_invoice_id));
    }
    for (const row of allocs.data ?? []) {
      if ((row as any).payment_batch_id) {
        batchIds.add(String((row as any).payment_batch_id));
      }
    }

    // Any invoice those batches also paid belongs to the group too.
    if (batchIds.size > 0) {
      const { data: siblings, error: siblingError } = await supabase
        .from("invoice_payment_allocations")
        .select("invoice_id")
        .in("payment_batch_id", [...batchIds]);
      if (siblingError) throw new Error(siblingError.message);
      for (const row of siblings ?? []) {
        invoiceIds.add(String((row as any).invoice_id));
      }
    }

    if (invoiceIds.size === beforeInvoices && batchIds.size === beforeBatches) {
      break;
    }
  }

  if (batchIds.size === 0) {
    return { changed: false, invoiceIds: [...invoiceIds], batchIds: [], unallocated: 0 };
  }

  // 2. Load the group.
  const [invoicesRes, batchesRes, existingRes] = await Promise.all([
    supabase
      .from("invoices")
      .select("id,total_amount,paid_amount,status,payment_history,due_date,start_date")
      .in("id", [...invoiceIds]),
    supabase
      .from("payment_batches")
      .select(
        "id,amount_received,paid_at,mode,source,slip_url,trigger_invoice_id,payment_method_id,payment_method_snapshot",
      )
      .in("id", [...batchIds]),
    supabase
      .from("invoice_payment_allocations")
      .select("id,payment_batch_id,invoice_id,amount")
      .in("payment_batch_id", [...batchIds]),
  ]);
  if (invoicesRes.error) throw new Error(invoicesRes.error.message);
  if (batchesRes.error) throw new Error(batchesRes.error.message);
  if (existingRes.error) throw new Error(existingRes.error.message);

  // Money on these invoices that no allocation row explains — payments made
  // before allocations were recorded, or written directly to `paid_amount`.
  // There is no batch to replay for it, so it must survive the replay rather
  // than being redistributed away. Measured against EVERY allocation on the
  // invoice, not just the batches being replayed.
  const { data: allAllocRows, error: allAllocError } = await supabase
    .from("invoice_payment_allocations")
    .select("invoice_id,amount")
    .in("invoice_id", [...invoiceIds]);
  if (allAllocError) throw new Error(allAllocError.message);

  const allocatedByInvoice = new Map<string, number>();
  for (const row of allAllocRows ?? []) {
    const id = String((row as any).invoice_id);
    allocatedByInvoice.set(
      id,
      (allocatedByInvoice.get(id) ?? 0) + toNumber((row as any).amount),
    );
  }

  // A cancelled invoice must not absorb money — the debt was written off.
  // Draft invoices DO take part: a draft can legitimately already hold a payment
  // (room 116/1's April invoice is exactly that). Their status is preserved
  // below, so taking part never publishes them.
  const invoices = (invoicesRes.data ?? [])
    .filter((row: any) => String(row.status ?? "") !== "cancelled")
    .map((row: any) => ({
      ...row,
      legacy_paid: Math.max(
        0,
        toNumber(row.paid_amount) - (allocatedByInvoice.get(String(row.id)) ?? 0),
      ),
    }))
    .sort((a: any, b: any) =>
      String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")),
    );
  const batches = (batchesRes.data ?? []).sort((a: any, b: any) =>
    new Date(a.paid_at).getTime() - new Date(b.paid_at).getTime(),
  );
  if (invoices.length === 0 || batches.length === 0) {
    return { changed: false, invoiceIds: [...invoiceIds], batchIds: [...batchIds], unallocated: 0 };
  }

  // 3. Replay against current amounts.
  const { allocations: nextAllocations, paidByInvoiceId: paidSoFar, unallocated } =
    planPaymentReplay(invoices as any[], batches as any[]);

  // SAFETY: if the batches carry more money than these invoices can absorb, the
  // batch data itself is untrustworthy — almost always duplicate receipts, which
  // this codebase produced for months by recording a fresh batch every time an
  // invoice's status was flipped back to paid. Redistributing that surplus does
  // real damage: it flows onto later invoices and marks genuinely unpaid months
  // as settled (room 114/1's May/June/July, overdue with nothing received, were
  // all marked paid this way). Refuse to write and let a human resolve the
  // duplicates first.
  if (unallocated > 0.005) {
    return {
      changed: false,
      needsReview: true,
      invoiceIds: [...invoiceIds],
      batchIds: [...batchIds],
      unallocated,
    };
  }

  // 4. No-op if the split is already correct.
  const key = (batchId: string, invId: string) => `${batchId}:${invId}`;
  const existingMap = new Map<string, number>();
  for (const row of existingRes.data ?? []) {
    existingMap.set(
      key(String((row as any).payment_batch_id), String((row as any).invoice_id)),
      toNumber((row as any).amount),
    );
  }
  const nextMap = new Map<string, number>();
  for (const row of nextAllocations) {
    nextMap.set(
      key(row.payment_batch_id, row.invoice_id),
      (nextMap.get(key(row.payment_batch_id, row.invoice_id)) ?? 0) + row.amount,
    );
  }
  let identical = existingMap.size === nextMap.size;
  if (identical) {
    for (const [k, v] of nextMap) {
      if (Math.abs((existingMap.get(k) ?? 0) - v) > 0.005) {
        identical = false;
        break;
      }
    }
  }
  if (identical) {
    return {
      changed: false,
      invoiceIds: [...invoiceIds],
      batchIds: [...batchIds],
      unallocated,
    };
  }

  // 5. Rewrite allocations for these batches, then bring each invoice's
  //    paid_amount, status and payment_history cache back in line.
  const { error: deleteError } = await supabase
    .from("invoice_payment_allocations")
    .delete()
    .in("payment_batch_id", [...batchIds]);
  if (deleteError) throw new Error(deleteError.message);

  if (nextAllocations.length > 0) {
    const { error: insertError } = await supabase
      .from("invoice_payment_allocations")
      .insert(
        nextAllocations.map((row) => ({
          ...row,
          created_at: new Date().toISOString(),
        })),
      );
    if (insertError) throw new Error(insertError.message);
  }

  const todayText = new Date().toISOString().slice(0, 10);
  for (const invoice of invoices as any[]) {
    const id = String(invoice.id);
    const nextPaid = paidSoFar.get(id) ?? 0;

    // Rebuild only the history entries belonging to the batches we just
    // rewrote; anything else (legacy entries with no batch) is left alone.
    const history = Array.isArray(invoice.payment_history)
      ? invoice.payment_history
      : [];
    const preserved = history.filter(
      (entry: any) => !batchIds.has(String(entry?.payment_batch_id ?? "")),
    );
    const regenerated = nextAllocations
      .filter((row) => row.invoice_id === id)
      .map((row) => {
        const batch = (batches as any[]).find(
          (b) => String(b.id) === row.payment_batch_id,
        );
        return {
          amount: row.amount,
          mode: batch?.mode ?? "full",
          paid_at: row.paid_at,
          slip_url: row.slip_url,
          created_at: new Date().toISOString(),
          source: row.source,
          payment_batch_id: row.payment_batch_id,
          trigger_invoice_id: row.trigger_invoice_id,
          payment_method: row.payment_method_snapshot,
          payment_method_id: row.payment_method_id,
        };
      });

    const nextStatus =
      // Cancelled is a written-off debt and draft is not yet issued; neither
      // should be republished as a side effect of re-deriving a split.
      ["cancelled", "draft"].includes(String(invoice.status ?? ""))
        ? String(invoice.status)
        : resolveInvoiceStatus(
            {
              total_amount: invoice.total_amount,
              paid_amount: nextPaid,
              due_date: invoice.due_date ?? null,
            },
            todayText,
          );

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        paid_amount: nextPaid,
        status: nextStatus,
        payment_history: [...preserved, ...regenerated],
      })
      .eq("id", id);
    if (updateError) throw new Error(updateError.message);
  }

  return {
    changed: true,
    invoiceIds: [...invoiceIds],
    batchIds: [...batchIds],
    unallocated,
  };
}

export async function getPaymentChainOutstanding(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<number> {
  const { data: carryRows, error: carryError } = await supabase
    .from("invoice_carry_forwards")
    .select("source_invoice_id")
    .eq("target_invoice_id", invoiceId);
  if (carryError) throw new Error(carryError.message);

  const chainIds = [
    invoiceId,
    ...(carryRows ?? []).map((row: any) => String(row.source_invoice_id)),
  ];

  const { data: rows, error } = await supabase
    .from("invoices")
    .select("id,total_amount,paid_amount")
    .in("id", chainIds);
  if (error) throw new Error(error.message);

  return (rows ?? []).reduce(
    (sum, row: any) => sum + getInvoiceOutstanding(row),
    0,
  );
}

export async function applyInvoicePaymentAllocation(
  supabase: SupabaseClient,
  options: ApplyPaymentOptions,
): Promise<ApplyPaymentResult> {
  const {
    invoiceId,
    amount,
    paidAt,
    slipUrl = null,
    mode = "full",
    source = "admin",
    idempotencyKey = null,
    paymentMethod = null,
    createdBy = null,
    keepExcessAsCredit = false,
  } = options;
  const safeAmount = Math.max(0, roundMoney(toNumber(amount)));
  if (safeAmount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const trimmedIdem = idempotencyKey?.trim() || null;
  // Hash of what was asked for (not of the computed split), so a real retry
  // replays and a reused key for a different payment is refused.
  const payloadHash = await paymentPayloadHash({
    kind: "auto",
    triggerInvoiceId: invoiceId,
    amount: safeAmount,
    keepExcessAsCredit,
    paidAt,
    mode,
    source,
    slipUrl: slipUrl ?? null,
    paymentMethodId: paymentMethod?.id ?? null,
  });
  if (trimmedIdem) {
    const existing = await findIdempotentPaymentResult(
      supabase,
      invoiceId,
      trimmedIdem,
      payloadHash,
    );
    if (existing) return existing;
  }

  const { data: targetInvoice, error: targetError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date",
    )
    .eq("id", invoiceId)
    .single();
  if (targetError || !targetInvoice) {
    throw new Error(targetError?.message ?? "Invoice not found.");
  }

  await syncInvoiceLedger(supabase, { invoiceIds: [invoiceId] });

  const { data: carryRows, error: carryError } = await supabase
    .from("invoice_carry_forwards")
    .select("source_invoice_id,target_invoice_id")
    .eq("target_invoice_id", invoiceId);
  if (carryError) throw new Error(carryError.message);

  const sourceInvoiceIds = (carryRows ?? []).map((row: any) =>
    String(row.source_invoice_id),
  );
  if (sourceInvoiceIds.length > 0) {
    await syncInvoiceLedger(supabase, { invoiceIds: sourceInvoiceIds });
  }

  const paymentTargets: any[] = [];
  if (sourceInvoiceIds.length > 0) {
    const { data: sourceInvoices, error: sourceError } = await supabase
      .from("invoices")
      .select(
        "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date,waived_late_fee_amount,locked_late_fee_amount,carry_forward_amount",
      )
      .in("id", sourceInvoiceIds)
      .order("start_date", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    paymentTargets.push(...(sourceInvoices ?? []));
  }

  const { data: freshTargetInvoice, error: refreshError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,start_date,waived_late_fee_amount,locked_late_fee_amount,carry_forward_amount",
    )
    .eq("id", invoiceId)
    .single();
  if (refreshError || !freshTargetInvoice) {
    throw new Error(refreshError?.message ?? "Invoice not found after sync.");
  }
  paymentTargets.push(freshTargetInvoice);

  // Freeze the receiving account now. Resolved from the tenant only if the
  // caller did not already resolve it — either way the value below is what gets
  // stored, and nothing downstream re-derives it.
  const resolvedMethod: ResolvedPaymentMethod =
    paymentMethod ??
    (await resolvePaymentMethodForTenant(
      supabase,
      (freshTargetInvoice as any).tenant_id,
    ));

  if (String((freshTargetInvoice as any).status ?? "") === "cancelled") {
    throw new Error("A cancelled invoice cannot receive a payment.");
  }
  // A cancelled carry-forward source owes nothing; record_payment_batch
  // refuses to allocate to it, so leave it out of the split.
  const payableTargets = paymentTargets.filter(
    (invoice) => String(invoice.status ?? "") !== "cancelled",
  );

  const totalOutstanding = roundMoney(
    payableTargets.reduce(
      (sum, invoice) => sum + getChainOwnOutstanding(invoice as ChainAllocationInput),
      0,
    ),
  );
  if (totalOutstanding <= 0) {
    throw new Error("This invoice chain is already fully paid.");
  }

  const paymentBatchId = crypto.randomUUID();
  const updates: {
    invoiceId: string;
    paid_amount: number;
    status: string;
    payment_history: any[];
    allocatedAmount: number;
    lockedLateFeeAmount?: number;
  }[] = [];
  const allocationRows: any[] = [];

  const revertSnapshots = new Map<string, InvoiceRowSnapshot>();
  for (const invoice of paymentTargets) {
    const id = String(invoice.id);
    revertSnapshots.set(id, {
      paid_amount: toNumber(invoice.paid_amount),
      payment_history: Array.isArray(invoice.payment_history)
        ? invoice.payment_history
        : [],
      status: String(invoice.status ?? ""),
      slip_url: (invoice as any).slip_url ?? null,
      slip_uploaded_at: (invoice as any).slip_uploaded_at ?? null,
      locked_late_fee_amount:
        (invoice as any).locked_late_fee_amount === undefined
          ? null
          : (invoice as any).locked_late_fee_amount,
    });
  }

  // Bug #4 fix: each invoice gets exactly its own allocated share, capped at
  // its own outstanding — never accumulating another invoice's share onto
  // this one. See allocatePaymentAcrossChain's doc comment for how this
  // regressed once before.
  const chainResults = allocatePaymentAcrossChain(
    payableTargets as ChainAllocationInput[],
    Math.min(safeAmount, totalOutstanding),
  );
  const chainAllocations = new Map(
    chainResults.map((result) => [result.id, result]),
  );
  // The exact sum of the (rounded) rows, so amount_allocated always equals the
  // allocation rows to the satang, as record_payment_batch requires.
  const amountToAllocate = sumAllocated(chainResults);
  const carryCtx = await loadCarryInContext(
    supabase,
    payableTargets.map((t: any) => String(t.id)),
  );
  const chainPaidOverrides = new Map<string, number>(
    chainResults.map((r) => [r.id, r.nextPaidAmount] as [string, number]),
  );

  for (const invoice of payableTargets) {
    const chainAllocation = chainAllocations.get(String(invoice.id));
    if (!chainAllocation) continue;

    const { allocated, nextPaidAmount } = chainAllocation;
    const paymentHistory = Array.isArray(invoice.payment_history)
      ? invoice.payment_history
      : [];
    const paymentEntry: Record<string, unknown> = {
      amount: allocated,
      mode,
      paid_at: paidAt,
      slip_url: slipUrl,
      created_at: new Date().toISOString(),
      source,
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
      // `payment_method` is what the reports read off the history entry. Before
      // this existed they fell through to the tenant's CURRENT account, so
      // re-assigning a room's account rewrote every past month's attribution.
      payment_method: resolvedMethod.snapshot,
      payment_method_id: resolvedMethod.id,
    };
    if (trimmedIdem) {
      paymentEntry.idempotency_key = trimmedIdem;
    }
    const nextStatus = resolveInvoiceStatusWithCarry(
      {
        total_amount: invoice.total_amount,
        paid_amount: nextPaidAmount,
        due_date: invoice.due_date,
        carry_forward_amount: (invoice as any).carry_forward_amount,
      },
      paidAt.slice(0, 10),
      settledCarriedInAmount(
        carryCtx.linksByTarget.get(String(invoice.id)) ?? [],
        carryCtx.sources,
        chainPaidOverrides,
        carryCtx.linksByTarget,
      ),
    );

    // Freeze the late fee right here, at the REAL payment date, the moment
    // this invoice becomes fully paid — not later, via some unrelated sweep.
    // `applyInvoicePaymentAllocation` used to never touch this column at all,
    // so a late fee only ever got frozen (and thus ever had a chance to be
    // billed) if the invoice happened to still be open when the next month's
    // invoice was generated. A tenant who paid a few days late — settling the
    // invoice before that ever happened — got no late fee frozen, meaning
    // nothing to bill, ever. Only freeze if nothing froze it already (e.g. an
    // earlier carry-forward), so this can't overwrite an existing lock.
    const lockedLateFeeAmount =
      nextStatus === "paid" &&
      (invoice.locked_late_fee_amount === null ||
        invoice.locked_late_fee_amount === undefined)
        ? calculateLateFeeAmount(invoice as InvoiceLike, paidAt.slice(0, 10))
        : undefined;

    updates.push({
      invoiceId: String(invoice.id),
      paid_amount: nextPaidAmount,
      status: nextStatus,
      payment_history: [...paymentHistory, paymentEntry],
      allocatedAmount: allocated,
      lockedLateFeeAmount,
    });

    allocationRows.push({
      payment_batch_id: paymentBatchId,
      trigger_invoice_id: invoiceId,
      invoice_id: invoice.id,
      amount: allocated,
      paid_at: paidAt,
      slip_url: slipUrl,
      source,
      payment_method_id: resolvedMethod.id,
      payment_method_snapshot: resolvedMethod.snapshot,
      created_at: new Date().toISOString(),
    });
  }

  // One atomic database call writes the receipt, every invoice update and the
  // allocations (all or nothing), replays a retried idempotency key, and fails
  // with STALE_INVOICE if another admin changed an invoice since we read it.
  const receiptAmount = keepExcessAsCredit ? safeAmount : amountToAllocate;
  if (receiptAmount > amountToAllocate && !(freshTargetInvoice as any).tenant_id) {
    // record_payment_batch would refuse it too (TENANT_REQUIRED); fail early and clearly.
    throw new Error("Cannot keep the excess as credit: the invoice has no tenant.");
  }
  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    "record_payment_batch",
    {
      p: {
        batch: {
          id: paymentBatchId,
          tenant_id: (freshTargetInvoice as any).tenant_id ?? null,
          trigger_invoice_id: invoiceId,
          amount_received: receiptAmount,
          amount_allocated: amountToAllocate,
          paid_at: paidAt,
          mode,
          source,
          slip_url: slipUrl,
          payment_method_id: resolvedMethod.id,
          payment_method_snapshot: resolvedMethod.snapshot,
          idempotency_key: trimmedIdem,
          created_by: createdBy,
          payload_hash: payloadHash,
        },
        invoices: updates.map((update) => {
          const seen = revertSnapshots.get(update.invoiceId)!;
          const row: Record<string, unknown> = {
            id: update.invoiceId,
            // Stale guard: the DB refuses the payment if either changed since
            // this read (a concurrent payment, void, or slip decision).
            expected_paid_amount: seen.paid_amount,
            expected_history_length: seen.payment_history.length,
            paid_amount: update.paid_amount,
            status: update.status,
            payment_history: update.payment_history,
          };
          if (update.lockedLateFeeAmount !== undefined) {
            row.locked_late_fee_amount = update.lockedLateFeeAmount;
          }
          // Slip belongs to the invoice it was submitted against only, and is
          // only ever set here, never cleared (see the note in git history).
          if (slipUrl && update.invoiceId === invoiceId) {
            row.slip_url = slipUrl;
            row.slip_uploaded_at = paidAt;
          }
          return row;
        }),
        allocations: allocationRows,
      },
    },
  );
  if (rpcError) throw new Error(rpcError.message);
  if ((rpcResult as any)?.replayed) {
    const replay = await findIdempotentPaymentResult(supabase, invoiceId, trimmedIdem ?? "", payloadHash);
    if (replay) return replay;
  }

  // Push any newly-frozen, still-unbilled late fee among the invoices this
  // payment just settled onto the tenant's next invoice, if one already
  // exists and is still open. See autoBillUnbilledLateFees for why this is
  // needed on top of the freeze itself.
  await autoBillUnbilledLateFees(
    supabase,
    String((freshTargetInvoice as any).tenant_id ?? ""),
    updates.map((item) => item.invoiceId),
  );

  const updatedInvoiceIds = updates.map((item) => item.invoiceId);
  const { data: updatedInvoices, error: updatedError } = await supabase
    .from("invoices")
    .select(
      "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount",
    )
    .in("id", updatedInvoiceIds);
  if (updatedError) throw new Error(updatedError.message);

  const allocationBreakdown: AllocationBreakdownRow[] = updates.map((u) => ({
    invoiceId: u.invoiceId,
    allocatedAmount: u.allocatedAmount,
    newPaidAmount: u.paid_amount,
    newStatus: u.status,
  }));

  return {
    paymentBatchId,
    paymentMethod: resolvedMethod,
    appliedAmount: amountToAllocate,
    updatedInvoices: updatedInvoices ?? [],
    allocationBreakdown,
  };
}

export type ManualAllocationEntry = {
  invoiceId: string;
  amount: number;
};

export type ApplyManualPaymentOptions = {
  tenantId: string;
  /** The admin's own chosen split — which invoice gets how much. */
  allocations: ManualAllocationEntry[];
  paidAt: string;
  slipUrl?: string | null;
  mode?: string;
  source?: string;
  idempotencyKey?: string | null;
  paymentMethod?: ResolvedPaymentMethod | null;
  createdBy?: string | null;
};

/**
 * Records one payment split across specific invoices by explicit admin
 * choice, instead of `applyInvoicePaymentAllocation`'s automatic
 * oldest-first split across one invoice's own carry-forward chain.
 *
 * Built for a tenant catching up on real arrears where the amount owed each
 * month doesn't cleanly resolve oldest-first — a lump sum or an installment
 * the admin wants to direct at specific months. Every other safety property
 * of the automatic path is unchanged: one real batch record, idempotency
 * (a retried request with the same key replays the original result instead
 * of double-charging), late-fee freezing on full payment, and a full
 * revert-on-error unwind. The only difference is who decides the split.
 *
 * Each entered amount is a hard cap at that invoice's own outstanding
 * balance — never silently truncated to fit. If an amount doesn't fit, the
 * caller finds out exactly which invoice and by how much, rather than
 * quietly getting a different result than what was typed.
 */
export async function applyManualInvoicePaymentAllocation(
  supabase: SupabaseClient,
  options: ApplyManualPaymentOptions,
): Promise<ApplyPaymentResult> {
  const {
    tenantId,
    allocations,
    paidAt,
    slipUrl = null,
    mode = "full",
    source = "admin",
    idempotencyKey = null,
    paymentMethod = null,
    createdBy = null,
  } = options;

  const cleanAllocations = allocations
    .map((row) => ({
      invoiceId: String(row.invoiceId ?? ""),
      amount: Math.max(0, roundMoney(toNumber(row.amount))),
    }))
    .filter((row) => row.invoiceId && row.amount > 0);
  if (cleanAllocations.length === 0) {
    throw new Error("เลือกอย่างน้อยหนึ่งใบแจ้งหนี้และระบุจำนวนเงิน");
  }
  const seenIds = new Set<string>();
  for (const row of cleanAllocations) {
    if (seenIds.has(row.invoiceId)) {
      throw new Error("เลือกใบแจ้งหนี้แต่ละใบได้เพียงครั้งเดียว");
    }
    seenIds.add(row.invoiceId);
  }

  const invoiceIds = cleanAllocations.map((row) => row.invoiceId);
  const triggerInvoiceId = invoiceIds[0];

  const trimmedIdem = idempotencyKey?.trim() || null;
  const payloadHash = await paymentPayloadHash({
    kind: "manual",
    tenantId,
    triggerInvoiceId,
    allocations: cleanAllocations,
    paidAt,
    mode,
    source,
    slipUrl: slipUrl ?? null,
    paymentMethodId: paymentMethod?.id ?? null,
  });
  if (trimmedIdem) {
    const existing = await findIdempotentPaymentResult(
      supabase,
      triggerInvoiceId,
      trimmedIdem,
      payloadHash,
    );
    if (existing) return existing;
  }

  await syncInvoiceLedger(supabase, { invoiceIds });

  const { data: invoiceRows, error: invoiceError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,total_amount,paid_amount,status,payment_history,slip_url,slip_uploaded_at,late_fee_amount,late_fee_per_day,late_fee_start_date,due_date,waived_late_fee_amount,locked_late_fee_amount",
    )
    .in("id", invoiceIds);
  if (invoiceError) throw new Error(invoiceError.message);
  if (!invoiceRows || invoiceRows.length !== invoiceIds.length) {
    throw new Error("ไม่พบใบแจ้งหนี้ที่เลือกบางรายการ");
  }

  const byId = new Map((invoiceRows as any[]).map((row) => [String(row.id), row]));

  for (const entry of cleanAllocations) {
    const invoice = byId.get(entry.invoiceId);
    if (String(invoice.tenant_id) !== tenantId) {
      throw new Error("ใบแจ้งหนี้ที่เลือกต้องเป็นของผู้เช่าคนเดียวกันทั้งหมด");
    }
    if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) {
      throw new Error(
        `ใบแจ้งหนี้ที่เลือกไม่สามารถรับชำระได้ในสถานะปัจจุบัน (${invoice.status})`,
      );
    }
    // Both sides are whole satang now, so compare exactly (the old 0.005
    // tolerance let through amounts record_payment_batch then rejected).
    const outstanding = roundMoney(getInvoiceOutstanding(invoice));
    if (entry.amount > outstanding) {
      throw new Error(
        `ยอดที่กรอกเกินยอดค้างชำระจริง — ค้างชำระ ${outstanding.toFixed(2)} บาท แต่กรอก ${entry.amount.toFixed(2)} บาท`,
      );
    }
  }

  const paymentBatchId = crypto.randomUUID();
  const resolvedMethod: ResolvedPaymentMethod =
    paymentMethod ?? (await resolvePaymentMethodForTenant(supabase, tenantId));

  const manualCarry = await loadCarryInContext(supabase, invoiceIds);
  const manualPaidOverrides = new Map<string, number>(
    cleanAllocations.map((a) => [
      a.invoiceId,
      roundMoney(toNumber(byId.get(a.invoiceId)?.paid_amount) + a.amount),
    ] as [string, number]),
  );

  const { payload, updates, amountToAllocate } = buildManualSplitPayload({
    batchId: paymentBatchId,
    tenantId,
    triggerInvoiceId,
    allocations: cleanAllocations,
    invoicesById: byId,
    paidAt,
    slipUrl,
    mode,
    source,
    idempotencyKey: trimmedIdem,
    payloadHash,
    method: resolvedMethod,
    createdBy,
    statusFor: (invoice: any, nextPaid) =>
      resolveInvoiceStatusWithCarry(
        {
          total_amount: invoice.total_amount,
          paid_amount: nextPaid,
          due_date: invoice.due_date,
          carry_forward_amount: (invoice as any).carry_forward_amount,
        },
        paidAt.slice(0, 10),
        settledCarriedInAmount(
          manualCarry.linksByTarget.get(String(invoice.id)) ?? [],
          manualCarry.sources,
          manualPaidOverrides,
          manualCarry.linksByTarget,
        ),
      ),
    lateFeeFor: (invoice) =>
      calculateLateFeeAmount(invoice as any, paidAt.slice(0, 10)),
  });

  // One atomic database call writes the receipt, every invoice update and the
  // allocations (all or nothing), replays a retried idempotency key, and fails
  // with STALE_INVOICE if another admin changed an invoice since we read it.
  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    "record_payment_batch",
    { p: payload },
  );
  if (rpcError) throw new Error(rpcError.message);
  if ((rpcResult as any)?.replayed) {
    const replay = await findIdempotentPaymentResult(
      supabase,
      triggerInvoiceId,
      trimmedIdem ?? "",
      payloadHash,
    );
    if (replay) return replay;
  }

  // Cascade: any later invoice bundling one of the invoices just paid as a
  // carried debt needs its own total refreshed too, or it would keep
  // showing the pre-payment figure until someone happened to open it and
  // click recalculate by hand.
  await refreshCarryForwardTargets(supabase, tenantId, invoiceIds);

  // Same reasoning as applyInvoicePaymentAllocation: push any newly-frozen,
  // still-unbilled late fee onto the tenant's next open invoice automatically.
  await autoBillUnbilledLateFees(supabase, tenantId, invoiceIds);

  const updatedInvoiceIds = updates.map((item) => item.invoiceId);
  const { data: updatedInvoices, error: updatedError } = await supabase
    .from("invoices")
    .select(
      "id,paid_amount,status,payment_history,slip_url,slip_uploaded_at,total_amount",
    )
    .in("id", updatedInvoiceIds);
  if (updatedError) throw new Error(updatedError.message);

  const allocationBreakdown: AllocationBreakdownRow[] = updates.map((u) => ({
    invoiceId: u.invoiceId,
    allocatedAmount: u.allocatedAmount,
    newPaidAmount: u.paid_amount,
    newStatus: u.status,
  }));

  return {
    paymentBatchId,
    paymentMethod: resolvedMethod,
    appliedAmount: amountToAllocate,
    updatedInvoices: updatedInvoices ?? [],
    allocationBreakdown,
  };
}
