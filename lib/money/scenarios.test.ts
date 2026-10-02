/**
 * End-to-end money scenarios over the PURE logic (no database).
 * One describe per business scenario; exact baht asserted.
 * Anything that needs a real database is an `it.todo` with the reason.
 */
import { describe, expect, it } from "vitest";
import { planReceiptAllocation } from "./allocation";
import { estimateLateFee, type LateFeePolicy } from "./late-fee";
import { buildManualSplitPayload } from "./manual-split-payload";
import {
  findPointsDiscrepancies,
  planRedemption,
  planRedemptionReversal,
  summarizePointsAndDiscounts,
  type InvoiceAdjustment,
  type PointsEvent,
} from "./points-redemption";
import { runReconciliation } from "./reconciliation-checks";
import { planMoveOutSettlement } from "./settlement";
import { netAllocated, newLedger, recordPayment, toReconciliationInput, voidBatch } from "./ledger-sim";
import { chargesFromInvoiceRow, computeInvoiceTotal, toInvoiceMoneyColumns } from "../invoice-total";
import { calculateInvoiceTransferRentProration, dailyRentRate } from "../invoice-utils";
import {
  allocatePaymentAcrossChain,
  calculateLateFeeAmount,
  planPaymentReplay,
  resolveInvoiceStatus,
  snapshotFromPaymentMethodRow,
  sumOwnOutstanding,
} from "../invoice-ledger";

const KBANK = { type: "bank", label: "KBank", account_number: "111-1-11111-1" };
const SCB = { type: "bank", label: "SCB", account_number: "222-2-22222-2" };

const clean = (l: ReturnType<typeof newLedger>) => runReconciliation(toReconciliationInput(l));

const policy: LateFeePolicy = {
  version: "v1",
  effectiveFrom: "2026-01-01",
  graceDays: 0,
  rate: { kind: "flat", baht: 50 },
  partialPaymentsReduceBase: true,
  cap: null,
  rounding: "round",
  compounding: false,
};

describe("Scenario: normal on-time rent", () => {
  it("full payment before the due date settles the invoice with no late fee and no findings", () => {
    const l = newLedger([{ id: "jun", periodStart: "2026-06-01", total: 3000 }]);
    const r = recordPayment(l, { amount: 3000, paidAt: "2026-06-03", snapshot: KBANK });
    expect(r).toMatchObject({ ok: true, replay: false, credit: 0 });
    expect(l.invoices[0]).toMatchObject({ paid: 3000, status: "paid" });
    expect(resolveInvoiceStatus({ total_amount: 3000, paid_amount: 3000, due_date: "2026-06-05" }, "2026-06-03")).toBe("paid");
    expect(estimateLateFee(policy, { dueDate: "2026-06-05", asOf: "2026-06-03", outstanding: 0, originalDue: 3000 }).amount).toBe(0);
    expect(clean(l)).toEqual([]);
  });
});

describe("Scenario: late and partial payment", () => {
  const invoice = { late_fee_start_date: "2026-06-06", late_fee_per_day: 50, waived_late_fee_amount: 0, locked_late_fee_amount: null };

  it("accrues 50/day inclusive from the start date: 5 days = 250", () => {
    expect(calculateLateFeeAmount(invoice, "2026-06-10")).toBe(250);
  });

  it("a frozen (locked) late fee wins over any later day-count", () => {
    expect(calculateLateFeeAmount({ ...invoice, locked_late_fee_amount: 200 }, "2026-09-01")).toBe(200);
  });

  it("estimate: 3 days late at 50/day = 150", () => {
    const e = estimateLateFee(policy, { dueDate: "2026-06-05", asOf: "2026-06-08", outstanding: 3000, originalDue: 3000 });
    expect(e).toMatchObject({ daysCharged: 3, amount: 150 });
  });

  it("partial payment after the due date leaves the invoice partial with the balance outstanding", () => {
    const l = newLedger([{ id: "jun", periodStart: "2026-06-01", total: 3000 }]);
    recordPayment(l, { amount: 1000, paidAt: "2026-06-10", snapshot: KBANK });
    expect(l.invoices[0]).toMatchObject({ paid: 1000, status: "partial" });
    expect(resolveInvoiceStatus({ total_amount: 3000, paid_amount: 1000, due_date: "2026-06-05" }, "2026-06-10")).toBe("partial");
    expect(resolveInvoiceStatus({ total_amount: 3000, paid_amount: 0, due_date: "2026-06-05" }, "2026-06-10")).toBe("overdue");
    expect(clean(l)).toEqual([]);
  });
});

