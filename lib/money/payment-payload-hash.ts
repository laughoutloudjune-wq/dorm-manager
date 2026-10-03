/**
 * Stable hash of a payment request's INTENT, sent to record_payment_batch as
 * `batch.payload_hash` and stored on the payment_batches row.
 *
 * Why the intent and not the computed split: a genuine retry of the same
 * request (same idempotency key) may be computed against a different invoice
 * state, e.g. after the first attempt committed. Hashing what the admin asked
 * for (amount, target, date, slip, method, explicit split) keeps a real retry
 * replaying, while the same key reused for a DIFFERENT payment is refused with
 * IDEMPOTENCY_CONFLICT instead of silently returning the other receipt.
 *
 * Pure and isomorphic: Web Crypto (globalThis.crypto.subtle) works in Node 18+
 * and in the browser, so importing this from lib/invoice-ledger.ts does not
 * pull node:crypto into client bundles.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every level; numbers normalised to 2 decimals. */
export function stableStringify(value: unknown): string {
  const normalise = (v: unknown): Json => {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map(normalise);
    if (typeof v === "object") {
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item === undefined) continue;
        out[key] = normalise(item);
      }
      return out;
    }
    return String(v);
  };
  return JSON.stringify(normalise(value));
}

export type AutoPaymentIntent = {
  kind: "auto";
  triggerInvoiceId: string;
  amount: number;
  keepExcessAsCredit: boolean;
  paidAt: string;
  mode: string;
  source: string;
  slipUrl: string | null;
  paymentMethodId: string | null;
};

export type ManualPaymentIntent = {
  kind: "manual";
  tenantId: string;
  triggerInvoiceId: string;
  allocations: Array<{ invoiceId: string; amount: number }>;
  paidAt: string;
  mode: string;
  source: string;
  slipUrl: string | null;
  paymentMethodId: string | null;
};

export type PaymentIntent = AutoPaymentIntent | ManualPaymentIntent;

/** Canonical string for an intent; the manual split is order-independent except for the trigger. */
export function paymentIntentCanonical(intent: PaymentIntent): string {
  if (intent.kind === "manual") {
    return stableStringify({
      ...intent,
      allocations: [...intent.allocations]
        .map((a) => ({ invoiceId: a.invoiceId, amount: a.amount }))
        .sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0)),
    });
  }
  return stableStringify(intent);
}

/** 'sha256:<hex>' of the canonical intent. */
export async function paymentPayloadHash(intent: PaymentIntent): Promise<string> {
  const bytes = new TextEncoder().encode(paymentIntentCanonical(intent));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
