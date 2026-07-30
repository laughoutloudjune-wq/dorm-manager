import { describe, expect, it } from "vitest";
import {
  DEFAULT_REWARDS_CONFIG,
  pointsForRentPayment,
  bahtEquivalent,
  isPaymentOnTime,
  computeCurrentStreak,
  computeStreakProgression,
  monthsBetween,
  hasReachedThreeMonthMilestone,
  yearMilestonesReached,
  clampRedemptionBaht,
  normalizeRewardsConfig,
  isInvoiceWithinProgram,
  isOnOrAfterProgramStart,
  addMonthsToDate,
  resolveTier,
  couponCosts,
} from "./points-ledger";

const cfg = DEFAULT_REWARDS_CONFIG;

describe("pointsForRentPayment", () => {
  it("floors invoice total * pct * points-per-baht, matching the spec example (5000 baht total, 1% -> 500 points)", () => {
    expect(pointsForRentPayment(5000, cfg)).toBe(500);
  });
  it("floors instead of rounds on a fractional result", () => {
    // 4999 * 0.01 * 10 = 499.9 -> floor to 499, not round to 500.
    expect(pointsForRentPayment(4999, cfg)).toBe(499);
  });
  it("uses the invoice's full total, not just the base rent line item, so utilities/fees earn points too", () => {
    // e.g. rent 2900 + water/electricity/common fee bringing the total to 3800.
    expect(pointsForRentPayment(3800, cfg)).toBe(380);
  });
});

describe("bahtEquivalent", () => {
  it("divides points by the points-per-baht ratio", () => {
    expect(bahtEquivalent(500, cfg)).toBe(50);
    expect(bahtEquivalent(300, cfg)).toBe(30);
  });
});

describe("isPaymentOnTime", () => {
  it("is on time when paid exactly on the due date", () => {
    expect(
      isPaymentOnTime({ due_date: "2026-06-05", payment_history: [{ paid_at: "2026-06-05T10:00:00Z" }] }),
    ).toBe(true);
  });
  it("is on time when paid before the due date", () => {
    expect(
      isPaymentOnTime({ due_date: "2026-06-05", payment_history: [{ paid_at: "2026-06-01T10:00:00Z" }] }),
    ).toBe(true);
  });
  it("is late when the (latest) payment lands after the due date", () => {
    expect(
      isPaymentOnTime({ due_date: "2026-06-05", payment_history: [{ paid_at: "2026-06-06T10:00:00Z" }] }),
    ).toBe(false);
  });
  it("uses the most recent payment when an invoice was paid in multiple installments", () => {
    expect(
      isPaymentOnTime({
        due_date: "2026-06-05",
        payment_history: [{ paid_at: "2026-06-01T10:00:00Z" }, { paid_at: "2026-06-10T10:00:00Z" }],
      }),
    ).toBe(false);
  });
  it("is false with no payment history at all", () => {
    expect(isPaymentOnTime({ due_date: "2026-06-05", payment_history: [] })).toBe(false);
  });
});

describe("computeCurrentStreak / computeStreakProgression", () => {
  const onTime = (id: string, due: string) => ({
    id,
    due_date: due,
    status: "paid",
    payment_history: [{ paid_at: due }],
  });
  const late = (id: string, due: string) => ({
    id,
    due_date: due,
    status: "paid",
    payment_history: [{ paid_at: "2099-01-01" }],
  });

  it("counts consecutive on-time payments", () => {
    const invoices = [onTime("a", "2026-01-05"), onTime("b", "2026-02-05"), onTime("c", "2026-03-05")];
    expect(computeCurrentStreak(invoices)).toBe(3);
  });

  it("resets to 0 immediately after a late payment, then rebuilds from scratch", () => {
    const invoices = [
      onTime("a", "2026-01-05"),
      onTime("b", "2026-02-05"),
      late("c", "2026-03-05"),
      onTime("d", "2026-04-05"),
    ];
    const progression = computeStreakProgression(invoices);
    expect(progression.map((p) => p.streak)).toEqual([1, 2, 0, 1]);
    expect(computeCurrentStreak(invoices)).toBe(1);
  });
});

describe("monthsBetween / milestone eligibility", () => {
  it("counts only full completed months", () => {
    expect(monthsBetween("2026-01-15", "2026-04-14")).toBe(2);
    expect(monthsBetween("2026-01-15", "2026-04-15")).toBe(3);
  });

  it("reaches the 3-month milestone only once 3 full months have completed", () => {
    expect(hasReachedThreeMonthMilestone("2026-01-15", "2026-04-14")).toBe(false);
    expect(hasReachedThreeMonthMilestone("2026-01-15", "2026-04-15")).toBe(true);
  });

  it("reaches only one 1-year milestone across 18 months when repeats is off", () => {
    expect(yearMilestonesReached("2025-01-15", "2026-07-15", false)).toBe(1);
  });

  it("reaches two 1-year milestones across 25 months when repeats is on", () => {
    expect(yearMilestonesReached("2024-06-15", "2026-07-15", true)).toBe(2);
  });
});

describe("clampRedemptionBaht", () => {
  it("clamps to the per-redemption cap when the requested amount exceeds it", () => {
    expect(clampRedemptionBaht(500, 300, 1000)).toBe(300);
  });
  it("clamps to the invoice's own outstanding balance when that's the tighter limit", () => {
    expect(clampRedemptionBaht(300, 300, 120)).toBe(120);
  });
  it("never returns a negative amount", () => {
    expect(clampRedemptionBaht(300, 300, -50)).toBe(0);
  });
});

