/**
 * Late-fee approval flow — pure helpers, no database.
 *
 * An ESTIMATE is never a charge. A fee only becomes money owed when an admin
 * approves it (or a policy that explicitly opted in with `auto_post` lets the
 * automation post it), at which point `post_late_fee_charge` writes it as a
 * distinct `late_fee_line` on a LATER invoice, linked to its source invoice
 * and to a `late_fee_charges` row. Waivers are `adjustments` rows and are
 * reversed by a paired reversal, never deleted.
 *
 * The SQL functions re-validate everything here; these helpers exist so the
 * route, the admin page and the automation compute the same numbers.
 */
import {
  chargesFromInvoiceRow,
  computeInvoiceTotal,
  toInvoiceMoneyColumns,
  type InvoiceMoneyColumns,
  type InvoiceMoneyRow,
} from "@/lib/invoice-total";
import { estimateLateFee, type LateFeePolicy } from "@/lib/money/late-fee";

export type LateFeeRateKind = "flat_per_day" | "percent_per_day" | "flat_once" | "percent_once";
export const LATE_FEE_RATE_KINDS: readonly LateFeeRateKind[] = [
  "flat_per_day",
  "percent_per_day",
  "flat_once",
  "percent_once",
];

/** A row of `late_fee_policies`. */
export type LateFeePolicyRow = {
  id?: string;
  version: number;
  effective_from: string;
  grace_days: number;
  rate_kind: LateFeeRateKind;
  rate_value: number;
  partial_payments_reduce_base: boolean;
  cap: number | null;
  rounding: "floor" | "round" | "ceil";
  compounding: boolean;
  auto_post: boolean;
  created_at?: string | null;
  created_by?: string | null;
  note?: string | null;
};

/** A row of `late_fee_charges`. */
export type LateFeeChargeRow = {
  id: string;
  source_invoice_id: string;
  target_invoice_id: string | null;
  covered_from: string;
  covered_to: string;
  eligible_balance?: number | null;
  rate_kind?: string | null;
  rate_value?: number | null;
  formula: string;
  policy_version: number;
  amount: number;
  posted_by: string;
  posted_at?: string | null;
};

/** A row of `adjustments` tied to a late-fee charge (source = 'late_fee_charge:<id>'). */
export type LateFeeAdjustmentRow = {
  id: string;
  type: string;
  amount: number;
  reason: string;
  actor: string | null;
  source: string | null;
  reverses_adjustment_id: string | null;
  created_at?: string | null;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "");
const parseDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};
export const addDays = (value: string, days: number) =>
  new Date(parseDate(value) + days * 86400000).toISOString().slice(0, 10);
const daysInclusive = (from: string, to: string) =>
  Math.floor((parseDate(to) - parseDate(from)) / 86400000) + 1;

export const CHARGE_SOURCE_PREFIX = "late_fee_charge:";
export const chargeAdjustmentSource = (chargeId: string) => `${CHARGE_SOURCE_PREFIX}${chargeId}`;
export const AUTOMATION_PREFIX = "automation:";
export const isAutomationActor = (actor: string) => actor.startsWith(AUTOMATION_PREFIX);

