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
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Sum of carried-in amounts whose source invoices are fully settled.
 * `overrides` = source paid amounts after a payment that is being recorded in
 * the same batch (so a source settled in the same batch counts).
 */
export const settledCarriedInAmount = (
  links: CarryInLink[],
  sources: Map<string, CarryInSource>,
  overrides: Map<string, number> = new Map(),
): number => {
  let sum = 0;
  for (const link of links) {
    const src = sources.get(String(link.source_invoice_id));
    if (!src || String(src.status ?? "") === "cancelled") continue;
    const total = num(src.total_amount);
    const paid = overrides.has(String(src.id))
      ? (overrides.get(String(src.id)) as number)
      : num(src.paid_amount);
    if (total > 0 && paid >= total) sum += num(link.amount);
  }
  return round2(sum);
};

/** Amount still owed on an invoice once settled carried-in debt is counted. */
export const owedAfterCarriedIn = (
  total: unknown,
  ownPaid: unknown,
  settledCarriedIn: number,
): number => Math.max(0, round2(num(total) - num(ownPaid) - settledCarriedIn));

/** True when the invoice counts as paid under the carried-in rule. */
export const isPaidWithCarriedIn = (
  total: unknown,
  ownPaid: unknown,
  settledCarriedIn: number,
): boolean => {
  const t = num(total);
  const own = num(ownPaid);
  if (t <= 0) return false;
  if (own >= t) return true;
  return own > 0 && settledCarriedIn > 0 && own + settledCarriedIn >= t;
};
