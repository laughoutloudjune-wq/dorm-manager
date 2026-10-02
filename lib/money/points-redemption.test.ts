import { describe, expect, it } from "vitest";
import {
  findPointsDiscrepancies,
  planRedemption,
  planRedemptionReversal,
  summarizePointsAndDiscounts,
  type InvoiceAdjustment,
  type PointsEvent,
} from "./points-redemption";

const base = {
  pointsBalance: 500,
  pointsToRedeem: 100,
  bahtPerPoint: 0.5,
  invoice: { id: "inv1", outstandingCharges: 5000, redeemableCharge: 4000 },
  idempotencyKey: "k1",
  existingKeys: [] as string[],
};

const redeemed = () => {
  const p = planRedemption(base);
  return { ev: p.pointsEvent as PointsEvent, adj: p.invoiceAdjustment as InvoiceAdjustment };
};

const reversed = () => {
  const { ev, adj } = redeemed();
  const r = planRedemptionReversal({ originalPointsEvent: ev, originalAdjustment: adj, reason: "r", alreadyReversedKeys: [] });
  return { ev, adj, revEv: r.pointsEvent as PointsEvent, revAdj: r.invoiceAdjustment as InvoiceAdjustment };
};

describe("planRedemption", () => {
  it("emits a paired event and adjustment sharing one key", () => {
    const p = planRedemption(base);
    expect(p.errors).toEqual([]);
    expect(p.replay).toBe(false);
    expect(p.pointsEvent).toMatchObject({ type: "redeem", points: -100, referenceKey: "k1" });
    expect(p.invoiceAdjustment).toMatchObject({ type: "points_redemption", amount: 50, referenceKey: "k1" });
  });

  it("replays instead of duplicating when the key exists", () => {
    const p = planRedemption({ ...base, existingKeys: ["k1"], pointsBalance: 0 });
    expect(p).toEqual({ replay: true, pointsEvent: null, invoiceAdjustment: null, errors: [] });
  });

  it("rejects more points than the balance", () => {
    const p = planRedemption({ ...base, pointsToRedeem: 501 });
    expect(p.errors.length).toBe(1);
    expect(p.pointsEvent).toBeNull();
    expect(p.invoiceAdjustment).toBeNull();
  });

  it("rejects a discount above the redeemable charge even if outstanding is larger", () => {
    const p = planRedemption({
      ...base,
      pointsToRedeem: 400,
      invoice: { id: "i", outstandingCharges: 5000, redeemableCharge: 100 },
    });
    expect(p.errors[0]).toMatch(/redeemable/);
    expect(p.pointsEvent).toBeNull();
  });

  it("rejects a discount above outstanding charges", () => {
    const p = planRedemption({
      ...base,
      pointsToRedeem: 400,
      invoice: { id: "i", outstandingCharges: 100, redeemableCharge: 4000 },
    });
    expect(p.errors.join()).toMatch(/outstanding/);
  });

  it("allows redeeming exactly the redeemable charge", () => {
    const p = planRedemption({
      ...base,
      pointsBalance: 1000,
      pointsToRedeem: 200,
      invoice: { id: "i", outstandingCharges: 500, redeemableCharge: 100 },
    });
    expect(p.errors).toEqual([]);
  });

  it.each([0, -5, 1.5, NaN])("rejects non-positive/non-integer points (%s)", (n) => {
    expect(planRedemption({ ...base, pointsToRedeem: n }).errors.length).toBeGreaterThan(0);
  });

  it("rejects a missing key and a bad rate", () => {
    expect(planRedemption({ ...base, idempotencyKey: " " }).errors.length).toBe(1);
    expect(planRedemption({ ...base, bahtPerPoint: 0 }).errors.length).toBe(1);
  });

  it("avoids floating point drift", () => {
    const p = planRedemption({ ...base, pointsBalance: 100, pointsToRedeem: 3, bahtPerPoint: 0.1 });
    expect(p.invoiceAdjustment?.amount).toBe(0.3);
  });
});

