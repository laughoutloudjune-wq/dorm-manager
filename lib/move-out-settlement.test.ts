import { describe, expect, it } from "vitest";
import {
  compareOlderBills,
  olderBillPlanLine,
  planMoveOutSettlement,
  type MoveOutOlderBillLine,
  type OlderBillOrderKeys,
} from "./move-out-settlement";

const line = (id: string, charges: number, fee = 0): MoveOutOlderBillLine => ({
  invoice_id: id,
  charges_due: charges,
  fee_due: fee,
  expected_paid_sum: 0,
  expected_waived_sum: 0,
});

const bill = (
  id: string,
  dueDate: string | null,
  charges: number,
  fee = 0,
  extra: Partial<OlderBillOrderKeys> = {},
) => ({
  invoiceId: id,
  dueDate,
  startDate: extra.startDate ?? null,
  createdAt: extra.createdAt ?? "2026-01-01T00:00:00+00:00",
  line: line(id, charges, fee),
});

describe("planMoveOutSettlement", () => {
  it("credit larger than everything: move-out bill, older bills, then refund", () => {
    const plan = planMoveOutSettlement({
      securityDeposit: 3000,
      advanceRent: 2900,
      forfeitDeposit: false,
      moveOutBill: { invoiceId: "mo", totalAmount: 1200, paidSum: 0 },
      olderBills: [bill("b", "2026-10-10", 4697, 500)],
    });
    expect(plan.credit.total).toBe(5900);
    expect(plan.moveOutBill).toEqual({
      invoiceId: "mo",
      amountDue: 1200,
      creditApplied: 1200,
      remainingDue: 0,
    });
    expect(plan.olderBills[0]).toEqual({
      invoiceId: "b",
      chargesDue: 4697,
      feeWaived: 500,
      creditApplied: 4697,
      remainingDue: 0,
    });
    expect(plan.creditApplied).toBe(5897);
    expect(plan.refund).toBe(3);
    expect(plan.totalFeeWaived).toBe(500);
    expect(plan.remainingOwed).toBe(0);
  });

  it("older bills are paid oldest due date first, and fees are waived even with no credit left", () => {
    const plan = planMoveOutSettlement({
      securityDeposit: 1000,
      advanceRent: 0,
      forfeitDeposit: false,
      moveOutBill: { invoiceId: "mo", totalAmount: 400, paidSum: 0 },
      olderBills: [
        bill("newer", "2026-09-10", 500, 300),
        bill("older", "2026-08-10", 500, 200),
      ],
    });
    expect(plan.olderBills.map((b) => [b.invoiceId, b.creditApplied, b.feeWaived])).toEqual([
      ["older", 500, 200],
      ["newer", 100, 300],
    ]);
    expect(plan.refund).toBe(0);
    expect(plan.remainingOwed).toBe(400);
    expect(plan.totalFeeWaived).toBe(500);
  });

  it("forfeited deposit leaves only the advance rent as credit", () => {
    const plan = planMoveOutSettlement({
      securityDeposit: 3000,
      advanceRent: 2100,
      forfeitDeposit: true,
      moveOutBill: { invoiceId: "mo", totalAmount: 2500, paidSum: 100 },
      olderBills: [],
    });
    expect(plan.credit).toEqual({ deposit: 0, advanceRent: 2100, total: 2100 });
    expect(plan.moveOutBill?.amountDue).toBe(2400);
    expect(plan.moveOutBill?.creditApplied).toBe(2100);
    expect(plan.moveOutBill?.remainingDue).toBe(300);
    expect(plan.refund).toBe(0);
  });

  it("no deposit recorded, and an overpaid move-out bill, never go negative", () => {
    const plan = planMoveOutSettlement({
      securityDeposit: null,
      advanceRent: -50,
      forfeitDeposit: false,
      moveOutBill: { invoiceId: "mo", totalAmount: 100, paidSum: 150 },
      olderBills: [bill("b", "2026-08-10", 0, 0)],
    });
    expect(plan.credit.total).toBe(0);
    expect(plan.moveOutBill?.amountDue).toBe(0);
    expect(plan.olderBills[0].creditApplied).toBe(0);
    expect(plan.refund).toBe(0);
  });

  it("without a move-out bill all credit goes to older bills (settle itself would refuse)", () => {
    const plan = planMoveOutSettlement({
      securityDeposit: 100.1,
      advanceRent: 0.2,
      forfeitDeposit: false,
      moveOutBill: null,
      olderBills: [bill("b", "2026-08-10", 50.15)],
    });
    expect(plan.moveOutBill).toBeNull();
    expect(plan.credit.total).toBe(100.3);
    expect(plan.olderBills[0].creditApplied).toBe(50.15);
    expect(plan.refund).toBe(50.15);
  });
});

