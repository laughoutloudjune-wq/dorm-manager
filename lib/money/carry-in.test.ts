import { describe, expect, it } from "vitest";
import { isLegacyInflatedPaid, isPaidWithCarriedIn, owedAfterCarriedIn, settledCarriedInAmount } from "./carry-in";
import { runReconciliation, type ReconciliationInput } from "./reconciliation-checks";
import { buildTenantStatement } from "./tenant-statement";
import { buildInvoiceLedgerView } from "./invoice-ledger-view";
import { allocatePaymentAcrossChain, getChainOwnOutstanding, getInvoiceOwnOutstanding, resolveInvoiceStatusWithCarry, sumOwnOutstanding } from "../invoice-ledger";

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

describe("three-invoice chain propagates (recursive settled rule)", () => {
  // A 1,000 -> B total 2,500 (carries A's 1,000) -> C total 6,000 (carries B's 2,500)
  const row = (id: string, total: number, paid: number) => ({ id, total_amount: total, paid_amount: paid, status: "pending" });
  const all = (a: number, b: number, c: number) =>
    new Map<string, any>([["A", row("A", 1000, a)], ["B", row("B", 2500, b)], ["C", row("C", 6000, c)]]);
  const linksByTarget = new Map([
    ["B", [{ source_invoice_id: "A", amount: 1000 }]],
    ["C", [{ source_invoice_id: "B", amount: 2500 }]],
  ]);
  const carriedFor = (target: "B" | "C", a: number, b: number, c: number, overrides = new Map<string, number>()) =>
    settledCarriedInAmount(linksByTarget.get(target)!, all(a, b, c), overrides, linksByTarget);

  it("A paid -> B is paid by its own 1,500 + 1,000 carried; and C sees B as settled", () => {
    expect(carriedFor("B", 1000, 1500, 3500)).toBe(1000);
    expect(isPaidWithCarriedIn(2500, 1500, 1000, 1000)).toBe(true);
    expect(carriedFor("C", 1000, 1500, 3500)).toBe(2500); // recursive: B settled via A
    expect(isPaidWithCarriedIn(6000, 3500, 2500, 2500)).toBe(true);
  });
  it("A NOT paid -> neither B nor C counts as settled (voiding A reopens both)", () => {
    expect(carriedFor("B", 0, 1500, 3500)).toBe(0);
    expect(carriedFor("C", 0, 1500, 3500)).toBe(0);
    expect(isPaidWithCarriedIn(6000, 3500, 0, 2500)).toBe(false);
  });
  it("same batch: overrides make A settled for B and C before A is written", () => {
    expect(carriedFor("C", 0, 1500, 3500, new Map([["A", 1000]]))).toBe(2500);
  });
  it("without the link map the rule stays conservative (one level only)", () => {
    expect(settledCarriedInAmount(linksByTarget.get("C")!, all(1000, 1500, 3500))).toBe(0);
  });
  it("a cycle cannot loop forever", () => {
    const cyc = new Map([["A", [{ source_invoice_id: "B", amount: 1 }]], ["B", [{ source_invoice_id: "A", amount: 1 }]]]);
    const rows = new Map<string, any>([["A", row("A", 10, 5)], ["B", row("B", 10, 5)]]);
    expect(settledCarriedInAmount(cyc.get("A")!, rows, new Map(), cyc)).toBe(0);
  });
});