describe("Scenario: several months paid at once", () => {
  it("one 7,400 transfer settles April 1,400, May 3,000 and June 3,000 oldest first", () => {
    const l = newLedger([
      { id: "jun", periodStart: "2026-06-01", total: 3000 },
      { id: "apr", periodStart: "2026-04-01", total: 1400 },
      { id: "may", periodStart: "2026-05-01", total: 3000 },
    ]);
    recordPayment(l, { amount: 7400, paidAt: "2026-06-04", snapshot: KBANK });
    expect(l.invoices.map((i) => [i.id, i.paid, i.status])).toEqual([
      ["jun", 3000, "paid"],
      ["apr", 1400, "paid"],
      ["may", 3000, "paid"],
    ]);
    expect(l.batches).toHaveLength(1); // one real deposit, three allocations
    expect(l.allocations).toHaveLength(3);
    expect(netAllocated(l)).toBe(7400);
    expect(clean(l)).toEqual([]);
  });
});

describe("Scenario: split payment (admin chooses the split)", () => {
  const charges = [
    { invoiceId: "may", periodStart: "2026-05-01", outstanding: 3000 },
    { invoiceId: "jun", periodStart: "2026-06-01", outstanding: 3000 },
  ];

  it("manual 1,000 to June + 1,500 to May of a 3,000 receipt keeps 500 as credit", () => {
    const plan = planReceiptAllocation({
      amountReceived: 3000,
      openCharges: charges,
      manual: [{ invoiceId: "jun", amount: 1000 }, { invoiceId: "may", amount: 1500 }],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.allocatedTotal).toBe(2500);
    expect(plan.unappliedCredit).toBe(500);
  });

  it("rejects a split bigger than the receipt, crediting everything back", () => {
    const plan = planReceiptAllocation({
      amountReceived: 1000,
      openCharges: charges,
      manual: [{ invoiceId: "may", amount: 800 }, { invoiceId: "jun", amount: 800 }],
    });
    expect(plan.errors).toContain("allocations exceed the amount received");
    expect(plan.allocations).toEqual([]);
    expect(plan.unappliedCredit).toBe(1000);
  });

  it("rejects a line larger than that invoice's balance", () => {
    const plan = planReceiptAllocation({ amountReceived: 5000, openCharges: charges, manual: [{ invoiceId: "may", amount: 3500 }] });
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it("the sim ledger applies a manual split and reconciles clean", () => {
    const l = newLedger([
      { id: "may", periodStart: "2026-05-01", total: 3000 },
      { id: "jun", periodStart: "2026-06-01", total: 3000 },
    ]);
    recordPayment(l, { amount: 3000, paidAt: "2026-06-04", snapshot: KBANK, manual: [{ invoiceId: "jun", amount: 1000 }, { invoiceId: "may", amount: 1500 }] });
    expect(l.invoices.map((i) => i.paid)).toEqual([1500, 1000]);
    expect(l.credit).toBe(500);
    expect(clean(l)).toEqual([]);
  });
});

describe("Scenario: duplicate retry (idempotent replay)", () => {
  it("the same key replays the first result and writes nothing new", () => {
    const l = newLedger([{ id: "jun", periodStart: "2026-06-01", total: 3000 }]);
    const first = recordPayment(l, { amount: 1000, paidAt: "2026-06-04", snapshot: KBANK, key: "k-1" });
    const retry = recordPayment(l, { amount: 1000, paidAt: "2026-06-04", snapshot: KBANK, key: "k-1" });
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(retry).toMatchObject({ ok: true, replay: true });
    expect(l.invoices[0].paid).toBe(1000); // not 2000
    expect(l.batches).toHaveLength(1);
    expect(l.allocations).toHaveLength(1);
  });

  it("the manual-split builder stamps the idempotency key on batch and every history entry", () => {
    const invoicesById = new Map([["jun", { id: "jun", total_amount: 3000, paid_amount: 0, payment_history: [] }]]);
    const { payload } = buildManualSplitPayload({
      batchId: "b1", tenantId: "t1", triggerInvoiceId: "jun",
      allocations: [{ invoiceId: "jun", amount: 1000 }], invoicesById,
      paidAt: "2026-06-04", slipUrl: null, mode: "cash", source: "admin", idempotencyKey: "k-1",
      method: { id: "pm1", snapshot: KBANK }, createdBy: "admin1",
      statusFor: () => "partial", lateFeeFor: () => 0, now: () => "2026-06-04T00:00:00Z",
    });
    expect(payload.batch.idempotency_key).toBe("k-1");
    expect((payload.invoices[0].payment_history as any[])[0].idempotency_key).toBe("k-1");
  });

  it("points redemption replay produces no new events", () => {
    const plan = planRedemption({
      pointsBalance: 400, pointsToRedeem: 100, bahtPerPoint: 0.5,
      invoice: { id: "i", outstandingCharges: 3000, redeemableCharge: 3000 },
      idempotencyKey: "k-9", existingKeys: ["k-9"],
    });
    expect(plan).toMatchObject({ replay: true, pointsEvent: null, invoiceAdjustment: null, errors: [] });
  });
});

describe("Scenario: overpayment", () => {
  it("8,000 against 7,400 owed applies 7,400 and keeps 600 as credit, never dropped", () => {
    const l = newLedger([
      { id: "apr", periodStart: "2026-04-01", total: 1400 },
      { id: "may", periodStart: "2026-05-01", total: 3000 },
      { id: "jun", periodStart: "2026-06-01", total: 3000 },
    ]);
    const r = recordPayment(l, { amount: 8000, paidAt: "2026-06-04", snapshot: KBANK });
    expect(r).toMatchObject({ ok: true, credit: 600 });
    expect(l.batches[0]).toMatchObject({ amount_received: 8000, amount_allocated: 7400 });
    expect(l.invoices.every((i) => i.paid === i.total)).toBe(true); // nothing pushed past its total
    expect(netAllocated(l) + l.credit).toBe(8000);
    expect(clean(l)).toEqual([]);
  });

  it("with nothing owed the whole receipt is credit", () => {
    const plan = planReceiptAllocation({ amountReceived: 500, openCharges: [] });
    expect(plan).toMatchObject({ allocatedTotal: 0, unappliedCredit: 500 });
  });

  it("the replay planner reports received money that no longer fits instead of losing it", () => {
    const plan = planPaymentReplay(
      [{ id: "a", total_amount: 1000, start_date: "2026-05-01" }],
      [{ id: "b1", amount_received: 1500, paid_at: "2026-05-02" }],
    );
    expect(plan.paidByInvoiceId.get("a")).toBe(1000);
    expect(plan.unallocated).toBe(500);
  });
});

describe("Scenario: account reassignment (snapshot frozen)", () => {
  it("snapshotFromPaymentMethodRow copies the row; later edits to the row do not reach the snapshot", () => {
    const row = { id: "pm1", label: "KBank", bank_name: "KBank", account_name: "Dorm", account_number: "111", qr_url: null as string | null };
    const resolved = snapshotFromPaymentMethodRow(row);
    row.account_number = "999";
    row.label = "Changed";
    expect(resolved.snapshot).toMatchObject({ account_number: "111", label: "KBank", type: "bank", methodId: "pm1" });
  });

  it("the batch and allocation keep the account used at payment time after the room is reassigned", () => {
    const l = newLedger([
      { id: "may", periodStart: "2026-05-01", total: 3000 },
      { id: "jun", periodStart: "2026-06-01", total: 3000 },
    ]);
    recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    // Room reassigned to SCB; next payment uses the new account.
    recordPayment(l, { amount: 3000, paidAt: "2026-06-04", snapshot: SCB });
    expect(l.batches.map((b) => (b.payment_method_snapshot as any).label)).toEqual(["KBank", "SCB"]);
    expect(l.allocations.map((a) => (a.payment_method_snapshot as any).label)).toEqual(["KBank", "SCB"]);
    expect(clean(l)).toEqual([]);
  });

  it("the manual-split payload freezes the method snapshot on batch and allocations", () => {
    const method = snapshotFromPaymentMethodRow({ id: "pm1", label: "KBank", account_number: "111" });
    const { payload } = buildManualSplitPayload({
      batchId: "b1", tenantId: "t1", triggerInvoiceId: "jun",
      allocations: [{ invoiceId: "jun", amount: 1000 }],
      invoicesById: new Map([["jun", { id: "jun", total_amount: 3000, paid_amount: 0 }]]),
      paidAt: "2026-06-04", slipUrl: null, mode: "cash", source: "admin", idempotencyKey: null,
      method, createdBy: null, statusFor: () => "partial", lateFeeFor: () => 0,
    });
    expect(payload.batch.payment_method_snapshot).toBe(method.snapshot);
    expect(payload.allocations[0].payment_method_snapshot).toBe(method.snapshot);
  });

  it("a payment row with no frozen snapshot is reported as unknown, not guessed", () => {
    const l = newLedger([{ id: "jun", periodStart: "2026-06-01", total: 3000 }]);
    recordPayment(l, { amount: 3000, paidAt: "2026-06-04", snapshot: KBANK });
    l.allocations[0].payment_method_snapshot = null;
    l.batches[0].payment_method_snapshot = null;
    expect(clean(l).some((f) => f.check === "missing_account_snapshot")).toBe(true);
  });
});

describe("Scenario: fee waiver (no sentinel amount)", () => {
  const input = { dueDate: "2026-06-05", asOf: "2026-06-08", outstanding: 3000, originalDue: 3000 };

  it("a 100 waiver on a 150 fee leaves 50", () => {
    expect(estimateLateFee(policy, { ...input, waived: 100 })).toMatchObject({ cappedAmount: 150, waivedAmount: 100, amount: 50 });
  });

  it("a huge 'waive everything' number is clamped to the real fee, so the record shows 150 not the sentinel", () => {
    const e = estimateLateFee(policy, { ...input, waived: 999_999 });
    expect(e.waivedAmount).toBe(150);
    expect(e.amount).toBe(0);
  });

  it("a negative waiver is ignored", () => {
    expect(estimateLateFee(policy, { ...input, waived: -50 }).amount).toBe(150);
  });

  it("the invoice-level accrual subtracts the waived amount and never goes below zero", () => {
    const inv = { late_fee_start_date: "2026-06-06", late_fee_per_day: 50, locked_late_fee_amount: null };
    expect(calculateLateFeeAmount({ ...inv, waived_late_fee_amount: 100 }, "2026-06-10")).toBe(150);
    expect(calculateLateFeeAmount({ ...inv, waived_late_fee_amount: 99_999 }, "2026-06-10")).toBe(0);
  });
});

describe("Scenario: carry-forward (chain counted once)", () => {
  // April 1,400 unpaid is carried into May: May bundles 3,000 own + 1,400.
  const apr = { total_amount: 1400, paid_amount: 0, carry_forward_amount: 0 };
  const may = { total_amount: 4400, paid_amount: 0, carry_forward_amount: 1400 };

  it("the tenant owes 4,400 in total, not 5,800", () => {
    expect(sumOwnOutstanding([apr, may])).toBe(4400);
  });

  it("paying the whole chain moves exactly the real debt and no more", () => {
    const res = allocatePaymentAcrossChain([{ id: "apr", ...apr }, { id: "may", ...may }], 4400);
    expect(res).toEqual([
      { id: "apr", allocated: 1400, nextPaidAmount: 1400 },
      { id: "may", allocated: 3000, nextPaidAmount: 3000 },
    ]);
  });

  it("the total engine counts the carried 1,400 once", () => {
    const total = computeInvoiceTotal({
      rent: 3000, water: 0, electricity: 0, commonFee: 0, nativeLateFee: 0, lateFeeItems: 0, fees: 0, carryForward: 1400, discount: 0,
    });
    expect(total).toBe(4400);
  });
});

describe("Scenario: utility correction", () => {
  const row = {
    rent_amount: 3000,
    water_bill: 150,
    electricity_bill: 600,
    common_fee: 0,
    late_fee_amount: 300, // own 100 + carried line 200
    additional_fees_total: 700, // other fees 500 + the same carried line 200
    additional_fees_breakdown: [{ item_type: "late_fee_line", total_amount: 200 }],
    carry_forward_amount: 1400,
    discount_amount: 0,
  };

  it("unpacks the overlapping late-fee columns without double counting", () => {
    expect(chargesFromInvoiceRow(row)).toMatchObject({ nativeLateFee: 100, lateFeeItems: 200, fees: 500, carryForward: 1400 });
    expect(computeInvoiceTotal(chargesFromInvoiceRow(row))).toBe(5950);
  });

  it("correcting electricity 600 -> 500 lowers the total by exactly 100, keeping carry-forward and late-fee lines", () => {
    const corrected = { ...chargesFromInvoiceRow(row), electricity: 500 };
    const cols = toInvoiceMoneyColumns(corrected);
    expect(cols).toEqual({
      total_amount: 5850,
      late_fee_amount: 300,
      additional_fees_total: 700,
      carry_forward_amount: 1400,
      discount_amount: 0,
    });
  });

  it("round-tripping the derived columns through the engine is stable (no reload inflation)", () => {
    const cols = toInvoiceMoneyColumns(chargesFromInvoiceRow(row));
    const again = chargesFromInvoiceRow({
      rent_amount: 3000, water_bill: 150, electricity_bill: 600, common_fee: 0,
      ...cols, additional_fees_breakdown: row.additional_fees_breakdown,
    });
    expect(computeInvoiceTotal(again)).toBe(cols.total_amount);
  });
});

describe("Scenario: room transfer (rent proration, floor(rent/30))", () => {
  it("dailyRentRate floors to whole baht", () => {
    expect(dailyRentRate(6000)).toBe(200);
    expect(dailyRentRate(3100)).toBe(103); // 103.33 -> 103
    expect(dailyRentRate(4500)).toBe(150);
  });

  it("transfer on 11 June: 10 days at the old rate + 20 days at the new rate", () => {
    const r = calculateInvoiceTransferRentProration("2026-06-01", "2026-06-30", "2026-06-11", null, 6000, 4500);
    expect(r).toMatchObject({ oldRoomDays: 10, newRoomDays: 20, oldRentAmount: 2000, newRentAmount: 3000 });
  });

  it("uses the floored rate for both rooms (3,100 -> 103/day, 10 days = 1,030)", () => {
    const r = calculateInvoiceTransferRentProration("2026-06-01", "2026-06-30", "2026-06-11", null, 3100, 3100);
    expect(r.oldRentAmount).toBe(1030);
    expect(r.newRentAmount).toBe(2060);
  });
});

describe("Scenario: deposit forfeiture (reason required)", () => {
  const base = { proratedRent: 0, securityDeposit: 6000 };

  it("forfeiting without a reason is rejected and nothing is forfeited", () => {
    const p = planMoveOutSettlement({ ...base, depositForfeiture: { forfeitAmount: 500 } });
    expect(p.errors).toContain("a reason is required when forfeiting any of the deposit");
    expect(p.depositForfeited).toBe(0);
    expect(p.refundDue).toBe(6000);
  });

  it("a documented forfeiture of 500 reduces the refund and is retained, not refunded", () => {
    const p = planMoveOutSettlement({ ...base, depositForfeiture: { forfeitAmount: 500, reason: "wall damage" } });
    expect(p.errors).toEqual([]);
    expect(p).toMatchObject({ depositForfeited: 500, forfeitReason: "wall damage", depositAvailable: 5500, refundDue: 5500 });
  });

  it("cannot forfeit more than the deposit held", () => {
    const p = planMoveOutSettlement({ ...base, depositForfeiture: { forfeitAmount: 9000, reason: "x" } });
    expect(p.errors).toContain("forfeitAmount exceeds the deposit held");
    expect(p.depositForfeited).toBe(6000);
  });
});

describe("Scenario: move-out refund due vs paid", () => {
  const input = {
    proratedRent: 1500,
    electricity: { previousReading: 100, currentReading: 150, rate: 8 }, // 400
    water: { amount: 120 },
    outstandingDebts: [{ invoiceId: "apr", periodStart: "2026-04-01", outstanding: 1400 }],
    securityDeposit: 6000,
    depositForfeiture: { forfeitAmount: 500, reason: "cleaning" },
  };

  it("final bill 2,020 + older debt 1,400 = 3,420 owed; deposit 5,500 pays it; refund due 2,080", () => {
    const p = planMoveOutSettlement(input);
    expect(p.errors).toEqual([]);
    expect(p).toMatchObject({
      electricity: 400, utilities: 520, finalBillTotal: 2020, outstandingDebt: 1400, totalOwed: 3420,
      depositApplied: 3420, balanceStillOwed: 0, refundDue: 2080, refundPaid: 0, refundOutstanding: 2080,
    });
    expect(p.debtPayments[0]).toMatchObject({ paidFromCredit: 1400, outstandingAfter: 0 });
  });

  it("a partial refund payout of 1,000 leaves 1,080 still to pay", () => {
    const p = planMoveOutSettlement({ ...input, refundPayouts: [1000] });
    expect(p).toMatchObject({ refundDue: 2080, refundPaid: 1000, refundOutstanding: 1080 });
  });

  it("paying out more than is due is an error", () => {
    expect(planMoveOutSettlement({ ...input, refundPayouts: [2500] }).errors).toContain("refund payouts exceed the refund due");
  });

  it("when credit is short, nothing is refunded and the shortfall is shown", () => {
    const p = planMoveOutSettlement({ ...input, securityDeposit: 2000, depositForfeiture: undefined });
    expect(p).toMatchObject({ refundDue: 0, balanceStillOwed: 1420 });
  });

  it("advance rent is consumed before the deposit", () => {
    const p = planMoveOutSettlement({ proratedRent: 2000, advanceRent: 1500, securityDeposit: 3000 });
    expect(p).toMatchObject({ advanceRentApplied: 1500, depositApplied: 500, refundDue: 2500 });
  });
});

describe("Scenario: points redemption and reversal", () => {
  const redeem = () =>
    planRedemption({
      pointsBalance: 500, pointsToRedeem: 100, bahtPerPoint: 0.5,
      invoice: { id: "inv", outstandingCharges: 3000, redeemableCharge: 3000 },
      idempotencyKey: "r1", existingKeys: [],
    });

  it("redeeming 100 points at 0.5 gives a 50 baht discount and removes 100 points", () => {
    const p = redeem();
    expect(p.pointsEvent).toMatchObject({ points: -100 });
    expect(p.invoiceAdjustment).toMatchObject({ amount: 50 });
  });

  it("a discount larger than the redeemable charge is rejected", () => {
    const p = planRedemption({
      pointsBalance: 500, pointsToRedeem: 500, bahtPerPoint: 1,
      invoice: { id: "inv", outstandingCharges: 3000, redeemableCharge: 300 },
      idempotencyKey: "r2", existingKeys: [],
    });
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.invoiceAdjustment).toBeNull();
  });

  it("reversal restores points and nets the discount to zero, keeping both rows", () => {
    const r = redeem();
    const ev = r.pointsEvent as PointsEvent;
    const adj = r.invoiceAdjustment as InvoiceAdjustment;
    const rev = planRedemptionReversal({ originalPointsEvent: ev, originalAdjustment: adj, reason: "tenant cancelled", alreadyReversedKeys: [] });
    expect(rev.errors).toEqual([]);
    expect(rev.invoiceAdjustment!.amount).toBe(-50);

    const events: PointsEvent[] = [{ type: "earn", points: 500, referenceKey: "e1" }, ev, rev.pointsEvent!];
    const adjustments = [adj, rev.invoiceAdjustment!];
    const s = summarizePointsAndDiscounts(events, adjustments);
    expect(s).toMatchObject({ pointsBalance: 500, bahtDiscountApplied: 50, bahtDiscountReversed: 50 });
    expect(findPointsDiscrepancies(events, adjustments)).toEqual([]);
  });

  it("the same redemption cannot be reversed twice", () => {
    const r = redeem();
    const rev = planRedemptionReversal({
      originalPointsEvent: r.pointsEvent!, originalAdjustment: r.invoiceAdjustment!,
      reason: "again", alreadyReversedKeys: ["r1"],
    });
    expect(rev.errors.length).toBe(1);
  });

  it("a redemption that lost its invoice adjustment is flagged", () => {
    const r = redeem();
    expect(findPointsDiscrepancies([r.pointsEvent!], []).map((d) => d.kind)).toEqual(["redeem_without_adjustment"]);
  });
});

describe("Scenario: voided receipt", () => {
  const twoInvoices = () =>
    newLedger([
      { id: "A", periodStart: "2026-05-01", total: 3000 },
      { id: "B", periodStart: "2026-06-01", total: 3000 },
    ]);

  it("voiding a single-invoice receipt nets money and balance to zero with zero findings", () => {
    const l = newLedger([{ id: "A", periodStart: "2026-05-01", total: 3000 }]);
    const r = recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    voidBatch(l, (r as any).batchId, "2026-05-05");
    expect(l.invoices[0]).toMatchObject({ paid: 0, status: "pending" });
    expect(netAllocated(l)).toBe(0);
    expect(l.allocations.map((a) => a.amount)).toEqual([3000, -3000]); // reversal row, nothing deleted
    expect(l.batches[0].voided_at).toBe("2026-05-05");
    expect(clean(l)).toEqual([]);
  });

  it("voiding a multi-invoice receipt with credit reverses every allocation and the credit", () => {
    const l = twoInvoices();
    const r = recordPayment(l, { amount: 4000, paidAt: "2026-05-04", snapshot: KBANK });
    expect(l.invoices.map((i) => i.paid)).toEqual([3000, 1000]);
    voidBatch(l, (r as any).batchId, "2026-05-05");
    expect(l.invoices.map((i) => [i.paid, i.status])).toEqual([[0, "pending"], [0, "pending"]]);
    expect(netAllocated(l)).toBe(0);
    expect(l.credit).toBe(0);
    expect(clean(l)).toEqual([]);
  });

  it("voiding only one of two receipts leaves the other intact", () => {
    const l = twoInvoices();
    recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    const r2 = recordPayment(l, { amount: 1000, paidAt: "2026-06-04", snapshot: KBANK });
    voidBatch(l, (r2 as any).batchId, "2026-06-05");
    expect(l.invoices.map((i) => i.paid)).toEqual([3000, 0]);
    expect(netAllocated(l)).toBe(3000);
    expect(clean(l)).toEqual([]);
  });

  it("tampering a payment_history amount is reported", () => {
    const l = twoInvoices();
    recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    l.invoices[0].history[0].amount = 2500;
    const f = clean(l);
    expect(f.map((x) => x.check)).toEqual(["payment_history_mismatch"]);
    expect(f[0]).toMatchObject({ invoiceId: "A", amount: 500 });
  });

  it("inflating paid_amount with no payment behind it is reported as high severity", () => {
    const l = twoInvoices();
    recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    l.invoices[1].paid = 1500;
    const f = clean(l).filter((x) => x.check === "invoice_paid_vs_allocations");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ invoiceId: "B", severity: "high", amount: 1500 });
  });

  it("a void whose reversal rows were lost is reported on the batch", () => {
    const l = newLedger([{ id: "A", periodStart: "2026-05-01", total: 3000 }]);
    const r = recordPayment(l, { amount: 3000, paidAt: "2026-05-04", snapshot: KBANK });
    voidBatch(l, (r as any).batchId, "2026-05-05");
    l.allocations.pop();
    expect(clean(l).some((x) => x.check === "batch_vs_allocations" && x.severity === "high")).toBe(true);
  });
});

