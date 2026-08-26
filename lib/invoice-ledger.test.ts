import { describe, expect, it } from "vitest";
import {
  calculateLateFeeAmount,
  computeLateFeeSnapshot,
  getInvoiceOutstanding,
  getInvoiceOwnOutstanding,
  planAbandonCredit,
  planPaymentReplay,
  resolveInvoiceStatus,
} from "./invoice-ledger";

describe("getInvoiceOutstanding", () => {
  it("returns zero when paid meets total", () => {
    expect(getInvoiceOutstanding({ total_amount: 100, paid_amount: 100 })).toBe(0);
  });
  it("returns difference when partially paid", () => {
    expect(getInvoiceOutstanding({ total_amount: 500, paid_amount: 200 })).toBe(300);
  });
  it("treats nullish as zero", () => {
    expect(getInvoiceOutstanding({ total_amount: null, paid_amount: null })).toBe(0);
  });
});

describe("getInvoiceOwnOutstanding", () => {
  // Room 212/2: June's 3,300 bill went unpaid and was carried into July, whose
  // 7,925 total is 3,125 of July usage + June's 3,300 + June's 1,500 late fee.
  const june = { total_amount: 3300, paid_amount: 0, carry_forward_amount: 0 };
  const july = { total_amount: 7925, paid_amount: 0, carry_forward_amount: 3300 };

  it("excludes the carried-in portion from the newer invoice", () => {
    expect(getInvoiceOwnOutstanding(july)).toBe(4625);
  });

  it("sums across a chain to the real debt, not the bundled totals", () => {
    // Summing raw outstanding would give 11,225 — June counted twice. Spending
    // an abandoning tenant's deposit against that figure burns credit they
    // never owed, which is what `abandon_room` used to do.
    const own = getInvoiceOwnOutstanding(june) + getInvoiceOwnOutstanding(july);
    const raw = getInvoiceOutstanding(june) + getInvoiceOutstanding(july);
    expect(own).toBe(7925);
    expect(raw).toBe(11225);
  });

  it("treats a payment as retiring the carried-in portion first", () => {
    // Room 114/1's April bill: 6,244 total carrying 1,446, with 6,000 paid.
    // The 1,446 carried debt clears first, leaving exactly its own 244.
    expect(
      getInvoiceOwnOutstanding({
        total_amount: 6244,
        paid_amount: 6000,
        carry_forward_amount: 1446,
      })
    ).toBe(244);
  });
});

describe("planAbandonCredit", () => {
  // Room 212/2: June ฿3,300 unpaid, July ฿7,925 of which ฿4,625 is its own.
  // Ordered FINAL INVOICE FIRST, which is how the route now queries them.
  const finalFirst = [
    { id: "july", total_amount: 7925, paid_amount: 0, carry_forward_amount: 3300 },
    { id: "june", total_amount: 3300, paid_amount: 0, carry_forward_amount: 0 },
  ];

  it("settles the final invoice before earlier periods", () => {
    const plan = planAbandonCredit(finalFirst, 5900);
    expect(plan.totalOwed).toBe(7925);
    // July's own charge 4,625 is covered first; June gets the remaining 1,275.
    expect(plan.lines.map((line) => line.applied)).toEqual([4625, 1275]);
    expect(plan.lines.map((line) => line.outcome)).toEqual(["paid", "partial"]);
    expect(plan.creditApplied).toBe(5900);
    expect(plan.refundableCredit).toBe(0);
  });

  it("never marks a shortfall as cancelled — the debt survives", () => {
    const plan = planAbandonCredit(finalFirst, 5900);
    // June keeps 2,025 owing. It must stay a real debt, not a write-off.
    expect(plan.writtenOff).toBe(2025);
    expect(plan.lines.map((line) => line.outcome)).not.toContain("cancelled");
    expect(plan.lines.map((line) => line.outcome)).not.toContain(
      "partial_cancelled",
    );
  });

  it("leaves every invoice unpaid when the deposit is forfeited", () => {
    const plan = planAbandonCredit(finalFirst, 0);
    expect(plan.creditApplied).toBe(0);
    expect(plan.writtenOff).toBe(7925);
    // Previously these became "cancelled"; they now stay owing.
    expect(plan.lines.map((line) => line.outcome)).toEqual(["unpaid", "unpaid"]);
  });

  it("returns leftover credit instead of burning it on double-counted debt", () => {
    const plan = planAbandonCredit(finalFirst, 9000);
    expect(plan.creditApplied).toBe(7925);
    expect(plan.writtenOff).toBe(0);
    expect(plan.refundableCredit).toBe(1075);
    expect(plan.lines.every((line) => line.outcome === "paid")).toBe(true);
  });

  it("skips an invoice whose own charge is already settled", () => {
    const plan = planAbandonCredit(
      [{ id: "carry-only", total_amount: 3300, paid_amount: 0, carry_forward_amount: 3300 }],
      1000,
    );
    expect(plan.lines[0].outcome).toBe("already_clear");
    expect(plan.refundableCredit).toBe(1000);
  });
});

