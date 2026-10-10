import { describe, expect, it } from "vitest";
import { creditByInvoiceId, moveOutCreditOf, ownBilledAmount, splitPaid } from "./billing-report";

const credit = (amount: number) => [{ source: "move_out_credit", amount }];

describe("moveOutCreditOf", () => {
  it("sums only move_out_credit entries", () => {
    expect(
      moveOutCreditOf([
        { source: "move_out_credit", amount: 1500.5 },
        { source: "move_out_credit", amount: 499.5 },
        { source: "promo", amount: 300 },
      ]),
    ).toBe(2000);
  });
  it("tolerates garbage", () => {
    expect(moveOutCreditOf(null)).toBe(0);
    expect(moveOutCreditOf(undefined)).toBe(0);
    expect(moveOutCreditOf("x")).toBe(0);
    expect(moveOutCreditOf({})).toBe(0);
    expect(moveOutCreditOf([null, 5, "a", { source: "move_out_credit" }, { source: "move_out_credit", amount: "abc" }])).toBe(0);
  });
  it("accepts numeric strings and rounds to 2dp", () => {
    expect(moveOutCreditOf([{ source: "move_out_credit", amount: "10.005" }, { source: "move_out_credit", amount: 0.1 }])).toBe(10.11);
  });
});

describe("ownBilledAmount", () => {
  it("strips carried-forward debt (April 1,400 carried into May 7,594)", () => {
    expect(ownBilledAmount({ total_amount: 7594, carry_forward_amount: 1400 })).toBe(6194);
  });
  it("leaves invoices without carry-forward unchanged", () => {
    expect(ownBilledAmount({ total_amount: 5000, carry_forward_amount: 0, discount_breakdown: [] })).toBe(5000);
  });
  it("shows the gross bill on a final invoice (400 net + 2,000 credit)", () => {
    expect(ownBilledAmount({ total_amount: 400, carry_forward_amount: 0, discount_breakdown: credit(2000) })).toBe(2400);
  });
  it("never goes negative", () => {
    expect(ownBilledAmount({ total_amount: -500, carry_forward_amount: 0 })).toBe(0);
    expect(ownBilledAmount({ total_amount: 100, carry_forward_amount: 900 })).toBe(0);
  });
  it("handles missing/garbage inputs", () => {
    expect(ownBilledAmount({ total_amount: undefined, carry_forward_amount: null, discount_breakdown: "bad" })).toBe(0);
    expect(ownBilledAmount({ total_amount: "1200", carry_forward_amount: "200" })).toBe(1000);
  });
});

describe("splitPaid", () => {
  it("splits cash and credit allocations (3,000 paid, 2,000 credit)", () => {
    expect(splitPaid({ paid_amount: 3000 }, 2000)).toEqual({ cash: 1000, credit: 2000 });
  });
  it("keeps legacy behaviour with no allocation rows", () => {
    expect(splitPaid({ paid_amount: 4200 }, 0)).toEqual({ cash: 4200, credit: 0 });
  });
  it("final invoice: credit via discount only, paid 0", () => {
    expect(splitPaid({ paid_amount: 0, discount_breakdown: credit(2000) }, 0)).toEqual({ cash: 0, credit: 2000 });
  });
  it("cash + allocation credit equals paid_amount for ordinary invoices", () => {
    const { cash, credit: c } = splitPaid({ paid_amount: 1234.56 }, 234.56);
    expect(cash + c).toBeCloseTo(1234.56, 2);
  });
  it("adds move-out credit on top of allocation credit", () => {
    expect(splitPaid({ paid_amount: 500, discount_breakdown: credit(300) }, 200)).toEqual({ cash: 300, credit: 500 });
  });
  it("never negative", () => {
    expect(splitPaid({ paid_amount: 100 }, 500)).toEqual({ cash: 0, credit: 500 });
    expect(splitPaid({ paid_amount: 100 }, -50)).toEqual({ cash: 150, credit: 0 });
    expect(splitPaid({ paid_amount: undefined }, Number.NaN)).toEqual({ cash: 0, credit: 0 });
  });
});

describe("creditByInvoiceId", () => {
  it("sums only credit rows per invoice", () => {
    const map = creditByInvoiceId([
      { invoice_id: "a", amount: 2000, isCredit: true },
      { invoice_id: "a", amount: 1000, isCredit: false },
      { invoice_id: "b", amount: 300, isCredit: true },
    ]);
    expect(map.get("a")).toBe(2000);
    expect(map.get("b")).toBe(300);
    expect(map.has("c")).toBe(false);
  });
  it("nets void/reversal rows (signed amounts)", () => {
    const map = creditByInvoiceId([
      { invoice_id: "a", amount: 2000, isCredit: true },
      { invoice_id: "a", amount: -2000, isCredit: true },
      { invoice_id: "b", amount: 500, isCredit: true },
      { invoice_id: "b", amount: -200, isCredit: true },
    ]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(300);
  });
  it("ignores rows without invoice id and tolerates garbage amounts", () => {
    const map = creditByInvoiceId([
      { invoice_id: "", amount: 100, isCredit: true },
      { invoice_id: null, amount: 100, isCredit: true },
      { invoice_id: "a", amount: "x", isCredit: true },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("a")).toBe(0);
  });
});
