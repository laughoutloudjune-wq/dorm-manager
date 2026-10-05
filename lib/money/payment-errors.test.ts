import { describe, expect, it } from "vitest";
import { paymentErrorStatus } from "./payment-errors";

describe("paymentErrorStatus", () => {
  it("expected refusals are 409 (conflict with the current state)", () => {
    for (const m of [
      "STALE_INVOICE abc (paid_amount changed from 0 to 300)",
      "OVERPAID_INVOICE abc would reach paid_amount 801 above its total 800",
      "TENANT_MISMATCH invoice abc belongs to tenant x",
      "INVOICE_NOT_PAYABLE invoice abc is cancelled",
      "IDEMPOTENCY_CONFLICT key k was already used",
      "VOID_NOT_ALLOWED settlement batch",
      "VOID_CREDIT_ALREADY_USED credit spent",
      "STALE_CHAIN carry-forward links changed while locking; retry",
      "Payment batch already voided",
    ]) expect(paymentErrorStatus(m)).toBe(409);
  });
  it("bad input is 400, a missing batch is 404, anything else stays 500", () => {
    expect(paymentErrorStatus("INVALID_PAYLOAD invoice abc status bogus is not a valid payment status")).toBe(400);
    expect(paymentErrorStatus("TENANT_REQUIRED amount_received exceeds amount_allocated")).toBe(400);
    expect(paymentErrorStatus("A reason is required to void a payment")).toBe(400);
    expect(paymentErrorStatus("Payment batch not found")).toBe(404);
    expect(paymentErrorStatus("connection reset by peer")).toBe(500);
    expect(paymentErrorStatus(undefined)).toBe(500);
  });
});
