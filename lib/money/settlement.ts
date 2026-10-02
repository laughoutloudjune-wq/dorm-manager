/**
 * Move-out settlement planning — pure arithmetic, no database.
 *
 * Builds the line-by-line picture of a final move-out:
 *   final bill  = full-month rent + prorated rent + utilities + other documented charges
 *   owed        = final bill + older outstanding invoice debt
 *   credit      = advance rent held + (security deposit held - forfeited deposit)
 *                 + unapplied overpayment credit held
 *
 * Rules:
 *  - Credit is drawn in a fixed order: advance rent, then security deposit,
 *    then unapplied overpayment credit.
 *  - Credit pays older invoice debt oldest-first, then the final bill.
 *  - ADVANCE RENT IS NOT REFUNDABLE (owner decision 2026-10-03). Advance rent
 *    left over once everything owed is covered is absorbed (`advanceRentAbsorbed`)
 *    and never becomes refund due.
 *  - Forfeiture reduces the deposit available. Forfeited money is neither refund
 *    nor cash — it is simply retained. A reason is REQUIRED.
 *  - `refundDue` = deposit left + unapplied overpayment credit left. Only those two
 *    can ever produce a refund. Never negative.
 *  - If credit is insufficient the shortfall is `balanceStillOwed`. It is never
 *    written off here.
 *  - Recorded refund payouts may not exceed `refundDue`.
 *
 * Amounts are worked in whole satang (integers) so sums never drift.
 */

export type MeterCharge = {
  previousReading: number;
  currentReading: number;
  /** Baht per unit. */
  rate: number;
  /** Minimum charge in baht, applied when usage * rate is lower. */
  minimum?: number;
};

/** Either meter readings or an already-computed amount (baht). */
export type UtilityChargeInput = MeterCharge | { amount: number };

export type OtherCharge = { label: string; amount: number; reason: string };

export type OutstandingDebt = {
  invoiceId: string;
  /** ISO date of the billing period start; used for oldest-first ordering. */
  periodStart: string;
  /** Amount still owed on this invoice, in baht. */
  outstanding: number;
};

export type DepositForfeiture = {
  forfeitAmount: number;
  /** Required when forfeitAmount > 0. */
  reason?: string;
  detail?: string;
};

export type MoveOutSettlementInput = {
  /** Rent for whole billing months not yet invoiced (baht). */
  fullMonthRent?: number;
  /** Rent for the trailing partial period, computed with dailyRentRate (baht). */
  proratedRent: number;
  electricity?: UtilityChargeInput;
  water?: UtilityChargeInput;
  otherCharges?: OtherCharge[];
  outstandingDebts?: OutstandingDebt[];
  securityDeposit?: number;
  advanceRent?: number;
  /** Unapplied overpayment credit held for the tenant (refundable). */
  unappliedCredit?: number;
  depositForfeiture?: DepositForfeiture;
  /** Refund payouts already paid to the tenant, in baht. */
  refundPayouts?: number[];
};

export type DebtPayment = {
  invoiceId: string;
  periodStart: string;
  outstandingBefore: number;
  paidFromCredit: number;
  outstandingAfter: number;
};

export type MoveOutSettlementPlan = {
  fullMonthRent: number;
  proratedRent: number;
  electricity: number;
  water: number;
  utilities: number;
  otherCharges: OtherCharge[];
  otherChargesTotal: number;
  finalBillTotal: number;
  outstandingDebt: number;
  totalOwed: number;
  advanceRentHeld: number;
  advanceRentApplied: number;
  /** Advance rent left over after everything owed was covered. Not refundable. */
  advanceRentAbsorbed: number;
  depositHeld: number;
  depositForfeited: number;
  forfeitReason: string | null;
  forfeitDetail: string | null;
  depositAvailable: number;
  depositApplied: number;
  /** Deposit left after forfeiture and application — refundable. */
  depositRemaining: number;
  unappliedCreditHeld: number;
  unappliedCreditApplied: number;
  unappliedCreditRemaining: number;
  creditAvailable: number;
  creditApplied: number;
  /** Credit applied to older invoices, oldest first. */
  debtPayments: DebtPayment[];
  debtPaidFromCredit: number;
  finalBillPaidFromCredit: number;
  /** What the final invoice still asks the tenant to pay. */
  finalBillDue: number;
  /** Credit left after settling debt and the final bill (all buckets). */
  remainingCredit: number;
  /** depositRemaining + unappliedCreditRemaining. Advance rent never counts. */
  refundDue: number;
  balanceStillOwed: number;
  refundPaid: number;
  refundOutstanding: number;
  errors: string[];
};

