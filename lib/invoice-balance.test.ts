import { describe, expect, it } from "vitest";
import {
  getInvoiceBalance,
  getTenantBalance,
  type BalanceAllocation,
  type BalanceTenant,
  type BalanceWaiver,
  type LegacyBalanceInvoice,
  type V2BalanceInvoice,
} from "./invoice-balance";

// A November 2026 bill on the new rules: due 5 Nov, fee from 6 Nov at 100/day.
const livingTenant: BalanceTenant = {
  status: "active",
  handover_date: null,
  tenancy_end_date: null,
};

const v2 = (overrides: Partial<V2BalanceInvoice> = {}): V2BalanceInvoice => ({
  id: "nov",
  fee_model: "v2",
  kind: "monthly",
  total_amount: 3000,
  due_date: "2026-11-05",
  late_fee_start_date: "2026-11-06",
  late_fee_per_day: 100,
  late_fee_paused_from: null,
  manual_status: null,
  is_verifying: false,
  tenant: livingTenant,
  ...overrides,
});

const legacy = (
  overrides: Partial<LegacyBalanceInvoice> = {},
): LegacyBalanceInvoice => ({
  id: "sep",
  fee_model: "legacy",
  total_amount: 3000,
  carry_forward_amount: 0,
  due_date: "2026-10-05",
  locked_late_fee_amount: null,
  late_fee_billed_at: null,
  manual_status: null,
  is_verifying: false,
  tenant: livingTenant,
  ...overrides,
});

const pay = (
  amount: number,
  paid_at: string,
  overrides: Partial<BalanceAllocation> = {},
): BalanceAllocation => ({
  invoice_id: "nov",
  amount,
  paid_at,
  voided_at: null,
  ...overrides,
});

const waive = (
  amount: number,
  overrides: Partial<BalanceWaiver> = {},
): BalanceWaiver => ({
  invoice_id: "nov",
  amount,
  voided_at: null,
  ...overrides,
});

