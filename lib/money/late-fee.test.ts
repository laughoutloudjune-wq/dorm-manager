import { describe, expect, it } from "vitest";
import { estimateLateFee, type LateFeePolicy } from "./late-fee";

const flat: LateFeePolicy = {
  version: "v1",
  effectiveFrom: "2026-01-01",
  graceDays: 0,
  rate: { kind: "flat", baht: 50 },
  partialPaymentsReduceBase: true,
  cap: null,
  rounding: "floor",
  compounding: false,
};
const input = { dueDate: "2026-09-05", outstanding: 3000, originalDue: 3000 };

describe("estimateLateFee", () => {
  it("charges nothing on or before the due date", () => {
    expect(estimateLateFee(flat, { ...input, asOf: "2026-09-05" }).amount).toBe(0);
  });

  it("charges flat per day starting the day after due", () => {
    const e = estimateLateFee(flat, { ...input, asOf: "2026-09-08" });
    expect(e.daysCharged).toBe(3);
    expect(e.amount).toBe(150);
    expect(e.coveredFrom).toBe("2026-09-06");
    expect(e.isEstimate).toBe(true);
  });

  it("honours the grace period", () => {
    const g = { ...flat, graceDays: 3 };
    expect(estimateLateFee(g, { ...input, asOf: "2026-09-08" }).amount).toBe(0);
    expect(estimateLateFee(g, { ...input, asOf: "2026-09-09" }).daysCharged).toBe(1);
  });

  it("applies the cap", () => {
    const e = estimateLateFee({ ...flat, cap: 200 }, { ...input, asOf: "2026-10-05" });
    expect(e.amount).toBe(200);
    expect(e.formula).toContain("capped at 200");
  });

  it("percentage fee uses the eligible balance; partial payments shrink it only if the policy says so", () => {
    const pct: LateFeePolicy = { ...flat, rate: { kind: "percent", percent: 1 } };
    const base = { dueDate: "2026-09-05", asOf: "2026-09-07", outstanding: 1000, originalDue: 3000 };
    expect(estimateLateFee(pct, base).amount).toBe(20);
    expect(estimateLateFee({ ...pct, partialPaymentsReduceBase: false }, base).amount).toBe(60);
  });

  it("compounds when asked", () => {
    const c: LateFeePolicy = { ...flat, rate: { kind: "percent", percent: 10 }, compounding: true };
    const e = estimateLateFee(c, { dueDate: "2026-09-05", asOf: "2026-09-07", outstanding: 1000, originalDue: 1000 });
    expect(e.grossAmount).toBeCloseTo(210, 5);
  });

  it("subtracts a waiver without a sentinel amount and never goes negative", () => {
    expect(estimateLateFee(flat, { ...input, asOf: "2026-09-08", waived: 100 }).amount).toBe(50);
    expect(estimateLateFee(flat, { ...input, asOf: "2026-09-08", waived: 99999 }).amount).toBe(0);
  });

  it("leaves invoices due before the policy's effective date alone", () => {
    const p = { ...flat, effectiveFrom: "2026-10-25" };
    expect(estimateLateFee(p, { ...input, asOf: "2026-12-01" }).amount).toBe(0);
  });

  it("charges nothing once nothing is outstanding", () => {
    expect(estimateLateFee(flat, { ...input, outstanding: 0, asOf: "2026-10-01" }).amount).toBe(0);
  });
});
