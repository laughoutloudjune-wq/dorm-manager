import { describe, expect, it } from "vitest";
import {
  calculateLateFeeAmount,
  getInvoiceOutstanding,
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
