import { describe, expect, it } from "vitest";
import {
  calculateLateFeeAmount,
  getInvoiceOutstanding,
  getInvoiceOwnOutstanding,
  planAbandonCredit,
  resolveInvoiceStatus,
} from "./invoice-ledger";

describe("getInvoiceOutstanding", () => {
  it("returns zero when paid meets total", () => {
    expect(getInvoiceOutstanding({ total_amount: 100, paid_amount: 100 })).toBe(0);
  });
  it("returns difference when partially paid", () => {
    expect(getInvoiceOutstanding({ total_amount: 500, paid_amount: 200 })).toBe(300);
  });
  it("treats nullish as zero", () => {
    expect(getInvoiceOutstanding({ total_amount: null, paid_amount: null })).toBe(0);
  });
});

describe("getInvoiceOwnOutstanding", () => {
  // Room 212/2: June's 3,300 bill went unpaid and was carried into July, whose
  // 7,925 total is 3,125 of July usage + June's 3,300 + June's 1,500 late fee.
  const june = { total_amount: 3300, paid_amount: 0, carry_forward_amount: 0 };
  const july = { total_amount: 7925, paid_amount: 0, carry_forward_amount: 3300 };

  it("excludes the carried-in portion from the newer invoice", () => {
    expect(getInvoiceOwnOutstanding(july)).toBe(4625);
  });

  it("sums across a chain to the real debt, not the bundled totals", () => {
    // Summing raw outstanding would give 11,225 — June counted twice. Spending
    // an abandoning tenant's deposit against that figure burns credit they
    // never owed, which is what `abandon_room` used to do.
    const own = getInvoiceOwnOutstanding(june) + getInvoiceOwnOutstanding(july);
    const raw = getInvoiceOutstanding(june) + getInvoiceOutstanding(july);
    expect(own).toBe(7925);
    expect(raw).toBe(11225);
  });

  it("treats a payment as retiring the carried-in portion first", () => {
    // Room 114/1's April bill: 6,244 total carrying 1,446, with 6,000 paid.
    // The 1,446 carried debt clears first, leaving exactly its own 244.
    expect(
      getInvoiceOwnOutstanding({
        total_amount: 6244,
        paid_amount: 6000,
        carry_forward_amount: 1446,
      })
    ).toBe(244);
  });
});

describe("planAbandonCredit", () => {
  // Room 212/2 again: June ฿3,300 unpaid, July ฿7,925 of which ฿4,625 is its own.
  const chain = [
    { id: "june", total_amount: 3300, paid_amount: 0, carry_forward_amount: 0 },
    { id: "july", total_amount: 7925, paid_amount: 0, carry_forward_amount: 3300 },
  ];

  it("spends credit oldest-first against own charges", () => {
    const plan = planAbandonCredit(chain, 5900);
    expect(plan.totalOwed).toBe(7925);
    expect(plan.lines.map((line) => line.applied)).toEqual([3300, 2600]);
    expect(plan.lines.map((line) => line.outcome)).toEqual([
      "paid",
      "partial_cancelled",
    ]);
    // Measuring by bundled totals would have written off 5,325.
    expect(plan.writtenOff).toBe(2025);
    expect(plan.refundableCredit).toBe(0);
  });

  it("returns leftover credit instead of burning it on double-counted debt", () => {
    const plan = planAbandonCredit(chain, 9000);
    expect(plan.creditApplied).toBe(7925);
    expect(plan.writtenOff).toBe(0);
    expect(plan.refundableCredit).toBe(1075);
    expect(plan.lines.every((line) => line.outcome === "paid")).toBe(true);
  });

  it("cancels everything when the deposit is forfeited and nothing is left", () => {
    const plan = planAbandonCredit(chain, 0);
    expect(plan.creditApplied).toBe(0);
    expect(plan.writtenOff).toBe(7925);
    expect(plan.lines.map((line) => line.outcome)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("skips an invoice whose own charge is already settled", () => {
    const plan = planAbandonCredit(
      [{ id: "carry-only", total_amount: 3300, paid_amount: 0, carry_forward_amount: 3300 }],
      1000,
    );
    expect(plan.lines[0].outcome).toBe("already_clear");
    expect(plan.refundableCredit).toBe(1000);
  });
});

describe("resolveInvoiceStatus", () => {
  it("returns paid when nothing owed", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 100, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("paid");
  });
  it("returns pending when before due and unpaid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 0, due_date: "2026-01-15" },
        "2026-01-10"
      )
    ).toBe("pending");
  });
  it("returns overdue when past due and unpaid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 0, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("overdue");
  });
  it("returns partial when past due but some paid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 40, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("partial");
  });
});

describe("calculateLateFeeAmount", () => {
  it("returns zero when no late fee start", () => {
    expect(
      calculateLateFeeAmount(
        { late_fee_start_date: null as any, late_fee_per_day: 100 },
        "2026-02-01"
      )
    ).toBe(0);
  });
  it("computes days inclusive from start to as-of", () => {
    expect(
      calculateLateFeeAmount(
        { late_fee_start_date: "2026-01-01", late_fee_per_day: 10 },
        "2026-01-03"
      )
    ).toBe(30);
  });
});
