import { describe, expect, it } from "vitest";
import {
  buildEstimateRow,
  canAutoPost,
  comparePolicyOnHistory,
  computeLateFeeProposal,
  explainLateFeeError,
  lateFeeMode,
  parsePolicyInput,
  pickTargetInvoice,
  policyForInvoice,
  rowMatchesEngine,
  shiftLateFeeLineColumns,
  summarizeCharge,
  validateWaiver,
  waiverPreview,
  type FlowInvoice,
  type LateFeeChargeRow,
  type LateFeePolicyRow,
} from "./late-fee-flow";

const policy = (over: Partial<LateFeePolicyRow> = {}): LateFeePolicyRow => ({
  version: 1,
  effective_from: "2026-01-01",
  grace_days: 0,
  rate_kind: "flat_per_day",
  rate_value: 50,
  partial_payments_reduce_base: true,
  cap: null,
  rounding: "floor",
  compounding: false,
  auto_post: false,
  created_at: "2026-10-01T03:00:00Z",
  ...over,
});

const inv = (over: Partial<FlowInvoice> = {}): FlowInvoice => ({
  id: "src",
  tenant_id: "t1",
  status: "overdue",
  start_date: "2026-09-01",
  due_date: "2026-09-05",
  total_amount: 3000,
  paid_amount: 0,
  rent_amount: 3000,
  late_fee_amount: 0,
  additional_fees_total: 0,
  additional_fees_breakdown: [],
  carry_forward_amount: 0,
  discount_amount: 0,
  ...over,
});

const charge = (over: Partial<LateFeeChargeRow> = {}): LateFeeChargeRow => ({
  id: "c1",
  source_invoice_id: "src",
  target_invoice_id: "tgt",
  covered_from: "2026-09-06",
  covered_to: "2026-09-08",
  formula: "3 days",
  policy_version: 1,
  amount: 150,
  posted_by: "admin-1",
  ...over,
});

describe("mode and policy selection", () => {
  it("no policy row means legacy behaviour; any policy means approval", () => {
    expect(lateFeeMode([])).toBe("legacy");
    expect(lateFeeMode(null)).toBe("legacy");
    expect(lateFeeMode([policy()])).toBe("approval");
  });

  it("picks the highest version effective on the invoice's due date, never a later one", () => {
    const ps = [policy(), policy({ version: 2, effective_from: "2026-11-01", rate_value: 80 })];
    expect(policyForInvoice(ps, "2026-09-05")?.version).toBe(1);
    expect(policyForInvoice(ps, "2026-11-05")?.version).toBe(2);
    expect(policyForInvoice([policy({ effective_from: "2026-10-01" })], "2026-09-05")).toBeNull();
  });

  it("automation only under auto_post and only for invoices due after the policy existed", () => {
    expect(canAutoPost(policy(), "2026-10-05")).toBe(false);
    const auto = policy({ auto_post: true, created_at: "2026-10-01T03:00:00Z" });
    expect(canAutoPost(auto, "2026-09-05")).toBe(false);
    expect(canAutoPost(auto, "2026-10-01")).toBe(true);
    expect(canAutoPost(null, "2026-10-05")).toBe(false);
  });
});

describe("computeLateFeeProposal", () => {
  const base = { dueDate: "2026-09-05", outstanding: 3000, originalDue: 3000, posted: [] };

  it("is an estimate with dates and a formula, nothing before the first fee day", () => {
    expect(computeLateFeeProposal({ ...base, policy: policy(), asOf: "2026-09-05" }).amount).toBe(0);
    const p = computeLateFeeProposal({ ...base, policy: policy(), asOf: "2026-09-08" });
    expect(p).toMatchObject({ amount: 150, coveredFrom: "2026-09-06", coveredTo: "2026-09-08", days: 3, isEstimate: true });
    expect(p.formula).toContain("v1");
  });

  it("only proposes days not already posted, so a second approval never re-charges", () => {
    const p = computeLateFeeProposal({ ...base, policy: policy(), asOf: "2026-09-10", posted: [charge()] });
    expect(p).toMatchObject({ amount: 100, coveredFrom: "2026-09-09", coveredTo: "2026-09-10", fullAmount: 250, postedAmount: 150 });
    const none = computeLateFeeProposal({ ...base, policy: policy(), asOf: "2026-09-08", posted: [charge()] });
    expect(none.amount).toBe(0);
  });

  it("respects the cap across postings", () => {
    const p = computeLateFeeProposal({ ...base, policy: policy({ cap: 200 }), asOf: "2026-10-31", posted: [charge()] });
    expect(p.amount).toBe(50);
  });

  it("charges a paid-late invoice on its balance during the late window, up to the paid date", () => {
    const p = computeLateFeeProposal({ ...base, outstanding: 0, balanceDuringLateWindow: 3000, policy: policy(), asOf: "2026-09-07" });
    expect(p.amount).toBe(100);
  });

  it("one-off kinds charge once", () => {
    const flat = computeLateFeeProposal({ ...base, policy: policy({ rate_kind: "flat_once", rate_value: 300 }), asOf: "2026-09-20" });
    expect(flat.amount).toBe(300);
    const pct = computeLateFeeProposal({ ...base, policy: policy({ rate_kind: "percent_once", rate_value: 5 }), asOf: "2026-09-20" });
    expect(pct.amount).toBe(150);
    const again = computeLateFeeProposal({
      ...base,
      policy: policy({ rate_kind: "flat_once", rate_value: 300 }),
      asOf: "2026-09-25",
      posted: [charge({ covered_to: "2026-09-20", amount: 300 })],
    });
    expect(again.amount).toBe(0);
  });

  it("does not apply a policy to invoices due before it became effective", () => {
    const p = computeLateFeeProposal({ ...base, policy: policy({ effective_from: "2026-10-01" }), asOf: "2026-10-10" });
    expect(p.amount).toBe(0);
  });
});

