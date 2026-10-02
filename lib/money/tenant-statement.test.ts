import { describe, expect, it } from "vitest";
import { buildTenantStatement } from "./tenant-statement";

const base = {
  id: "inv1",
  status: "pending",
  start_date: "2026-07-25",
  due_date: "2026-08-05",
  rent_amount: 5000,
  water_bill: 100,
  electricity_bill: 400,
  common_fee: 0,
  total_amount: 5500,
  paid_amount: 0,
  late_fee_amount: 0,
  additional_fees_total: 0,
  carry_forward_amount: 0,
  discount_amount: 0,
};
const alloc = (o: any) => ({
  invoice_id: "inv1",
  payment_batch_id: "b1",
  amount: 5500,
  paid_at: "2026-08-03T10:00:00Z",
  ...o,
});

describe("buildTenantStatement", () => {
  it("on-time paid", () => {
    const s = buildTenantStatement(
      { ...base, status: "paid", paid_amount: 5500 },
      [alloc({ id: "a1", invoice_period: "2026-07-25" })],
      [],
      { asOf: "2026-08-20" },
    );
    expect(s.total).toBe(5500);
    expect(s.balance).toBe(0);
    expect(s.confirmedPaid).toBe(5500);
    expect(s.lateFee.state).toBe("none");
    expect(s.explanationTh).toBe("ชำระครบแล้ว");
    expect(s.payments[0].appliedTo[0].periodMonth).toBe("2026-07");
  });

  it("partial", () => {
    const s = buildTenantStatement({ ...base, status: "partial" }, [alloc({ id: "a1", amount: 2000 })], [], {
      asOf: "2026-08-01",
    });
    expect(s.balance).toBe(3500);
    expect(s.explanationTh).toContain("บางส่วน");
    expect(s.nextActionTh).toContain("3,500");
  });

  it("multiple months in one transfer", () => {
    const allocs = [
      alloc({ id: "a1", amount: 1400, invoice_id: "inv0", invoice_period: "2026-06-25" }),
      alloc({ id: "a2", amount: 5500, invoice_period: "2026-07-25" }),
    ];
    const s = buildTenantStatement({ ...base, status: "paid" }, allocs, []);
    expect(s.payments).toHaveLength(1);
    expect(s.payments[0].amount).toBe(6900);
    expect(s.payments[0].amountToThisInvoice).toBe(5500);
    expect(s.payments[0].appliedTo.map((a) => a.periodMonth)).toEqual(["2026-06", "2026-07"]);
    expect(s.balance).toBe(0);
  });

  it("void shown as reversed and not counted", () => {
    const allocs = [
      alloc({ id: "a1" }),
      {
        id: "r1",
        invoice_id: "inv1",
        payment_batch_id: "b1",
        amount: -5500,
        reverses_allocation_id: "a1",
        reversal_reason: "ลงผิด",
      },
    ];
    const s = buildTenantStatement(base, allocs, [], { asOf: "2026-08-01" });
    expect(s.payments[0].state).toBe("reversed");
    expect(s.payments[0].reversedReason).toBe("ลงผิด");
    expect(s.confirmedPaid).toBe(0);
    expect(s.balance).toBe(5500);
  });

  it("void via history fallback", () => {
    const s = buildTenantStatement(
      base,
      [],
      [
        { amount: 5500, paid_at: "2026-08-03", payment_batch_id: "b9" },
        { type: "void", payment_batch_id: "b9", amount: -5500, reason: "x" },
      ],
      { asOf: "2026-08-01" },
    );
    expect(s.payments[0].state).toBe("reversed");
    expect(s.balance).toBe(5500);
  });

  it("under review is not counted as received", () => {
    const s = buildTenantStatement({ ...base, status: "verifying", slip_url: "http://s" }, [], []);
    expect(s.underReview?.active).toBe(true);
    expect(s.confirmedPaid).toBe(0);
    expect(s.balance).toBe(5500);
    expect(s.payments).toHaveLength(0);
  });

  it("late fee: estimate vs charged", () => {
    const open = { ...base, status: "overdue", late_fee_per_day: 50, late_fee_start_date: "2026-08-06" };
    const est = buildTenantStatement(open, [], [], { asOf: "2026-08-10" });
    expect(est.lateFee.state).toBe("estimate");
    if (est.lateFee.state === "estimate") {
      expect(est.lateFee.days).toBe(5);
      expect(est.lateFee.amount).toBe(250);
      expect(est.lateFee.coveredFrom).toBe("2026-08-06");
    }
    expect(est.total).toBe(5500); // estimate never added
    const charged = buildTenantStatement({ ...open, locked_late_fee_amount: 150 }, [], [], { asOf: "2026-08-10" });
    expect(charged.lateFee).toMatchObject({ state: "charged", amount: 150, locked: true });
  });

  it("carried debt and carried late fee not double counted", () => {
    const row = {
      ...base,
      carry_forward_amount: 1400,
      late_fee_amount: 300, // own 100 + carried 200
      additional_fees_total: 500, // other 300 + carried 200
      additional_fees_breakdown: [
        { item_type: "late_fee_line", total_amount: 200 },
        { item_type: "fee", total_amount: 300 },
      ],
      total_amount: 7500,
    };
    const s = buildTenantStatement(row, [], [], { asOf: "2026-08-01" });
    expect(s.total).toBe(7500);
    expect(s.totalMatchesRow).toBe(true);
    expect(s.lines.find((l) => l.key === "carryForward")?.amount).toBe(1400);
    expect(s.lines.find((l) => l.key === "lateFee")?.amount).toBe(100);
    expect(s.lines.find((l) => l.key === "carriedLateFee")?.amount).toBe(200);
    expect(s.lines.find((l) => l.key === "fees")?.amount).toBe(300);
    expect(s.lines.reduce((a, l) => a + l.amount, 0)).toBe(7500);
  });

  it("discounts separate; refund only when provided", () => {
    const row = { ...base, discount_amount: 100, total_amount: 5400, discount_breakdown: [{ label: "promo", amount: 100 }] };
    const s = buildTenantStatement(row, [], [], { asOf: "2026-08-01" });
    expect(s.total).toBe(5400);
    expect(s.charges).toBe(5500);
    expect(s.credits).toEqual([{ label: "promo", amount: 100 }]);
    expect(s.refund).toBeUndefined();
    expect(buildTenantStatement(row, [], [], { refund: { due: 500, paid: 200 } }).refund?.outstanding).toBe(300);
  });
});
