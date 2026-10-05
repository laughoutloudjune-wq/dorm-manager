import { describe, expect, it } from "vitest";
import { calculateLateFeeAmount } from "../invoice-ledger";

/**
 * Parity fixtures for the fee a downstream invoice freezes when propagation marks it paid.
 * SQL `public.money_late_fee_amount` (migration 20261002000000) must return EXACTLY these numbers:
 * the same rows are asserted in supabase/tests/09_late_fee_freeze.sql (cases P1-P9).
 * If you change one side, change the other and both tests.
 */
export const LATE_FEE_FREEZE_FIXTURES: Array<{
  name: string;
  start: string | null;
  rate: number;
  waived: number;
  locked: number | null;
  asOf: string;
  expected: number;
}> = [
  { name: "P1 a frozen amount always wins", start: "2026-06-06", rate: 50, waived: 0, locked: 120, asOf: "2026-07-30", expected: 120 },
  { name: "P2 no start date", start: null, rate: 50, waived: 0, locked: null, asOf: "2026-06-10", expected: 0 },
  { name: "P3 zero daily rate", start: "2026-06-06", rate: 0, waived: 0, locked: null, asOf: "2026-06-10", expected: 0 },
  { name: "P4 paid before the fee starts", start: "2026-06-06", rate: 50, waived: 0, locked: null, asOf: "2026-06-05", expected: 0 },
  { name: "P5 start day counts (one day)", start: "2026-06-06", rate: 50, waived: 0, locked: null, asOf: "2026-06-06", expected: 50 },
  { name: "P6 inclusive day count (5 days)", start: "2026-06-06", rate: 50, waived: 0, locked: null, asOf: "2026-06-10", expected: 250 },
  { name: "P7 waived amount is subtracted", start: "2026-06-06", rate: 50, waived: 100, locked: null, asOf: "2026-06-08", expected: 50 },
  { name: "P8 waived more than the fee floors at 0", start: "2026-06-06", rate: 50, waived: 999, locked: null, asOf: "2026-06-08", expected: 0 },
  { name: "P9 fractional daily rate", start: "2026-06-06", rate: 12.5, waived: 0, locked: null, asOf: "2026-06-09", expected: 50 },
];

describe("late-fee freeze rule (TS side of the SQL parity fixtures)", () => {
  for (const f of LATE_FEE_FREEZE_FIXTURES) {
    it(f.name, () => {
      expect(
        calculateLateFeeAmount(
          {
            late_fee_start_date: f.start,
            late_fee_per_day: f.rate,
            waived_late_fee_amount: f.waived,
            locked_late_fee_amount: f.locked,
          },
          f.asOf,
        ),
      ).toBe(f.expected);
    });
  }

  it("the normal payment path freezes calculateLateFeeAmount(invoice, paidAt.slice(0, 10)); the SQL step is given that same string", () => {
    const paidAt = "2026-06-10T12:00:00+07:00";
    expect(paidAt.slice(0, 10)).toBe("2026-06-10");
    expect(
      calculateLateFeeAmount(
        { late_fee_start_date: "2026-06-06", late_fee_per_day: 50, waived_late_fee_amount: 0, locked_late_fee_amount: null },
        paidAt.slice(0, 10),
      ),
    ).toBe(250);
  });
});
