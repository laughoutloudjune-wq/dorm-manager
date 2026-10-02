/**
 * One set of money-report definitions, used by the Reports screen, its CSV
 * exports, the dashboard and the daily digest, so the same word never means
 * two different numbers.
 *
 * Source of truth for "money received" is the receipt ledger:
 *   - payment_batches (a voided batch is no longer a receipt)
 *   - invoice_payment_allocations, summed as SIGNED amounts: a void appends a
 *     negative row (reverses_allocation_id -> original) rather than deleting,
 *     so original and reversal both stay listed and net to zero.
 * Never derive "collected" from invoices marked paid or from paid_amount.
 */

export type ReportBasis = "cash" | "billing";

export const BASIS_LABELS: Record<ReportBasis, { en: string; th: string }> = {
  cash: {
    en: "cash basis (by actual receipt date)",
    th: "ตามเงินเข้าจริง (ตามวันที่รับเงินจริง)",
  },
  billing: {
    en: "billing basis (by invoice period)",
    th: "ตามงวดบิล (ตามงวดของใบแจ้งหนี้)",
  },
};

export type ReportTermKey =
  | "billed"
  | "cashReceived"
  | "creditApplied"
  | "refundDue"
  | "refundPaid"
  | "waived"
  | "writtenOff";

export const REPORT_TERMS: Record<ReportTermKey, { en: string; th: string; definition: string }> = {
  billed: {
    en: "Billed",
    th: "ยอดเรียกเก็บ",
    definition: "Invoice totals for the period (billing basis).",
  },
  cashReceived: {
    en: "Cash received",
    th: "เงินที่รับจริง",
    definition:
      "Money that actually reached a bank account or cash box, from non-voided receipts net of reversals, filed by the date it was received.",
  },
  creditApplied: {
    en: "Credit applied",
    th: "หักเครดิต",
    definition: "Non-cash settlement (abandoned-room credit, credit balance). No money reached an account.",
  },
  refundDue: {
    en: "Refund due",
    th: "ยอดที่ต้องคืน",
    definition: "Amount owed back to a tenant at settlement, not yet paid out.",
  },
  refundPaid: {
    en: "Refund paid",
    th: "คืนเงินแล้ว",
    definition: "Money actually paid out to a tenant (non-voided refund payouts), by payout date.",
  },
  waived: {
    en: "Waived",
    th: "ยกเว้น",
    definition: "Charges forgiven by an admin adjustment (net of reversals). Not money received.",
  },
  writtenOff: {
    en: "Written off",
    th: "ตัดเป็นหนี้สูญ",
    definition: "Debt written off by an admin adjustment (net of reversals). Not money received.",
  },
};

/** Allocations grouped by the invoice's billing period. Never call this "cash received this month". */
export const BILLING_PERIOD_ALLOCATION_LABEL = {
  en: "Payments applied to this period's invoices",
  th: "ยอดตัดชำระของบิลงวดนี้",
};

export const labelTh = (key: ReportTermKey) => REPORT_TERMS[key].th;

/** Heading for a figure on a given basis, e.g. "เงินที่รับจริง — ตามเงินเข้าจริง (...)". */
export const withBasis = (key: ReportTermKey, basis: ReportBasis, lang: "th" | "en" = "th") =>
  `${REPORT_TERMS[key][lang]} — ${BASIS_LABELS[basis][lang]}`;

export type AllocationLike = {
  id?: string | null;
  payment_batch_id?: string | null;
  amount: number | string | null;
  paid_at?: string | null;
  source?: string | null;
  reverses_allocation_id?: string | null;
};

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (value: number) => Math.round(value * 100) / 100;

export const NON_CASH_SOURCES = ["abandon_room", "credit"];
const isNonCashSource = (source: string | null | undefined) =>
  NON_CASH_SOURCES.includes(String(source ?? "").trim());

export const isReversalRow = (row: AllocationLike) =>
  Boolean(row.reverses_allocation_id) || num(row.amount) < 0;

/**
 * Resolve the effective source of a row. A reversal row carries source 'void',
 * so it inherits the source of the allocation it reverses (a voided credit is
 * still credit, not cash).
 */
export function effectiveSource(row: AllocationLike, byId: Map<string, AllocationLike>): string {
  if (row.reverses_allocation_id) {
    const original = byId.get(String(row.reverses_allocation_id));
    if (original) return String(original.source ?? "");
  }
  return String(row.source ?? "");
}

/**
 * Drop receipts that belong to a voided batch but were never reversed by
 * negative rows (should not happen after void_payment_batch, but the batch
 * flag is authoritative). A voided batch that DOES have reversal rows keeps
 * all of them: signed rows already net to zero and both stay visible.
 */
export function dropUnreversedVoided<T extends AllocationLike>(rows: T[], voidedBatchIds: Iterable<string> = []): T[] {
  const voided = new Set([...voidedBatchIds].map(String));
  if (voided.size === 0) return rows;
  const hasReversal = new Set<string>();
  for (const row of rows) {
    if (isReversalRow(row) && row.payment_batch_id) hasReversal.add(String(row.payment_batch_id));
  }
  return rows.filter((row) => {
    const batch = row.payment_batch_id ? String(row.payment_batch_id) : "";
    return !(batch && voided.has(batch) && !hasReversal.has(batch));
  });
}

export type ReceiptSummary = {
  /** Net cash that reached an account: signed sum of cash-source rows. */
  cashReceived: number;
  /** Net non-cash credit settled. */
  creditApplied: number;
  /** Gross positive cash rows before reversals. */
  cashGross: number;
  /** Cash reversed by voids (<= 0). */
  cashReversed: number;
  /** Distinct receipts (batches) with positive cash. */
  receiptCount: number;
};