describe("normalizeRewardsConfig", () => {
  it("falls back to defaults entirely when given nothing", () => {
    expect(normalizeRewardsConfig(null)).toEqual(DEFAULT_REWARDS_CONFIG);
  });
  it("merges only recognized, correctly-typed keys over the defaults", () => {
    const merged = normalizeRewardsConfig({ points_per_baht: 20, garbage_key: "x", max_redemptions_per_month: "two" });
    expect(merged.points_per_baht).toBe(20);
    expect(merged.max_redemptions_per_month).toBe(DEFAULT_REWARDS_CONFIG.max_redemptions_per_month);
  });
  it("accepts a valid program_start_date string and rejects garbage", () => {
    expect(normalizeRewardsConfig({ program_start_date: "2026-07-01" }).program_start_date).toBe("2026-07-01");
    expect(normalizeRewardsConfig({ program_start_date: "not-a-date" }).program_start_date).toBeNull();
  });
});

describe("isInvoiceWithinProgram", () => {
  it("excludes an invoice whose billing period starts before the program launch", () => {
    expect(isInvoiceWithinProgram({ start_date: "2026-06-01" }, "2026-07-01")).toBe(false);
  });
  it("includes an invoice whose billing period starts on or after the program launch", () => {
    expect(isInvoiceWithinProgram({ start_date: "2026-07-01" }, "2026-07-01")).toBe(true);
    expect(isInvoiceWithinProgram({ start_date: "2026-08-01" }, "2026-07-01")).toBe(true);
  });
  it("includes everything when there is no cutoff configured", () => {
    expect(isInvoiceWithinProgram({ start_date: "2020-01-01" }, null)).toBe(true);
  });
});

describe("addMonthsToDate", () => {
  it("adds whole calendar months, preserving the day of month", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-03-03"); // JS Date rolls Feb 31 -> Mar 3, same as native Date math
    expect(addMonthsToDate("2026-01-15", 3)).toBe("2026-04-15");
    expect(addMonthsToDate("2025-06-15", 12)).toBe("2026-06-15");
  });
});

describe("isOnOrAfterProgramStart", () => {
  it("is false before the cutoff, true on/after it, and always true with no cutoff", () => {
    expect(isOnOrAfterProgramStart("2026-06-30", "2026-07-01")).toBe(false);
    expect(isOnOrAfterProgramStart("2026-07-01", "2026-07-01")).toBe(true);
    expect(isOnOrAfterProgramStart("2020-01-01", null)).toBe(true);
  });
});

describe("milestone gating by program_start_date (via addMonthsToDate + isOnOrAfterProgramStart)", () => {
  it("excludes a 3-month milestone whose achievement date predates the program launch", () => {
    // Moved in 2026-01-01 -> 3-month milestone lands 2026-04-01, before a 2026-07-01 launch.
    const milestoneDate = addMonthsToDate("2026-01-01", 3);
    expect(isOnOrAfterProgramStart(milestoneDate, "2026-07-01")).toBe(false);
  });
  it("includes a 3-month milestone whose achievement date is on/after the program launch", () => {
    // Moved in 2026-05-01 -> 3-month milestone lands 2026-08-01, after a 2026-07-01 launch.
    const milestoneDate = addMonthsToDate("2026-05-01", 3);
    expect(isOnOrAfterProgramStart(milestoneDate, "2026-07-01")).toBe(true);
  });
  it("gates each year-milestone independently, so only later years count after a mid-tenancy launch", () => {
    // Moved in 2024-01-01: year-1 milestone 2025-01-01 (before launch), year-2 milestone 2026-01-01 (after launch).
    expect(isOnOrAfterProgramStart(addMonthsToDate("2024-01-01", 12), "2025-06-01")).toBe(false);
    expect(isOnOrAfterProgramStart(addMonthsToDate("2024-01-01", 24), "2025-06-01")).toBe(true);
  });
});

describe("resolveTier", () => {
  it("is 'none' below the silver threshold", () => {
    expect(resolveTier(2999, cfg)).toBe("none");
  });
  it("reaches each tier at its exact threshold, matching the spec (3000/5000/10000)", () => {
    expect(resolveTier(3000, cfg)).toBe("silver");
    expect(resolveTier(4999, cfg)).toBe("silver");
    expect(resolveTier(5000, cfg)).toBe("gold");
    expect(resolveTier(9999, cfg)).toBe("gold");
    expect(resolveTier(10000, cfg)).toBe("platinum");
  });
  it("never demotes based on current spendable balance — callers must pass lifetime earned points", () => {
    // A tenant who earned 6000 lifetime and redeemed down to a balance of 500 is still Gold.
    expect(resolveTier(6000, cfg)).toBe("gold");
  });
});

describe("couponCosts", () => {
  it("derives the rent coupon from max_redemption_baht * points_per_baht (300 baht, 10 pts/baht -> 3000 pts)", () => {
    const { rent } = couponCosts(cfg);
    expect(rent).toEqual({ cost: 3000, value: 300 });
  });
  it("makes the utility coupon exactly half the rent coupon's cost and value (1500 pts / 150 baht)", () => {
    const { utility } = couponCosts(cfg);
    expect(utility).toEqual({ cost: 1500, value: 150 });
  });
  it("scales both coupons when the admin tunes the redemption cap or ratio", () => {
    const tuned = { ...cfg, max_redemption_baht: 500, points_per_baht: 20 };
    const { rent, utility } = couponCosts(tuned);
    expect(rent).toEqual({ cost: 10000, value: 500 });
    expect(utility).toEqual({ cost: 5000, value: 250 });
  });
});
