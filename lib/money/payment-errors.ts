/**
 * HTTP status for the refusals the payment/void/settle database functions raise on purpose
 * (finding 165). They are expected business outcomes (a stale balance, an overpaid invoice, a bad
 * payload), not server faults, so clients must see 409/400, not 500. The message stays as the
 * database wrote it: it names the invoice and the amounts.
 */
const CONFLICT =
  /^(STALE_INVOICE|STALE_CHAIN|OVERPAID_INVOICE|TENANT_MISMATCH|INVOICE_NOT_PAYABLE|INVOICE_NOT_FOUND|IDEMPOTENCY_CONFLICT|VOID_NOT_ALLOWED|VOID_CREDIT_ALREADY_USED|VOID_WOULD_MAKE_NEGATIVE|CROSS_TENANT_CARRY|ALREADY_SETTLED|Payment batch already voided)/;
const BAD_REQUEST = /^(INVALID_PAYLOAD|TENANT_REQUIRED|REASON_REQUIRED|amount_received must|amount_allocated must|A reason is required)/;

export function paymentErrorStatus(message: unknown): number {
  const text = String(message ?? "").trim();
  if (CONFLICT.test(text)) return 409;
  if (BAD_REQUEST.test(text)) return 400;
  if (/^Payment batch not found/.test(text)) return 404;
  return 500;
}
