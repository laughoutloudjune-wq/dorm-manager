import { describe, expect, it } from "vitest";
import { buildManualSplitPayload } from "@/lib/money/manual-split-payload";

const inv = (id: string, total: number, paid: number, extra: Record<string, unknown> = {}) => ({
  id,
  total_amount: total,
  paid_amount: paid,
  payment_history: [],
  ...extra,
});

function build(overrides: Partial<Parameters<typeof buildManualSplitPayload>[0]> = {}) {
  const invoicesById = new Map([
    ["a", inv("a", 1000, 200)],
    ["b", inv("b", 500, 0, { locked_late_fee_amount: 30 })],
  ]);
  return buildManualSplitPayload({
    batchId: "batch-1",
    tenantId: "t1",
    triggerInvoiceId: "a",
    allocations: [
      { invoiceId: "a", amount: 800 },
      { invoiceId: "b", amount: 100.1 },
    ],
    invoicesById,
    paidAt: "2026-10-01T00:00:00Z",
    slipUrl: "slip.png",
    mode: "full",
    source: "admin",
    idempotencyKey: "k1",
    method: { id: "m1", snapshot: { name: "bank" } },
    createdBy: "admin",
    statusFor: (i, next) => (next >= Number(i.total_amount) ? "paid" : "partial"),
    lateFeeFor: () => 55,
    now: () => "NOW",
    ...overrides,
  });
}

describe("buildManualSplitPayload", () => {
  it("sets expected_paid_amount from the rows read and applies the split", () => {
    const { payload } = build();
    expect(payload.invoices[0]).toMatchObject({ id: "a", expected_paid_amount: 200, paid_amount: 1000, status: "paid" });
    expect(payload.invoices[1]).toMatchObject({ id: "b", expected_paid_amount: 0, paid_amount: 100.1, status: "partial" });
  });

  it("keeps amount_received == amount_allocated == sum of allocations (no float drift)", () => {
    const { payload, amountToAllocate } = build({
      allocations: [
        { invoiceId: "a", amount: 0.1 },
        { invoiceId: "b", amount: 0.2 },
      ],
    });
    expect(amountToAllocate).toBe(0.3);
    expect(payload.batch.amount_received).toBe(0.3);
    expect(payload.batch.amount_allocated).toBe(0.3);
    expect(payload.allocations.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(0.3, 10);
  });

  it("freezes the late fee only when newly paid and nothing is frozen", () => {
    const { payload } = build();
    expect(payload.invoices[0].locked_late_fee_amount).toBe(55);
    expect("locked_late_fee_amount" in payload.invoices[1]).toBe(false);
  });

  it("writes the slip only onto the trigger invoice", () => {
    const { payload } = build();
    expect(payload.invoices[0]).toMatchObject({ slip_url: "slip.png", slip_uploaded_at: "2026-10-01T00:00:00Z" });
    expect("slip_url" in payload.invoices[1]).toBe(false);
  });

  it("omits slip fields when no slip is supplied", () => {
    const { payload } = build({ slipUrl: null });
    expect("slip_url" in payload.invoices[0]).toBe(false);
  });

  it("appends a payment_history entry carrying batch id and idempotency key", () => {
    const { updates } = build();
    const entry = updates[0].payment_history[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ payment_batch_id: "batch-1", trigger_invoice_id: "a", idempotency_key: "k1", amount: 800 });
  });

  it("caps paid_amount at the invoice total", () => {
    const { payload } = build({ allocations: [{ invoiceId: "a", amount: 900 }] });
    expect(payload.invoices[0].paid_amount).toBe(1000);
  });
});