describe("resolveInvoiceStatus", () => {
  it("returns paid when nothing owed", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 100, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("paid");
  });
  it("returns pending when before due and unpaid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 0, due_date: "2026-01-15" },
        "2026-01-10"
      )
    ).toBe("pending");
  });
  it("returns overdue when past due and unpaid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 0, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("overdue");
  });
  it("returns partial when past due but some paid", () => {
    expect(
      resolveInvoiceStatus(
        { total_amount: 100, paid_amount: 40, due_date: "2026-01-05" },
        "2026-01-10"
      )
    ).toBe("partial");
  });
});

describe("calculateLateFeeAmount", () => {
  it("returns zero when no late fee start", () => {
    expect(
      calculateLateFeeAmount(
        { late_fee_start_date: null as any, late_fee_per_day: 100 },
        "2026-02-01"
      )
    ).toBe(0);
  });
  it("computes days inclusive from start to as-of", () => {
    expect(
      calculateLateFeeAmount(
        { late_fee_start_date: "2026-01-01", late_fee_per_day: 10 },
        "2026-01-03"
      )
    ).toBe(30);
  });
});

describe("computeLateFeeSnapshot", () => {
  it("matches calculateLateFeeAmount's live day-count for a still-open invoice", () => {
    const snapshot = computeLateFeeSnapshot(
      {
        status: "overdue",
        late_fee_start_date: "2026-01-01",
        late_fee_per_day: 10,
        locked_late_fee_amount: null,
      },
      "2026-01-03",
    );
    expect(snapshot.amount).toBe(30);
    expect(snapshot.days).toBe(3);
    expect(snapshot.asOf).toBe("2026-01-03");
  });

  it("uses the already-frozen amount for a still-open invoice, not a fresh day-count", () => {
    const snapshot = computeLateFeeSnapshot(
      {
        status: "overdue",
        late_fee_start_date: "2026-01-01",
        late_fee_per_day: 10,
        locked_late_fee_amount: 30,
      },
      "2026-06-01", // far past the freeze — must not re-derive a bigger number
    );
    expect(snapshot.amount).toBe(30);
  });

  // Room 217/2's real bug: a tenant paid 3 days late (should be ฿300), but an
  // earlier, unrelated carry-forward event had already frozen the fee at
  // ฿1,500 (15 days, based on "still open as of generation day"). Once
  // locked, the number never re-derives — this test only guards that a PAID
  // invoice's snapshot is read from the freeze, not recomputed against
  // asOfDateText, which is the property the fix actually depends on.
  it("reads a paid invoice's late fee from the freeze, never live-recomputed against asOf", () => {
    const snapshot = computeLateFeeSnapshot(
      {
        status: "paid",
        late_fee_start_date: "2026-08-11",
        late_fee_per_day: 100,
        locked_late_fee_amount: 300,
      },
      "2026-09-25", // generation date weeks later — must not inflate the fee
    );
    expect(snapshot.amount).toBe(300);
    expect(snapshot.days).toBe(3);
    expect(snapshot.asOf).toBe("2026-08-13"); // start (08-11) + 3 days - 1
  });

  it("never fabricates a fee for a paid invoice that was never frozen", () => {
    // Historical paid invoices from before the payment-time freeze existed
    // have no locked_late_fee_amount. A live day-count against "today" would
    // wildly overstate a fee the tenant was never actually told about.
    const snapshot = computeLateFeeSnapshot(
      {
        status: "paid",
        late_fee_start_date: "2026-01-11",
        late_fee_per_day: 100,
        locked_late_fee_amount: null,
      },
      "2026-08-25",
    );
    expect(snapshot.amount).toBe(0);
    expect(snapshot.days).toBe(0);
    expect(snapshot.asOf).toBeNull();
  });

  it("returns zero for a paid invoice with a zero freeze, without dividing by a zero rate", () => {
    const snapshot = computeLateFeeSnapshot(
      {
        status: "paid",
        late_fee_start_date: "2026-01-11",
        late_fee_per_day: 0,
        locked_late_fee_amount: 0,
      },
      "2026-08-25",
    );
    expect(snapshot.amount).toBe(0);
    expect(snapshot.days).toBe(0);
  });
});

