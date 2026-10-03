import { describe, expect, it } from "vitest";
import { isPaidWithCarriedIn, owedAfterCarriedIn, settledCarriedInAmount } from "./carry-in";
import { runReconciliation, type ReconciliationInput } from "./reconciliation-checks";
import { buildTenantStatement } from "./tenant-statement";
import { buildInvoiceLedgerView } from "./invoice-ledger-view";
import { allocatePaymentAcrossChain, resolveInvoiceStatusWithCarry, sumOwnOutstanding } from "../invoice-ledger";

// April owes 1,400. May's total 7,594 already includes those 1,400 (carried in),
// so May's own charge is 6,194.
const sources = (aprPaid: number, extra: Record<string, any> = {}) =>
  new Map<string, any>([
    ["apr", { id: "apr", total_amount: 1400, paid_amount: aprPaid, status: "pending" }],
    ...Object.entries(extra),
  ]);
const aprToMay = [{ source_invoice_id: "apr", amount: 1400 }];

describe("carried-in rule: two-invoice chain", () => {
  it("source fully settled -> May is paid with own 6,194 and owes nothing", () => {
    const carried = settledCarriedInAmount(aprToMay, sources(1400));
    expect(carried).toBe(1400);
    expect(isPaidWithCarriedIn(7594, 6194, carried)).toBe(true);
    expect(owedAfterCarriedIn(7594, 6194, carried)).toBe(0);
    expect(resolveInvoiceStatusWithCarry({ total_amount: 7594, paid_amount: 6194, due_date: "2026-06-05" }, "2026-07-01", carried)).toBe("paid");
  });

  it("source still open -> May stays partial and owes the carried 1,400", () => {
    const carried = settledCarriedInAmount(aprToMay, sources(0));
    expect(carried).toBe(0);
    expect(isPaidWithCarriedIn(7594, 6194, carried)).toBe(false);
    expect(owedAfterCarriedIn(7594, 6194, carried)).toBe(1400);
    expect(resolveInvoiceStatusWithCarry({ total_amount: 7594, paid_amount: 6194, due_date: "2099-01-01" }, "2026-07-01", carried)).toBe("partial");
  });

  it("source settled in the SAME payment batch counts (override), so a later status sync agrees", () => {
    // before the batch April has 0 paid; the batch pays April 1,400 and May 6,194
    const carried = settledCarriedInAmount(aprToMay, sources(0), new Map([["apr", 1400]]));
    expect(carried).toBe(1400);
    expect(isPaidWithCarriedIn(7594, 6194, carried)).toBe(true);
    // after the batch is committed, a sync reads April as 1,400 paid -> same answer
    expect(settledCarriedInAmount(aprToMay, sources(1400))).toBe(carried);
  });

  it("carried-in alone never makes an unpaid invoice paid; a partly paid source does not count", () => {
    expect(isPaidWithCarriedIn(7594, 0, 1400)).toBe(false);
    expect(settledCarriedInAmount(aprToMay, sources(1399.99))).toBe(0);
  });

  it("payment of 8,994 is capped at the real debt 7,594 and 7,594 settles both", () => {
    const chain = [
      { id: "apr", total_amount: 1400, paid_amount: 0, carry_forward_amount: 0 },
      { id: "may", total_amount: 7594, paid_amount: 0, carry_forward_amount: 1400 },
    ];
    const total = (amt: number) => allocatePaymentAcrossChain(chain as any, amt).reduce((s, r) => s + r.allocated, 0);
    expect(total(8994)).toBe(7594);
    const r = allocatePaymentAcrossChain(chain as any, 7594);
    expect(r.map((x) => [x.id, x.allocated])).toEqual([["apr", 1400], ["may", 6194]]);
  });
});

describe("carried-in rule: three-invoice chain", () => {
  // Mar 1,000 -> Apr total 2,500 (own 1,500, carries 1,000) -> May total 6,000 (own 3,500, carries 2,500)
  const links = new Map([
    ["apr", [{ source_invoice_id: "mar", amount: 1000 }]],
    ["may", [{ source_invoice_id: "apr", amount: 2500 }]],
  ]);
  const inv = (id: string, total: number, paid: number) => ({ id, total_amount: total, paid_amount: paid, status: "pending" });

  it("everything paid in one batch: Apr and May are both paid", () => {
    const paidAfter = new Map([["mar", 1000], ["apr", 1500], ["may", 3500]]);
    const all = new Map([["mar", inv("mar", 1000, 0)], ["apr", inv("apr", 2500, 0)], ["may", inv("may", 6000, 0)]]);
    // Apr's source (mar) is settled; Apr is NOT fully settled on its own row (1,500 of 2,500)...
    const aprCarried = settledCarriedInAmount(links.get("apr")!, all, paidAfter);
    expect(aprCarried).toBe(1000);
    expect(isPaidWithCarriedIn(2500, 1500, aprCarried)).toBe(true);
    // ...so May's source (apr) counts as settled only if apr's paid_amount reaches its total.
    const mayCarried = settledCarriedInAmount(links.get("may")!, all, new Map([...paidAfter, ["apr", 2500]]));
    expect(mayCarried).toBe(2500);
    expect(isPaidWithCarriedIn(6000, 3500, mayCarried)).toBe(true);
  });

  it("a middle invoice that is only paid by carried-in does NOT settle the next one (conservative)", () => {
    // Apr reads 1,500 paid of 2,500 (status paid via carried-in) but its paid_amount < total,
    // so May does not count its 2,500 as settled and stays open until Apr's row is fully paid.
    const all = new Map([["apr", inv("apr", 2500, 1500)]]);
    expect(settledCarriedInAmount(links.get("may")!, all)).toBe(0);
    expect(isPaidWithCarriedIn(6000, 3500, 0)).toBe(false);
  });
});

