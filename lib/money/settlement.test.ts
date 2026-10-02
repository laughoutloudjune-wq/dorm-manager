import { describe, expect, it } from "vitest";
import { dailyRentRate } from "../invoice-utils";
import { planMoveOutSettlement } from "./settlement";

const base = {
  proratedRent: 1500,
  electricity: { previousReading: 100, currentReading: 120, rate: 8, minimum: 0 },
  water: { amount: 100 },
};

describe("planMoveOutSettlement", () => {
  it("normal move-out: deposit covers the bill and a refund is due", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 3000 });
    expect(plan.electricity).toBe(160);
    expect(plan.utilities).toBe(260);
    expect(plan.finalBillTotal).toBe(1760);
    expect(plan.depositApplied).toBe(1760);
    expect(plan.refundDue).toBe(1240);
    expect(plan.balanceStillOwed).toBe(0);
    expect(plan.errors).toEqual([]);
  });

  it("works with the shared daily rate for prorated rent", () => {
    const plan = planMoveOutSettlement({ proratedRent: dailyRentRate(3100) * 10, securityDeposit: 3100 });
    expect(plan.proratedRent).toBe(1030);
    expect(plan.refundDue).toBe(2070);
  });

  it("applies the electricity minimum", () => {
    const plan = planMoveOutSettlement({
      proratedRent: 0,
      electricity: { previousReading: 10, currentReading: 11, rate: 8, minimum: 50 },
    });
    expect(plan.electricity).toBe(50);
  });

  it("adds documented other charges and rejects undocumented ones", () => {
    const ok = planMoveOutSettlement({
      proratedRent: 0,
      otherCharges: [{ label: "key", amount: 200, reason: "lost key" }],
    });
    expect(ok.otherChargesTotal).toBe(200);
    expect(ok.finalBillTotal).toBe(200);
    const bad = planMoveOutSettlement({ proratedRent: 0, otherCharges: [{ label: "x", amount: 100, reason: " " }] });
    expect(bad.errors.length).toBe(1);
    expect(bad.finalBillTotal).toBe(0);
  });

  it("credit not enough: reports balance still owed and no refund", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 1000 });
    expect(plan.depositApplied).toBe(1000);
    expect(plan.refundDue).toBe(0);
    expect(plan.balanceStillOwed).toBe(760);
    expect(plan.finalBillPaidFromCredit).toBe(1000);
  });

  it("forfeiture without a reason is an error and is not applied", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 3000, depositForfeiture: { forfeitAmount: 500 } });
    expect(plan.errors.join(" ")).toMatch(/reason/);
    expect(plan.depositForfeited).toBe(0);
  });

  it("forfeiture with a reason reduces available deposit and is not refund", () => {
    const plan = planMoveOutSettlement({
      ...base,
      securityDeposit: 3000,
      depositForfeiture: { forfeitAmount: 1000, reason: "damage", detail: "broken door" },
    });
    expect(plan.errors).toEqual([]);
    expect(plan.depositForfeited).toBe(1000);
    expect(plan.forfeitDetail).toBe("broken door");
    expect(plan.depositAvailable).toBe(2000);
    expect(plan.refundDue).toBe(240);
    // forfeited + applied + refund accounts for the whole deposit
    expect(plan.depositForfeited + plan.depositApplied + plan.refundDue).toBe(3000);
  });

  it("rejects forfeiting more than the deposit held", () => {
    const plan = planMoveOutSettlement({
      proratedRent: 0,
      securityDeposit: 500,
      depositForfeiture: { forfeitAmount: 900, reason: "damage" },
    });
    expect(plan.errors.join(" ")).toMatch(/exceeds/);
    expect(plan.depositForfeited).toBe(500);
  });

  it("applies advance rent before the deposit", () => {
    const plan = planMoveOutSettlement({ proratedRent: 1000, advanceRent: 600, securityDeposit: 3000 });
    expect(plan.advanceRentApplied).toBe(600);
    expect(plan.depositApplied).toBe(400);
    expect(plan.refundDue).toBe(2600);
  });

  it("never refunds unused advance rent: it is absorbed", () => {
    const plan = planMoveOutSettlement({ proratedRent: 0, advanceRent: 600, securityDeposit: 0 });
    expect(plan.advanceRentApplied).toBe(0);
    expect(plan.advanceRentAbsorbed).toBe(600);
    expect(plan.remainingCredit).toBe(600);
    expect(plan.refundDue).toBe(0);
  });

  it("leftover advance is absorbed while the untouched deposit is refund due", () => {
    const plan = planMoveOutSettlement({ proratedRent: 1000, advanceRent: 3000, securityDeposit: 2000 });
    expect(plan.advanceRentApplied).toBe(1000);
    expect(plan.advanceRentAbsorbed).toBe(2000);
    expect(plan.depositApplied).toBe(0);
    expect(plan.depositRemaining).toBe(2000);
    expect(plan.refundDue).toBe(2000);
    expect(plan.finalBillDue).toBe(0);
  });

  it("unapplied overpayment credit is used after the deposit and is refundable", () => {
    const used = planMoveOutSettlement({ proratedRent: 1000, advanceRent: 200, securityDeposit: 500, unappliedCredit: 800 });
    expect(used.depositApplied).toBe(500);
    expect(used.unappliedCreditApplied).toBe(300);
    expect(used.refundDue).toBe(500);
    const unused = planMoveOutSettlement({ proratedRent: 0, unappliedCredit: 250 });
    expect(unused.refundDue).toBe(250);
  });

  it("full-month rent is part of the final bill", () => {
    const plan = planMoveOutSettlement({ fullMonthRent: 3000, proratedRent: 300, securityDeposit: 1000 });
    expect(plan.finalBillTotal).toBe(3300);
    expect(plan.finalBillDue).toBe(2300);
    expect(plan.balanceStillOwed).toBe(2300);
  });

  it("refund due never exceeds deposit left plus unapplied credit (property)", () => {
    for (let i = 0; i < 200; i++) {
      const r = (n: number) => Math.round(Math.random() * n * 100) / 100;
      const deposit = r(5000);
      const plan = planMoveOutSettlement({
        proratedRent: r(4000),
        advanceRent: r(5000),
        securityDeposit: deposit,
        unappliedCredit: r(1000),
        outstandingDebts: [{ invoiceId: "a", periodStart: "2026-01-01", outstanding: r(3000) }],
        depositForfeiture: { forfeitAmount: r(deposit), reason: "damage" },
      });
      expect(plan.refundDue).toBeLessThanOrEqual(plan.depositHeld - plan.depositForfeited + plan.unappliedCreditHeld + 1e-9);
      expect(Math.round((plan.advanceRentApplied + plan.advanceRentAbsorbed) * 100)).toBe(Math.round(plan.advanceRentHeld * 100));
      expect(Math.round((plan.debtPaidFromCredit + plan.finalBillPaidFromCredit) * 100)).toBe(Math.round(plan.creditApplied * 100));
    }
  });

  it("settles older debt oldest first, then the final bill", () => {
    const plan = planMoveOutSettlement({
      proratedRent: 1000,
      securityDeposit: 2000,
      outstandingDebts: [
        { invoiceId: "may", periodStart: "2026-05-01", outstanding: 800 },
        { invoiceId: "apr", periodStart: "2026-04-01", outstanding: 1400 },
      ],
    });
    expect(plan.outstandingDebt).toBe(2200);
    expect(plan.totalOwed).toBe(3200);
    expect(plan.debtPayments.map((d) => [d.invoiceId, d.paidFromCredit])).toEqual([
      ["apr", 1400],
      ["may", 600],
    ]);
    expect(plan.debtPayments[1].outstandingAfter).toBe(200);
    expect(plan.finalBillPaidFromCredit).toBe(0);
    expect(plan.balanceStillOwed).toBe(1200);
    expect(plan.refundDue).toBe(0);
  });

  it("never produces a negative refund", () => {
    const plan = planMoveOutSettlement({ proratedRent: 5000, securityDeposit: 100, advanceRent: 50 });
    expect(plan.refundDue).toBe(0);
    expect(plan.remainingCredit).toBe(0);
    expect(plan.refundOutstanding).toBe(0);
    expect(plan.balanceStillOwed).toBe(4850);
  });

  it("refund partly paid leaves the rest outstanding", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 3000, refundPayouts: [500, 240] });
    expect(plan.refundDue).toBe(1240);
    expect(plan.refundPaid).toBe(740);
    expect(plan.refundOutstanding).toBe(500);
    expect(plan.errors).toEqual([]);
  });

  it("refund fully paid leaves nothing outstanding", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 3000, refundPayouts: [1240] });
    expect(plan.refundOutstanding).toBe(0);
  });

  it("refund over-paid is an error", () => {
    const plan = planMoveOutSettlement({ ...base, securityDeposit: 3000, refundPayouts: [1000, 500] });
    expect(plan.errors.join(" ")).toMatch(/exceed/);
    expect(plan.refundOutstanding).toBe(0);
  });

  it("avoids floating point drift", () => {
    const plan = planMoveOutSettlement({ proratedRent: 0.1, water: { amount: 0.2 }, securityDeposit: 1 });
    expect(plan.finalBillTotal).toBe(0.3);
    expect(plan.refundDue).toBe(0.7);
  });
});