/**
 * `allRows` supplies the lookup for reversal-source resolution (originals may
 * sit outside the filtered window); `rows` is what is summed.
 */
export function summarizeAllocations(
  rows: AllocationLike[],
  voidedBatchIds: Iterable<string> = [],
  allRows: AllocationLike[] = rows,
): ReceiptSummary {
  const voidedSet = new Set([...voidedBatchIds].map(String));
  const live = dropUnreversedVoided(rows, voidedSet);
  const byId = new Map<string, AllocationLike>();
  for (const row of allRows) if (row.id) byId.set(String(row.id), row);

  let cashReceived = 0;
  let creditApplied = 0;
  let cashGross = 0;
  let cashReversed = 0;
  const batches = new Set<string>();
  for (const row of live) {
    const amount = num(row.amount);
    if (isNonCashSource(effectiveSource(row, byId))) {
      creditApplied += amount;
      continue;
    }
    cashReceived += amount;
    if (amount >= 0) {
      cashGross += amount;
      const batchId = String(row.payment_batch_id ?? row.id ?? "");
      if (!voidedSet.has(batchId)) batches.add(batchId);
    } else {
      cashReversed += amount;
    }
  }
  return {
    cashReceived: round2(cashReceived),
    creditApplied: round2(creditApplied),
    cashGross: round2(cashGross),
    cashReversed: round2(cashReversed),
    receiptCount: batches.size,
  };
}

/** YYYY-MM of a timestamp string, using the same string-slice convention as the rest of the app. */
export const monthOf = (value: string | null | undefined) => String(value ?? "").slice(0, 7);

/** Cash basis: summarize rows received in `month` (by paid_at). */
export function summarizeByReceiptMonth(rows: AllocationLike[], month: string, voidedBatchIds: Iterable<string> = []) {
  return summarizeAllocations(
    rows.filter((row) => monthOf(row.paid_at) === month),
    voidedBatchIds,
    rows,
  );
}

/** Cash received per month key (cash basis). */
export function cashReceivedByMonth(rows: AllocationLike[], voidedBatchIds: Iterable<string> = []): Map<string, number> {
  const months = new Set(rows.map((r) => monthOf(r.paid_at)));
  const out = new Map<string, number>();
  for (const month of months) out.set(month, summarizeByReceiptMonth(rows, month, voidedBatchIds).cashReceived);
  return out;
}

export type AdjustmentLike = {
  id?: string | null;
  type: string;
  amount: number | string | null;
  reverses_adjustment_id?: string | null;
};

/** Waived / written-off totals, net of reversals (a reversal inherits its original's type). */
export function summarizeAdjustments(rows: AdjustmentLike[]) {
  const byId = new Map<string, AdjustmentLike>();
  for (const row of rows) if (row.id) byId.set(String(row.id), row);
  let waived = 0;
  let writtenOff = 0;
  for (const row of rows) {
    const type =
      row.type === "reversal" && row.reverses_adjustment_id
        ? byId.get(String(row.reverses_adjustment_id))?.type
        : row.type;
    if (type === "waiver") waived += num(row.amount);
    else if (type === "write_off") writtenOff += num(row.amount);
  }
  return { waived: round2(waived), writtenOff: round2(writtenOff) };
}

export type RefundPayoutLike = { amount: number | string | null; voided_at?: string | null };

export const sumRefundPaid = (rows: RefundPayoutLike[]) =>
  round2(rows.filter((r) => !r.voided_at).reduce((s, r) => s + num(r.amount), 0));

/**
 * Receipt ledger rows in [fromIso, toIso) by actual receipt date, plus the ids
 * of voided batches. Used by the dashboard, the LIFF dashboard and the digest
 * so "collected" is computed once, from receipts, never from paid invoices.
 * Falls back gracefully on a DB that predates the void migration.
 */
export async function fetchReceiptLedger(
  supabase: any,
  fromIso: string,
  toIso: string,
): Promise<{ rows: AllocationLike[]; voidedBatchIds: string[]; error: string | null }> {
  const run = (columns: string) =>
    supabase.from("invoice_payment_allocations").select(columns).gte("paid_at", fromIso).lt("paid_at", toIso);
  let res = await run("id,payment_batch_id,amount,paid_at,source,reverses_allocation_id");
  if (res.error && isMissingSchemaError(res.error)) res = await run("id,payment_batch_id,amount,paid_at,source");
  if (res.error) return { rows: [], voidedBatchIds: [], error: res.error.message };
  const rows = (res.data ?? []) as AllocationLike[];

  const voidedBatchIds: string[] = [];
  const batchIds = [...new Set(rows.map((r) => String(r.payment_batch_id ?? "")).filter(Boolean))];
  for (let i = 0; i < batchIds.length; i += 200) {
    const voidRes = await supabase
      .from("payment_batches")
      .select("id")
      .in("id", batchIds.slice(i, i + 200))
      .not("voided_at", "is", null);
    if (voidRes.error) {
      if (isMissingSchemaError(voidRes.error)) break;
      return { rows, voidedBatchIds, error: voidRes.error.message };
    }
    for (const row of voidRes.data ?? []) voidedBatchIds.push(String((row as any).id));
  }
  return { rows, voidedBatchIds, error: null };
}

/** True if a Supabase error is about a missing column/table (migration not applied yet). */
export const isMissingSchemaError = (error: { message?: string; code?: string } | null | undefined) => {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  return (
    /42703|42p01|pgrst204|pgrst200|pgrst205/.test(text) ||
    /column .* does not exist|could not find|relation .* does not exist|schema cache/.test(text)
  );
};
