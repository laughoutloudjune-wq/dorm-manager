import { describe, expect, it } from "vitest";
import {
  buildRecordPayoutBody,
  buildVoidPayoutBody,
  buildVoidSettlementBody,
  canVoidSettlement,
  defaultPayoutForm,
  isReasonValid,
  validatePayoutForm,
} from "./form-logic";

const now = new Date(2026, 9, 5, 12, 0);
const ok = () => ({ ...defaultPayoutForm(1500, "สมชาย", now), method: "โอน", reference: "REF1" });

describe("validatePayoutForm", () => {
  it("defaults amount to outstanding and accepts a complete form", () => {
    expect(ok().amount).toBe("1500.00");
    expect(validatePayoutForm(ok(), 1500, now)).toEqual({});
  });
  it("rejects amount above outstanding, zero, 3 decimals, non-numeric", () => {
    expect(validatePayoutForm({ ...ok(), amount: "1500.01" }, 1500, now).amount).toBeTruthy();
    expect(validatePayoutForm({ ...ok(), amount: "0" }, 1500, now).amount).toBeTruthy();
    expect(validatePayoutForm({ ...ok(), amount: "10.123" }, 1500, now).amount).toBeTruthy();
    expect(validatePayoutForm({ ...ok(), amount: "abc" }, 1500, now).amount).toBeTruthy();
  });
  it("requires method and recipient", () => {
    const e = validatePayoutForm({ ...ok(), method: " ", recipient: "" }, 1500, now);
    expect(e.method).toBeTruthy();
    expect(e.recipient).toBeTruthy();
  });
  it("requires reference or evidence link", () => {
    expect(validatePayoutForm({ ...ok(), reference: "" }, 1500, now).reference).toBeTruthy();
    expect(validatePayoutForm({ ...ok(), reference: "", evidenceUrl: "https://x.y/z" }, 1500, now)).toEqual({});
  });
  it("rejects future dates", () => {
    expect(validatePayoutForm({ ...ok(), paidAt: "2026-10-06T12:00" }, 1500, now).paidAt).toBeTruthy();
  });
});

describe("request bodies", () => {
  it("builds payout body with ISO date and the given key", () => {
    const b = buildRecordPayoutBody("t1", ok(), "key-1");
    expect(b).toMatchObject({ action: "record_refund_payout", tenantId: "t1", amount: 1500, idempotencyKey: "key-1", evidenceUrl: null });
    expect(b.paidAt).toBe(new Date(2026, 9, 5, 12, 0).toISOString());
  });
  it("builds void bodies with trimmed reason", () => {
    expect(buildVoidPayoutBody("p", " x ")).toEqual({ action: "void_refund_payout", payoutId: "p", reason: "x" });
    expect(buildVoidSettlementBody("s", " y ")).toEqual({ action: "void_settlement", settlementId: "s", reason: "y" });
    expect(isReasonValid("  ")).toBe(false);
  });
  it("settlement void only when active and no live payouts", () => {
    expect(canVoidSettlement({ voidedAt: null, livePayouts: 0 })).toBe(true);
    expect(canVoidSettlement({ voidedAt: null, livePayouts: 1 })).toBe(false);
    expect(canVoidSettlement({ voidedAt: "x", livePayouts: 0 })).toBe(false);
  });
});