describe("getInvoiceBalance — fee days (v2)", () => {
  it("charges no fee when the bill is paid in full on the due date", () => {
    const b = getInvoiceBalance(v2(), [pay(3000, "2026-11-05")], [], "2026-11-20");
    expect(b.feeStopDate).toBe("2026-11-05");
    expect(b.feeDays).toBe(0);
    expect(b.feeAccrued).toBe(0);
    expect(b.amountDue).toBe(0);
    expect(b.status).toBe("paid");
  });

  it("charges exactly one day when paid one day after the due date", () => {
    // Paid on 6 Nov — the fee's own start day. The fee stops on the day the
    // charges are covered, and that day counts: one day, 100 baht.
    const b = getInvoiceBalance(v2(), [pay(3000, "2026-11-06")], [], "2026-11-20");
    expect(b.feeStopDate).toBe("2026-11-06");
    expect(b.feeDays).toBe(1);
    expect(b.feeAccrued).toBe(100);
    expect(b.chargesPaid).toBe(3000);
    expect(b.chargesDue).toBe(0);
    expect(b.feeDue).toBe(100);
    // The fee is fixed now, but still owed on this same bill.
    expect(b.amountDue).toBe(100);
    expect(b.feeRunning).toBe(false);
    expect(b.status).toBe("overdue");
  });

  it("a payment on the start day that also covers the fee settles the bill", () => {
    const b = getInvoiceBalance(v2(), [pay(3100, "2026-11-06")], [], "2026-11-20");
    expect(b.feeDays).toBe(1);
    expect(b.chargesPaid).toBe(3000);
    expect(b.feePaid).toBe(100);
    expect(b.amountDue).toBe(0);
    expect(b.status).toBe("paid");
  });

  it("counts every day from the start date through today while unpaid", () => {
    const b = getInvoiceBalance(v2(), [], [], "2026-11-10");
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(5); // 6, 7, 8, 9, 10 Nov
    expect(b.feeAccrued).toBe(500);
    expect(b.feeRunning).toBe(true);
    expect(b.amountDue).toBe(3500);
  });

  it("accrues nothing on or before the due date", () => {
    const b = getInvoiceBalance(v2(), [], [], "2026-11-05");
    expect(b.feeDays).toBe(0);
    expect(b.feeRunning).toBe(false);
    expect(b.amountDue).toBe(3000);
  });

  it("stops the fee on the pause date and keeps it fixed afterwards", () => {
    const paused = v2({ late_fee_paused_from: "2026-11-08" });
    const b = getInvoiceBalance(paused, [], [], "2026-11-30");
    expect(b.feeStopDate).toBe("2026-11-08");
    expect(b.feeDays).toBe(3); // 6, 7, 8 Nov — the formula is inclusive of the stop date
    expect(b.feeAccrued).toBe(300);
    expect(b.feeRunning).toBe(false);
    expect(b.amountDue).toBe(3300);
  });

  it("ignores a pause dated after the as-of date", () => {
    const paused = v2({ late_fee_paused_from: "2026-11-20" });
    const b = getInvoiceBalance(paused, [], [], "2026-11-10");
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(5);
  });

  it("caps a waiver larger than the accrued fee so nothing goes negative", () => {
    const b = getInvoiceBalance(v2(), [], [waive(5000)], "2026-11-10");
    expect(b.feeAccrued).toBe(500);
    expect(b.feeWaived).toBe(500);
    expect(b.feeDue).toBe(0);
    expect(b.amountDue).toBe(3000);
  });

  it("sums several waivers and skips voided ones", () => {
    const b = getInvoiceBalance(
      v2(),
      [],
      [waive(100), waive(150), waive(1000, { voided_at: "2026-11-09T10:00:00+07:00" })],
      "2026-11-10",
    );
    expect(b.feeWaived).toBe(250);
    expect(b.amountDue).toBe(3000 + 500 - 250);
  });

  it("stops the fee on the transfer date of a backdated payment, not the day it was entered", () => {
    // Transferred 7 Nov, recorded by the admin on 20 Nov.
    const b = getInvoiceBalance(
      v2(),
      [pay(3000, "2026-11-07T10:15:00+07:00")],
      [],
      "2026-11-20",
    );
    expect(b.feeStopDate).toBe("2026-11-07");
    expect(b.feeDays).toBe(2);
    expect(b.amountDue).toBe(200);
  });

  it("reads paid_at in Bangkok time, not UTC", () => {
    // 18:30 UTC on 6 Nov is 01:30 on 7 Nov in Bangkok.
    const b = getInvoiceBalance(v2(), [pay(3000, "2026-11-06T18:30:00Z")], [], "2026-11-20");
    expect(b.feeStopDate).toBe("2026-11-07");
    expect(b.feeDays).toBe(2);
  });

  it("stops on the date cumulative payments reached the charges, in paid_at order", () => {
    // Passed out of order on purpose.
    const b = getInvoiceBalance(
      v2(),
      [pay(2000, "2026-11-12"), pay(1000, "2026-11-08")],
      [],
      "2026-11-30",
    );
    expect(b.feeStopDate).toBe("2026-11-12");
    expect(b.feeDays).toBe(7); // 6..12 Nov
    expect(b.amountDue).toBe(700);
  });

  it("keeps the fee running while payments fall short of the charges", () => {
    const b = getInvoiceBalance(v2(), [pay(2999, "2026-11-07")], [], "2026-11-10");
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(5);
    expect(b.amountDue).toBe(1 + 500);
    expect(b.status).toBe("overdue");
  });

  it("restarts the fee when the covering payment is voided", () => {
    const b = getInvoiceBalance(
      v2(),
      [pay(3000, "2026-11-06", { voided_at: "2026-11-09T09:00:00+07:00" })],
      [],
      "2026-11-10",
    );
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(5);
    expect(b.chargesPaid).toBe(0);
    expect(b.amountDue).toBe(3500);
  });

  it("ignores payments dated after the as-of date", () => {
    // Asking "what was owed on 8 Nov" must not see a 12 Nov transfer.
    const b = getInvoiceBalance(v2(), [pay(3000, "2026-11-12")], [], "2026-11-08");
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(3);
    expect(b.chargesPaid).toBe(0);
    expect(b.amountDue).toBe(3300);
  });

  it("never accrues a fee on a move-out bill, however late", () => {
    const b = getInvoiceBalance(v2({ kind: "move_out" }), [], [], "2027-03-01");
    expect(b.feeDays).toBe(0);
    expect(b.feeAccrued).toBe(0);
    expect(b.feeRunning).toBe(false);
    expect(b.amountDue).toBe(3000);
    expect(b.status).toBe("overdue");
  });

  it("stops the fee on the tenant's handover date once they have left", () => {
    const leaving = v2({
      tenant: { status: "active", handover_date: "2026-11-09", tenancy_end_date: "2026-11-30" },
    });
    const b = getInvoiceBalance(leaving, [], [], "2026-11-20");
    expect(b.feeStopDate).toBe("2026-11-09");
    expect(b.feeDays).toBe(4);
  });

  it("does not stop the fee for a notice date while the tenant still lives there", () => {
    const givenNotice = v2({
      tenant: { status: "active", handover_date: null, tenancy_end_date: "2026-11-08" },
    });
    const b = getInvoiceBalance(givenNotice, [], [], "2026-11-20");
    expect(b.feeStopDate).toBeNull();
    expect(b.feeDays).toBe(15);
  });

  it("uses the earliest of payment, pause and handover", () => {
    const b = getInvoiceBalance(
      v2({
        late_fee_paused_from: "2026-11-15",
        tenant: { status: "active", handover_date: "2026-11-11", tenancy_end_date: null },
      }),
      [pay(3000, "2026-11-13")],
      [],
      "2026-11-30",
    );
    expect(b.feeStopDate).toBe("2026-11-11");
    expect(b.feeDays).toBe(6);
  });

  it("handles satang without floating-point drift", () => {
    const b = getInvoiceBalance(
      v2({ total_amount: 0.3, late_fee_per_day: 0 }),
      [pay(0.1, "2026-11-01"), pay(0.2, "2026-11-02")],
      [],
      "2026-11-10",
    );
    expect(b.chargesPaid).toBe(0.3);
    expect(b.amountDue).toBe(0);
    expect(b.feeStopDate).toBe("2026-11-02");
    expect(b.status).toBe("paid");
  });

  it("rejects an allocation or waiver that belongs to a different invoice", () => {
    expect(() =>
      getInvoiceBalance(v2(), [pay(3000, "2026-11-05", { invoice_id: "oct" })], [], "2026-11-20"),
    ).toThrow(/invoice/);
    expect(() =>
      getInvoiceBalance(v2(), [], [waive(100, { invoice_id: "oct" })], "2026-11-20"),
    ).toThrow(/invoice/);
  });

  it("rejects an as-of value that is not a calendar date", () => {
    expect(() => getInvoiceBalance(v2(), [], [], "2026-11-20T10:00:00Z")).toThrow(/asOfBangkok/);
  });
});

