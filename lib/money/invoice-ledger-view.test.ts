import { describe, expect, it } from "vitest";
import { buildInvoiceLedgerView, buildVoidPreview, voidPreviewText, receiptKindForSource } from "./invoice-ledger-view";

const snap = { bank_name: "KBank", account_number: "123" };

describe("invoice ledger view", () => {
  it("classifies sources", () => {
    expect(receiptKindForSource("admin_webapp")).toBe("cash");
    expect(receiptKindForSource("credit")).toBe("credit");
    expect(receiptKindForSource("abandon_room")).toBe("credit");
    expect(receiptKindForSource("waived")).toBe("waived");
    expect(receiptKindForSource("write_off")).toBe("written_off");
  });

  it("shows a split receipt with remaining balances and is consistent", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 1000 },
      invoiceTotals: { A: 400 },
      batches: [{ id: "b1", amount_received: 1400, paid_at: "2026-08-01", source: "admin_webapp", payment_method_snapshot: snap }],
      allocations: [
        { id: "a1", payment_batch_id: "b1", invoice_id: "A", amount: 400, created_at: "1", period: "07/2026" },
        { id: "a2", payment_batch_id: "b1", invoice_id: "B", amount: 1000, created_at: "2", period: "08/2026" },
      ],
    });
    expect(v.state).toBe("consistent");
    expect(v.receipts).toHaveLength(1);
    expect(v.receipts[0].rows.map((r) => r.remainingAfter)).toEqual([0, 0]);
    expect(v.receipts[0].accountKnown).toBe(true);
    expect(v.cashReceived).toBe(1000);
    expect(v.receipts[0].appliedHere).toBe(1000);
  });

  it("uses context-only rows for balances without showing them as receipts", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 1000 },
      batches: [{ id: "b2", source: "admin_webapp" }],
      allocations: [
        { id: "a1", payment_batch_id: "b1", invoice_id: "B", amount: 600, created_at: "1", context_only: true },
        { id: "a2", payment_batch_id: "b2", invoice_id: "B", amount: 400, created_at: "2" },
      ],
    });
    expect(v.receipts).toHaveLength(1);
    expect(v.receipts[0].rows[0].remainingAfter).toBe(0);
    expect(v.state).toBe("consistent");
  });

  it("keeps voided receipt and reversal together, labelled voided", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 0 },
      batches: [{ id: "b1", amount_received: 1000, source: "admin_webapp", voided_at: "2026-08-03", void_reason: "ผิดยอด" }],
      allocations: [
        { id: "a1", payment_batch_id: "b1", invoice_id: "B", amount: 1000, created_at: "1" },
        { id: "r1", payment_batch_id: "b1", invoice_id: "B", amount: -1000, created_at: "2", source: "void", reverses_allocation_id: "a1" },
      ],
    });
    const r = v.receipts[0];
    expect(r.voided).toBe(true);
    expect(r.voidReason).toBe("ผิดยอด");
    expect(r.rows.map((x) => x.amount)).toEqual([1000, -1000]);
    expect(r.rows[1].isReversal).toBe(true);
    expect(r.rows[1].remainingAfter).toBe(1000);
    expect(r.appliedHere).toBe(0);
    expect(v.cashReceived).toBe(0);
    expect(v.state).toBe("consistent");
  });

  it("flags a discrepancy with the difference", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 1000 },
      batches: [{ id: "b1", source: "admin_webapp" }],
      allocations: [{ id: "a1", payment_batch_id: "b1", invoice_id: "B", amount: 700 }],
    });
    expect(v.state).toBe("discrepancy");
    expect(v.invoiceBalance).toBe(0);
    expect(v.ledgerBalance).toBe(300);
    expect(v.discrepancy).toBe(-300);
  });

  it("treats paid_amount with no allocations as legacy, not an error", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 1000 },
      batches: [],
      allocations: [],
    });
    expect(v.state).toBe("legacy_no_allocations");
    expect(v.discrepancy).toBeNull();
  });

  it("renders non-cash as credit applied, not cash, and NULL snapshot as unknown", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 500, paid_amount: 500 },
      batches: [{ id: "b1", source: "abandon_room", payment_method_snapshot: null }],
      allocations: [{ id: "a1", payment_batch_id: "b1", invoice_id: "B", amount: 500 }],
    });
    expect(v.creditApplied).toBe(500);
    expect(v.cashReceived).toBe(0);
    expect(v.receipts[0].isCash).toBe(false);
    expect(v.receipts[0].accountKnown).toBe(false);
  });

  it("builds a void preview", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "B", total_amount: 1000, paid_amount: 1000 },
      invoiceTotals: { A: 400 },
      batches: [{ id: "b1", source: "admin_webapp" }],
      allocations: [
        { id: "a1", payment_batch_id: "b1", invoice_id: "A", amount: 400, period: "07/2026" },
        { id: "a2", payment_batch_id: "b1", invoice_id: "B", amount: 1000, period: "08/2026" },
      ],
    });
    const p = buildVoidPreview(v.receipts[0], 1000);
    expect(p.paidAfter).toBe(0);
    expect(p.affected).toHaveLength(2);
    expect(voidPreviewText(p)).toContain("1000 -> 0");
  });
});
