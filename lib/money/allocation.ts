/**
 * Receipt allocation planning — pure arithmetic, no database.
 *
 * One real money-in event (a receipt) is split across the open charges it
 * settles. Rules:
 *  - Default policy is oldest debt first.
 *  - Staff may choose the split manually; the plan is validated, never trusted.
 *  - Allocations never exceed the receipt or any charge's outstanding balance.
 *  - Whatever cannot be applied is returned as `unappliedCredit` — it is kept as
 *    tenant credit, never dropped and never silently overpaid onto an invoice.
 *
 * Amounts are worked in whole satang (integers) so sums never drift.
 */

export type OpenCharge = {
  invoiceId: string;
  /** ISO date of the billing period start; used for oldest-first ordering. */
  periodStart: string;
  /** Amount still owed on this charge, in baht. */
  outstanding: number;
};

export type PlannedAllocation = {
  invoiceId: string;
  amount: number;
  /** Outstanding on this charge after the allocation, for the preview. */
  remainingAfter: number;
};

export type AllocationPlan = {
  allocations: PlannedAllocation[];
  allocatedTotal: number;
  unappliedCredit: number;
  errors: string[];
};

const toSatang = (baht: number) => Math.round((Number.isFinite(baht) ? baht : 0) * 100);
const toBaht = (satang: number) => satang / 100;

export function planReceiptAllocation(input: {
  amountReceived: number;
  openCharges: OpenCharge[];
  /** Omit for oldest-first. When given, staff chose exactly these amounts. */
  manual?: Array<{ invoiceId: string; amount: number }>;
}): AllocationPlan {
  const errors: string[] = [];
  const received = toSatang(input.amountReceived);
  if (received <= 0) {
    return { allocations: [], allocatedTotal: 0, unappliedCredit: 0, errors: ["amountReceived must be greater than 0"] };
  }

  const charges = [...input.openCharges]
    .filter((c) => toSatang(c.outstanding) > 0)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.invoiceId.localeCompare(b.invoiceId));
  const byId = new Map(charges.map((c) => [c.invoiceId, toSatang(c.outstanding)]));

  const out: Array<{ invoiceId: string; amount: number }> = [];

  if (input.manual) {
    const seen = new Set<string>();
    for (const row of input.manual) {
      const amount = toSatang(row.amount);
      if (amount <= 0) continue;
      if (seen.has(row.invoiceId)) {
        errors.push(`duplicate allocation for invoice ${row.invoiceId}`);
        continue;
      }
      seen.add(row.invoiceId);
      const owed = byId.get(row.invoiceId);
      if (owed === undefined) {
        errors.push(`invoice ${row.invoiceId} has no open balance`);
        continue;
      }
      if (amount > owed) {
        errors.push(`allocation to invoice ${row.invoiceId} exceeds its balance`);
        continue;
      }
      out.push({ invoiceId: row.invoiceId, amount });
    }
    const sum = out.reduce((s, r) => s + r.amount, 0);
    if (sum > received) {
      errors.push("allocations exceed the amount received");
      return { allocations: [], allocatedTotal: 0, unappliedCredit: toBaht(received), errors };
    }
  } else {
    let remaining = received;
    for (const charge of charges) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, byId.get(charge.invoiceId)!);
      out.push({ invoiceId: charge.invoiceId, amount });
      remaining -= amount;
    }
  }

  const allocatedSatang = out.reduce((s, r) => s + r.amount, 0);
  return {
    allocations: out.map((r) => ({
      invoiceId: r.invoiceId,
      amount: toBaht(r.amount),
      remainingAfter: toBaht(byId.get(r.invoiceId)! - r.amount),
    })),
    allocatedTotal: toBaht(allocatedSatang),
    unappliedCredit: toBaht(received - allocatedSatang),
    errors,
  };
}
