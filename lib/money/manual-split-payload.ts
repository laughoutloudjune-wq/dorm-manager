/**
 * Pure builder for the `record_payment_batch` payload of an admin-chosen
 * (manual) split. No database, no clock except the injectable `now`.
 * Status and late-fee freezing are passed in so this file stays free of
 * lib/invoice-ledger.ts (which imports it).
 */

export type ManualSplitInvoice = {
  id: string;
  total_amount: unknown;
  paid_amount: unknown;
  payment_history?: unknown;
  locked_late_fee_amount?: unknown;
  [key: string]: unknown;
};

export type ManualSplitMethod = { id: string | null; snapshot: unknown };

export type ManualSplitInput = {
  batchId: string;
  tenantId: string;
  triggerInvoiceId: string;
  allocations: Array<{ invoiceId: string; amount: number }>;
  invoicesById: Map<string, ManualSplitInvoice>;
  paidAt: string;
  slipUrl: string | null;
  mode: string;
  source: string;
  idempotencyKey: string | null;
  method: ManualSplitMethod;
  createdBy: string | null;
  statusFor: (invoice: ManualSplitInvoice, nextPaidAmount: number) => string;
  lateFeeFor: (invoice: ManualSplitInvoice) => number;
  now?: () => string;
};

export type ManualSplitUpdate = {
  invoiceId: string;
  paid_amount: number;
  status: string;
  payment_history: unknown[];
  allocatedAmount: number;
  lockedLateFeeAmount?: number;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildManualSplitPayload(input: ManualSplitInput) {
  const now = input.now ?? (() => new Date().toISOString());
  const updates: ManualSplitUpdate[] = [];
  const allocationRows: Record<string, unknown>[] = [];
  const invoiceRows: Record<string, unknown>[] = [];

  for (const entry of input.allocations) {
    const invoice = input.invoicesById.get(entry.invoiceId);
    if (!invoice) throw new Error(`invoice ${entry.invoiceId} missing`);
    const allocated = round2(entry.amount);
    const currentPaid = num(invoice.paid_amount);
    const nextPaid = Math.min(num(invoice.total_amount), currentPaid + allocated);
    const history = Array.isArray(invoice.payment_history) ? invoice.payment_history : [];
    const paymentEntry: Record<string, unknown> = {
      amount: allocated,
      mode: input.mode,
      paid_at: input.paidAt,
      slip_url: input.slipUrl,
      created_at: now(),
      source: input.source,
      payment_batch_id: input.batchId,
      trigger_invoice_id: input.triggerInvoiceId,
      payment_method: input.method.snapshot,
      payment_method_id: input.method.id,
    };
    if (input.idempotencyKey) paymentEntry.idempotency_key = input.idempotencyKey;

    const status = input.statusFor(invoice, nextPaid);
    const locked =
      status === "paid" &&
      (invoice.locked_late_fee_amount === null || invoice.locked_late_fee_amount === undefined)
        ? input.lateFeeFor(invoice)
        : undefined;
    const nextHistory = [...history, paymentEntry];

    updates.push({
      invoiceId: entry.invoiceId,
      paid_amount: nextPaid,
      status,
      payment_history: nextHistory,
      allocatedAmount: allocated,
      lockedLateFeeAmount: locked,
    });

    const row: Record<string, unknown> = {
      id: entry.invoiceId,
      expected_paid_amount: currentPaid,
      paid_amount: nextPaid,
      status,
      payment_history: nextHistory,
    };
    if (locked !== undefined) row.locked_late_fee_amount = locked;
    if (input.slipUrl && entry.invoiceId === input.triggerInvoiceId) {
      row.slip_url = input.slipUrl;
      row.slip_uploaded_at = input.paidAt;
    }
    invoiceRows.push(row);

    allocationRows.push({
      invoice_id: entry.invoiceId,
      amount: allocated,
      slip_url: input.slipUrl,
      source: input.source,
      payment_method_id: input.method.id,
      payment_method_snapshot: input.method.snapshot,
    });
  }

  const total = round2(input.allocations.reduce((s, e) => s + round2(e.amount), 0));
  const payload = {
    batch: {
      id: input.batchId,
      tenant_id: input.tenantId,
      trigger_invoice_id: input.triggerInvoiceId,
      amount_received: total,
      amount_allocated: total,
      paid_at: input.paidAt,
      mode: input.mode,
      source: input.source,
      slip_url: input.slipUrl,
      payment_method_id: input.method.id,
      payment_method_snapshot: input.method.snapshot,
      idempotency_key: input.idempotencyKey,
      created_by: input.createdBy,
    },
    invoices: invoiceRows,
    allocations: allocationRows,
  };
  return { payload, updates, amountToAllocate: total };
}
