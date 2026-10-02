import { describe, expect, it } from "vitest";
import { planReceiptAllocation } from "./allocation";

const charges = [
  { invoiceId: "may", periodStart: "2026-05-01", outstanding: 3000 },
  { invoiceId: "apr", periodStart: "2026-04-01", outstanding: 1400 },
  { invoiceId: "jun", periodStart: "2026-06-01", outstanding: 3000 },
];

describe("planReceiptAllocation", () => {
  it("pays oldest debt first", () => {
    const plan = planReceiptAllocation({ amountReceived: 2000, openCharges: charges });
    expect(plan.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([["apr", 1400], ["may", 600]]);
    expect(plan.unappliedCredit).toBe(0);
    expect(plan.allocations[1].remainingAfter).toBe(2400);
  });

  it("settles several months in one payment", () => {
    const plan = planReceiptAllocation({ amountReceived: 7400, openCharges: charges });
    expect(plan.allocatedTotal).toBe(7400);
    expect(plan.allocations).toHaveLength(3);
  });

  it("keeps an overpayment as tenant credit instead of dropping it", () => {
    const plan = planReceiptAllocation({ amountReceived: 8000, openCharges: charges });
    expect(plan.allocatedTotal).toBe(7400);
    expect(plan.unappliedCredit).toBe(600);
  });

  it("with no debt, the whole receipt becomes credit", () => {
    const plan = planReceiptAllocation({ amountReceived: 500, openCharges: [] });
    expect(plan.allocations).toEqual([]);
    expect(plan.unappliedCredit).toBe(500);
  });

  it("supports a manual split (split payment) and reports the remainder as credit", () => {
    const plan = planReceiptAllocation({
      amountReceived: 3000,
      openCharges: charges,
      manual: [{ invoiceId: "jun", amount: 1000 }, { invoiceId: "may", amount: 1500 }],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.allocatedTotal).toBe(2500);
    expect(plan.unappliedCredit).toBe(500);
  });

  it("rejects manual allocations over the receipt, over a balance, or duplicated", () => {
    expect(planReceiptAllocation({ amountReceived: 1000, openCharges: charges, manual: [{ invoiceId: "may", amount: 2000 }] }).errors).not.toEqual([]);
    expect(planReceiptAllocation({ amountReceived: 5000, openCharges: charges, manual: [{ invoiceId: "apr", amount: 2000 }] }).errors).not.toEqual([]);
    expect(planReceiptAllocation({ amountReceived: 5000, openCharges: charges, manual: [{ invoiceId: "apr", amount: 100 }, { invoiceId: "apr", amount: 100 }] }).errors).not.toEqual([]);
    const over = planReceiptAllocation({ amountReceived: 1000, openCharges: charges, manual: [{ invoiceId: "may", amount: 600 }, { invoiceId: "jun", amount: 600 }] });
    expect(over.errors).toContain("allocations exceed the amount received");
    expect(over.allocations).toEqual([]);
  });

  it("does not drift on fractional baht", () => {
    const plan = planReceiptAllocation({
      amountReceived: 0.3,
      openCharges: [{ invoiceId: "a", periodStart: "2026-01-01", outstanding: 0.1 }, { invoiceId: "b", periodStart: "2026-02-01", outstanding: 0.2 }],
    });
    expect(plan.allocatedTotal).toBe(0.3);
    expect(plan.unappliedCredit).toBe(0);
  });

  it("rejects a non-positive receipt", () => {
    expect(planReceiptAllocation({ amountReceived: 0, openCharges: charges }).errors).not.toEqual([]);
  });
});
