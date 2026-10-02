/** Deep links into admin detail modals. Pure helpers, shared by pages and tests. */

export const invoiceDeepLink = (invoiceId: string) => `/invoices?invoice=${encodeURIComponent(invoiceId)}`;
export const tenantDeepLink = (tenantId: string) => `/tenants?tenant=${encodeURIComponent(tenantId)}`;

/** A usable id from a search param, or null. Trims; rejects empty and absurdly long values. */
export function parseDeepLinkId(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 && v.length <= 64 ? v : null;
}

/** "YYYY-MM" for an invoice's start_date ("YYYY-MM-DD..."), or null if malformed. */
export function monthFromStartDate(startDate: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(startDate ?? ""));
  return m ? `${m[1]}-${m[2]}` : null;
}