describe("planRedemptionReversal", () => {
  it("emits paired opposite events with reversalOf and never deletes", () => {
    const { revEv, revAdj } = reversed();
    expect(revEv).toMatchObject({ type: "redeem_reversal", points: 100, reversalOf: "k1", referenceKey: "k1:reversal" });
    expect(revAdj).toMatchObject({
      type: "points_redemption_reversal",
      amount: -50,
      reversalOf: "k1",
      referenceKey: "k1:reversal",
    });
  });

  it("rejects a second reversal", () => {
    const { ev, adj } = redeemed();
    const r = planRedemptionReversal({ originalPointsEvent: ev, originalAdjustment: adj, reason: "x", alreadyReversedKeys: ["k1"] });
    expect(r.errors.join()).toMatch(/already been reversed/);
    expect(r.pointsEvent).toBeNull();
  });

  it("rejects mismatched reference keys", () => {
    const { ev, adj } = redeemed();
    const r = planRedemptionReversal({
      originalPointsEvent: ev,
      originalAdjustment: { ...adj, referenceKey: "other" },
      reason: "x",
      alreadyReversedKeys: [],
    });
    expect(r.errors.join()).toMatch(/referenceKey/);
  });

  it("rejects mismatched amount-to-points ratio", () => {
    const { ev, adj } = redeemed();
    const r = planRedemptionReversal({
      originalPointsEvent: ev,
      originalAdjustment: { ...adj, amount: 80 },
      reason: "x",
      alreadyReversedKeys: [],
    });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.invoiceAdjustment).toBeNull();
  });

  it("rejects without a reason or with non-redemption originals", () => {
    const { ev, adj } = redeemed();
    expect(
      planRedemptionReversal({ originalPointsEvent: ev, originalAdjustment: adj, reason: "", alreadyReversedKeys: [] }).errors,
    ).toHaveLength(1);
    expect(
      planRedemptionReversal({
        originalPointsEvent: { ...ev, type: "earn", points: 5 },
        originalAdjustment: adj,
        reason: "x",
        alreadyReversedKeys: [],
      }).pointsEvent,
    ).toBeNull();
  });
});

describe("summarizePointsAndDiscounts", () => {
  it("keeps points and discounts in separate totals", () => {
    const { ev, adj, revEv, revAdj } = reversed();
    const earn: PointsEvent = { type: "earn", points: 300, referenceKey: "e1" };
    expect(summarizePointsAndDiscounts([earn, ev, revEv], [adj, revAdj])).toEqual({
      pointsEarned: 300,
      pointsRedeemed: 100,
      pointsReversed: 100,
      pointsBalance: 300,
      bahtDiscountApplied: 50,
      bahtDiscountReversed: 50,
    });
  });

  it("is all zeros when empty", () => {
    expect(summarizePointsAndDiscounts([], []).pointsBalance).toBe(0);
  });
});

describe("findPointsDiscrepancies", () => {
  it("is clean for a redemption and its reversal", () => {
    const { ev, adj, revEv, revAdj } = reversed();
    expect(findPointsDiscrepancies([ev, revEv], [adj, revAdj])).toEqual([]);
  });

  it("flags a redeem event without an adjustment", () => {
    const { ev } = redeemed();
    expect(findPointsDiscrepancies([ev], []).map((d) => d.kind)).toEqual(["redeem_without_adjustment"]);
  });

  it("flags an adjustment without an event", () => {
    const { adj } = redeemed();
    expect(findPointsDiscrepancies([], [adj]).map((d) => d.kind)).toEqual(["adjustment_without_redeem"]);
  });

  it("flags amounts not matching the ratio", () => {
    const { ev, adj } = redeemed();
    expect(findPointsDiscrepancies([ev], [{ ...adj, amount: 99 }]).map((d) => d.kind)).toEqual(["ratio_mismatch"]);
  });

  it("flags a reversal without an original", () => {
    const { revEv, revAdj } = reversed();
    expect(findPointsDiscrepancies([revEv], [revAdj]).map((d) => d.kind)).toEqual(["reversal_without_original"]);
  });

  it("flags half a reversal and duplicate keys", () => {
    const { ev, adj, revEv } = reversed();
    expect(findPointsDiscrepancies([ev, revEv], [adj]).map((d) => d.kind)).toEqual(["reversal_event_without_adjustment"]);
    expect(findPointsDiscrepancies([ev, ev], [adj]).map((d) => d.kind)).toEqual(["duplicate_reference_key"]);
  });
});
