// Pure helpers for the BILLING view of the admin income report.
//
// Three defects they fix (finding 170):
//  1. total_amount bundles carry_forward_amount, so a carried debt was billed
//     in two periods -> ownBilledAmount strips it.
//  2. paid_amount includes NON-CASH settlement credit (allocation sources
//     'credit' / 'abandon_room') -> splitPaid separates cash from credit.
//  3. The final move-out invoice's total_amount is NET of the deposit/advance
//     credit used on it (stored as a discount_breakdown entry with source
//     'move_out_credit') -> ownBilledAmount adds it back to show the gross bill.

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function moveOutCreditOf(discountBreakdown: unknown): number {
  if (!Array.isArray(discountBreakdown)) return 0;
  let sum = 0;
  for (const entry of discountBreakdown) {
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { source?: unknown }).source !== "move_out_credit") continue;
    sum += num((entry as { amount?: unknown }).amount);
  }
  return round2(sum);
}

export function ownBilledAmount(inv: {
  total_amount: unknown;
  carry_forward_amount: unknown;
  discount_breakdown?: unknown;
}): number {
  const own = Math.max(0, num(inv.total_amount) - num(inv.carry_forward_amount));
  return round2(own + moveOutCreditOf(inv.discount_breakdown));
}

export function splitPaid(
  inv: { paid_amount: unknown; discount_breakdown?: unknown },
  allocationCredit: number,
): { cash: number; credit: number } {
  const credit = num(allocationCredit);
  return {
    cash: round2(Math.max(0, num(inv.paid_amount) - credit)),
    credit: round2(Math.max(0, credit + moveOutCreditOf(inv.discount_breakdown))),
  };
}

export function creditByInvoiceId(
  allocations: Array<{ invoice_id: unknown; amount: unknown; isCredit?: boolean }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of allocations) {
    if (!row.isCredit) continue;
    const id = String(row.invoice_id ?? "");
    if (!id) continue;
    map.set(id, round2((map.get(id) ?? 0) + num(row.amount)));
  }
  return map;
}
