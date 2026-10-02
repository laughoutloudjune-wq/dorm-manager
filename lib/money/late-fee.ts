/**
 * Late-fee estimate — pure arithmetic, no database.
 *
 * An estimate is NOT a charge. Nothing here posts anything; it returns the
 * amount, the covered dates, the eligible balance and a plain formula so an
 * admin can approve it (posting it as a distinct charge) and a tenant can read
 * how it was worked out. The policy is versioned and carries every rule.
 */

export type LateFeePolicy = {
  version: string;
  /** Policy applies to invoices whose due date is on/after this date (YYYY-MM-DD). */
  effectiveFrom: string;
  /** Whole days after the due date before the fee starts. */
  graceDays: number;
  /** Fee per day: a flat baht amount, or a percentage of the eligible balance. */
  rate: { kind: "flat"; baht: number } | { kind: "percent"; percent: number };
  /** If true, a partial payment shrinks the balance the fee is charged on. */
  partialPaymentsReduceBase: boolean;
  /** Maximum total fee in baht; null = no cap. */
  cap: number | null;
  /** Rounding of the final amount. */
  rounding: "floor" | "round" | "ceil";
  /**
   * Compounding: when true, each day's percentage is charged on balance plus
   * fee accrued so far. Only meaningful for percent rates.
   */
  compounding: boolean;
};

export type LateFeeInput = {
  /** YYYY-MM-DD, a calendar date in the dorm's local timezone. */
  dueDate: string;
  /** YYYY-MM-DD: the date the fee is calculated up to (today, or the date it was settled). */
  asOf: string;
  /** Unpaid charge balance at `asOf`, excluding any late fee. */
  outstanding: number;
  /** Original amount that was due, used when partial payments do not reduce the base. */
  originalDue: number;
  /** Fee already waived, in baht. */
  waived?: number;
};

export type LateFeeEstimate = {
  policyVersion: string;
  coveredFrom: string | null;
  coveredTo: string | null;
  daysCharged: number;
  eligibleBalance: number;
  grossAmount: number;
  cappedAmount: number;
  waivedAmount: number;
  /** What would be charged if approved. */
  amount: number;
  /** Plain-language formula for admin and tenant screens. */
  formula: string;
  isEstimate: true;
};

const parseDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};
const addDays = (value: string, days: number) =>
  new Date(parseDate(value) + days * 86400000).toISOString().slice(0, 10);
const roundBy = (mode: LateFeePolicy["rounding"], n: number) =>
  mode === "floor" ? Math.floor(n) : mode === "ceil" ? Math.ceil(n) : Math.round(n);

export function estimateLateFee(policy: LateFeePolicy, input: LateFeeInput): LateFeeEstimate {
  const empty = (over: Partial<LateFeeEstimate>): LateFeeEstimate => ({
    policyVersion: policy.version,
    coveredFrom: null,
    coveredTo: null,
    daysCharged: 0,
    eligibleBalance: 0,
    grossAmount: 0,
    cappedAmount: 0,
    waivedAmount: 0,
    amount: 0,
    formula: "",
    isEstimate: true,
    ...over,
  });

  const firstFeeDay = addDays(input.dueDate, policy.graceDays + 1);
  const outstanding = Math.max(0, input.outstanding);
  const eligibleBalance = policy.partialPaymentsReduceBase
    ? outstanding
    : Math.max(0, input.originalDue);

  if (
    input.dueDate < policy.effectiveFrom ||
    outstanding <= 0 ||
    parseDate(input.asOf) < parseDate(firstFeeDay)
  ) {
    return empty({ eligibleBalance, formula: "no late fee yet" });
  }

  const days = Math.floor((parseDate(input.asOf) - parseDate(firstFeeDay)) / 86400000) + 1;
  let gross = 0;
  if (policy.rate.kind === "flat") {
    gross = days * policy.rate.baht;
  } else if (policy.compounding) {
    let running = eligibleBalance;
    for (let i = 0; i < days; i++) running += running * (policy.rate.percent / 100);
    gross = running - eligibleBalance;
  } else {
    gross = days * eligibleBalance * (policy.rate.percent / 100);
  }

  const capped = policy.cap === null ? gross : Math.min(gross, policy.cap);
  const rounded = roundBy(policy.rounding, capped);
  const waived = Math.min(Math.max(0, input.waived ?? 0), rounded);
  const rateText =
    policy.rate.kind === "flat"
      ? `${policy.rate.baht} baht/day`
      : `${policy.rate.percent}%/day of ${eligibleBalance}${policy.compounding ? " (compounding)" : ""}`;

  return empty({
    coveredFrom: firstFeeDay,
    coveredTo: input.asOf,
    daysCharged: days,
    eligibleBalance,
    grossAmount: gross,
    cappedAmount: rounded,
    waivedAmount: waived,
    amount: rounded - waived,
    formula:
      `${days} days (${firstFeeDay} to ${input.asOf}) x ${rateText}` +
      (policy.cap !== null ? `, capped at ${policy.cap}` : "") +
      (waived > 0 ? `, less ${waived} waived` : "") +
      ` = ${rounded - waived} baht (estimate, policy ${policy.version})`,
  });
}