describe("compareOlderBills (settle_move_out's ORDER BY)", () => {
  const keys = (
    invoiceId: string,
    dueDate: string | null,
    startDate: string | null,
    createdAt: string | null,
  ): OlderBillOrderKeys => ({ invoiceId, dueDate, startDate, createdAt });

  it("due date, NULLS LAST", () => {
    const sorted = [keys("a", null, null, null), keys("b", "2026-09-10", null, null), keys("c", "2026-08-10", null, null)]
      .sort(compareOlderBills)
      .map((k) => k.invoiceId);
    expect(sorted).toEqual(["c", "b", "a"]);
  });

  it("ties broken by start date, then created_at to the microsecond, then id", () => {
    const sorted = [
      keys("d", "2026-09-10", "2026-09-01", "2026-09-25T06:24:46.741961+00:00"),
      keys("c", "2026-09-10", "2026-09-01", "2026-09-25T06:24:46.741960+00:00"),
      keys("b", "2026-09-10", "2026-08-01", "2026-09-26T00:00:00+00:00"),
      keys("A", "2026-09-10", "2026-09-01", "2026-09-25T06:24:46.741961+00:00"),
    ]
      .sort(compareOlderBills)
      .map((k) => k.invoiceId);
    expect(sorted).toEqual(["b", "c", "A", "d"]);
  });
});

describe("olderBillPlanLine", () => {
  const base = {
    invoiceId: "x",
    totalAmount: 4697,
    storedPaidAmount: 0,
    engineChargesDue: 4697,
    engineFeeDue: 0,
    paidSum: 0,
    waivedSum: 0,
  };

  it("passes the engine's figures and stamps through", () => {
    expect(
      olderBillPlanLine({ ...base, feeModel: "v2", engineFeeDue: 1200, waivedSum: 100 }),
    ).toEqual({
      invoice_id: "x",
      charges_due: 4697,
      fee_due: 1200,
      expected_paid_sum: 0,
      expected_waived_sum: 100,
    });
  });

  it("legacy: never more than the stored running balance leaves (pre-allocation payments)", () => {
    expect(
      olderBillPlanLine({ ...base, feeModel: "legacy", storedPaidAmount: 4000 }).charges_due,
    ).toBe(697);
  });

  it("v2 ignores paid_amount but is capped at total − Σ allocations", () => {
    expect(
      olderBillPlanLine({ ...base, feeModel: "v2", storedPaidAmount: 4000 }).charges_due,
    ).toBe(4697);
    expect(
      olderBillPlanLine({ ...base, feeModel: "v2", paidSum: 4600 }).charges_due,
    ).toBe(97);
  });

  it("a bundled legacy bill keeps the engine's own-charges figure", () => {
    // total 8,666 includes 5,758 carried in; engine says 2,908 owed.
    expect(
      olderBillPlanLine({
        ...base,
        feeModel: "legacy",
        totalAmount: 8666,
        engineChargesDue: 2908,
      }).charges_due,
    ).toBe(2908);
  });
});
