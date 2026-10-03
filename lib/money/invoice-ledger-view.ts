/**
 * Pure view-model builder for the admin invoice "Payments" tab. REPORT ONLY:
 * it arranges receipts (payment batches) with all their allocation rows,
 * including voided receipts and their reversal rows, and compares the stored
 * invoices.paid_amount with the balance derived from signed allocations. It
 * never fixes anything.
 */
import {
  UNKNOWN_PAYMENT_METHOD,
  isNonCashPaymentSource,
  paymentMethodSnapshotLabel,
  paymentSourceLabel,
} from "@/lib/invoice-utils";

export type LedgerAllocationInput = {
  id: string;
  payment_batch_id: string;
  invoice_id: string;
  /** Signed: reversal rows are negative. */
  amount: number | string | null;
  created_at?: string | null;
  paid_at?: string | null;
  slip_url?: string | null;
  source?: string | null;
  reverses_allocation_id?: string | null;
  reversal_reason?: string | null;
  payment_method_snapshot?: unknown;
  /** Display info for the invoice this row belongs to. */
  period?: string | null;
  room_number?: string | null;
  /**
   * Row only supplies running-balance context (an allocation from a receipt
   * other than the ones being shown). It is counted for balances but never
   * rendered as a receipt.
   */
  context_only?: boolean;
};

export type LedgerBatchInput = {
  id: string;
  amount_received?: number | string | null;
  paid_at?: string | null;
  slip_url?: string | null;
  source?: string | null;
  payment_method_snapshot?: unknown;
  voided_at?: string | null;
  void_reason?: string | null;
};

export type LedgerInvoiceInput = {
  id: string;
  total_amount: number | string | null;
  paid_amount: number | string | null;
};

export type ReceiptKind = "cash" | "credit" | "waived" | "written_off";

/** Thai labels, consistent with the neighbouring payment cards. */
export const LEDGER_LABELS = {
  billed: "ยอดเรียกเก็บ",
  cash_received: "รับเงินจริง",
  credit_applied: "หักเครดิต",
  waived: "ยกเว้นให้",
  written_off: "ตัดหนี้สูญ",
  invoice_balance: "ยอดค้างตามใบแจ้งหนี้",
  ledger_balance: "ยอดค้างตามบัญชีใบรับเงิน",
  voided: "ยกเลิกแล้ว",
  reversal: "กลับรายการ",
  legacy: "ไม่มีบันทึกใบรับเงิน (ข้อมูลเดิม)",
} as const;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export const receiptKindForSource = (source: string | null | undefined): ReceiptKind => {
  const key = String(source ?? "").trim().toLowerCase();
  if (/^waive/.test(key)) return "waived";
  if (/^write_?off/.test(key)) return "written_off";
  if (isNonCashPaymentSource(key)) return "credit";
  return "cash";
};

export type LedgerRow = {
  id: string;
  invoiceId: string;
  isThisInvoice: boolean;
  period: string;
  roomNumber: string;
  /** Signed amount. */
  amount: number;
  isReversal: boolean;
  /** Remaining balance of that invoice after this row (total minus cumulative signed allocations). */
  remainingAfter: number | null;
};

export type LedgerReceipt = {
  batchId: string;
  paidAt: string | null;
  amountReceived: number;
  source: string | null;
  sourceLabel: string;
  kind: ReceiptKind;
  isCash: boolean;
  accountLabel: string;
  accountKnown: boolean;
  slipUrls: string[];
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  /** Original rows followed by reversal rows. */
  rows: LedgerRow[];
  /** Net signed amount applied to the open invoice (0 once fully reversed). */
  appliedHere: number;
};

export type BalanceState = "consistent" | "discrepancy" | "legacy_no_allocations";