describe("columns for the SQL functions", () => {
  const target = inv({
    id: "tgt",
    status: "pending",
    start_date: "2026-10-01",
    total_amount: 3200,
    additional_fees_total: 200,
    additional_fees_breakdown: [{ label: "cleaning", total_amount: 200 }],
  });

  it("adding a fee moves total, late_fee_amount and additional_fees_total by exactly the fee", () => {
    expect(rowMatchesEngine(target)).toBe(true);
    const p = shiftLateFeeLineColumns(target, 150);
    expect(p).toEqual({
      expected_total_amount: 3200,
      columns: { total_amount: 3350, late_fee_amount: 150, additional_fees_total: 350, carry_forward_amount: 0, discount_amount: 0 },
    });
  });

  it("a waiver moves them down by exactly the waiver", () => {
    const posted = {
      ...target,
      total_amount: 3350,
      late_fee_amount: 150,
      additional_fees_total: 350,
      additional_fees_breakdown: [
        { label: "cleaning", total_amount: 200 },
        { item_type: "late_fee_line", total_amount: 150, late_fee_charge_id: "c1" },
      ],
    };
    expect(rowMatchesEngine(posted)).toBe(true);
    expect(shiftLateFeeLineColumns(posted, -100).columns).toMatchObject({ total_amount: 3250, late_fee_amount: 50, additional_fees_total: 250 });
    expect(waiverPreview({ ...posted, paid_amount: 3300 }, 100)).toMatchObject({ totalBefore: 3350, totalAfter: 3250, belowPaid: true });
  });

  it("flags an invoice whose stored total disagrees with the engine", () => {
    expect(rowMatchesEngine({ ...target, total_amount: 9999 })).toBe(false);
  });
});

describe("waivers and summaries", () => {
  it("requires a reason and never exceeds what is still charged (no sentinel amounts)", () => {
    expect(validateWaiver({ amount: 50, reason: "  ", remaining: 150 }).ok).toBe(false);
    expect(validateWaiver({ amount: 151, reason: "goodwill", remaining: 150 }).ok).toBe(false);
    expect(validateWaiver({ amount: 99999999, reason: "goodwill", remaining: 150 }).ok).toBe(false);
    expect(validateWaiver({ amount: 0, reason: "goodwill", remaining: 150 }).ok).toBe(false);
    expect(validateWaiver({ amount: 100, reason: "goodwill", remaining: 150 })).toEqual({ ok: true, amount: 100 });
  });

  it("net waived counts reversals; each waiver shows whether it was reversed", () => {
    const s = summarizeCharge(charge(), [
      { id: "w1", type: "waiver", amount: 100, reason: "r", actor: "o", source: "late_fee_charge:c1", reverses_adjustment_id: null },
      { id: "r1", type: "reversal", amount: -100, reason: "oops", actor: "o", source: "late_fee_charge:c1", reverses_adjustment_id: "w1" },
      { id: "w2", type: "waiver", amount: 30, reason: "r2", actor: "o", source: "late_fee_charge:c1", reverses_adjustment_id: null },
      { id: "x", type: "waiver", amount: 999, reason: "other", actor: "o", source: "late_fee_charge:other", reverses_adjustment_id: null },
    ]);
    expect(s.waived).toBe(30);
    expect(s.remaining).toBe(120);
    expect(s.waivers.map((w) => [w.id, w.reversed])).toEqual([
      ["w1", true],
      ["w2", false],
    ]);
  });
});