describe("getInvoiceBalance — legacy adapter", () => {
  it("counts only a bundled bill's own charges — room 109/1 September", () => {
    // 109/1's September bill stored 8,666 including August's carried 5,758.
    const b = getInvoiceBalance(
      legacy({ total_amount: 8666, carry_forward_amount: 5758 }),
      [],
      [],
      "2026-10-20",
    );
    expect(b.charges).toBe(2908);
    expect(b.amountDue).toBe(2908);
  });

  it("reads 109/1's three bundled bills as 8,666 owed, not 17,291", () => {
    const tenant = getTenantBalance(
      [
        legacy({ id: "jul", total_amount: 2867, carry_forward_amount: 0, due_date: "2026-08-05" }),
        legacy({ id: "aug", total_amount: 5758, carry_forward_amount: 2867, due_date: "2026-09-05" }),
        legacy({ id: "sep", total_amount: 8666, carry_forward_amount: 5758, due_date: "2026-10-05" }),
      ],
      [],
      [],
      "2026-10-20",
    );
    expect(tenant.rows.map((row) => row.balance.charges)).toEqual([2867, 2891, 2908]);
    expect(tenant.amountDue).toBe(8666);
    expect(2867 + 5758 + 8666).toBe(17291); // what raw-summing the stored totals gave
  });

  it("honours a frozen late fee that was never billed elsewhere", () => {
    const b = getInvoiceBalance(
      legacy({ locked_late_fee_amount: 1500, late_fee_billed_at: null }),
      [pay(3000, "2026-10-12", { invoice_id: "sep" })],
      [],
      "2026-10-20",
    );
    expect(b.feeAccrued).toBe(1500);
    expect(b.feeDue).toBe(1500);
    expect(b.amountDue).toBe(1500);
  });

  it("never grows a frozen legacy fee, however long it stays unpaid", () => {
    const bill = legacy({ locked_late_fee_amount: 1500 });
    const early = getInvoiceBalance(bill, [], [], "2026-10-20");
    const late = getInvoiceBalance(bill, [], [], "2027-06-01");
    expect(early.feeAccrued).toBe(1500);
    expect(late.feeAccrued).toBe(1500);
    expect(late.feeDays).toBe(0);
    expect(late.feeRunning).toBe(false);
  });

  it("shows no fee on a legacy bill whose fee was never frozen", () => {
    const b = getInvoiceBalance(legacy({ locked_late_fee_amount: null }), [], [], "2027-06-01");
    expect(b.feeAccrued).toBe(0);
    expect(b.amountDue).toBe(3000);
  });

  it("drops a frozen fee already billed onto another invoice", () => {
    const b = getInvoiceBalance(
      legacy({ locked_late_fee_amount: 1500, late_fee_billed_at: "2026-09-25T00:00:00Z" }),
      [],
      [],
      "2026-10-20",
    );
    expect(b.feeAccrued).toBe(0);
    expect(b.amountDue).toBe(3000);
  });

  it("shows no late fee at all on a former tenant's legacy bill", () => {
    const b = getInvoiceBalance(
      legacy({
        locked_late_fee_amount: 1500,
        tenant: { status: "inactive", handover_date: null, tenancy_end_date: null },
      }),
      [],
      [],
      "2026-10-20",
    );
    expect(b.feeAccrued).toBe(0);
    expect(b.amountDue).toBe(3000);
  });

  it("applies a new-style waiver against a frozen legacy fee", () => {
    const b = getInvoiceBalance(
      legacy({ locked_late_fee_amount: 1500 }),
      [],
      [waive(500, { invoice_id: "sep" })],
      "2026-10-20",
    );
    expect(b.feeWaived).toBe(500);
    expect(b.amountDue).toBe(4000);
  });

  it("works from a legacy row with no carry-forward recorded", () => {
    const b = getInvoiceBalance(
      legacy({ total_amount: 3000, carry_forward_amount: null }),
      [],
      [],
      "2026-10-20",
    );
    expect(b.charges).toBe(3000);
  });

  it("never mutates its inputs", () => {
    const bill = Object.freeze(legacy({ locked_late_fee_amount: 1500 }));
    const allocations = Object.freeze([
      Object.freeze(pay(1000, "2026-10-12", { invoice_id: "sep" })),
    ]);
    const waivers = Object.freeze([Object.freeze(waive(100, { invoice_id: "sep" }))]);
    const snapshot = JSON.stringify({ bill, allocations, waivers });
    getInvoiceBalance(bill, allocations, waivers, "2026-10-20");
    expect(JSON.stringify({ bill, allocations, waivers })).toBe(snapshot);
  });
});

