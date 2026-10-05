import { describe, expect, it } from "vitest";
import {
  bangkokToday,
  buildDefaultLateFeePolicy,
  buildLateFeeRows,
  firstLateFeeDay,
  isSlipAwaitingReview,
  positiveRefunds,
  positiveUnapplied,
  totalQueueCount,
} from "./action-queue";

describe("action queue helpers", () => {
  it("bangkokToday rolls over at 17:00 UTC", () => {
    expect(bangkokToday(new Date("2026-10-03T16:59:00Z"))).toBe("2026-10-03");
    expect(bangkokToday(new Date("2026-10-03T17:00:00Z"))).toBe("2026-10-04");
  });

  it("slip needs verifying status and a slip", () => {
    expect(isSlipAwaitingReview({ status: "verifying", slip_url: "x" })).toBe(true);
    expect(isSlipAwaitingReview({ status: "verifying", slip_url: " " })).toBe(false);
    expect(isSlipAwaitingReview({ status: "pending", slip_url: "x" })).toBe(false);
  });

  it("firstLateFeeDay prefers invoice start date, else next start day after due", () => {
    expect(firstLateFeeDay("2026-09-05", "2026-09-08", 6)).toBe("2026-09-08");
    expect(firstLateFeeDay("2026-09-05", null, 6)).toBe("2026-09-06");
    expect(firstLateFeeDay("2026-09-10", null, 6)).toBe("2026-10-06");
  });

  it("policy fee starts on the start day", () => {
    const p = buildDefaultLateFeePolicy({ late_fee_start_day: 6, late_fee_per_day: 50 }, { due_date: "2026-09-05" });
    expect(p.graceDays).toBe(0);
    expect(p.rate).toEqual({ kind: "flat", baht: 50 });
  });

  it("estimates overdue invoices against locked amount and skips others", () => {
    const settings = { late_fee_start_day: 6, late_fee_per_day: 50 };
    const rows = buildLateFeeRows(
      [
        { id: "a", status: "overdue", due_date: "2026-09-05", total_amount: 5000, paid_amount: 0, locked_late_fee_amount: null },
        { id: "b", status: "overdue", due_date: "2026-09-05", total_amount: 5000, paid_amount: 5000 },
        { id: "c", status: "pending", due_date: "2026-10-10", total_amount: 5000, paid_amount: 0 },
        { id: "d", status: "paid", due_date: "2026-08-05", total_amount: 5000, paid_amount: 0 },
        { id: "e", status: "partial", due_date: "2026-09-05", total_amount: 5000, paid_amount: 1000, locked_late_fee_amount: 100 },
      ],
      settings,
      "2026-10-03"
    );
    expect(rows.map((r) => r.invoiceId)).toEqual(["a", "e"]);
    expect(rows[1].outstanding).toBe(4000);
    // 2026-09-06..2026-10-03 = 28 days x 50
    expect(rows[0].estimate.amount).toBe(1400);
    expect(rows[0].locked).toBeNull();
    expect(rows[1].locked).toBe(100);
    expect(rows[1].difference).toBe(1300);
  });

  it("filters positive balances and totals only ready sections", () => {
    expect(positiveUnapplied([{ tenant_id: "a", unapplied_credit: 0 }, { tenant_id: "b", unapplied_credit: 5 }])).toHaveLength(1);
    expect(positiveRefunds([{ tenant_id: "a", refund_outstanding: -3 }])).toHaveLength(0);
    expect(
      totalQueueCount([
        { key: "slips", count: 2, state: "ready" },
        { key: "refunds", count: 9, state: "unavailable" },
      ])
    ).toBe(2);
  });
});

describe("late-fee base uses own outstanding", () => {
  const settings = { late_fee_start_day: 6, late_fee_per_day: 50 };
  const row = (inv: object) =>
    buildLateFeeRows(
      [{ id: "m", status: "overdue", due_date: "2026-09-05", total_amount: 7594, paid_amount: 0, ...inv }],
      settings,
      "2026-10-03"
    );

  it("excludes the carried-in share from the base", () => {
    expect(row({ carry_forward_amount: 1400 })[0].outstanding).toBe(6194);
  });

  it("drops the invoice when only carried debt remains", () => {
    expect(row({ carry_forward_amount: 1400, paid_amount: 6194 })).toEqual([]);
  });

  it("keeps total - paid for a legacy row whose paid already includes the carry", () => {
    expect(row({ carry_forward_amount: 1400, paid_amount: 7000 })[0].outstanding).toBe(594);
  });
});
