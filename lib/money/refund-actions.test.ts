import { describe, expect, it } from "vitest";
import { buildRefundPayoutPayload, explainRefundError } from "./refund-actions";

describe("explainRefundError", () => {
  it("maps database refusals to 409 / 400 / 404, not 500", () => {
    expect(explainRefundError("REFUND_EXCEEDS_DUE refund due 1000 minus paid 600 leaves 400").status).toBe(409);
    expect(explainRefundError("NOT_SETTLED tenant x has no live move-out settlement").status).toBe(409);
    expect(explainRefundError("IDEMPOTENCY_CONFLICT key k was already used").status).toBe(409);
    expect(explainRefundError("ALREADY_VOIDED settlement was already voided").status).toBe(409);
    expect(explainRefundError("SETTLEMENT_HAS_PAYOUT a refund was paid out").status).toBe(409);
    expect(explainRefundError("ROOM_REOCCUPIED room has an active tenant").status).toBe(409);
    expect(explainRefundError("FINAL_INVOICE_HAS_PAYMENTS the final invoice").status).toBe(409);
    expect(explainRefundError("REASON_REQUIRED a reason is required").status).toBe(400);
    expect(explainRefundError("INVALID_PAYLOAD amount must be greater than 0").status).toBe(400);
    expect(explainRefundError("PAYOUT_NOT_FOUND abc").status).toBe(404);
  });
  it("keeps the error code visible and falls back to 500 for anything unknown", () => {
    expect(explainRefundError("REFUND_EXCEEDS_DUE x").message).toContain("REFUND_EXCEEDS_DUE");
    expect(explainRefundError("something exploded").status).toBe(500);
  });
});

describe("buildRefundPayoutPayload", () => {
  it("passes the fields through as strings and a number amount", () => {
    expect(
      buildRefundPayoutPayload(
        { tenantId: "t1", amount: "600", paidAt: "2026-10-02T10:00:00+07:00", method: "bank", recipient: "A", reference: "R1", idempotencyKey: "k" },
        "user-1",
      ),
    ).toEqual({
      tenant_id: "t1", amount: 600, paid_at: "2026-10-02T10:00:00+07:00", method: "bank", recipient: "A",
      reference: "R1", evidence_url: null, idempotency_key: "k", actor: "user-1",
    });
  });
  it("sends a non-numeric amount as null so the database rejects it", () => {
    expect(buildRefundPayoutPayload({ amount: "abc" }, "u").amount).toBeNull();
  });
});
