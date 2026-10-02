/**
 * Move-out settlement planning — pure arithmetic, no database.
 *
 * Builds the line-by-line picture of a final move-out:
 *   final bill  = prorated rent + utilities + other documented charges
 *   owed        = final bill + older outstanding invoice debt
 *   credit      = advance rent held + (security deposit held - forfeited deposit)
 *
 * Rules:
 *  - Advance rent is consumed before the security deposit.
 *  - Forfeiture reduces the deposit available. Forfeited money is neither
 *    refund nor cash — it is simply retained. A reason is REQUIRED.
 *  - Credit pays older invoice debt oldest-first, then the final bill.
 *  - `refundDue` is the credit left over and is never negative.
 *  - If credit is insufficient the shortfall is `balanceStillOwed`.
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
  proratedRent: number;
  electricity?: UtilityChargeInput;
  water?: UtilityChargeInput;
  otherCharges?: OtherCharge[];
  outstandingDebts?: OutstandingDebt[];
  securityDeposit?: number;
  advanceRent?: number;
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
  depositHeld: number;
  depositForfeited: number;
  forfeitReason: string | null;
  forfeitDetail: string | null;
  depositAvailable: number;
  depositApplied: number;
  creditAvailable: number;
  /** Credit applied to older invoices, oldest first. */
  debtPayments: DebtPayment[];
  debtPaidFromCredit: number;
  finalBillPaidFromCredit: number;
  /** Credit left after settling debt and the final bill. */
  remainingCredit: number;
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

  const finalBill = Math.max(rent, 0) + electricity + water + otherTotal;

  const debts = [...(input.outstandingDebts ?? [])]
    .map((d) => ({ ...d, owed: toSatang(d.outstanding) }))
    .filter((d) => d.owed > 0)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.invoiceId.localeCompare(b.invoiceId));
  const debtTotal = debts.reduce((s, d) => s + d.owed, 0);
  const totalOwed = finalBill + debtTotal;

  const deposit = Math.max(toSatang(input.securityDeposit ?? 0), 0);
  const advance = Math.max(toSatang(input.advanceRent ?? 0), 0);

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
  const creditAvailable = advance + depositAvailable;

  // Advance rent first, then deposit.
  const advanceApplied = Math.min(advance, totalOwed);
  const depositApplied = Math.min(depositAvailable, totalOwed - advanceApplied);
  const creditUsed = advanceApplied + depositApplied;

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

  const remainingCredit = Math.max(creditAvailable - creditUsed, 0);
  const refundDue = remainingCredit;
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
    depositHeld: toBaht(deposit),
    depositForfeited: toBaht(forfeit),
    forfeitReason: forfeit > 0 ? forfeitReason : null,
    forfeitDetail: forfeit > 0 ? input.depositForfeiture?.detail ?? null : null,
    depositAvailable: toBaht(depositAvailable),
    depositApplied: toBaht(depositApplied),
    creditAvailable: toBaht(creditAvailable),
    debtPayments,
    debtPaidFromCredit: toBaht(debtPaid),
    finalBillPaidFromCredit: toBaht(finalBillPaid),
    remainingCredit: toBaht(remainingCredit),
    refundDue: toBaht(refundDue),
    balanceStillOwed: toBaht(balanceStillOwed),
    refundPaid: toBaht(refundPaid),
    refundOutstanding: toBaht(Math.max(refundDue - refundPaid, 0)),
    errors,
  };
}