export type InvoiceLedgerView = {
  billed: number;
  cashReceived: number;
  creditApplied: number;
  waived: number;
  writtenOff: number;
  invoiceBalance: number;
  /** Carried-in debt already settled on its source invoice (inside billed, not in the balances). */
  carriedInSettled: number;
  ledgerBalance: number;
  /** invoiceBalance - ledgerBalance; null unless state is "discrepancy". */
  discrepancy: number | null;
  state: BalanceState;
  receipts: LedgerReceipt[];
};

export function buildInvoiceLedgerView(input: {
  invoice: LedgerInvoiceInput;
  allocations: LedgerAllocationInput[];
  batches: LedgerBatchInput[];
  /** total_amount of every invoice that appears in `allocations`, keyed by id. */
  invoiceTotals?: Record<string, number | string | null>;
  /**
   * Carried-in debt (inside total_amount) whose SOURCE invoice is fully settled; it was
   * paid on that invoice's allocations. Reduces both balances equally, so it never
   * creates or hides a discrepancy (lib/money/carry-in.ts).
   */
  carriedInSettled?: number;
}): InvoiceLedgerView {
  const { invoice, allocations, batches } = input;
  const totals = new Map<string, number>(
    Object.entries(input.invoiceTotals ?? {}).map(([k, v]) => [k, num(v)]),
  );
  totals.set(invoice.id, num(invoice.total_amount));

  const batchById = new Map(batches.map((b) => [String(b.id), b]));
  const allocById = new Map(allocations.map((a) => [String(a.id), a]));

  // Running balance per invoice: order by created_at, then original input order.
  const orderIndex = new Map(allocations.map((a, i) => [a.id, i]));
  const ordered = [...allocations].sort((a, b) => {
    const c = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    return c !== 0 ? c : (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });
  const cumulative = new Map<string, number>();
  const remainingAfter = new Map<string, number | null>();
  for (const a of ordered) {
    const next = round2((cumulative.get(a.invoice_id) ?? 0) + num(a.amount));
    cumulative.set(a.invoice_id, next);
    remainingAfter.set(a.id, totals.has(a.invoice_id) ? round2(num(totals.get(a.invoice_id)) - next) : null);
  }

  /** A row's kind is the kind of its receipt; a reversal inherits it. */
  const sourceOf = (a: LedgerAllocationInput): string | null => {
    const batchSource = batchById.get(a.payment_batch_id)?.source;
    if (batchSource) return batchSource;
    if (a.source && a.source !== "void") return a.source;
    if (a.reverses_allocation_id) return allocById.get(a.reverses_allocation_id)?.source ?? null;
    return a.source ?? null;
  };

  const shown = ordered.filter((a) => !a.context_only);
  const receiptsMap = new Map<string, LedgerReceipt>();
  const batchIds = new Set<string>([...batches.map((b) => String(b.id)), ...shown.map((a) => a.payment_batch_id)]);
  for (const batchId of batchIds) {
    const batch = batchById.get(batchId);
    const rowsRaw = shown.filter((a) => a.payment_batch_id === batchId);
    const first = rowsRaw.find((a) => !a.reverses_allocation_id) ?? rowsRaw[0];
    const source = batch?.source ?? (first ? sourceOf(first) : null);
    const kind = receiptKindForSource(source);
    const accountLabel = paymentMethodSnapshotLabel(
      batch?.payment_method_snapshot ?? first?.payment_method_snapshot ?? null,
    );
    const slips = new Set<string>();
    if (batch?.slip_url) slips.add(batch.slip_url);
    for (const a of rowsRaw) if (a.slip_url && !a.reverses_allocation_id) slips.add(a.slip_url);

    const rows: LedgerRow[] = rowsRaw
      .map((a) => ({
        id: a.id,
        invoiceId: a.invoice_id,
        isThisInvoice: a.invoice_id === invoice.id,
        period: a.period ?? "-",
        roomNumber: a.room_number ?? "-",
        amount: num(a.amount),
        isReversal: Boolean(a.reverses_allocation_id) || num(a.amount) < 0,
        remainingAfter: remainingAfter.get(a.id) ?? null,
      }))
      // originals first, then reversals; stable within each group
      .sort((a, b) => Number(a.isReversal) - Number(b.isReversal));

    const positives = rows.filter((r) => !r.isReversal).reduce((s, r) => s + r.amount, 0);
    receiptsMap.set(batchId, {
      batchId,
      paidAt: batch?.paid_at ?? first?.paid_at ?? null,
      amountReceived: num(batch?.amount_received) > 0 ? num(batch?.amount_received) : round2(positives),
      source,
      sourceLabel: paymentSourceLabel(source),
      kind,
      isCash: kind === "cash",
      accountLabel,
      accountKnown: accountLabel !== UNKNOWN_PAYMENT_METHOD,
      slipUrls: [...slips],
      voided: Boolean(batch?.voided_at) || rows.some((r) => r.isReversal),
      voidedAt: batch?.voided_at ?? null,
      voidReason: batch?.void_reason ?? rowsRaw.find((a) => a.reversal_reason)?.reversal_reason ?? null,
      rows,
      appliedHere: round2(rows.filter((r) => r.isThisInvoice).reduce((s, r) => s + r.amount, 0)),
    });
  }

  const receipts = [...receiptsMap.values()].sort(
    (a, b) => new Date(b.paidAt ?? 0).getTime() - new Date(a.paidAt ?? 0).getTime(),
  );

  const sums: Record<ReceiptKind, number> = { cash: 0, credit: 0, waived: 0, written_off: 0 };
  let signedHere = 0;
  let anyHere = false;
  for (const a of allocations) {
    if (a.invoice_id !== invoice.id) continue;
    anyHere = true;
    const amt = num(a.amount);
    signedHere += amt;
    sums[receiptKindForSource(sourceOf(a))] += amt;
  }

  const total = num(invoice.total_amount);
  const paid = num(invoice.paid_amount);
  const carriedIn = Math.max(0, num(input.carriedInSettled));
  const invoiceBalance = Math.max(0, round2(total - paid - carriedIn));
  const ledgerBalance = Math.max(0, round2(total - signedHere - carriedIn));
  const diff = round2(signedHere - paid);

  let state: BalanceState = "consistent";
  if (!anyHere && paid > 0) state = "legacy_no_allocations";
  else if (Math.abs(diff) >= 0.01) state = "discrepancy";

  return {
    billed: total,
    cashReceived: round2(sums.cash),
    creditApplied: round2(sums.credit),
    waived: round2(sums.waived),
    writtenOff: round2(sums.written_off),
    invoiceBalance,
    ledgerBalance,
    carriedInSettled: carriedIn,
    discrepancy: state === "discrepancy" ? diff : null,
    state,
    receipts,
  };
}

export type VoidPreview = {
  paidBefore: number;
  paidAfter: number;
  affected: { period: string; roomNumber: string; amount: number }[];
};

/** What voiding a receipt will do to the open invoice and which periods it touches. */
export function buildVoidPreview(receipt: LedgerReceipt, paidAmount: number | string | null): VoidPreview {
  const before = num(paidAmount);
  const affected = receipt.rows
    .filter((r) => !r.isReversal)
    .map((r) => ({ period: r.period, roomNumber: r.roomNumber, amount: r.amount }));
  const hereOriginals = receipt.rows
    .filter((r) => r.isThisInvoice && !r.isReversal)
    .reduce((s, r) => s + r.amount, 0);
  return { paidBefore: before, paidAfter: round2(before - hereOriginals), affected };
}

export function voidPreviewText(preview: VoidPreview, fmt: (n: number) => string = (n) => String(n)): string {
  const periods = preview.affected.length
    ? preview.affected.map((a) => `งวด ${a.period} (${fmt(a.amount)})`).join(", ")
    : "-";
  return `ยอดชำระใบนี้: ${fmt(preview.paidBefore)} -> ${fmt(preview.paidAfter)}\nงวดที่ได้รับผลกระทบ: ${periods}`;
}
