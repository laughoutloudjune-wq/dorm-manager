import { describe, expect, it } from "vitest";
import {
  dailyRentRate,
  calculateProratedRentByBillingDay,
  calculateInvoiceTransferRentProration,
  paymentSourceLabel,
  isNonCashPaymentSource,
  lateFeeLineTotal,
} from "./invoice-utils";

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

describe("paymentSourceLabel", () => {
  it("names every source the app actually writes", () => {
    // These four are the only values present in production.
    expect(paymentSourceLabel("admin_webapp")).toContain("แอดมิน");
    expect(paymentSourceLabel("admin_liff_approve")).toContain("LINE");
    expect(paymentSourceLabel("admin_status_paid")).toContain("ชำระแล้ว");
    expect(paymentSourceLabel("abandon_room")).toContain("ทิ้งห้อง");
  });

  it("never renders an empty remark", () => {
    expect(paymentSourceLabel(null)).toBe("ไม่ระบุที่มา");
    expect(paymentSourceLabel("")).toBe("ไม่ระบุที่มา");
    expect(paymentSourceLabel("   ")).toBe("ไม่ระบุที่มา");
  });

  it("falls back to the raw value for an unrecognised source", () => {
    // Better to surface an unknown tag than to hide where money came from.
    expect(paymentSourceLabel("some_future_source")).toBe("some_future_source");
  });
});

describe("isNonCashPaymentSource", () => {
  it("flags deposit credit, which never touched a bank account", () => {
    expect(isNonCashPaymentSource("abandon_room")).toBe(true);
    expect(isNonCashPaymentSource("credit")).toBe(true);
  });

  it("treats real transfers as cash", () => {
    expect(isNonCashPaymentSource("admin_webapp")).toBe(false);
    expect(isNonCashPaymentSource("admin_liff_approve")).toBe(false);
    expect(isNonCashPaymentSource(null)).toBe(false);
  });
});

describe("lateFeeLineTotal", () => {
  // Room 212/2 April: a 14-day late fee stored BOTH in `late_fee_amount` and as
  // a breakdown line. Summing the two columns charged it twice (4,490 -> 5,890).
  const breakdown = [
    {
      item_type: "late_fee_line",
      detail: "ค่าปรับล่าช้า",
      unit: 14,
      price_per_unit: 100,
      total_amount: 1400,
    },
    { detail: "ค่าบริการอื่น", unit: 1, price_per_unit: 250, total_amount: 250 },
  ];

  it("totals only the late-fee lines, not other charges", () => {
    expect(lateFeeLineTotal(breakdown)).toBe(1400);
  });

  it("ignores carry-forward and transfer rows", () => {
    expect(
      lateFeeLineTotal([
        { item_type: "carry_forward", total_amount: 3300 },
        { item_type: "transfer_detail", total_amount: 900 },
      ]),
    ).toBe(0);
  });

  it("is zero for an invoice with no breakdown", () => {
    expect(lateFeeLineTotal(null)).toBe(0);
    expect(lateFeeLineTotal([])).toBe(0);
    expect(lateFeeLineTotal(undefined)).toBe(0);
  });

  it("falls back to `amount` when `total_amount` is absent", () => {
    expect(lateFeeLineTotal([{ item_type: "late_fee_line", amount: 800 }])).toBe(800);
  });
});