describe("legacy-inflated rows are not double counted (finding 177 guard)", () => {
  it("own outstanding: new shape 0, partial 3,194, legacy 7,594/7,594 = 0, 114/1 = 244", () => {
    expect(getChainOwnOutstanding({ id: "x", total_amount: 7594, paid_amount: 6194, carry_forward_amount: 1400 })).toBe(0);
    expect(getChainOwnOutstanding({ id: "x", total_amount: 7594, paid_amount: 3000, carry_forward_amount: 1400 })).toBe(3194);
    expect(getChainOwnOutstanding({ id: "x", total_amount: 7594, paid_amount: 7594, carry_forward_amount: 1400 })).toBe(0);
    expect(getChainOwnOutstanding({ id: "x", total_amount: 6244, paid_amount: 6000, carry_forward_amount: 1446 })).toBe(244);
    expect(getInvoiceOwnOutstanding({ total_amount: 1500, paid_amount: 0, carry_forward_amount: 0 })).toBe(1500);
  });
  it("legacy row never becomes paid through carried-in credit", () => {
    expect(isLegacyInflatedPaid(6244, 6000, 1446)).toBe(true);
    expect(isLegacyInflatedPaid(7594, 6194, 1400)).toBe(false);
    expect(isPaidWithCarriedIn(6244, 6000, 1446, 1446)).toBe(false); // still owes 244
    expect(owedAfterCarriedIn(6244, 6000, 1446, 1446)).toBe(244);
    expect(resolveInvoiceStatusWithCarry({ total_amount: 6244, paid_amount: 6000, carry_forward_amount: 1446, due_date: "2099-01-01" }, "2026-07-01", 1446)).toBe("partial");
  });
});

describe("tenant statement never contradicts itself", () => {
  const may = {
    id: "may", status: "paid", start_date: "2026-05-25", due_date: "2026-06-05",
    rent_amount: 6194, water_bill: 0, electricity_bill: 0, common_fee: 0,
    total_amount: 7594, paid_amount: 6194, late_fee_amount: 0, additional_fees_total: 0,
    carry_forward_amount: 1400, discount_amount: 0,
  };
  const alloc = [{ id: "a1", invoice_id: "may", payment_batch_id: "b1", amount: 6194, paid_at: "2026-06-03T10:00:00Z", invoice_period: "2026-05-25" }];
  it("row still labelled paid but its carried-in source was voided: shows the 1,400 owed, not 'fully paid'", () => {
    const s = buildTenantStatement(may, alloc, [], { asOf: "2026-06-10", carriedInSettled: 0 });
    expect(s.balance).toBe(1400);
    expect(s.explanationTh).not.toBe("ชำระครบแล้ว");
  });
  it("source settled: balance 0 and it reads fully paid", () => {
    const s = buildTenantStatement(may, alloc, [], { asOf: "2026-06-10", carriedInSettled: 1400 });
    expect(s.balance).toBe(0);
    expect(s.explanationTh).toBe("ชำระครบแล้ว");
  });
});

describe("legacy-shaped MIDDLE invoice does not make a later invoice look settled (item 1)", () => {
  // A 1,446 (paid in full) -> M total 6,244 carrying 1,446, paid 6,000 (still owes 244) -> C total 9,000 carrying 6,244
  const rows = new Map<string, any>([
    ["A", { id: "A", total_amount: 1446, paid_amount: 1446, status: "paid", carry_forward_amount: 0 }],
    ["M", { id: "M", total_amount: 6244, paid_amount: 6000, status: "partial", carry_forward_amount: 1446 }],
    ["C", { id: "C", total_amount: 9000, paid_amount: 2756, status: "partial", carry_forward_amount: 6244 }],
  ]);
  const links = new Map([
    ["M", [{ source_invoice_id: "A", amount: 1446 }]],
    ["C", [{ source_invoice_id: "M", amount: 6244 }]],
  ]);
  it("M's own source is settled, but M itself is NOT settled for C (it still owes 244)", () => {
    expect(settledCarriedInAmount(links.get("M")!, rows, new Map(), links)).toBe(1446);
    expect(settledCarriedInAmount(links.get("C")!, rows, new Map(), links)).toBe(0);
    expect(owedAfterCarriedIn(9000, 2756, 0, 6244)).toBe(6244);
    expect(isPaidWithCarriedIn(9000, 2756, 0, 6244)).toBe(false);
  });
  it("a non-legacy middle invoice (paid <= own charge) with the same upstream IS settled", () => {
    const ok = new Map(rows);
    ok.set("M", { id: "M", total_amount: 6244, paid_amount: 4798, status: "partial", carry_forward_amount: 1446 });
    expect(settledCarriedInAmount(links.get("C")!, ok, new Map(), links)).toBe(6244);
  });
  it("M still owes 244 under the shared own-outstanding rule", () => {
    expect(getChainOwnOutstanding({ id: "M", total_amount: 6244, paid_amount: 6000, carry_forward_amount: 1446 })).toBe(244);
  });
});