describe("getInvoiceBalance — status table", () => {
  it("draft: never sent", () => {
    expect(getInvoiceBalance(v2({ manual_status: "draft" }), [], [], "2026-11-01").status).toBe("draft");
  });

  it("pending: sent, owing, not yet due, nothing paid", () => {
    expect(getInvoiceBalance(v2(), [], [], "2026-11-01").status).toBe("pending");
  });

  it("partial: some money received, still owing, not yet due", () => {
    const b = getInvoiceBalance(v2(), [pay(1000, "2026-10-30")], [], "2026-11-01");
    expect(b.amountDue).toBe(2000);
    expect(b.status).toBe("partial");
  });

  it("overdue: owing after the due date, paid or not", () => {
    expect(getInvoiceBalance(v2(), [], [], "2026-11-06").status).toBe("overdue");
    expect(
      getInvoiceBalance(v2(), [pay(1000, "2026-11-01")], [], "2026-11-06").status,
    ).toBe("overdue");
  });

  it("paid: nothing left owing", () => {
    expect(
      getInvoiceBalance(v2(), [pay(3000, "2026-11-01")], [], "2026-11-01").status,
    ).toBe("paid");
  });

  it("paid: the fee is fully waived and the charges are covered", () => {
    const b = getInvoiceBalance(v2(), [pay(3000, "2026-11-08")], [waive(300)], "2026-11-20");
    expect(b.feeAccrued).toBe(300);
    expect(b.status).toBe("paid");
  });

  it("verifying: a slip is waiting for review", () => {
    expect(
      getInvoiceBalance(v2({ is_verifying: true }), [], [], "2026-11-01").status,
    ).toBe("verifying");
  });

  it("closed_unpaid: closed without full payment", () => {
    expect(
      getInvoiceBalance(v2({ manual_status: "closed_unpaid" }), [], [], "2026-11-20").status,
    ).toBe("closed_unpaid");
  });

  it("cancelled: voided before any money", () => {
    expect(
      getInvoiceBalance(v2({ manual_status: "cancelled" }), [], [], "2026-11-01").status,
    ).toBe("cancelled");
  });

  it("verifying overrides overdue and paid, but the money is still computed", () => {
    const overdue = getInvoiceBalance(v2({ is_verifying: true }), [], [], "2026-11-10");
    expect(overdue.status).toBe("verifying");
    expect(overdue.amountDue).toBe(3500);
    expect(overdue.feeDays).toBe(5);

    const covered = getInvoiceBalance(
      v2({ is_verifying: true }),
      [pay(3000, "2026-11-01")],
      [],
      "2026-11-10",
    );
    expect(covered.amountDue).toBe(0);
    expect(covered.status).toBe("verifying");
  });

  it("closed_unpaid overrides overdue, keeping the real amount owed", () => {
    const b = getInvoiceBalance(
      v2({ manual_status: "closed_unpaid" }),
      [pay(1000, "2026-11-01")],
      [],
      "2026-11-10",
    );
    expect(b.status).toBe("closed_unpaid");
    expect(b.amountDue).toBe(2000 + 500);
  });

  it("cancelled and draft override pending", () => {
    expect(getInvoiceBalance(v2({ manual_status: "cancelled" }), [], [], "2026-11-10").status).toBe("cancelled");
    expect(getInvoiceBalance(v2({ manual_status: "draft" }), [], [], "2026-11-10").status).toBe("draft");
  });

  it("a manual status wins over the verifying flag", () => {
    expect(
      getInvoiceBalance(
        v2({ manual_status: "cancelled", is_verifying: true }),
        [],
        [],
        "2026-11-10",
      ).status,
    ).toBe("cancelled");
  });

  it("applies the same table to legacy bills — status is never read from the stored column", () => {
    expect(getInvoiceBalance(legacy(), [], [], "2026-10-01").status).toBe("pending");
    expect(getInvoiceBalance(legacy(), [], [], "2026-10-20").status).toBe("overdue");
    expect(
      getInvoiceBalance(legacy(), [pay(3000, "2026-10-02", { invoice_id: "sep" })], [], "2026-10-20").status,
    ).toBe("paid");
  });
});

