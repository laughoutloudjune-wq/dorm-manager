/**
 * Points redemption planning — pure arithmetic, no database.
 *
 * Redeeming points is ONE business fact written to two places: a points event
 * (points go down) and an invoice adjustment (the bill goes down). Both sides
 * carry the SAME referenceKey so they can be written atomically, replayed
 * safely, reversed as a pair, and reconciled afterwards.
 *
 * Rules:
 *  - Points are whole numbers; the discount is points x bahtPerPoint.
 *  - A discount never exceeds the redeemable charge (rent/utilities only —
 *    late fees are not discountable) nor the invoice's outstanding charges.
 *  - A referenceKey that already exists is a replay: no new events.
 *  - Reversal is a new pair of opposite events; nothing is ever deleted.
 *  - Discounts are kept apart from cash received; they are never summed with it.
 *
 * Amounts are worked in whole satang (integers) so sums never drift.
 */

export type PointsEventType = "earn" | "redeem" | "redeem_reversal";
export type InvoiceAdjustmentType = "points_redemption" | "points_redemption_reversal";

export type PointsEvent = {
  type: PointsEventType;
  /** Signed: negative for redeem, positive for earn and redeem_reversal. */
  points: number;
  referenceKey: string;
  /** Set on reversals: the referenceKey of the redemption being reversed. */
  reversalOf?: string;
  /** Conversion rate frozen at redemption time. */
  bahtPerPoint?: number;
  reason?: string;
};

export type InvoiceAdjustment = {
  type: InvoiceAdjustmentType;
  /** Signed baht: positive discount for a redemption, negative for its reversal. */
  amount: number;
  referenceKey: string;
  reversalOf?: string;
  bahtPerPoint?: number;
  reason?: string;
};

export type RedemptionPlan = {
  /** True when the idempotency key was already used: nothing new to write. */
  replay: boolean;
  pointsEvent: PointsEvent | null;
  invoiceAdjustment: InvoiceAdjustment | null;
  errors: string[];
};

const toSatang = (baht: number) => Math.round((Number.isFinite(baht) ? baht : 0) * 100);
const toBaht = (satang: number) => satang / 100;
const discountFor = (points: number, bahtPerPoint: number) => toSatang(points * bahtPerPoint);

const rejected = (...errors: string[]): RedemptionPlan => ({
  replay: false,
  pointsEvent: null,
  invoiceAdjustment: null,
  errors,
});

export function planRedemption(input: {
  pointsBalance: number;
  pointsToRedeem: number;
  bahtPerPoint: number;
  invoice: {
    id: string;
    /** Everything still owed on the invoice, including late fees. */
    outstandingCharges: number;
    /** Part of the invoice a discount may touch: rent and utilities only. */
    redeemableCharge: number;
  };
  idempotencyKey: string;
  existingKeys: Iterable<string>;
}): RedemptionPlan {
  const key = (input.idempotencyKey ?? "").trim();
  if (!key) return rejected("An idempotency key is required.");

  // Replay comes first: a retried request must succeed quietly, not fail on
  // "balance too low" because the first attempt already spent the points.
  if (new Set(input.existingKeys).has(key)) {
    return { replay: true, pointsEvent: null, invoiceAdjustment: null, errors: [] };
  }

  const errors: string[] = [];
  const points = input.pointsToRedeem;
  if (!Number.isInteger(points) || points <= 0) errors.push("Points to redeem must be a positive whole number.");
  if (!(Number.isFinite(input.bahtPerPoint) && input.bahtPerPoint > 0)) errors.push("bahtPerPoint must be positive.");
  if (errors.length) return rejected(...errors);

  if (points > input.pointsBalance) {
    errors.push(`Cannot redeem ${points} points; balance is ${input.pointsBalance}.`);
  }

  const discountSatang = discountFor(points, input.bahtPerPoint);
  const redeemable = Math.max(0, toSatang(input.invoice.redeemableCharge));
  const outstanding = Math.max(0, toSatang(input.invoice.outstandingCharges));
  if (discountSatang > redeemable) {
    errors.push(
      `Discount ${toBaht(discountSatang)} exceeds the redeemable charge ${toBaht(redeemable)} (rent/utilities only, not late fees).`,
    );
  }
  if (discountSatang > outstanding) {
    errors.push(`Discount ${toBaht(discountSatang)} exceeds the outstanding charges ${toBaht(outstanding)}.`);
  }
  if (errors.length) return rejected(...errors);

  return {
    replay: false,
    pointsEvent: { type: "redeem", points: -points, referenceKey: key, bahtPerPoint: input.bahtPerPoint },
    invoiceAdjustment: {
      type: "points_redemption",
      amount: toBaht(discountSatang),
      referenceKey: key,
      bahtPerPoint: input.bahtPerPoint,
    },
    errors: [],
  };
}