describe("reconciliation agrees with the carried-in rule", () => {
  const input = (mayStatus: string, aprPaid: number): ReconciliationInput => ({
    invoices: [
      { id: "apr", tenant_id: "t1", room_id: "r1", status: aprPaid >= 1400 ? "paid" : "pending", total_amount: 1400, paid_amount: aprPaid },
      { id: "may", tenant_id: "t1", room_id: "r1", status: mayStatus, total_amount: 7594, paid_amount: 6194 },
    ],
    batches: [],
    allocations: [],
    carryForwards: [{ source_invoice_id: "apr", target_invoice_id: "may", amount: 1400 }],
    moneyEvents: [],
  } as any);
  const statusFindings = (i: ReconciliationInput) =>
    runReconciliation(i).filter((f) => f.check === "status_vs_balance" && f.invoiceId === "may");

  it("May paid with April settled -> no status finding", () => {
    expect(statusFindings(input("paid", 1400))).toEqual([]);
  });
  it("May paid but April NOT settled -> flagged high", () => {
    const f = statusFindings(input("paid", 0));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
  });
  it("May left partial although April is settled -> flagged medium (status never caught up)", () => {
    const f = statusFindings(input("partial", 1400));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
  });
});

describe("tenant and admin displays agree with the status", () => {
  const may = {
    id: "may", status: "paid", start_date: "2026-05-25", due_date: "2026-06-05",
    rent_amount: 6194, water_bill: 0, electricity_bill: 0, common_fee: 0,
    total_amount: 7594, paid_amount: 6194, late_fee_amount: 0, additional_fees_total: 0,
    carry_forward_amount: 1400, discount_amount: 0,
  };
  const alloc = [{ id: "a1", invoice_id: "may", payment_batch_id: "b1", amount: 6194, paid_at: "2026-06-03T10:00:00Z", invoice_period: "2026-05-25" }];

  it("tenant statement: balance 0 when the carried-in source is settled, 1,400 when it is not", () => {
    const settled = buildTenantStatement(may, alloc, [], { asOf: "2026-06-10", carriedInSettled: 1400 });
    expect(settled.balance).toBe(0);
    expect(settled.carriedInSettled).toBe(1400);
    const open = buildTenantStatement({ ...may, status: "partial" }, alloc, [], { asOf: "2026-06-04", carriedInSettled: 0 });
    expect(open.balance).toBe(1400);
  });

  it("admin ledger view: balances are 0 and consistent (no false discrepancy) with carried-in settled", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "may", total_amount: 7594, paid_amount: 6194 },
      batches: [{ id: "b1", amount_received: 6194, paid_at: "2026-06-03", source: "admin_webapp", payment_method_snapshot: { bank_name: "KBank" } }] as any,
      allocations: [{ id: "a1", payment_batch_id: "b1", invoice_id: "may", amount: 6194, created_at: "1", period: "05/2026" }] as any,
      carriedInSettled: 1400,
    });
    expect(v.invoiceBalance).toBe(0);
    expect(v.ledgerBalance).toBe(0);
    expect(v.state).toBe("consistent");
  });

  it("admin ledger view still reports a REAL discrepancy when paid_amount and allocations differ", () => {
    const v = buildInvoiceLedgerView({
      invoice: { id: "may", total_amount: 7594, paid_amount: 6194 },
      batches: [{ id: "b1", amount_received: 5000, paid_at: "2026-06-03", source: "admin_webapp", payment_method_snapshot: { bank_name: "KBank" } }] as any,
      allocations: [{ id: "a1", payment_batch_id: "b1", invoice_id: "may", amount: 5000, created_at: "1", period: "05/2026" }] as any,
      carriedInSettled: 1400,
    });
    expect(v.state).toBe("discrepancy");
    expect(v.discrepancy).toBe(-1194);
  });
});

describe("dashboard / overdue totals count carried debt once", () => {
  const apr = (paid: number) => ({ total_amount: 1400, paid_amount: paid, carry_forward_amount: 0 });
  const may = (paid: number) => ({ total_amount: 7594, paid_amount: paid, carry_forward_amount: 1400 });

  it("nothing paid: 1,400 + 6,194 = 7,594 owed (not 8,994)", () => {
    expect(sumOwnOutstanding([apr(0), may(0)])).toBe(7594);
  });
  it("after the own-share payment (April 1,400, May 6,194) nothing is owed", () => {
    expect(sumOwnOutstanding([apr(1400), may(6194)])).toBe(0);
  });
  it("May's own share paid but April still open: only April's 1,400 is owed", () => {
    expect(sumOwnOutstanding([apr(0), may(6194)])).toBe(1400);
  });
  it("legacy row shape (May reads 7,594/7,594) does not create a negative or extra debt", () => {
    expect(sumOwnOutstanding([apr(1400), may(7594)])).toBe(0);
  });
});