describe("getTenantBalance", () => {
  // Design doc A3: a tenant who didn't pay October or November, viewed 15 Dec.
  const oct = v2({ id: "oct", due_date: "2026-11-10", late_fee_start_date: "2026-11-11" });
  const nov = v2({ id: "nov", due_date: "2026-12-10", late_fee_start_date: "2026-12-11" });
  const dec = v2({ id: "dec", due_date: "2027-01-10", late_fee_start_date: "2027-01-11" });

  it("shows this month's bill beside older ones without adding them together — design A3", () => {
    const result = getTenantBalance([dec, oct, nov], [], [], "2026-12-15");
    expect(result.rows.map((row) => row.invoice.id)).toEqual(["oct", "nov", "dec"]);

    const [octRow, novRow, decRow] = result.rows.map((row) => row.balance);
    expect(octRow).toMatchObject({ chargesDue: 3000, feeDays: 35, feeDue: 3500, feeRunning: true });
    expect(novRow).toMatchObject({ chargesDue: 3000, feeDays: 5, feeDue: 500 });
    expect(decRow).toMatchObject({ chargesDue: 3000, feeDays: 0, feeDue: 0, status: "pending" });
    // December's bill stays at 3,000 on its own row.
    expect(decRow.amountDue).toBe(3000);
    expect(result.amountDue).toBe(13000);
  });

  it("routes each allocation and waiver to its own bill", () => {
    const result = getTenantBalance(
      [oct, nov],
      [pay(3000, "2026-11-12", { invoice_id: "oct" }), pay(500, "2026-12-01", { invoice_id: "nov" })],
      [waive(200, { invoice_id: "oct" })],
      "2026-12-15",
    );
    const [octRow, novRow] = result.rows.map((row) => row.balance);
    expect(octRow.feeStopDate).toBe("2026-11-12");
    expect(octRow.amountDue).toBe(200 - 200);
    expect(novRow.amountDue).toBe(2500 + 500);
    expect(result.amountDue).toBe(3000);
  });

  it("leaves draft, cancelled and closed bills out of the total but still lists them", () => {
    const result = getTenantBalance(
      [
        oct,
        v2({ id: "draft", manual_status: "draft" }),
        v2({ id: "void", manual_status: "cancelled" }),
        v2({ id: "closed", manual_status: "closed_unpaid" }),
      ],
      [],
      [],
      "2026-11-10",
    );
    expect(result.rows).toHaveLength(4);
    expect(result.rows.filter((row) => row.includedInTotal).map((row) => row.invoice.id)).toEqual(["oct"]);
    expect(result.amountDue).toBe(3000);
  });

  it("keeps a bill awaiting slip review in the total", () => {
    const result = getTenantBalance([v2({ id: "oct", is_verifying: true })], [], [], "2026-11-01");
    expect(result.rows[0].includedInTotal).toBe(true);
    expect(result.amountDue).toBe(3000);
  });

  it("mixes legacy and v2 bills for one tenant", () => {
    const result = getTenantBalance(
      [legacy({ id: "sep", total_amount: 8666, carry_forward_amount: 5758 }), nov],
      [],
      [],
      "2026-12-15",
    );
    expect(result.rows.map((row) => row.invoice.id)).toEqual(["sep", "nov"]);
    expect(result.amountDue).toBe(2908 + 3000 + 500);
  });

  it("rejects the same invoice passed twice", () => {
    expect(() => getTenantBalance([oct, oct], [], [], "2026-12-15")).toThrow(/twice/);
  });

  it("rejects allocations for a bill that is not in the list", () => {
    expect(() =>
      getTenantBalance([oct], [pay(100, "2026-11-12", { invoice_id: "other" })], [], "2026-12-15"),
    ).toThrow(/other/);
  });
});
