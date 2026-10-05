import { describe, expect, it } from "vitest";
import { computeInvoiceTotal } from "../invoice-total";
import {
  buildFinalSettlementRpcPayload,
  buildMoveOutPlanInput,
  computeMoveOutRentPeriod,
  finalInvoiceCharges,
  resolveHeldCredit,
} from "./move-out-settlement-input";
import { planMoveOutSettlement } from "./settlement";

describe("resolveHeldCredit", () => {
  it("uses tenant columns when the ledger has no rows for a bucket", () => {
    expect(resolveHeldCredit({ security_deposit_amount: 3000, advance_rent_amount: 1000 }, [])).toEqual({
      deposit: 3000,
      advance: 1000,
      unapplied: 0,
    });
  });
  it("uses the ledger balance per bucket once it has rows", () => {
    const held = resolveHeldCredit({ security_deposit_amount: 3000, advance_rent_amount: 1000 }, [
      { bucket: "deposit", amount: 3000 },
      { bucket: "deposit", amount: -500 },
      { bucket: "unapplied", amount: "120.50" },
    ]);
    expect(held).toEqual({ deposit: 2500, advance: 1000, unapplied: 120.5 });
  });
});

describe("computeMoveOutRentPeriod", () => {
  it("whole months plus trailing days at dailyRentRate", () => {
    const p = computeMoveOutRentPeriod({
      lastBilledEndDate: "2026-05-25",
      moveOutDate: "2026-06-28",
      billingDay: 25,
      monthlyRent: 3100,
      useProrate: true,
    });
    expect(p.fullMonths).toBe(1);
    expect(p.prorateDays).toBe(3);
    expect(p.dailyRate).toBe(103);
    expect(p.fullMonthRent).toBe(3100);
    expect(p.proratedRent).toBe(309);
    expect(p.startDate).toBe("2026-05-25");
  });
  it("no prorate charges no final-period rent", () => {
    const p = computeMoveOutRentPeriod({
      lastBilledEndDate: "2026-06-25",
      moveOutDate: "2026-06-28",
      billingDay: 25,
      monthlyRent: 3000,
      useProrate: false,
    });
    expect(p.fullMonthRent + p.proratedRent).toBe(0);
  });
});

describe("buildFinalSettlementRpcPayload", () => {
  const period = computeMoveOutRentPeriod({
    lastBilledEndDate: "2026-09-25",
    moveOutDate: "2026-09-28",
    billingDay: 25,
    monthlyRent: 3000,
    useProrate: true,
  });
  const openInvoices = [
    { id: "old", start_date: "2026-08-25", status: "overdue", total_amount: 1500, paid_amount: 200, carry_forward_amount: 0 },
    { id: "gone", start_date: "2026-07-25", status: "paid", total_amount: 900, paid_amount: 900, carry_forward_amount: 0 },
  ];
  const plan = planMoveOutSettlement(
    buildMoveOutPlanInput({
      period,
      previousElectricity: 100,
      currentElectricity: 130,
      previousWater: 10,
      currentWater: 15,
      electricityRate: 8,
      waterRate: 20,
      feeLines: [{ label: "ค่าทำความสะอาด", amount: 500 }],
      openInvoices,
      held: { deposit: 3000, advance: 1000, unapplied: 0 },
      forfeitAmount: 0,
    }),
  );

  it("builds a plan from open debt (own outstanding) and the final bill", () => {
    expect(plan.errors).toEqual([]);
    expect(plan.outstandingDebt).toBe(1300);
    expect(plan.proratedRent).toBe(300);
    expect(plan.finalBillTotal).toBe(300 + 240 + 100 + 500);
  });

  it("final invoice columns come from the engine and the credit shows as its discount", () => {
    const p = buildFinalSettlementRpcPayload({
      tenantId: "t",
      roomId: "r",
      idempotencyKey: "k",
      moveOutDate: "2026-09-28",
      createdBy: "admin",
      paidAt: "2026-09-28T00:00:00Z",
      plan,
      period,
      openInvoices,
      source: "credit",
      finalInvoice: {
        id: "f",
        issueDate: "2026-09-28",
        dueDate: "2026-10-05",
        notes: "x",
        meter: { electricityStart: 100, electricityEnd: 130, waterStart: 10, waterEnd: 15 },
      },
    });
    const charges = finalInvoiceCharges(plan);
    expect(p.invoice?.total_amount).toBe(computeInvoiceTotal(charges));
    expect(p.invoice?.discount_amount).toBe(plan.finalBillPaidFromCredit);
    expect(Number(p.invoice?.total_amount) + plan.finalBillPaidFromCredit).toBe(plan.finalBillTotal);
    expect(p.debts).toEqual([{ invoice_id: "old", expected_paid_amount: 200 }]);
    expect(p.settlement.refundDue).toBe(plan.depositRemaining);
  });

  it("abandon: debt only, no invoice", () => {
    const debtPlan = planMoveOutSettlement(
      buildMoveOutPlanInput({
        period,
        previousElectricity: 0,
        currentElectricity: 0,
        previousWater: 0,
        currentWater: 0,
        electricityRate: 0,
        waterRate: 0,
        feeLines: [],
        openInvoices,
        held: { deposit: 0, advance: 5000, unapplied: 0 },
        forfeitAmount: 0,
        debtOnly: true,
      }),
    );
    expect(debtPlan.finalBillTotal).toBe(0);
    expect(debtPlan.advanceRentAbsorbed).toBe(3700);
    expect(debtPlan.refundDue).toBe(0);
    const p = buildFinalSettlementRpcPayload({
      tenantId: "t",
      roomId: "r",
      idempotencyKey: "k",
      moveOutDate: "2026-09-28",
      createdBy: null,
      paidAt: "2026-09-28T00:00:00Z",
      plan: debtPlan,
      period,
      openInvoices,
      source: "abandon_room",
      finalInvoice: null,
    });
    expect(p.invoice).toBeNull();
    expect(p.charges).toBeNull();
  });

  // finding 167: the credit used on the final bill is also stored as a protected discount line.
  const buildWithCredit = (finalBillPaidFromCredit: number) =>
    buildFinalSettlementRpcPayload({
      tenantId: "t", roomId: "r", idempotencyKey: "k", moveOutDate: "2026-09-28", createdBy: "admin",
      paidAt: "2026-09-28T00:00:00Z",
      plan: { ...plan, finalBillPaidFromCredit } as any,
      period, openInvoices, source: "credit",
      finalInvoice: {
        id: "f", issueDate: "2026-09-28", dueDate: "2026-10-05", notes: "x",
        meter: { electricityStart: 100, electricityEnd: 130, waterStart: 10, waterEnd: 15 },
      },
    });
  it("adds one move_out_credit discount line equal to the credit used, so an invoice edit cannot erase it", () => {
    const p = buildWithCredit(plan.finalBillPaidFromCredit);
    expect((p.invoice as any).discount_breakdown).toEqual([
      expect.objectContaining({ source: "move_out_credit", amount: plan.finalBillPaidFromCredit }),
    ]);
  });
  it("adds no discount line when no credit was used on the final bill", () => {
    expect((buildWithCredit(0).invoice as any).discount_breakdown).toEqual([]);
  });
});