describe("planPaymentReplay", () => {
  const batch = (id: string, amount: number, paidAt: string) => ({
    id,
    amount_received: amount,
    paid_at: paidAt,
  });

  it("re-splits a chain payment after an earlier invoice is edited down", () => {
    // Room 116/1: ฿6,481 arrived against the May invoice while April was worth
    // ฿6,144, so April was allocated ฿6,144 / May ฿337. April was later
    // corrected down to ฿3,244, leaving the stored split claiming more had gone
    // to April than the invoice was worth.
    const { allocations, paidByInvoiceId, unallocated } = planPaymentReplay(
      [
        { id: "april", total_amount: 3244, start_date: "2026-04-01" },
        { id: "may", total_amount: 6481, start_date: "2026-05-01" },
      ],
      [batch("b1", 6481, "2026-06-07T05:00:00Z")],
    );

    expect(paidByInvoiceId.get("april")).toBe(3244);
    expect(paidByInvoiceId.get("may")).toBe(3237);
    expect(allocations.map((row) => row.amount)).toEqual([3244, 3237]);
    // Every baht received still lands somewhere.
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(6481);
    expect(unallocated).toBe(0);
  });

  it("fills the oldest invoice first", () => {
    const { paidByInvoiceId } = planPaymentReplay(
      [
        { id: "old", total_amount: 1000, start_date: "2026-01-01" },
        { id: "new", total_amount: 1000, start_date: "2026-02-01" },
      ],
      [batch("b1", 1500, "2026-03-01T00:00:00Z")],
    );
    expect(paidByInvoiceId.get("old")).toBe(1000);
    expect(paidByInvoiceId.get("new")).toBe(500);
  });

  it("replays multiple batches in date order", () => {
    const { paidByInvoiceId, unallocated } = planPaymentReplay(
      [
        { id: "a", total_amount: 500, start_date: "2026-01-01" },
        { id: "b", total_amount: 500, start_date: "2026-02-01" },
      ],
      [
        batch("late", 400, "2026-04-01T00:00:00Z"),
        batch("early", 600, "2026-03-01T00:00:00Z"),
      ].sort((l, r) => new Date(l.paid_at).getTime() - new Date(r.paid_at).getTime()),
    );
    expect(paidByInvoiceId.get("a")).toBe(500);
    expect(paidByInvoiceId.get("b")).toBe(500);
    expect(unallocated).toBe(0);
  });

  it("reports money that no longer fits as unallocated rather than dropping it", () => {
    // Invoices edited down below what the tenant actually transferred.
    const { allocations, unallocated } = planPaymentReplay(
      [{ id: "only", total_amount: 1000, start_date: "2026-01-01" }],
      [batch("b1", 2500, "2026-02-01T00:00:00Z")],
    );
    expect(allocations.reduce((sum, row) => sum + row.amount, 0)).toBe(1000);
    expect(unallocated).toBe(1500);
  });

  it("never allocates more than an invoice is worth", () => {
    const { allocations } = planPaymentReplay(
      [{ id: "only", total_amount: 100, start_date: "2026-01-01" }],
      [batch("b1", 100, "2026-02-01T00:00:00Z"), batch("b2", 100, "2026-03-01T00:00:00Z")],
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].amount).toBe(100);
  });

  it("carries the batch's frozen receiving account onto each allocation", () => {
    const snapshot = { label: "บริษัท", bank_name: "ธนาคารกสิกรไทย" };
    const { allocations } = planPaymentReplay(
      [
        { id: "a", total_amount: 100, start_date: "2026-01-01" },
        { id: "b", total_amount: 100, start_date: "2026-02-01" },
      ],
      [
        {
          ...batch("b1", 200, "2026-03-01T00:00:00Z"),
          payment_method_id: "m1",
          payment_method_snapshot: snapshot,
        },
      ],
    );
    expect(allocations).toHaveLength(2);
    for (const row of allocations) {
      expect(row.payment_method_snapshot).toEqual(snapshot);
      expect(row.payment_method_id).toBe("m1");
    }
  });
});