/** Checks one event/adjustment pair is internally consistent. Returns problems found. */
function pairProblems(event: PointsEvent, adj: InvoiceAdjustment): string[] {
  const problems: string[] = [];
  if (event.referenceKey !== adj.referenceKey) {
    problems.push(`referenceKey differs: ${event.referenceKey} vs ${adj.referenceKey}.`);
  }
  if (event.bahtPerPoint !== undefined && adj.bahtPerPoint !== undefined && event.bahtPerPoint !== adj.bahtPerPoint) {
    problems.push("The two sides recorded different baht-per-point rates.");
  }
  const rate = event.bahtPerPoint ?? adj.bahtPerPoint;
  const pointsAbs = Math.abs(event.points);
  const amountSatang = Math.abs(toSatang(adj.amount));
  if (rate !== undefined) {
    const expected = discountFor(pointsAbs, rate);
    if (expected !== amountSatang) {
      problems.push(
        `${pointsAbs} points at ${rate} baht/point should be ${toBaht(expected)}, not ${Math.abs(adj.amount)}.`,
      );
    }
  } else if (pointsAbs === 0 || amountSatang === 0) {
    problems.push("Points or amount is zero.");
  }
  return problems;
}

export function planRedemptionReversal(input: {
  originalPointsEvent: PointsEvent;
  originalAdjustment: InvoiceAdjustment;
  reason: string;
  alreadyReversedKeys: Iterable<string>;
}): RedemptionPlan {
  const ev = input.originalPointsEvent;
  const adj = input.originalAdjustment;
  const errors: string[] = [];

  if (!(input.reason ?? "").trim()) errors.push("A reversal reason is required.");
  if (ev.type !== "redeem" || !(ev.points < 0)) errors.push("Original points event is not a redemption.");
  if (adj.type !== "points_redemption" || !(adj.amount > 0)) {
    errors.push("Original adjustment is not a points redemption discount.");
  }
  if (errors.length) return rejected(...errors);

  errors.push(...pairProblems(ev, adj));
  if (errors.length) return rejected(...errors);

  const key = ev.referenceKey;
  if (new Set(input.alreadyReversedKeys).has(key)) {
    return rejected(`Redemption ${key} has already been reversed.`);
  }

  const reversalKey = `${key}:reversal`;
  const reason = input.reason.trim();
  const bahtPerPoint = ev.bahtPerPoint ?? adj.bahtPerPoint;
  return {
    replay: false,
    pointsEvent: {
      type: "redeem_reversal",
      points: Math.abs(ev.points),
      referenceKey: reversalKey,
      reversalOf: key,
      bahtPerPoint,
      reason,
    },
    invoiceAdjustment: {
      type: "points_redemption_reversal",
      amount: -Math.abs(adj.amount),
      referenceKey: reversalKey,
      reversalOf: key,
      bahtPerPoint,
      reason,
    },
    errors: [],
  };
}

export type PointsDiscountSummary = {
  pointsEarned: number;
  pointsRedeemed: number;
  pointsReversed: number;
  pointsBalance: number;
  bahtDiscountApplied: number;
  bahtDiscountReversed: number;
};

