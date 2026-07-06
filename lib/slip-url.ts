/**
 * A legitimate payment-slip URL is always produced by our own upload flow
 * (app/(public)/payment/liff/page.tsx and app/(public)/payment/[token]/page.tsx),
 * which always writes to the "payment_slips" bucket under our own Supabase
 * project. Public endpoints that accept a client-supplied slipUrl string must
 * check it against this shape instead of trusting it outright — otherwise a
 * caller could point slip_url at an arbitrary external link.
 */
export function isTrustedSlipUrl(slipUrl: string): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return false;
  const expectedPrefix = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/payment_slips/`;
  return slipUrl.startsWith(expectedPrefix);
}
