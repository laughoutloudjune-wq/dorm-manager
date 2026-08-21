import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotal,
  totalLateFee,
  additionalFeesColumn,
  toInvoiceMoneyColumns,
  chargesFromInvoiceRow,
  lateFeeLineTotalOf,
  type InvoiceCharges,
} from "./invoice-total";

const charges = (overrides: Partial<InvoiceCharges> = {}): InvoiceCharges => ({
  rent: 0,
  water: 0,
  electricity: 0,
  commonFee: 0,
  nativeLateFee: 0,
  lateFeeItems: 0,
  fees: 0,
  carryForward: 0,
  discount: 0,
  ...overrides,
});

describe("computeInvoiceTotal", () => {
  it("adds every charge and subtracts the discount", () => {
    expect(
      computeInvoiceTotal(
        charges({
          rent: 2900,
          water: 170,
          electricity: 1708,
          commonFee: 20,
          nativeLateFee: 300,
          lateFeeItems: 1400,
          fees: 250,
          carryForward: 3300,
          discount: 48,
        }),
      ),
    ).toBe(2900 + 170 + 1708 + 20 + 300 + 1400 + 250 + 3300 - 48);
  });

  it("counts a carried balance — the bug that erased debt on a meter edit", () => {
    // updateUtilityUnits omitted carryForward entirely, so changing a water
    // reading on room 212/2 dropped its carried 3,300 out of the total.
    const withCarry = charges({ rent: 2900, water: 170, carryForward: 3300 });
    expect(computeInvoiceTotal(withCarry)).toBe(6370);
    expect(computeInvoiceTotal({ ...withCarry, carryForward: 0 })).toBe(3070);
  });

  it("counts own and carried late fees exactly once each", () => {
    // The double-count charged the carried lines twice (4,490 -> 5,890).
    expect(
      computeInvoiceTotal(
        charges({ rent: 3090, nativeLateFee: 0, lateFeeItems: 1400 }),
      ),
    ).toBe(4490);
    expect(
      computeInvoiceTotal(
        charges({ rent: 3090, nativeLateFee: 500, lateFeeItems: 1400 }),
      ),
    ).toBe(4990);
  });

  it("treats nullish components as zero rather than NaN", () => {
    expect(
      computeInvoiceTotal({
        ...charges({ rent: 1000 }),
        water: undefined as unknown as number,
        discount: null as unknown as number,
      }),
    ).toBe(1000);
  });
});

describe("derived money columns", () => {
  const c = charges({
    rent: 3000,
    nativeLateFee: 500,
    lateFeeItems: 1400,
    fees: 250,
    carryForward: 3300,
    discount: 50,
  });

  it("late_fee_amount is own penalty plus carried lines", () => {
    expect(totalLateFee(c)).toBe(1900);
  });

  it("additional_fees_total keeps its historical overlap with late fees", () => {
    expect(additionalFeesColumn(c)).toBe(1650);
  });

  it("derives every column from one set of charges", () => {
    expect(toInvoiceMoneyColumns(c)).toEqual({
      total_amount: 3000 + 500 + 1400 + 250 + 3300 - 50,
      late_fee_amount: 1900,
      additional_fees_total: 1650,
      carry_forward_amount: 3300,
      discount_amount: 50,
    });
  });
});

describe("chargesFromInvoiceRow", () => {
  it("unpacks the overlap so nothing is counted twice", () => {
    // Room 212/2 April as actually stored: the 1,400 late fee appears in BOTH
    // late_fee_amount and additional_fees_total.
    const unpacked = chargesFromInvoiceRow({
      rent_amount: 2900,
      water_bill: 170,
      electricity_bill: 0,
      common_fee: 20,
      late_fee_amount: 1400,
      additional_fees_total: 1400,
      additional_fees_breakdown: [
        { item_type: "late_fee_line", total_amount: 1400 },
      ],
      carry_forward_amount: 0,
      discount_amount: 0,
    });

    expect(unpacked.lateFeeItems).toBe(1400);
    expect(unpacked.nativeLateFee).toBe(0);
    expect(unpacked.fees).toBe(0);
    // The correct total — not the 5,890 that was stored.
    expect(computeInvoiceTotal(unpacked)).toBe(4490);
  });

  it("separates a genuine own late fee from carried lines", () => {
    const unpacked = chargesFromInvoiceRow({
      rent_amount: 3000,
      late_fee_amount: 1900,
      additional_fees_total: 1650,
      additional_fees_breakdown: [
        { item_type: "late_fee_line", total_amount: 1400 },
        { detail: "ค่าซ่อม", total_amount: 250 },
      ],
    });
    expect(unpacked.nativeLateFee).toBe(500);
    expect(unpacked.lateFeeItems).toBe(1400);
    expect(unpacked.fees).toBe(250);
  });

  it("round-trips a row through charges and back to columns", () => {
    const row = {
      rent_amount: 3000,
      water_bill: 200,
      electricity_bill: 800,
      common_fee: 20,
      late_fee_amount: 1900,
      additional_fees_total: 1650,
      additional_fees_breakdown: [
        { item_type: "late_fee_line", total_amount: 1400 },
        { detail: "ค่าซ่อม", total_amount: 250 },
      ],
      carry_forward_amount: 3300,
      discount_amount: 50,
    };
    const columns = toInvoiceMoneyColumns(chargesFromInvoiceRow(row));
    expect(columns.late_fee_amount).toBe(row.late_fee_amount);
    expect(columns.additional_fees_total).toBe(row.additional_fees_total);
    expect(columns.carry_forward_amount).toBe(row.carry_forward_amount);
  });

  it("handles a row with no breakdown at all", () => {
    const unpacked = chargesFromInvoiceRow({
      rent_amount: 3000,
      late_fee_amount: 300,
    });
    expect(unpacked.lateFeeItems).toBe(0);
    expect(unpacked.nativeLateFee).toBe(300);
    expect(computeInvoiceTotal(unpacked)).toBe(3300);
  });
});

describe("lateFeeLineTotalOf", () => {
  it("counts only late-fee lines", () => {
    expect(
      lateFeeLineTotalOf([
        { item_type: "late_fee_line", total_amount: 1400 },
        { item_type: "carry_forward", total_amount: 3300 },
        { item_type: "transfer_detail", total_amount: 900 },
        { detail: "ค่าซ่อม", total_amount: 250 },
      ]),
    ).toBe(1400);
  });

  it("is zero for missing or empty input", () => {
    expect(lateFeeLineTotalOf(null)).toBe(0);
    expect(lateFeeLineTotalOf(undefined)).toBe(0);
    expect(lateFeeLineTotalOf([])).toBe(0);
    expect(lateFeeLineTotalOf("not an array")).toBe(0);
  });
});
