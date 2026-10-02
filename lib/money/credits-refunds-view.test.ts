import { describe, expect, it } from "vitest";
import { labelTh } from "./report-definitions";
import {
  CREDIT_LABELS,
  aggregateCredits,
  balancesFromView,
  creditsRefundsToCsv,
  payoutsFromRows,
  payoutsToCsv,
  refundRowsFromView,
  summarizeTotals,
} from "./credits-refunds-view";

describe("credits-refunds-view", () => {
  it("labels reuse report-definitions terms", () => {
    expect(CREDIT_LABELS.refundDue).toContain(labelTh("refundDue"));
    expect(CREDIT_LABELS.refundDue).toContain("ยังไม่ได้จ่ายออก");
    expect(CREDIT_LABELS.refundPaid).toBe(labelTh("refundPaid"));
  });

  it("aggregates credit rows per tenant and bucket", () => {
    const out = aggregateCredits([
      { tenant_id: "a", bucket: "deposit", amount: "3000" },
      { tenant_id: "a", bucket: "deposit", amount: -500 },
      { tenant_id: "a", bucket: "advance", amount: 2000 },
      { tenant_id: "b", bucket: "unapplied", amount: 150.5 },
    ]);
    expect(out.find((b) => b.tenantId === "a")).toEqual({
      tenantId: "a",
      depositHeld: 2500,
      advanceHeld: 2000,
      unappliedCredit: 0,
    });
    expect(out.find((b) => b.tenantId === "b")?.unappliedCredit).toBe(150.5);
  });

  it("maps view rows and tolerates null/string numerics", () => {
    expect(
      balancesFromView([{ tenant_id: "a", deposit_held: "100.10", advance_held: null, unapplied_credit: 5 }]),
    ).toEqual([{ tenantId: "a", depositHeld: 100.1, advanceHeld: 0, unappliedCredit: 5 }]);
  });

  it("recomputes outstanding as due - paid, including overpaid", () => {
    const rows = refundRowsFromView([
      { tenant_id: "a", refund_due: 3000, refund_paid: 1000 },
      { tenant_id: "b", refund_due: 0, refund_paid: 200 },
    ]);
    expect(rows[0].outstanding).toBe(2000);
    expect(rows[1].outstanding).toBe(-200);
  });

  it("sorts payouts newest first and flags voided", () => {
    const out = payoutsFromRows([
      { id: "1", tenant_id: "a", amount: 100, paid_at: "2026-01-01" },
      { id: "2", tenant_id: "a", amount: 50, paid_at: "2026-02-01", voided_at: "2026-02-02", void_reason: "typo" },
    ]);
    expect(out.map((p) => p.id)).toEqual(["2", "1"]);
    expect(out[0].voided).toBe(true);
  });

  it("sums totals", () => {
    const t = summarizeTotals(
      [{ tenantId: "a", depositHeld: 10, advanceHeld: 5, unappliedCredit: 1 }],
      [{ tenantId: "a", refundDue: 10, refundPaid: 4, outstanding: 6 }],
    );
    expect(t).toMatchObject({ depositHeld: 10, refundDue: 10, refundPaid: 4, outstanding: 6 });
  });

  it("escapes csv cells and labels voided payouts", () => {
    const csv = payoutsToCsv([
      {
        id: "1",
        tenantId: "a",
        amount: 10,
        paidAt: "2026-01-01",
        method: "โอน",
        recipient: 'A, "B"',
        reference: null,
        voided: true,
        voidReason: "x",
        tenantName: "สมชาย",
        roomNumber: "101",
      },
    ]);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain("ยกเลิกแล้ว");
    expect(creditsRefundsToCsv({ balances: [], refunds: [], payouts: [] })).toContain(CREDIT_LABELS.refundDue);
  });
});
