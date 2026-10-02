import { describe, expect, it } from "vitest";
import {
  BASIS_LABELS,
  cashReceivedByMonth,
  dropUnreversedVoided,
  isMissingSchemaError,
  summarizeAdjustments,
  summarizeAllocations,
  summarizeByReceiptMonth,
  sumRefundPaid,
} from "./report-definitions";

describe("report definitions", () => {
  it("labels both bases distinctly", () => {
    expect(BASIS_LABELS.cash.en).toBe("cash basis (by actual receipt date)");
    expect(BASIS_LABELS.billing.en).toBe("billing basis (by invoice period)");
  });

  it("nets a void reversal to zero and keeps non-cash out of cash", () => {
    const rows = [
      { id: "a", payment_batch_id: "b1", amount: 1000, paid_at: "2026-09-05", source: "transfer" },
      { id: "a-r", payment_batch_id: "b1", amount: -1000, paid_at: "2026-09-05", source: "void", reverses_allocation_id: "a" },
      { id: "c", payment_batch_id: "b2", amount: 500, paid_at: "2026-09-06", source: "credit" },
      { id: "d", payment_batch_id: "b3", amount: 700, paid_at: "2026-09-07", source: "transfer" },
    ];
    const s = summarizeAllocations(rows, ["b1"]);
    expect(s.cashReceived).toBe(700);
    expect(s.creditApplied).toBe(500);
    expect(s.cashGross).toBe(1700);
    expect(s.cashReversed).toBe(-1000);
    expect(s.receiptCount).toBe(1);
  });

  it("a voided credit reversal stays credit, not cash", () => {
    const rows = [
      { id: "c", payment_batch_id: "b", amount: 500, paid_at: "2026-09-06", source: "abandon_room" },
      { id: "c-r", payment_batch_id: "b", amount: -500, paid_at: "2026-09-06", source: "void", reverses_allocation_id: "c" },
    ];
    const s = summarizeAllocations(rows, ["b"]);
    expect(s.cashReceived).toBe(0);
    expect(s.creditApplied).toBe(0);
  });

  it("drops a voided batch that has no reversal rows", () => {
    const rows = [{ id: "a", payment_batch_id: "b1", amount: 300, source: "transfer" }];
    expect(dropUnreversedVoided(rows, ["b1"])).toHaveLength(0);
    expect(summarizeAllocations(rows, ["b1"]).cashReceived).toBe(0);
  });

  it("files cash by receipt month, not billing period", () => {
    const rows = [
      { id: "a", payment_batch_id: "b1", amount: 1000, paid_at: "2026-08-02T10:00:00Z", source: "transfer" },
      { id: "b", payment_batch_id: "b2", amount: 400, paid_at: "2026-09-02T10:00:00Z", source: "transfer" },
    ];
    expect(summarizeByReceiptMonth(rows, "2026-09").cashReceived).toBe(400);
    expect(cashReceivedByMonth(rows).get("2026-08")).toBe(1000);
  });

  it("reversal in a later month resolves the original's source", () => {
    const rows = [
      { id: "a", payment_batch_id: "b1", amount: 1000, paid_at: "2026-08-02", source: "credit" },
      { id: "r", payment_batch_id: "b1", amount: -1000, paid_at: "2026-09-02", source: "void", reverses_allocation_id: "a" },
    ];
    const s = summarizeByReceiptMonth(rows, "2026-09", ["b1"]);
    expect(s.creditApplied).toBe(-1000);
    expect(s.cashReceived).toBe(0);
  });

  it("nets adjustments with reversals", () => {
    const s = summarizeAdjustments([
      { id: "1", type: "waiver", amount: 200 },
      { id: "2", type: "write_off", amount: 900 },
      { id: "3", type: "reversal", amount: -200, reverses_adjustment_id: "1" },
    ]);
    expect(s).toEqual({ waived: 0, writtenOff: 900 });
  });

  it("ignores voided refund payouts", () => {
    expect(sumRefundPaid([{ amount: 100 }, { amount: 50, voided_at: "x" }])).toBe(100);
  });

  it("detects missing-schema errors", () => {
    expect(isMissingSchemaError({ message: "column payment_batches.voided_at does not exist" })).toBe(true);
    expect(isMissingSchemaError({ message: "permission denied" })).toBe(false);
  });
});
