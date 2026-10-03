import { describe, expect, it } from "vitest";
import { paymentIntentCanonical, paymentPayloadHash, stableStringify } from "./payment-payload-hash";

const auto = {
  kind: "auto" as const,
  triggerInvoiceId: "inv-1",
  amount: 1500,
  keepExcessAsCredit: false,
  paidAt: "2026-10-03T10:00:00.000Z",
  mode: "full",
  source: "admin",
  slipUrl: null,
  paymentMethodId: null,
};

describe("stableStringify", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
  it("normalises float noise to 2 decimals", () => {
    expect(stableStringify({ x: 0.1 + 0.2 })).toBe('{"x":0.3}');
  });
});

describe("paymentPayloadHash", () => {
  it("is stable for the same intent regardless of key order", async () => {
    const { kind, triggerInvoiceId, ...rest } = auto;
    const reordered = { ...rest, triggerInvoiceId, kind };
    expect(await paymentPayloadHash(auto)).toBe(await paymentPayloadHash(reordered));
    expect(await paymentPayloadHash(auto)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("differs when the amount differs", async () => {
    expect(await paymentPayloadHash(auto)).not.toBe(await paymentPayloadHash({ ...auto, amount: 1501 }));
  });
  it("ignores manual allocation order but not amounts", async () => {
    const manual = {
      kind: "manual" as const,
      tenantId: "t",
      triggerInvoiceId: "a",
      allocations: [
        { invoiceId: "a", amount: 100 },
        { invoiceId: "b", amount: 200 },
      ],
      paidAt: "2026-10-03",
      mode: "full",
      source: "admin",
      slipUrl: null,
      paymentMethodId: null,
    };
    const swapped = { ...manual, allocations: [...manual.allocations].reverse() };
    expect(paymentIntentCanonical(manual)).toBe(paymentIntentCanonical(swapped));
    const changed = { ...manual, allocations: [{ invoiceId: "a", amount: 150 }, { invoiceId: "b", amount: 150 }] };
    expect(await paymentPayloadHash(manual)).not.toBe(await paymentPayloadHash(changed));
  });
});
