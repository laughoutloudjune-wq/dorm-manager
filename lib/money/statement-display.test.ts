import { describe, expect, it } from "vitest";
import { buildTenantStatement } from "./tenant-statement";
import { appliedToLabel, balanceDiffersFromLegacy, displayBalance, periodLabel } from "./statement-display";

const inv = {
  id: "i1",
  status: "pending",
  total_amount: 1000,
  paid_amount: 0,
  rent_amount: 1000,
  water_bill: 0,
  electricity_bill: 0,
  common_fee: 0,
  due_date: "2099-01-05",
} as any;

describe("statement display", () => {
  it("falls back to total - paid without a statement", () => {
    expect(displayBalance({ total_amount: 1000, paid_amount: 300 }, null)).toBe(700);
    expect(displayBalance({ total_amount: 100, paid_amount: 300 }, undefined)).toBe(0);
    expect(balanceDiffersFromLegacy({ total_amount: 1, paid_amount: 0 }, null)).toBe(false);
  });
  it("uses the statement balance and flags legacy disagreement", () => {
    const s = buildTenantStatement(inv, [], []);
    expect(displayBalance({ total_amount: 1000, paid_amount: 400 }, s)).toBe(s.balance);
    expect(balanceDiffersFromLegacy({ total_amount: 1000, paid_amount: 400 }, s)).toBe(true);
    expect(balanceDiffersFromLegacy({ total_amount: 1000, paid_amount: 0 }, s)).toBe(false);
  });
  it("labels periods", () => {
    expect(periodLabel(null)).toBeNull();
    expect(periodLabel("bad")).toBeNull();
    expect(periodLabel("2026-07")).toBeTruthy();
  });
  it("summarises applied periods", () => {
    const s = buildTenantStatement(
      inv,
      [{ id: "a1", payment_batch_id: "b1", invoice_id: "i1", amount: 500, paid_at: "2026-08-01", invoice_period: "2026-07-25" }],
      [],
    );
    expect(appliedToLabel(s.payments[0])).toContain("ใช้กับงวด");
    expect(appliedToLabel({ ...s.payments[0], appliedTo: [] })).toBe("");
  });
});
