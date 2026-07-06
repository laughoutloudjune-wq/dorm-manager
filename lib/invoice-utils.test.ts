import { describe, expect, it } from "vitest";
import { dailyRentRate, calculateProratedRentByBillingDay, calculateInvoiceTransferRentProration } from "./invoice-utils";

describe("dailyRentRate", () => {
  it("splits monthly rent over a fixed 30-day cycle, rounded down to a whole baht", () => {
    expect(dailyRentRate(3000)).toBe(100);
    // 3050 / 30 = 101.66... must floor, not round, to 101.
    expect(dailyRentRate(3050)).toBe(101);
  });
});

describe("calculateProratedRentByBillingDay", () => {
  it("uses the floored daily rate for the reference move-in proration", () => {
    // Moves in on the 20th, billing day is the 25th -> 6 occupied days (20-25 inclusive).
    const result = calculateProratedRentByBillingDay(3050, "2026-06-20", 25);
    expect(result?.dailyRounded).toBe(101);
    expect(result?.occupiedDays).toBe(6);
    expect(result?.rentAmount).toBe(606);
  });
});

describe("calculateInvoiceTransferRentProration", () => {
  it("uses the same floored daily rate convention as move-in proration", () => {
    const result = calculateInvoiceTransferRentProration(
      "2026-06-01",
      "2026-06-30",
      "2026-06-16",
      null,
      3050,
      4000
    );
    // Old room: Jun 1-15 (15 days) at floor(3050/30)=101/day.
    expect(result.oldRoomDays).toBe(15);
    expect(result.oldRentAmount).toBe(101 * 15);
    // New room: Jun 16-30 (15 days) at floor(4000/30)=133/day.
    expect(result.newRoomDays).toBe(15);
    expect(result.newRentAmount).toBe(133 * 15);
  });
});