const toSatang = (baht: number) => Math.round((Number.isFinite(baht) ? baht : 0) * 100);
const toBaht = (satang: number) => satang / 100;

function utilitySatang(label: string, input: UtilityChargeInput | undefined, errors: string[]): number {
  if (!input) return 0;
  if ("amount" in input) {
    const amount = toSatang(input.amount);
    if (amount < 0) {
      errors.push(`${label} amount must not be negative`);
      return 0;
    }
    return amount;
  }
  const usage = input.currentReading - input.previousReading;
  if (!Number.isFinite(usage) || usage < 0) {
    errors.push(`${label} current reading is lower than the previous reading`);
    return 0;
  }
  if (!(input.rate >= 0)) {
    errors.push(`${label} rate must not be negative`);
    return 0;
  }
  // Usage can be fractional; round once, to the satang.
  const metered = Math.round(usage * toSatang(input.rate));
  return Math.max(metered, toSatang(input.minimum ?? 0));
}

export function planMoveOutSettlement(input: MoveOutSettlementInput): MoveOutSettlementPlan {
  const errors: string[] = [];

  const fullMonthRent = toSatang(input.fullMonthRent ?? 0);
  if (fullMonthRent < 0) errors.push("fullMonthRent must not be negative");
  const rent = toSatang(input.proratedRent);
  if (rent < 0) errors.push("proratedRent must not be negative");
  const electricity = utilitySatang("electricity", input.electricity, errors);
  const water = utilitySatang("water", input.water, errors);

  const otherCharges: OtherCharge[] = [];
  let otherTotal = 0;
  for (const c of input.otherCharges ?? []) {
    const amount = toSatang(c.amount);
    if (amount === 0) continue;
    if (amount < 0) {
      errors.push(`other charge "${c.label}" must not be negative`);
      continue;
    }
    if (!c.reason?.trim()) {
      errors.push(`other charge "${c.label}" needs a documented reason`);
      continue;
    }
    otherCharges.push({ label: c.label, amount: toBaht(amount), reason: c.reason });
    otherTotal += amount;
  }

  const finalBill = Math.max(fullMonthRent, 0) + Math.max(rent, 0) + electricity + water + otherTotal;

  const debts = [...(input.outstandingDebts ?? [])]
    .map((d) => ({ ...d, owed: toSatang(d.outstanding) }))
    .filter((d) => d.owed > 0)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.invoiceId.localeCompare(b.invoiceId));
  const debtTotal = debts.reduce((s, d) => s + d.owed, 0);
  const totalOwed = finalBill + debtTotal;

  const deposit = Math.max(toSatang(input.securityDeposit ?? 0), 0);
  const advance = Math.max(toSatang(input.advanceRent ?? 0), 0);
  const unapplied = Math.max(toSatang(input.unappliedCredit ?? 0), 0);

  let forfeit = toSatang(input.depositForfeiture?.forfeitAmount ?? 0);
  const forfeitReason = input.depositForfeiture?.reason?.trim() || null;
  if (forfeit < 0) {
    errors.push("forfeitAmount must not be negative");
    forfeit = 0;
  }
  if (forfeit > 0 && !forfeitReason) {
    errors.push("a reason is required when forfeiting any of the deposit");
    forfeit = 0;
  }
  if (forfeit > deposit) {
    errors.push("forfeitAmount exceeds the deposit held");
    forfeit = deposit;
  }

  const depositAvailable = deposit - forfeit;
  const creditAvailable = advance + depositAvailable + unapplied;

  // Advance rent first, then deposit, then unapplied overpayment credit.
  const advanceApplied = Math.min(advance, totalOwed);
  const depositApplied = Math.min(depositAvailable, totalOwed - advanceApplied);
  const unappliedApplied = Math.min(unapplied, totalOwed - advanceApplied - depositApplied);
  const creditUsed = advanceApplied + depositApplied + unappliedApplied;

  // Older invoices first (oldest to newest), then the final bill.
  let pool = creditUsed;
  const debtPayments: DebtPayment[] = debts.map((d) => {
    const paid = Math.min(pool, d.owed);
    pool -= paid;
    return {
      invoiceId: d.invoiceId,
      periodStart: d.periodStart,
      outstandingBefore: toBaht(d.owed),
      paidFromCredit: toBaht(paid),
      outstandingAfter: toBaht(d.owed - paid),
    };
  });
  const finalBillPaid = Math.min(pool, finalBill);
  const debtPaid = creditUsed - finalBillPaid;

  const advanceAbsorbed = advance - advanceApplied;
  const depositRemaining = depositAvailable - depositApplied;
  const unappliedRemaining = unapplied - unappliedApplied;
  const remainingCredit = advanceAbsorbed + depositRemaining + unappliedRemaining;
  const refundDue = depositRemaining + unappliedRemaining;
  const balanceStillOwed = Math.max(totalOwed - creditUsed, 0);

  let refundPaid = 0;
  for (const p of input.refundPayouts ?? []) {
    const amount = toSatang(p);
    if (amount < 0) {
      errors.push("refund payouts must not be negative");
      continue;
    }
    refundPaid += amount;
  }
  if (refundPaid > refundDue) {
    errors.push("refund payouts exceed the refund due");
  }

  return {
    fullMonthRent: toBaht(Math.max(fullMonthRent, 0)),
    proratedRent: toBaht(Math.max(rent, 0)),
    electricity: toBaht(electricity),
    water: toBaht(water),
    utilities: toBaht(electricity + water),
    otherCharges,
    otherChargesTotal: toBaht(otherTotal),
    finalBillTotal: toBaht(finalBill),
    outstandingDebt: toBaht(debtTotal),
    totalOwed: toBaht(totalOwed),
    advanceRentHeld: toBaht(advance),
    advanceRentApplied: toBaht(advanceApplied),
    advanceRentAbsorbed: toBaht(advanceAbsorbed),
    depositHeld: toBaht(deposit),
    depositForfeited: toBaht(forfeit),
    forfeitReason: forfeit > 0 ? forfeitReason : null,
    forfeitDetail: forfeit > 0 ? input.depositForfeiture?.detail ?? null : null,
    depositAvailable: toBaht(depositAvailable),
    depositApplied: toBaht(depositApplied),
    depositRemaining: toBaht(depositRemaining),
    unappliedCreditHeld: toBaht(unapplied),
    unappliedCreditApplied: toBaht(unappliedApplied),
    unappliedCreditRemaining: toBaht(unappliedRemaining),
    creditAvailable: toBaht(creditAvailable),
    creditApplied: toBaht(creditUsed),
    debtPayments,
    debtPaidFromCredit: toBaht(debtPaid),
    finalBillPaidFromCredit: toBaht(finalBillPaid),
    finalBillDue: toBaht(finalBill - finalBillPaid),
    remainingCredit: toBaht(remainingCredit),
    refundDue: toBaht(refundDue),
    balanceStillOwed: toBaht(balanceStillOwed),
    refundPaid: toBaht(refundPaid),
    refundOutstanding: toBaht(Math.max(refundDue - refundPaid, 0)),
    errors,
  };
}
