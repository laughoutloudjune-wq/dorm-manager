/**
 * Tiny in-memory ledger simulation used ONLY by scenario tests.
 * Mirrors the shape of the real tables (invoices, payment_batches,
 * invoice_payment_allocations) so reconciliation-checks can run over it.
 * It composes the real planner (planReceiptAllocation); it is not production code.
 */
import { planReceiptAllocation } from "./allocation";
import type { AllocationRow, BatchRow, InvoiceRow, ReconciliationInput } from "./reconciliation-checks";

export type SimInvoice = {
  id: string;
  periodStart: string;
  total: number;
  paid: number;
  status: string;
  history: Array<Record<string, unknown>>;
};

export type SimLedger = {
  invoices: SimInvoice[];
  batches: BatchRow[];
  allocations: AllocationRow[];
  /** idempotency key -> batch id */
  keys: Map<string, string>;
  /** unapplied credit held for the tenant */
  credit: number;
  seq: number;
};

export type PayResult =
  | { ok: true; replay: boolean; batchId: string; credit: number }
  | { ok: false; error: string };

export const newLedger = (
  invoices: Array<Pick<SimInvoice, "id" | "periodStart" | "total"> & Partial<SimInvoice>>,
): SimLedger => ({
  invoices: invoices.map((i) => ({ paid: 0, history: [], status: "pending", ...i })),
  batches: [],
  allocations: [],
  keys: new Map(),
  credit: 0,
  seq: 0,
});

export function recordPayment(
  l: SimLedger,
  p: {
    amount: number;
    paidAt: string;
    snapshot: unknown;
    key?: string;
    /** paid_amount values the caller saw when it built the request (optimistic lock). */
    expectedPaid?: Record<string, number>;
    manual?: Array<{ invoiceId: string; amount: number }>;
  },
): PayResult {
  if (p.key && l.keys.has(p.key)) return { ok: true, replay: true, batchId: l.keys.get(p.key)!, credit: l.credit };
  for (const [id, seen] of Object.entries(p.expectedPaid ?? {})) {
    const inv = l.invoices.find((i) => i.id === id);
    if (!inv || inv.paid !== seen) return { ok: false, error: `stale expected_paid_amount for ${id}` };
  }
  const plan = planReceiptAllocation({
    amountReceived: p.amount,
    manual: p.manual,
    openCharges: l.invoices
      .filter((i) => i.status !== "cancelled")
      .map((i) => ({ invoiceId: i.id, periodStart: i.periodStart, outstanding: i.total - i.paid })),
  });
  if (plan.errors.length) return { ok: false, error: plan.errors.join("; ") };

  const batchId = `b${++l.seq}`;
  l.batches.push({
    id: batchId,
    tenant_id: "t1",
    room_id: "r1",
    amount_received: p.amount,
    amount_allocated: plan.allocatedTotal,
    paid_at: p.paidAt,
    voided_at: null,
    payment_method_snapshot: p.snapshot,
  });
  for (const a of plan.allocations) {
    const inv = l.invoices.find((i) => i.id === a.invoiceId)!;
    inv.paid = Math.round((inv.paid + a.amount) * 100) / 100;
    inv.status = inv.paid >= inv.total ? "paid" : "partial";
    inv.history.push({ payment_batch_id: batchId, amount: a.amount, paid_at: p.paidAt });
    l.allocations.push({
      id: `a${++l.seq}`,
      payment_batch_id: batchId,
      invoice_id: a.invoiceId,
      amount: a.amount,
      paid_at: p.paidAt,
      payment_method_snapshot: p.snapshot,
    });
  }
  l.credit += plan.unappliedCredit;
  if (p.key) l.keys.set(p.key, batchId);
  return { ok: true, replay: false, batchId, credit: l.credit };
}

/** Void a receipt: negative reversal rows, nothing deleted. */
export function voidBatch(l: SimLedger, batchId: string, at: string) {
  const batch = l.batches.find((b) => b.id === batchId)!;
  const originals = l.allocations.filter(
    (a) => a.payment_batch_id === batchId && Number(a.amount) > 0 && !a.reverses_allocation_id,
  );
  let reversed = 0;
  for (const a of originals) {
    const amt = Number(a.amount);
    l.allocations.push({
      id: `a${++l.seq}`,
      payment_batch_id: batchId,
      invoice_id: a.invoice_id,
      amount: -amt,
      reverses_allocation_id: a.id,
      paid_at: at,
      payment_method_snapshot: null,
    });
    const inv = l.invoices.find((i) => i.id === a.invoice_id)!;
    inv.paid = Math.round((inv.paid - amt) * 100) / 100;
    inv.status = inv.paid <= 0 ? "pending" : inv.paid >= inv.total ? "paid" : "partial";
    reversed += amt;
  }
  l.credit -= Number(batch.amount_received) - reversed;
  batch.voided_at = at;
}

export function toReconciliationInput(l: SimLedger): ReconciliationInput {
  const invoices: InvoiceRow[] = l.invoices.map((i) => ({
    id: i.id,
    tenant_id: "t1",
    room_id: "r1",
    status: i.status,
    total_amount: i.total,
    paid_amount: i.paid,
    payment_history: i.history,
  }));
  return { invoices, batches: l.batches, allocations: l.allocations, carryForwards: [] };
}

/** Net cash that stays received: allocations net of reversals. */
export const netAllocated = (l: SimLedger) =>
  Math.round(l.allocations.reduce((s, a) => s + Number(a.amount), 0) * 100) / 100;
