import { describe, expect, it } from "vitest";
import { classifyReceiptPayments } from "./receipt-payments";

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
