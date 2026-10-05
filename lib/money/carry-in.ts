/**
 * Carried-in debt, in one place (pure, no DB).
 *
 * A carry-forward TARGET's total already bundles amounts carried in from earlier
 * SOURCE invoices (April owes 1,400; May's total 7,594 includes those 1,400).
 * Money paid against April is recorded on April's allocations, not May's. So for
 * May, "paid" and "still owed" must count the carried-in amount whose source is
 * fully settled:
 *
 *   effective paid  = own paid + settled carried-in
 *   still owed      = max(0, total - effective paid)
 *   status 'paid'   = own paid > 0 and effective paid >= total
 *
 * This is the TypeScript twin of SQL public.money_derive_invoice_status_cf
 * (migration 20261002000000). Keep the two in step. A source counts as settled
 * when it is not cancelled, has total > 0 and paid_amount >= total_amount.
 */

export type CarryInLink = { source_invoice_id: string; amount: number };
export type CarryInSource = {
  id: string;
  total_amount: unknown;
  paid_amount: unknown;
  status?: unknown;
  /** Needed by the recursive rule to recognise a legacy-shaped source (see isLegacyInflatedPaid). */
  carry_forward_amount?: unknown;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Sum of carried-in amounts whose SOURCE invoices are settled.
 *
 * A source is settled when it is not cancelled, has total > 0 and either
 *   - paid_amount >= total_amount, or
 *   - (recursive, needs `linksByTarget`) own paid > 0 and own paid + ITS settled
 *     carried-in >= total, so a chain A -> B -> C propagates: B counts as settled for
 *     C once A is settled and B's own share is paid.
 * Without `linksByTarget` only the first rule applies (non-recursive, conservative).
 * `overrides` = source paid amounts after a payment being recorded in the same batch.
 * Twin of SQL public.money_carried_in_settled (depth cap 12 -> 0).
 */
export const settledCarriedInAmount = (
  links: CarryInLink[],
  sources: Map<string, CarryInSource>,
  overrides: Map<string, number> = new Map(),
  linksByTarget?: Map<string, CarryInLink[]>,
  depth = 0,
): number => {
  if (depth > 12) return 0;
  let sum = 0;
  for (const link of links) {
    const src = sources.get(String(link.source_invoice_id));
    if (!src || String(src.status ?? "") === "cancelled") continue;
    const total = num(src.total_amount);
    if (total <= 0) continue;
    const paid = overrides.has(String(src.id))
      ? (overrides.get(String(src.id)) as number)
      : num(src.paid_amount);
    let settled = paid >= total;
    if (!settled && linksByTarget && paid > 0 && !isLegacyInflatedPaid(total, paid, src.carry_forward_amount)) {
      const upstream = settledCarriedInAmount(
        linksByTarget.get(String(src.id)) ?? [],
        sources,
        overrides,
        linksByTarget,
        depth + 1,
      );
      settled = paid + upstream >= total;
    }
    if (settled) sum += num(link.amount);
  }
  return round2(sum);
};

/**
 * Legacy-shaped row: paid_amount is MORE than the invoice's own charge (total - carry).
 * Under the own-share model that can never happen (the allocator caps each row at its own
 * outstanding), so such a row was written before that fix and its paid_amount already
 * includes the carried part. For those rows the carried-in credit must NOT be added again,
 * and what is owed is plain total - paid (room 114/1: 6,244 total, 1,446 carried, 6,000
 * paid -> 244 still owed).
 */
export const isLegacyInflatedPaid = (total: unknown, ownPaid: unknown, carry: unknown): boolean => {
  const c = Math.max(0, num(carry));
  return c > 0 && num(ownPaid) > round2(num(total) - c);
};

/** Amount still owed on an invoice once settled carried-in debt is counted. */
export const owedAfterCarriedIn = (
  total: unknown,
  ownPaid: unknown,
  settledCarriedIn: number,
  carry?: unknown,
): number => {
  if (carry !== undefined && isLegacyInflatedPaid(total, ownPaid, carry)) {
    return Math.max(0, round2(num(total) - num(ownPaid)));
  }
  return Math.max(0, round2(num(total) - num(ownPaid) - settledCarriedIn));
};

/** True when the invoice counts as paid under the carried-in rule. */
export const isPaidWithCarriedIn = (
  total: unknown,
  ownPaid: unknown,
  settledCarriedIn: number,
  carry?: unknown,
): boolean => {
  const t = num(total);
  const own = num(ownPaid);
  if (t <= 0) return false;
  if (own >= t) return true;
  if (carry !== undefined && isLegacyInflatedPaid(total, ownPaid, carry)) return false;
  return own > 0 && settledCarriedIn > 0 && own + settledCarriedIn >= t;
};
