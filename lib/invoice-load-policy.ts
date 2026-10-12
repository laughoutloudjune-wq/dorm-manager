/**
 * Pure decisions behind the invoice page's loading and polling, kept out of
 * the React hooks so they can be unit tested (vitest runs in a node
 * environment here, with no component renderer).
 */

export const INVOICE_POLL_INTERVAL_MS = 20_000;
/** Period maintenance (status/discount/ledger sync) is not repeated more often than this on background refreshes. */
export const MAINTENANCE_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Explicit loads (first open, month change, a modal asking for a reload) run
 * maintenance. Background refreshes only do so if it has not run recently for
 * the same period, so a page left open does not repeat the same writes every
 * 20 seconds.
 */
export function shouldRunMaintenance(input: {
  silent: boolean;
  period: string;
  lastPeriod: string | null;
  lastRunAt: number | null;
  now: number;
}): boolean {
  if (!input.silent) return true;
  if (input.lastRunAt === null || input.lastPeriod !== input.period) return true;
  return input.now - input.lastRunAt >= MAINTENANCE_MIN_INTERVAL_MS;
}

/** Background polling is skipped while the tab is hidden. */
export function shouldPoll(hidden: boolean): boolean {
  return !hidden;
}

/** When the tab becomes visible again, refresh at once if a poll was missed. */
export function shouldRefreshOnVisible(input: {
  lastPollAt: number | null;
  now: number;
  intervalMs?: number;
}): boolean {
  if (input.lastPollAt === null) return true;
  return input.now - input.lastPollAt >= (input.intervalMs ?? INVOICE_POLL_INTERVAL_MS);
}

/**
 * Stable fingerprint of an invoice's payment history. The ledger view reloads
 * when this changes (a payment was recorded or voided) and not when the same
 * history arrives as a fresh array from an unrelated state update.
 */
export function paymentHistorySignature(history: unknown): string {
  if (!Array.isArray(history)) return "";
  // Whole-entry content, not a hand-picked subset: void/reversal rewrites
  // entries in ways a few fields might not capture.
  return JSON.stringify(history);
}

/** The inputs that should trigger a ledger-history fetch, as one comparable key; null means "do not load". */
export function ledgerLoadKey(input: {
  invoiceId: string;
  tab: string;
  historySignature: string;
  reloadToken: number;
}): string | null {
  if (!input.invoiceId || input.tab !== "payments") return null;
  return `${input.invoiceId}#${input.historySignature}#${input.reloadToken}`;
}

/** Assignable payment methods are needed only while the Payments tab of an open modal is showing, and only once. */
export function shouldLoadAssignableMethods(input: {
  detailOpen: boolean;
  tab: string;
  alreadyLoaded: boolean;
}): boolean {
  return input.detailOpen && input.tab === "payments" && !input.alreadyLoaded;
}