/** Points and discount totals, kept separate from each other and from cash received. */
export function summarizePointsAndDiscounts(
  events: PointsEvent[],
  adjustments: InvoiceAdjustment[],
): PointsDiscountSummary {
  let earned = 0;
  let redeemed = 0;
  let reversed = 0;
  for (const e of events) {
    if (e.type === "earn") earned += e.points;
    else if (e.type === "redeem") redeemed += Math.abs(e.points);
    else if (e.type === "redeem_reversal") reversed += Math.abs(e.points);
  }
  let applied = 0;
  let discountReversed = 0;
  for (const a of adjustments) {
    if (a.type === "points_redemption") applied += Math.abs(toSatang(a.amount));
    else if (a.type === "points_redemption_reversal") discountReversed += Math.abs(toSatang(a.amount));
  }
  return {
    pointsEarned: earned,
    pointsRedeemed: redeemed,
    pointsReversed: reversed,
    pointsBalance: earned - redeemed + reversed,
    bahtDiscountApplied: toBaht(applied),
    bahtDiscountReversed: toBaht(discountReversed),
  };
}

export type PointsDiscrepancyKind =
  | "redeem_without_adjustment"
  | "adjustment_without_redeem"
  | "reversal_event_without_adjustment"
  | "reversal_adjustment_without_event"
  | "ratio_mismatch"
  | "reversal_without_original"
  | "duplicate_reference_key";

export type PointsDiscrepancy = {
  kind: PointsDiscrepancyKind;
  referenceKey: string;
  detail: string;
};

export function findPointsDiscrepancies(events: PointsEvent[], adjustments: InvoiceAdjustment[]): PointsDiscrepancy[] {
  const out: PointsDiscrepancy[] = [];
  const add = (kind: PointsDiscrepancyKind, referenceKey: string, detail: string) =>
    out.push({ kind, referenceKey, detail });

  const isRedeemEv = (e: PointsEvent) => e.type === "redeem";
  const isReverseEv = (e: PointsEvent) => e.type === "redeem_reversal";
  const isRedeemAdj = (a: InvoiceAdjustment) => a.type === "points_redemption";
  const isReverseAdj = (a: InvoiceAdjustment) => a.type === "points_redemption_reversal";

  const evByKey = new Map<string, PointsEvent>();
  for (const e of events.filter((x) => isRedeemEv(x) || isReverseEv(x))) {
    if (evByKey.has(e.referenceKey)) add("duplicate_reference_key", e.referenceKey, "Two points events share this key.");
    else evByKey.set(e.referenceKey, e);
  }
  const adjByKey = new Map<string, InvoiceAdjustment>();
  for (const a of adjustments.filter((x) => isRedeemAdj(x) || isReverseAdj(x))) {
    if (adjByKey.has(a.referenceKey)) {
      add("duplicate_reference_key", a.referenceKey, "Two invoice adjustments share this key.");
    } else adjByKey.set(a.referenceKey, a);
  }

  const redeemKeys = new Set(events.filter(isRedeemEv).map((e) => e.referenceKey));

  for (const [key, e] of evByKey) {
    const a = adjByKey.get(key);
    if (!a) {
      add(
        isRedeemEv(e) ? "redeem_without_adjustment" : "reversal_event_without_adjustment",
        key,
        "No invoice adjustment shares this key.",
      );
      continue;
    }
    const kindMatches = isRedeemEv(e) ? isRedeemAdj(a) : isReverseAdj(a);
    if (!kindMatches) {
      add("ratio_mismatch", key, "Points event and invoice adjustment are of opposite kinds.");
      continue;
    }
    for (const p of pairProblems(e, a)) add("ratio_mismatch", key, p);
    if (isReverseEv(e) && (!e.reversalOf || !redeemKeys.has(e.reversalOf))) {
      add(
        "reversal_without_original",
        key,
        `Reversal points to ${e.reversalOf ?? "nothing"}, which is not a recorded redemption.`,
      );
    }
  }
  for (const [key, a] of adjByKey) {
    if (evByKey.has(key)) continue;
    add(
      isRedeemAdj(a) ? "adjustment_without_redeem" : "reversal_adjustment_without_event",
      key,
      "No points event shares this key.",
    );
  }
  return out;
}