describe("planPaymentReplay — legacy payments", () => {
  const batch = (id: string, amount: number, paidAt: string) => ({
    id,
    amount_received: amount,
    paid_at: paidAt,
  });

  it("never redistributes away a payment no allocation accounts for", () => {
    // The old invoice was settled before allocations were recorded, so it has
    // paid_amount with no allocation row behind it. Replaying the chain must
    // not treat it as unpaid and hand its money to a later invoice.
    const { paidByInvoiceId, allocations } = planPaymentReplay(
      [
        { id: "legacy", total_amount: 1000, start_date: "2026-01-01", legacy_paid: 1000 },
        { id: "recent", total_amount: 1000, start_date: "2026-02-01" },
      ],
      [batch("b1", 1000, "2026-03-01T00:00:00Z")],
    );

    expect(paidByInvoiceId.get("legacy")).toBe(1000);
    expect(paidByInvoiceId.get("recent")).toBe(1000);
    // The batch money goes to the invoice that actually still owes it.
    expect(allocations).toHaveLength(1);
    expect(allocations[0].invoice_id).toBe("recent");
  });

  it("only opens the unbacked remainder of a partly-legacy invoice", () => {
    const { paidByInvoiceId, allocations } = planPaymentReplay(
      [{ id: "part", total_amount: 1000, start_date: "2026-01-01", legacy_paid: 400 }],
      [batch("b1", 1000, "2026-02-01T00:00:00Z")],
    );
    expect(paidByInvoiceId.get("part")).toBe(1000);
    expect(allocations[0].amount).toBe(600);
  });
});

describe("planPaymentReplay — phantom-receipt detection", () => {
  it("flags surplus rather than pushing it onto later unpaid invoices", () => {
    // Room 114/1: duplicate batches meant the group carried far more money than
    // the tenant ever paid. Spreading it forward marked May/June/July — genuinely
    // overdue with ฿0 received — as fully paid. The surplus must surface as
    // `unallocated` so the caller can refuse to write.
    const { paidByInvoiceId, unallocated } = planPaymentReplay(
      [
        { id: "apr", total_amount: 6244, start_date: "2026-04-01" },
        { id: "may", total_amount: 5294, start_date: "2026-05-01" },
      ],
      [
        { id: "real", amount_received: 6000, paid_at: "2026-05-30T05:00:00Z" },
        { id: "phantom1", amount_received: 6000, paid_at: "2026-05-30T05:00:00Z" },
        { id: "phantom2", amount_received: 6000, paid_at: "2026-05-30T05:00:00Z" },
      ],
    );
    // Capacity is 11,538 against 18,000 recorded.
    expect(paidByInvoiceId.get("apr")).toBe(6244);
    expect(paidByInvoiceId.get("may")).toBe(5294);
    expect(unallocated).toBeCloseTo(6462, 2);
  });

  it("reports no surplus for a clean chain", () => {
    const { unallocated } = planPaymentReplay(
      [
        { id: "april", total_amount: 3244, start_date: "2026-04-01" },
        { id: "may", total_amount: 6481, start_date: "2026-05-01" },
      ],
      [{ id: "b1", amount_received: 6481, paid_at: "2026-06-07T05:00:00Z" }],
    );
    expect(unallocated).toBe(0);
  });
});