describe("estimate rows", () => {
  const target = inv({ id: "tgt", status: "pending", start_date: "2026-10-01", due_date: "2026-10-05" });

  it("shows estimate apart from posted/waived; total due excludes the estimate", () => {
    const row = buildEstimateRow({
      invoice: inv({ paid_amount: 1000, status: "partial" }),
      tenantInvoices: [target],
      policies: [policy()],
      charges: [charge()],
      adjustments: [{ id: "w", type: "waiver", amount: 50, reason: "r", actor: "o", source: "late_fee_charge:c1", reverses_adjustment_id: null }],
      today: "2026-09-10",
    })!;
    expect(row.principalOverdue).toBe(2000);
    expect(row.posted).toBe(150);
    expect(row.waived).toBe(50);
    expect(row.totalDue).toBe(2100);
    expect(row.estimate?.amount).toBe(100);
    expect(row.targetInvoiceId).toBe("tgt");
    expect(row.blockedReason).toBeNull();
  });

  it("is blocked without a policy, without a later open invoice, or when the legacy flow already billed it", () => {
    const noPolicy = buildEstimateRow({ invoice: inv(), tenantInvoices: [target], policies: [], charges: [], adjustments: [], today: "2026-09-10" })!;
    expect(noPolicy.estimate).toBeNull();
    expect(noPolicy.blockedReason).toContain("นโยบาย");
    const noTarget = buildEstimateRow({ invoice: inv(), tenantInvoices: [], policies: [policy()], charges: [], adjustments: [], today: "2026-09-10" })!;
    expect(noTarget.blockedReason).toContain("บิลถัดไป");
    const legacy = buildEstimateRow({
      invoice: inv({ late_fee_billed_at: "2026-09-25T00:00:00Z" }),
      tenantInvoices: [target],
      policies: [policy()],
      charges: [],
      adjustments: [],
      today: "2026-09-10",
    })!;
    expect(legacy.estimate).toBeNull();
    expect(legacy.blockedReason).toContain("ระบบเดิม");
  });

  it("a paid-late invoice is estimated up to its paid date", () => {
    const row = buildEstimateRow({
      invoice: inv({ status: "paid", paid_amount: 3000, payment_history: [{ paid_at: "2026-09-08T10:00:00+07:00", amount: 3000 }] }),
      tenantInvoices: [target],
      policies: [policy()],
      charges: [],
      adjustments: [],
      today: "2026-10-02",
    })!;
    expect(row.asOf).toBe("2026-09-08");
    expect(row.principalOverdue).toBe(0);
    expect(row.estimate?.amount).toBe(150);
  });

  it("targets the next open invoice after the source only", () => {
    const older = inv({ id: "older", status: "pending", start_date: "2026-08-01" });
    const paid = inv({ id: "paidnext", status: "paid", start_date: "2026-10-01" });
    const later = inv({ id: "later", status: "draft", start_date: "2026-11-01" });
    expect(pickTargetInvoice(inv(), [older, paid, later])?.id).toBe("later");
  });
});

describe("policy comparison and input", () => {
  it("compares a candidate to what is stored, read-only", () => {
    const res = comparePolicyOnHistory({
      candidate: policy({ rate_value: 20, effective_from: "2030-01-01" }),
      invoices: [
        inv({ id: "a", status: "paid", paid_amount: 3000, locked_late_fee_amount: 150, payment_history: [{ paid_at: "2026-09-08" }] }),
        inv({ id: "b", status: "overdue" }),
      ],
      charges: [charge({ source_invoice_id: "b", amount: 200 })],
      today: "2026-09-10",
    });
    const a = res.rows.find((r) => r.invoiceId === "a")!;
    expect(a).toMatchObject({ current: 150, currentSource: "legacy_locked", candidate: 60, difference: -90 });
    const b = res.rows.find((r) => r.invoiceId === "b")!;
    expect(b).toMatchObject({ current: 200, currentSource: "posted", candidate: 100 });
  });

  it("validates a new policy; auto_post defaults to false", () => {
    const ok = parsePolicyInput({ effective_from: "2026-11-01", rate_kind: "flat_per_day", rate_value: 50 });
    expect(ok.ok && ok.value.auto_post).toBe(false);
    expect(parsePolicyInput({ effective_from: "x", rate_kind: "flat_per_day", rate_value: 50 }).ok).toBe(false);
    expect(parsePolicyInput({ effective_from: "2026-11-01", rate_kind: "weird", rate_value: 50 }).ok).toBe(false);
    expect(parsePolicyInput({ effective_from: "2026-11-01", rate_kind: "percent_per_day", rate_value: 150 }).ok).toBe(false);
    expect(parsePolicyInput({ effective_from: "2026-11-01", rate_kind: "flat_per_day", rate_value: 50, cap: -1 }).ok).toBe(false);
  });

  it("explains SQL error codes in Thai, keeping the code", () => {
    expect(explainLateFeeError("STALE_INVOICE abc (expected 1)")).toContain("(STALE_INVOICE)");
    expect(explainLateFeeError("something else")).toBe("something else");
  });
});
