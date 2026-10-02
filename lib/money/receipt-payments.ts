/**
 * Display-only split of an invoice's payment_history cache into payments that
 * count as received and payments that were reversed (voided). A void appends a
 * `type: "void"` entry pointing at the batch (payment_batch_id); the original
 * entry stays in the list, so it must be recognised and NOT counted.
 */
export type ReceiptHistoryEntry = Record<string, any>;

export type ClassifiedReceiptPayments = {
  active: ReceiptHistoryEntry[];
  reversed: Array<ReceiptHistoryEntry & { reversedReason: string | null }>;
  /** paid_at of the latest payment that still counts, or null. */
  lastActivePaidAt: string | null;
};

export function classifyReceiptPayments(history: unknown): ClassifiedReceiptPayments {
  const list: ReceiptHistoryEntry[] = Array.isArray(history) ? history : [];
  const voidedBatches = new Map<string, string | null>();
  for (const e of list) {
    if (String(e?.type ?? "") === "void" && e.payment_batch_id) {
      voidedBatches.set(String(e.payment_batch_id), e.reason ?? null);
    }
  }
  const active: ReceiptHistoryEntry[] = [];
  const reversed: ClassifiedReceiptPayments["reversed"] = [];
  for (const e of list) {
    if (String(e?.type ?? "") === "void") continue;
    const batch = e?.payment_batch_id ? String(e.payment_batch_id) : null;
    const isReversed = !!e?.reversed_at || (batch != null && voidedBatches.has(batch));
    if (isReversed) {
      reversed.push({ ...e, reversedReason: (batch != null ? voidedBatches.get(batch) : null) ?? e?.reversal_reason ?? null });
    } else {
      active.push(e);
    }
  }
  const last = active[active.length - 1];
  return { active, reversed, lastActivePaidAt: last?.paid_at ?? null };
}

/** Sources where no money reached a bank account (mirrors isNonCashPaymentSource). */
const NON_CASH_SOURCES = ["abandon_room", "credit"];
const isNonCash = (source: unknown) => NON_CASH_SOURCES.includes(String(source ?? "").trim());
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export type ReceiptAllocationRow = {
  id?: string | null;
  invoice_id?: string | null;
  amount?: number | string | null;
  paid_at?: string | null;
  source?: string | null;
  reverses_allocation_id?: string | null;
  reversed_at?: string | null;
  reversal_reason?: string | null;
};

export type ReceiptPaymentSummary = {
  /** allocations = ledger; history = cache fallback; legacy = paid_amount only. */
  basis: "allocations" | "history" | "legacy";
  /** Confirmed cash received for this invoice, reversals netted. */
  cashReceived: number;
  /** Non-cash credit applied (abandon_room / credit), shown separately. */
  creditApplied: number;
  /** Amount to print on the "paid" line (legacy: invoices.paid_amount). */
  printedAmount: number;
  reversed: Array<{ paid_at: string | null; amount: number; reversedReason: string | null }>;
  lastActivePaidAt: string | null;
};

/**
 * The receipt's "amount paid": confirmed cash for this invoice from
 * invoice_payment_allocations (reversals netted), never invoices.paid_amount.
 * `allocations` is null when the allocation query failed (columns missing etc.),
 * in which case the payment_history cache is used instead.
 */
export function summarizeReceiptPayments(input: {
  invoiceId: string;
  allocations: ReceiptAllocationRow[] | null;
  history: unknown;
  paidAmount: unknown;
}): ReceiptPaymentSummary {
  const { allocations, history } = input;
  if (allocations === null) {
    const c = classifyReceiptPayments(history);
    let cash = 0;
    let credit = 0;
    for (const e of c.active) {
      if (isNonCash(e?.source)) credit += num(e?.amount);
      else cash += num(e?.amount);
    }
    return {
      basis: "history",
      cashReceived: cash,
      creditApplied: credit,
      printedAmount: cash,
      reversed: c.reversed.map((e) => ({ paid_at: e?.paid_at ?? null, amount: num(e?.amount), reversedReason: e.reversedReason })),
      lastActivePaidAt: c.lastActivePaidAt,
    };
  }

  const mine = allocations.filter((a) => a.invoice_id == null || String(a.invoice_id) === input.invoiceId);
  if (mine.length === 0) {
    return {
      basis: "legacy",
      cashReceived: 0,
      creditApplied: 0,
      printedAmount: num(input.paidAmount),
      reversed: [],
      lastActivePaidAt: null,
    };
  }
  const reversedIds = new Map<string, string | null>();
  for (const a of mine) {
    if (a.reverses_allocation_id) reversedIds.set(String(a.reverses_allocation_id), a.reversal_reason ?? null);
  }
  let cash = 0;
  let credit = 0;
  let last: string | null = null;
  const reversed: ReceiptPaymentSummary["reversed"] = [];
  const real = mine.filter((a) => !a.reverses_allocation_id && num(a.amount) > 0);
  real.sort((a, b) => String(a.paid_at ?? "").localeCompare(String(b.paid_at ?? "")));
  for (const a of real) {
    const isRev = !!a.reversed_at || (a.id != null && reversedIds.has(String(a.id)));
    if (isRev) {
      reversed.push({
        paid_at: a.paid_at ?? null,
        amount: num(a.amount),
        reversedReason: (a.id != null ? reversedIds.get(String(a.id)) : null) ?? a.reversal_reason ?? null,
      });
      continue;
    }
    if (isNonCash(a.source)) credit += num(a.amount);
    else {
      cash += num(a.amount);
      last = a.paid_at ?? last;
    }
  }
  return { basis: "allocations", cashReceived: cash, creditApplied: credit, printedAmount: cash, reversed, lastActivePaidAt: last };
}
