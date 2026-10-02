import { describe, expect, it } from "vitest";
import { classifyReceiptPayments, summarizeReceiptPayments } from "./receipt-payments";

describe("classifyReceiptPayments", () => {
  it("handles non-arrays", () => {
    expect(classifyReceiptPayments(null)).toEqual({ active: [], reversed: [], lastActivePaidAt: null });
  });
  it("marks a voided batch reversed and ignores it for the date", () => {
    const r = classifyReceiptPayments([
      { amount: 500, paid_at: "2026-08-01", payment_batch_id: "b1" },
      { amount: 700, paid_at: "2026-08-09", payment_batch_id: "b2" },
      { type: "void", payment_batch_id: "b2", reason: "wrong slip" },
    ]);
    expect(r.active.map((e) => e.payment_batch_id)).toEqual(["b1"]);
    expect(r.reversed).toHaveLength(1);
    expect(r.reversed[0].reversedReason).toBe("wrong slip");
    expect(r.lastActivePaidAt).toBe("2026-08-01");
  });
  it("honours reversed_at on the entry", () => {
    const r = classifyReceiptPayments([{ amount: 1, paid_at: "2026-01-01", reversed_at: "2026-01-02" }]);
    expect(r.active).toHaveLength(0);
    expect(r.lastActivePaidAt).toBeNull();
  });
});

describe("summarizeReceiptPayments", () => {
  const base = { invoiceId: "i1", history: [], paidAmount: 9999 };
  it("sums confirmed cash, nets reversals, splits credit", () => {
    const r = summarizeReceiptPayments({
      ...base,
      allocations: [
        { id: "a1", invoice_id: "i1", amount: 1000, paid_at: "2026-08-01", source: "transfer" },
        { id: "a2", invoice_id: "i1", amount: 500, paid_at: "2026-08-05", source: "transfer" },
        { id: "a3", invoice_id: "i1", amount: -500, reverses_allocation_id: "a2", reversal_reason: "bad" },
        { id: "a4", invoice_id: "i1", amount: 200, paid_at: "2026-08-06", source: "credit" },
        { id: "a5", invoice_id: "other", amount: 77, paid_at: "2026-08-06" },
      ],
    });
    expect(r.basis).toBe("allocations");
    expect(r.cashReceived).toBe(1000);
    expect(r.creditApplied).toBe(200);
    expect(r.printedAmount).toBe(1000);
    expect(r.reversed).toEqual([{ paid_at: "2026-08-05", amount: 500, reversedReason: "bad" }]);
    expect(r.lastActivePaidAt).toBe("2026-08-01");
  });
  it("treats reversed_at without a reversal row as reversed", () => {
    const r = summarizeReceiptPayments({
      ...base,
      allocations: [{ id: "a1", invoice_id: "i1", amount: 300, reversed_at: "2026-09-01" }],
    });
    expect(r.cashReceived).toBe(0);
    expect(r.reversed).toHaveLength(1);
  });
  it("legacy: no allocations shows paid_amount", () => {
    const r = summarizeReceiptPayments({ ...base, allocations: [] });
    expect(r.basis).toBe("legacy");
    expect(r.printedAmount).toBe(9999);
  });
  it("falls back to history when the allocation query failed", () => {
    const r = summarizeReceiptPayments({
      ...base,
      allocations: null,
      history: [
        { amount: 400, paid_at: "2026-08-01", payment_batch_id: "b1" },
        { amount: 100, paid_at: "2026-08-02", source: "credit" },
        { type: "void", payment_batch_id: "b1" },
      ],
    });
    expect(r.basis).toBe("history");
    expect(r.cashReceived).toBe(0);
    expect(r.creditApplied).toBe(100);
    expect(r.reversed).toHaveLength(1);
  });
});