/** Calendar date in Asia/Bangkok. */
export const bangkokDate = (iso: string | Date) => {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return new Date(t + 7 * 3600000).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Policy selection
// ---------------------------------------------------------------------------

/**
 * Whether the new approval flow is in force at all. With NO policy row the
 * system keeps its legacy behaviour exactly (production is unchanged until the
 * owner creates a policy). Once any policy exists, nothing is posted without
 * an admin unless the applicable policy has `auto_post`.
 */
export type LateFeeMode = "legacy" | "approval";
export const lateFeeMode = (policies: LateFeePolicyRow[] | null | undefined): LateFeeMode =>
  policies && policies.length > 0 ? "approval" : "legacy";

/**
 * The policy that governs an invoice: the highest version whose
 * `effective_from` is on or before the invoice's due date. A policy created
 * later with a later effective date never reaches back to older invoices.
 */
export function policyForInvoice(
  policies: LateFeePolicyRow[],
  dueDate: string | null | undefined,
): LateFeePolicyRow | null {
  if (!dueDate) return null;
  const due = day(dueDate);
  let best: LateFeePolicyRow | null = null;
  for (const p of policies) {
    if (day(p.effective_from) <= due && (!best || p.version > best.version)) best = p;
  }
  return best;
}

/**
 * Automation may post only under a policy that opted in, and only for invoices
 * that fell due on/after the day that policy was created — so activating a
 * policy never silently re-bills history. Mirrors the SQL guard.
 */
export function canAutoPost(policy: LateFeePolicyRow | null, sourceDueDate: string | null | undefined): boolean {
  if (!policy || !policy.auto_post || !sourceDueDate) return false;
  const created = policy.created_at ? bangkokDate(policy.created_at) : null;
  if (!created) return false;
  return day(sourceDueDate) >= created;
}

/** The per-day policies map directly onto the estimate engine. */
export function toEstimatePolicy(row: LateFeePolicyRow): LateFeePolicy {
  return {
    version: String(row.version),
    effectiveFrom: day(row.effective_from),
    graceDays: Math.max(0, Math.floor(num(row.grace_days))),
    rate:
      row.rate_kind === "percent_per_day" || row.rate_kind === "percent_once"
        ? { kind: "percent", percent: num(row.rate_value) }
        : { kind: "flat", baht: num(row.rate_value) },
    partialPaymentsReduceBase: !!row.partial_payments_reduce_base,
    cap: row.cap === null || row.cap === undefined ? null : num(row.cap),
    rounding: row.rounding ?? "floor",
    compounding: !!row.compounding,
  };
}

export const describeRate = (row: Pick<LateFeePolicyRow, "rate_kind" | "rate_value">) => {
  const v = num(row.rate_value);
  switch (row.rate_kind) {
    case "flat_per_day":
      return `${v} บาท/วัน`;
    case "percent_per_day":
      return `${v}%/วัน`;
    case "flat_once":
      return `${v} บาท (ครั้งเดียว)`;
    case "percent_once":
      return `${v}% (ครั้งเดียว)`;
  }
};

// ---------------------------------------------------------------------------
// Proposal: what WOULD be posted if approved now
// ---------------------------------------------------------------------------

export type ProposalInput = {
  policy: LateFeePolicyRow;
  dueDate: string;
  /** Date the fee is calculated up to (today, or the date the invoice was fully paid). */
  asOf: string;
  /** Unpaid own balance at `asOf` (0 for an invoice already paid). */
  outstanding: number;
  /** The invoice's own original amount due. */
  originalDue: number;
  /**
   * Balance to charge on when nothing is outstanding any more (a paid-late
   * invoice): the per-day estimate otherwise returns 0. Defaults to originalDue.
   */
  balanceDuringLateWindow?: number;
  /** Charges already posted for this source invoice. */
  posted: Pick<LateFeeChargeRow, "covered_from" | "covered_to" | "amount" | "policy_version">[];
};

export type LateFeeProposal = {
  policyVersion: number;
  rateKind: LateFeeRateKind;
  rateValue: number;
  /** Fee for the whole late window under this policy (before subtracting what is posted). */
  fullAmount: number;
  postedAmount: number;
  /** What approving now would post. 0 = nothing to post. */
  amount: number;
  coveredFrom: string | null;
  coveredTo: string | null;
  days: number;
  eligibleBalance: number;
  formula: string;
  isEstimate: true;
};

export function computeLateFeeProposal(input: ProposalInput): LateFeeProposal {
  const { policy } = input;
  const rateValue = num(policy.rate_value);
  const postedAmount = round2(input.posted.reduce((s, c) => s + num(c.amount), 0));
  const postedSamePolicy = round2(
    input.posted.filter((c) => c.policy_version === policy.version).reduce((s, c) => s + num(c.amount), 0),
  );
  const lastPostedTo = input.posted.reduce<string | null>(
    (max, c) => (!max || day(c.covered_to) > max ? day(c.covered_to) : max),
    null,
  );
  const firstFeeDay = addDays(day(input.dueDate), Math.max(0, num(policy.grace_days)) + 1);
  const base = (over: Partial<LateFeeProposal>): LateFeeProposal => ({
    policyVersion: policy.version,
    rateKind: policy.rate_kind,
    rateValue,
    fullAmount: 0,
    postedAmount,
    amount: 0,
    coveredFrom: null,
    coveredTo: null,
    days: 0,
    eligibleBalance: 0,
    formula: "ยังไม่มีค่าปรับ",
    isEstimate: true,
    ...over,
  });

  const asOf = day(input.asOf);
  const outstanding = Math.max(0, num(input.outstanding));
  const lateBalance =
    outstanding > 0 ? outstanding : Math.max(0, num(input.balanceDuringLateWindow ?? input.originalDue));
  if (day(input.dueDate) < day(policy.effective_from) || lateBalance <= 0 || asOf < firstFeeDay) {
    return base({});
  }

  let full = 0;
  let eligible = policy.partial_payments_reduce_base ? lateBalance : Math.max(0, num(input.originalDue));
  if (policy.rate_kind === "flat_once" || policy.rate_kind === "percent_once") {
    const raw = policy.rate_kind === "flat_once" ? rateValue : (eligible * rateValue) / 100;
    const capped = policy.cap === null ? raw : Math.min(raw, num(policy.cap));
    full = policy.rounding === "ceil" ? Math.ceil(capped) : policy.rounding === "round" ? Math.round(capped) : Math.floor(capped);
  } else {
    const est = estimateLateFee(toEstimatePolicy(policy), {
      dueDate: day(input.dueDate),
      asOf,
      outstanding: lateBalance,
      originalDue: num(input.originalDue),
    });
    full = est.cappedAmount;
    eligible = est.eligibleBalance;
  }
  full = round2(full);

  const coveredFrom = lastPostedTo && lastPostedTo >= firstFeeDay ? addDays(lastPostedTo, 1) : firstFeeDay;
  if (coveredFrom > asOf) {
    return base({ fullAmount: full, eligibleBalance: eligible, formula: "ค่าปรับถึงวันนี้ถูกเรียกเก็บแล้ว" });
  }
  const days = daysInclusive(coveredFrom, asOf);
  let amount = Math.max(0, round2(full - postedAmount));
  // Never above what the uncovered days can carry at this rate (the SQL checks the same).
  if (policy.rate_kind === "flat_per_day") amount = Math.min(amount, round2(days * rateValue));
  if (policy.cap !== null && policy.cap !== undefined) amount = Math.min(amount, Math.max(0, round2(num(policy.cap) - postedSamePolicy)));
  if (amount <= 0) {
    return base({ fullAmount: full, eligibleBalance: eligible, formula: "ค่าปรับถึงวันนี้ถูกเรียกเก็บแล้ว" });
  }

  const rateText = describeRate(policy);
  const capText = policy.cap !== null && policy.cap !== undefined ? `, เพดาน ${num(policy.cap)} บาท` : "";
  const postedText = postedAmount > 0 ? `, หักที่เรียกเก็บแล้ว ${postedAmount}` : "";
  const isPerDay = policy.rate_kind === "flat_per_day" || policy.rate_kind === "percent_per_day";
  const formula =
    (isPerDay
      ? `${days} วัน (${coveredFrom} ถึง ${asOf}) × ${rateText}${policy.rate_kind === "percent_per_day" ? ` ของ ${eligible}` : ""}`
      : `${rateText}${policy.rate_kind === "percent_once" ? ` ของ ${eligible}` : ""} (เลยกำหนดตั้งแต่ ${firstFeeDay})`) +
    capText +
    postedText +
    ` = ${amount} บาท (นโยบาย v${policy.version})`;

  return base({
    fullAmount: full,
    amount,
    coveredFrom,
    coveredTo: asOf,
    days,
    eligibleBalance: round2(eligible),
    formula,
  });
}

// ---------------------------------------------------------------------------
// Money columns the SQL functions expect (current row moved by exactly `delta`)
// ---------------------------------------------------------------------------

export type ColumnsPayload = { expected_total_amount: number; columns: InvoiceMoneyColumns };

/** True when the stored total equals the totals engine; posting onto anything else is refused. */
export function rowMatchesEngine(row: InvoiceMoneyRow & { total_amount?: number | null }): boolean {
  return round2(computeInvoiceTotal(chargesFromInvoiceRow(row))) === round2(num(row.total_amount));
}

/**
 * Columns after adding (delta > 0) or removing (delta < 0) late-fee LINE money,
 * computed by the one totals engine. `breakdownLateLineDelta` lets the caller
 * describe the breakdown change the SQL will make, so the engine sees the same
 * lines the database will store.
 */
export function shiftLateFeeLineColumns(
  row: InvoiceMoneyRow & { total_amount?: number | null },
  delta: number,
): ColumnsPayload {
  const charges = chargesFromInvoiceRow(row);
  const next = { ...charges, lateFeeItems: round2(charges.lateFeeItems + delta) };
  const cols = toInvoiceMoneyColumns(next);
  return {
    expected_total_amount: round2(num(row.total_amount)),
    columns: {
      total_amount: round2(cols.total_amount),
      late_fee_amount: round2(cols.late_fee_amount),
      additional_fees_total: round2(cols.additional_fees_total),
      carry_forward_amount: round2(cols.carry_forward_amount),
      discount_amount: round2(cols.discount_amount),
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger summaries
// ---------------------------------------------------------------------------

export type ChargeSummary = {
  charge: LateFeeChargeRow;
  waived: number;
  remaining: number;
  waivers: Array<LateFeeAdjustmentRow & { reversed: boolean; reversal: LateFeeAdjustmentRow | null }>;
  automated: boolean;
};

export function summarizeCharge(charge: LateFeeChargeRow, adjustments: LateFeeAdjustmentRow[]): ChargeSummary {
  const mine = adjustments.filter((a) => a.source === chargeAdjustmentSource(charge.id));
  const reversalByTarget = new Map(
    mine.filter((a) => a.type === "reversal" && a.reverses_adjustment_id).map((a) => [String(a.reverses_adjustment_id), a]),
  );
  const waived = round2(mine.reduce((s, a) => s + num(a.amount), 0));
  return {
    charge,
    waived,
    remaining: round2(num(charge.amount) - waived),
    waivers: mine
      .filter((a) => a.type === "waiver")
      .map((a) => ({ ...a, reversed: reversalByTarget.has(a.id), reversal: reversalByTarget.get(a.id) ?? null })),
    automated: isAutomationActor(charge.posted_by),
  };
}

export type WaiverCheck = { ok: true; amount: number } | { ok: false; error: string };

/** Front-line validation for a waiver; the SQL repeats every rule. */
export function validateWaiver(input: { amount: unknown; reason: unknown; remaining: number }): WaiverCheck {
  const amount = round2(num(input.amount));
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) return { ok: false, error: "ต้องระบุเหตุผลในการยกเว้นค่าปรับ" };
  if (!(amount > 0)) return { ok: false, error: "จำนวนที่ยกเว้นต้องมากกว่า 0" };
  if (amount > round2(input.remaining)) {
    return { ok: false, error: `ยกเว้นได้ไม่เกิน ${round2(input.remaining)} บาท (ยอดค่าปรับคงเหลือ)` };
  }
  return { ok: true, amount };
}

/** Before/after preview for the waive dialog. */
export function waiverPreview(row: InvoiceMoneyRow & { total_amount?: number | null; paid_amount?: number | null }, amount: number) {
  const before = round2(num(row.total_amount));
  const after = shiftLateFeeLineColumns(row, -Math.max(0, amount)).columns.total_amount;
  const paid = round2(num(row.paid_amount));
  return {
    totalBefore: before,
    totalAfter: after,
    balanceBefore: round2(Math.max(0, before - paid)),
    balanceAfter: round2(Math.max(0, after - paid)),
    belowPaid: after < paid,
  };
}

// ---------------------------------------------------------------------------
// Target selection, estimate rows, policy comparison
// ---------------------------------------------------------------------------

export const OPEN_TARGET_STATUSES = ["draft", "pending", "partial", "overdue"] as const;

export type FlowInvoice = InvoiceMoneyRow & {
  id: string;
  tenant_id: string | null;
  status: string | null;
  start_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  payment_history?: unknown;
  slip_uploaded_at?: string | null;
  locked_late_fee_amount?: number | null;
  late_fee_billed_at?: string | null;
};

/** The tenant's next invoice after `source` that is still open for editing (late fees bill one step forward). */
export function pickTargetInvoice<T extends FlowInvoice>(source: FlowInvoice, tenantInvoices: T[]): T | null {
  const candidates = tenantInvoices
    .filter(
      (i) =>
        i.id !== source.id &&
        i.tenant_id === source.tenant_id &&
        (OPEN_TARGET_STATUSES as readonly string[]).includes(String(i.status ?? "")) &&
        day(i.start_date) > day(source.start_date),
    )
    .sort((a, b) => day(a.start_date).localeCompare(day(b.start_date)));
  return candidates[0] ?? null;
}

/** Own unpaid balance, excluding debt carried in from an earlier invoice. */
export const principalOverdue = (inv: Pick<FlowInvoice, "total_amount" | "paid_amount" | "carry_forward_amount">) => {
  const outstanding = Math.max(0, num(inv.total_amount) - num(inv.paid_amount));
  const own = Math.max(0, num(inv.total_amount) - num(inv.carry_forward_amount));
  return round2(Math.min(own, outstanding));
};

/** Date an invoice finished being paid: latest payment_history entry, else slip upload, else fallback. */
export function fullyPaidDate(inv: Pick<FlowInvoice, "payment_history" | "slip_uploaded_at">, fallback: string): string {
  const history = Array.isArray(inv.payment_history) ? (inv.payment_history as any[]) : [];
  let best: string | null = null;
  for (const h of history) {
    if (String(h?.type ?? "") === "void") continue;
    const at = h?.paid_at ?? h?.created_at;
    if (at && (!best || String(at) > best)) best = String(at);
  }
  const chosen = best ?? (inv.slip_uploaded_at ? String(inv.slip_uploaded_at) : fallback);
  return chosen.length > 10 ? bangkokDate(chosen) : chosen.slice(0, 10);
}

export type EstimateRow = {
  invoiceId: string;
  tenantId: string | null;
  status: string;
  dueDate: string;
  periodStart: string | null;
  principalOverdue: number;
  asOf: string;
  policyVersion: number | null;
  /** NOT charged. Shown apart from what is posted. */
  estimate: LateFeeProposal | null;
  posted: number;
  waived: number;
  /** principal overdue + posted - waived (estimate excluded). */
  totalDue: number;
  charges: ChargeSummary[];
  targetInvoiceId: string | null;
  /** The legacy frozen figure on the invoice, for reference only. */
  legacyLocked: number | null;
  /** Why the estimate cannot be approved right now, if it can't. */
  blockedReason: string | null;
};

export function buildEstimateRow(args: {
  invoice: FlowInvoice;
  tenantInvoices: FlowInvoice[];
  policies: LateFeePolicyRow[];
  charges: LateFeeChargeRow[];
  adjustments: LateFeeAdjustmentRow[];
  today: string;
}): EstimateRow | null {
  const { invoice } = args;
  if (!invoice.due_date) return null;
  const status = String(invoice.status ?? "");
  if (status === "draft" || status === "cancelled") return null;
  const isPaid = status === "paid";
  const asOf = isPaid ? fullyPaidDate(invoice, args.today) : args.today;
  if (day(invoice.due_date) >= asOf) return null;

  const principal = isPaid ? 0 : principalOverdue(invoice);
  const myCharges = args.charges.filter((c) => c.source_invoice_id === invoice.id);
  const summaries = myCharges.map((c) => summarizeCharge(c, args.adjustments));
  const posted = round2(summaries.reduce((s, c) => s + num(c.charge.amount), 0));
  const waived = round2(summaries.reduce((s, c) => s + c.waived, 0));
  const policy = policyForInvoice(args.policies, invoice.due_date);
  const ownOriginal = Math.max(0, num(invoice.total_amount) - num(invoice.carry_forward_amount));
  // A fee the legacy flow already billed (late_fee_billed_at) is never estimated again.
  const estimate = policy && !invoice.late_fee_billed_at
    ? computeLateFeeProposal({
        policy,
        dueDate: invoice.due_date,
        asOf,
        outstanding: principal,
        originalDue: ownOriginal,
        balanceDuringLateWindow: ownOriginal,
        posted: myCharges,
      })
    : null;
  const target = pickTargetInvoice(invoice, args.tenantInvoices);

  // Nothing to show: not late in any way that matters.
  if (principal <= 0 && posted <= 0 && (!estimate || estimate.amount <= 0)) return null;

  let blockedReason: string | null = null;
  if (invoice.late_fee_billed_at) blockedReason = "ค่าปรับของบิลนี้ถูกลงบิลถัดไปแล้วด้วยระบบเดิม";
  else if (!policy) blockedReason = "ยังไม่มีนโยบายค่าปรับที่ครอบคลุมบิลนี้ (ตั้งนโยบายก่อน)";
  else if (!estimate || estimate.amount <= 0) blockedReason = "ไม่มีค่าปรับใหม่ให้เรียกเก็บ";
  else if (!target) blockedReason = "ยังไม่มีบิลถัดไปที่เปิดแก้ไขได้ สำหรับลงค่าปรับ";
  else if (!rowMatchesEngine(target)) blockedReason = "ยอดรวมของบิลถัดไปไม่ตรงกับสูตรคำนวณ ต้องตรวจบิลก่อน";

  return {
    invoiceId: invoice.id,
    tenantId: invoice.tenant_id,
    status,
    dueDate: day(invoice.due_date),
    periodStart: invoice.start_date ? day(invoice.start_date) : null,
    principalOverdue: principal,
    asOf,
    policyVersion: policy?.version ?? null,
    estimate,
    posted,
    waived,
    totalDue: round2(principal + posted - waived),
    charges: summaries,
    targetInvoiceId: target?.id ?? null,
    legacyLocked:
      invoice.locked_late_fee_amount === null || invoice.locked_late_fee_amount === undefined
        ? null
        : num(invoice.locked_late_fee_amount),
    blockedReason,
  };
}

export type PolicyComparisonRow = {
  invoiceId: string;
  dueDate: string;
  /** What is stored now: posted charges, else the legacy frozen amount, else 0. */
  current: number;
  currentSource: "posted" | "legacy_locked" | "none";
  candidate: number;
  difference: number;
  formula: string;
};

/**
 * READ-ONLY: what a candidate policy would have charged on historical invoices
 * versus what is stored. Nothing is written; applying a policy to history is
 * never automatic.
 */
export function comparePolicyOnHistory(args: {
  candidate: LateFeePolicyRow;
  invoices: FlowInvoice[];
  charges: LateFeeChargeRow[];
  today: string;
}): { rows: PolicyComparisonRow[]; totals: { current: number; candidate: number; difference: number } } {
  const rows: PolicyComparisonRow[] = [];
  // Compare as if the candidate applied regardless of its effective date.
  const candidate = { ...args.candidate, effective_from: "1970-01-01" };
  for (const inv of args.invoices) {
    if (!inv.due_date) continue;
    const status = String(inv.status ?? "");
    if (status === "draft" || status === "cancelled") continue;
    const asOf = status === "paid" ? fullyPaidDate(inv, args.today) : args.today;
    if (day(inv.due_date) >= asOf) continue;
    const ownOriginal = Math.max(0, num(inv.total_amount) - num(inv.carry_forward_amount));
    const proposal = computeLateFeeProposal({
      policy: candidate,
      dueDate: inv.due_date,
      asOf,
      outstanding: status === "paid" ? 0 : principalOverdue(inv),
      originalDue: ownOriginal,
      balanceDuringLateWindow: ownOriginal,
      posted: [],
    });
    const posted = args.charges.filter((c) => c.source_invoice_id === inv.id).reduce((s, c) => s + num(c.amount), 0);
    const legacy = inv.locked_late_fee_amount === null || inv.locked_late_fee_amount === undefined ? null : num(inv.locked_late_fee_amount);
    const current = posted > 0 ? posted : legacy ?? 0;
    const currentSource = posted > 0 ? "posted" : legacy !== null ? "legacy_locked" : "none";
    if (current === 0 && proposal.fullAmount === 0) continue;
    rows.push({
      invoiceId: inv.id,
      dueDate: day(inv.due_date),
      current: round2(current),
      currentSource,
      candidate: proposal.fullAmount,
      difference: round2(proposal.fullAmount - current),
      formula: proposal.formula,
    });
  }
  const totals = rows.reduce(
    (t, r) => ({ current: t.current + r.current, candidate: t.candidate + r.candidate, difference: t.difference + r.difference }),
    { current: 0, candidate: 0, difference: 0 },
  );
  return {
    rows: rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)),
    totals: { current: round2(totals.current), candidate: round2(totals.candidate), difference: round2(totals.difference) },
  };
}

export type PolicyInput = {
  effective_from: string;
  grace_days: number;
  rate_kind: LateFeeRateKind;
  rate_value: number;
  partial_payments_reduce_base: boolean;
  cap: number | null;
  rounding: "floor" | "round" | "ceil";
  compounding: boolean;
  auto_post: boolean;
  note: string | null;
};

/** Validate a new-policy request. Returns the cleaned input or the first error. */
export function parsePolicyInput(raw: any): { ok: true; value: PolicyInput } | { ok: false; error: string } {
  const effective = String(raw?.effective_from ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return { ok: false, error: "วันที่เริ่มใช้ไม่ถูกต้อง" };
  const kind = String(raw?.rate_kind ?? "") as LateFeeRateKind;
  if (!LATE_FEE_RATE_KINDS.includes(kind)) return { ok: false, error: "ประเภทอัตราค่าปรับไม่ถูกต้อง" };
  const rate = Number(raw?.rate_value);
  if (!Number.isFinite(rate) || rate < 0) return { ok: false, error: "อัตราค่าปรับต้องเป็นตัวเลขไม่ติดลบ" };
  if ((kind === "percent_per_day" || kind === "percent_once") && rate > 100) {
    return { ok: false, error: "อัตราร้อยละต้องไม่เกิน 100" };
  }
  const grace = Number(raw?.grace_days ?? 0);
  if (!Number.isInteger(grace) || grace < 0) return { ok: false, error: "จำนวนวันผ่อนผันต้องเป็นจำนวนเต็มไม่ติดลบ" };
  const capRaw = raw?.cap;
  const cap = capRaw === null || capRaw === undefined || capRaw === "" ? null : Number(capRaw);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) return { ok: false, error: "เพดานค่าปรับต้องเป็นตัวเลขไม่ติดลบ" };
  const rounding = String(raw?.rounding ?? "floor");
  if (!["floor", "round", "ceil"].includes(rounding)) return { ok: false, error: "วิธีปัดเศษไม่ถูกต้อง" };
  const note = typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim() : null;
  return {
    ok: true,
    value: {
      effective_from: effective,
      grace_days: grace,
      rate_kind: kind,
      rate_value: rate,
      partial_payments_reduce_base: raw?.partial_payments_reduce_base !== false,
      cap,
      rounding: rounding as PolicyInput["rounding"],
      compounding: raw?.compounding === true,
      auto_post: raw?.auto_post === true,
      note,
    },
  };
}

/** Map an error raised by the SQL functions to a plain Thai message (code kept for logs). */
export function explainLateFeeError(message: string): string {
  const code = String(message ?? "").split(/\s/)[0];
  const map: Record<string, string> = {
    STALE_INVOICE: "บิลปลายทางถูกแก้ไขระหว่างนี้ กรุณาโหลดใหม่แล้วลองอีกครั้ง",
    OVERLAPPING_CHARGE: "ช่วงวันที่นี้ถูกเรียกเก็บค่าปรับไปแล้วบางส่วน",
    DUPLICATE_CHARGE_DIFFERENT: "มีการเรียกเก็บค่าปรับช่วงนี้ด้วยยอดอื่นไปแล้ว",
    INCONSISTENT_COLUMNS: "ยอดที่คำนวณไม่ตรงกับบิลปัจจุบัน กรุณาโหลดใหม่",
    ENGINE_MISMATCH: "ยอดรวมของบิลปลายทางไม่ตรงกับสูตรคำนวณ ต้องตรวจบิลก่อน",
    TARGET_NOT_OPEN: "บิลปลายทางไม่ได้อยู่ในสถานะที่แก้ไขได้",
    TENANT_MISMATCH: "บิลต้นทางและปลายทางเป็นของผู้เช่าคนละคน",
    WAIVER_EXCEEDS_FEE: "ยอดยกเว้นเกินค่าปรับคงเหลือ",
    WAIVER_BELOW_PAID: "ยกเว้นแล้วยอดบิลจะต่ำกว่ายอดที่ชำระไปแล้ว",
    REASON_REQUIRED: "ต้องระบุเหตุผล",
    APPROVER_REQUIRED: "ต้องระบุผู้อนุมัติ",
    AUTO_POST_DISABLED: "นโยบายนี้ไม่อนุญาตให้ระบบเรียกเก็บอัตโนมัติ",
    AUTO_POST_HISTORICAL: "บิลนี้ครบกำหนดก่อนมีนโยบาย ต้องให้ผู้ดูแลอนุมัติ",
    CAP_EXCEEDED: "เกินเพดานค่าปรับของนโยบาย",
    AMOUNT_EXCEEDS_RATE: "ยอดเกินกว่าที่อัตราของนโยบายอนุญาต",
    RATE_MISMATCH: "อัตราไม่ตรงกับนโยบาย",
    LINE_OUT_OF_SYNC: "รายการค่าปรับในบิลไม่ตรงกับบัญชี ต้องตรวจสอบ",
    UNKNOWN_POLICY_VERSION: "ไม่พบนโยบายค่าปรับเวอร์ชันนี้",
  };
  return map[code] ? `${map[code]} (${code})` : message;
}