describe("Scenario: status edit never changes balances", () => {
  it("flipping an unpaid invoice to 'paid' moves no money; reconciliation flags the lie", () => {
    const l = newLedger([{ id: "A", periodStart: "2026-05-01", total: 3000 }]);
    recordPayment(l, { amount: 1000, paidAt: "2026-05-04", snapshot: KBANK });
    const before = JSON.stringify({ b: l.batches, a: l.allocations, paid: l.invoices[0].paid });
    l.invoices[0].status = "paid"; // what update_status writes: status only
    expect(JSON.stringify({ b: l.batches, a: l.allocations, paid: l.invoices[0].paid })).toBe(before);
    const f = clean(l);
    expect(f.map((x) => x.check)).toEqual(["status_vs_balance"]);
    expect(f[0]).toMatchObject({ severity: "high", amount: 2000 });
  });

  it("status is derived from balances, not the reverse", () => {
    expect(resolveInvoiceStatus({ total_amount: 3000, paid_amount: 1000, due_date: "2026-07-01" }, "2026-06-10")).toBe("partial");
  });

  it.todo("update_status route writes only `status` and never calls applyInvoicePaymentAllocation - needs route/DB test (no API route coverage)");
});

describe("Scenario: concurrent updates (stale expected_paid_amount)", () => {
  it("a second writer holding a stale paid_amount is rejected and nothing is written", () => {
    const l = newLedger([{ id: "A", periodStart: "2026-05-01", total: 3000 }]);
    // Two admins both load the invoice at paid=0.
    const first = recordPayment(l, { amount: 1000, paidAt: "2026-05-04", snapshot: KBANK, expectedPaid: { A: 0 } });
    const second = recordPayment(l, { amount: 1000, paidAt: "2026-05-04", snapshot: KBANK, expectedPaid: { A: 0 } });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "stale expected_paid_amount for A" });
    expect(l.invoices[0].paid).toBe(1000);
    expect(l.batches).toHaveLength(1);
    expect(clean(l)).toEqual([]);
  });

  it("the manual-split builder emits expected_paid_amount equal to the paid_amount it read", () => {
    const { payload } = buildManualSplitPayload({
      batchId: "b1", tenantId: "t1", triggerInvoiceId: "A",
      allocations: [{ invoiceId: "A", amount: 500 }],
      invoicesById: new Map([["A", { id: "A", total_amount: 3000, paid_amount: 1000 }]]),
      paidAt: "2026-05-04", slipUrl: null, mode: "cash", source: "admin", idempotencyKey: null,
      method: { id: null, snapshot: KBANK }, createdBy: null, statusFor: () => "partial", lateFeeFor: () => 0,
    });
    expect(payload.invoices[0]).toMatchObject({ expected_paid_amount: 1000, paid_amount: 1500 });
  });

  it.todo("two truly simultaneous record_payment_batch calls serialise on the row lock - needs DB test");
  it.todo("a retried request racing its own first attempt hits the unique (trigger_invoice_id, idempotency_key) index - needs DB test");
});
