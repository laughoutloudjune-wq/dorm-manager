import type { SupabaseClient } from "@supabase/supabase-js";
import {
  chargesFromInvoiceRow,
  computeInvoiceTotal,
  toInvoiceMoneyColumns,
  type InvoiceMoneyColumns,
  type InvoiceMoneyRow,
} from "./invoice-total";
import { toBangkokMonth } from "./money/bangkok-date";

/**
 * Tenant rewards/points ledger. Mirrors lib/invoice-ledger.ts conventions:
 * pure calculation helpers up top, DB-touching orchestration functions below
 * with snapshot/revert error handling (no real multi-row transactions available
 * on the Supabase JS client here).
 *
 * A tenant's point balance is always SUM(points) over their non-expired
 * point_ledger_entries rows — never a separate mutable counter — so history
 * stays auditable the same way invoice/payment history does. Likewise there is
 * no stored "streak count" or "milestone reached" flag: both are recomputed
 * from the tenant's paid-invoice history and move_in_date every time
 * syncPointsForTenant runs, keyed for idempotency off a deterministic
 * idempotency_key per fact (e.g. `rent_on_time:<invoiceId>`), so re-running it
 * never double-awards.
 */

export type RewardsConfig = {
  points_per_baht: number;
  ontime_rent_rate_pct: number;
  streak_bonus_points: number;
  streak_length: number;
  referral_bonus_points: number;
  milestone_3mo_points: number;
  milestone_1yr_points: number;
  milestone_1yr_repeats: boolean;
  max_redemption_baht: number;
  max_redemptions_per_month: number;
  point_expiry_months: number;
  /**
   * Rent-payment rewards (on-time + streak) only consider invoices whose
   * billing period (start_date) falls on/after this date, and tenancy
   * milestones (3mo/1yr) only count if the milestone's own achievement date
   * (move_in_date + 3/12/24/... months) falls on/after this date — a program
   * launched mid-tenancy shouldn't retroactively reward months of payments or
   * milestones that predate it. Null means no cutoff (award for full history).
   */
  program_start_date: string | null;
  /**
   * Tenure tiers, based on a tenant's *lifetime earned* points (every positive
   * ledger entry ever, ignoring redemptions/deductions) — not their current
   * spendable balance, so redeeming points never demotes a tenant's tier.
   */
  tier_silver_points: number;
  tier_gold_points: number;
  tier_platinum_points: number;
};

export const DEFAULT_REWARDS_CONFIG: RewardsConfig = {
  points_per_baht: 10,
  ontime_rent_rate_pct: 1,
  streak_bonus_points: 300,
  streak_length: 3,
  referral_bonus_points: 1500,
  milestone_3mo_points: 500,
  milestone_1yr_points: 1750,
  milestone_1yr_repeats: true,
  max_redemption_baht: 300,
  max_redemptions_per_month: 1,
  point_expiry_months: 12,
  program_start_date: null,
  tier_silver_points: 3000,
  tier_gold_points: 5000,
  tier_platinum_points: 10000,
};

export type TenantTier = "none" | "silver" | "gold" | "platinum";

/** Tier is based on lifetime earned points, so spending points never demotes a tenant. */
export const resolveTier = (lifetimeEarnedPoints: number, config: RewardsConfig): TenantTier => {
  if (lifetimeEarnedPoints >= config.tier_platinum_points) return "platinum";
  if (lifetimeEarnedPoints >= config.tier_gold_points) return "gold";
  if (lifetimeEarnedPoints >= config.tier_silver_points) return "silver";
  return "none";
};

export type CouponOption = { cost: number; value: number };

/**
 * Fixed-cost redemption coupons (shopping-app style), derived from the
 * existing per-redemption cap rather than a separate hardcoded config: the
 * rent coupon costs exactly enough points to redeem the full cap, and the
 * utility coupon is half that (both cost and value) — so an admin tuning
 * `max_redemption_baht` or `points_per_baht` scales both coupons together.
 */
export const couponCosts = (config: RewardsConfig): { rent: CouponOption; utility: CouponOption } => {
  const rentValue = config.max_redemption_baht;
  const rentCost = Math.round(rentValue * config.points_per_baht);
  const utilityValue = Math.round((rentValue / 2) * 100) / 100;
  const utilityCost = Math.round(rentCost / 2);
  return {
    rent: { cost: rentCost, value: rentValue },
    utility: { cost: utilityCost, value: utilityValue },
  };
};

const isDateOnlyString = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const normalizeRewardsConfig = (raw: any): RewardsConfig => {
  const base = { ...DEFAULT_REWARDS_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  for (const key of Object.keys(base) as (keyof RewardsConfig)[]) {
    const value = raw[key];
    if (key === "program_start_date") {
      if (value === null || isDateOnlyString(value)) base.program_start_date = value;
    } else if (typeof base[key] === "boolean") {
      if (typeof value === "boolean") (base as any)[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      (base as any)[key] = value;
    }
  }
  return base;
};

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const toDateOnly = (value: string) => {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

// ── Pure calculation helpers ──────────────────────────────────────────────────

/**
 * Points earned for an on-time payment, based on the invoice's full total
 * (rent + utilities + common fee + other fees, after discounts) — not just
 * the base rent line item — since the tenant is being rewarded for paying
 * the whole bill on time, not only the rent portion of it.
 */
export const pointsForRentPayment = (totalAmount: number, config: RewardsConfig) =>
  Math.floor(toNumber(totalAmount) * (config.ontime_rent_rate_pct / 100) * config.points_per_baht);

export const bahtEquivalent = (points: number, config: RewardsConfig) =>
  Math.round((toNumber(points) / config.points_per_baht) * 100) / 100;

export type LedgerInvoiceLike = {
  id: string;
  due_date: string;
  status: string | null;
  payment_history: any[] | null;
  start_date?: string | null;
};

/** True when dateText is on/after programStartDate, or always true when there's no cutoff configured. */
export const isOnOrAfterProgramStart = (dateText: string, programStartDate: string | null) => {
  if (!programStartDate) return true;
  return toDateOnly(dateText) >= toDateOnly(programStartDate);
};

/**
 * Rent-payment rewards only apply to invoices whose billing period starts
 * on/after the program's launch date — a program that starts mid-tenancy
 * shouldn't retroactively reward months of payments made before it existed.
 * No cutoff (keeps every invoice) when programStartDate is null/unset.
 */
export const isInvoiceWithinProgram = (
  invoice: Pick<LedgerInvoiceLike, "start_date">,
  programStartDate: string | null,
) => {
  if (!invoice.start_date) return true;
  return isOnOrAfterProgramStart(invoice.start_date, programStartDate);
};

/** Adds `months` calendar months to a YYYY-MM-DD date-only string, returned in the same format. */
export const addMonthsToDate = (dateText: string, months: number) => {
  const base = toDateOnly(dateText);
  const next = new Date(base.getFullYear(), base.getMonth() + months, base.getDate());
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, "0");
  const d = String(next.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/** Last payment_history entry's paid_at (date-only) compared against due_date. */
export const isPaymentOnTime = (invoice: Pick<LedgerInvoiceLike, "due_date" | "payment_history">) => {
  const history = Array.isArray(invoice.payment_history) ? invoice.payment_history : [];
  if (history.length === 0) return false;
  const latest = [...history].sort(
    (a, b) => new Date(b.paid_at || b.created_at).getTime() - new Date(a.paid_at || a.created_at).getTime(),
  )[0];
  const paidAtText = String(latest?.paid_at || latest?.created_at || "");
  if (!paidAtText) return false;
  return toDateOnly(paidAtText.slice(0, 10)) <= toDateOnly(invoice.due_date);
};

/**
 * Walks paid invoices oldest-first, tracking a running consecutive-on-time
 * counter that resets to 0 on a late payment. Returns the counter value at
 * each invoice (so callers can find "every 3rd consecutive on-time payment")
 * plus the final streak (the value after the most recent invoice).
 */
export const computeStreakProgression = (paidInvoicesAsc: LedgerInvoiceLike[]) => {
  let streak = 0;
  const progression: { invoiceId: string; streak: number; onTime: boolean }[] = [];
  for (const invoice of paidInvoicesAsc) {
    const onTime = isPaymentOnTime(invoice);
    streak = onTime ? streak + 1 : 0;
    progression.push({ invoiceId: invoice.id, streak, onTime });
  }
  return progression;
};

export const computeCurrentStreak = (paidInvoicesAsc: LedgerInvoiceLike[]) => {
  const progression = computeStreakProgression(paidInvoicesAsc);
  return progression.length > 0 ? progression[progression.length - 1].streak : 0;
};

/** Full completed calendar months between two YYYY-MM-DD date-only strings. */
export const monthsBetween = (startDateText: string, asOfDateText: string) => {
  const start = toDateOnly(startDateText);
  const asOf = toDateOnly(asOfDateText);
  if (asOf <= start) return 0;
  let months = (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth());
  if (asOf.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
};

export const hasReachedThreeMonthMilestone = (moveInDateText: string, asOfDateText: string) =>
  monthsBetween(moveInDateText, asOfDateText) >= 3;

/** How many completed 12-month milestones a tenant has reached (capped at 1 if repeats is off). */
export const yearMilestonesReached = (moveInDateText: string, asOfDateText: string, repeats: boolean) => {
  const years = Math.floor(monthsBetween(moveInDateText, asOfDateText) / 12);
  if (years <= 0) return 0;
  return repeats ? years : 1;
};

/**
 * Clamp a requested baht discount against the per-redemption cap and the
 * invoice's redeemable charge (see redeemableChargeFor — rent/utilities only,
 * never the invoice's whole outstanding balance).
 */
export const clampRedemptionBaht = (requestedBaht: number, maxRedemptionBaht: number, redeemableCharge: number) =>
  Math.max(0, Math.min(requestedBaht, maxRedemptionBaht, redeemableCharge));

export type RedemptionTarget = "rent" | "utility";

export type RedeemableInvoiceLike = {
  rent_amount?: number | null;
  water_bill?: number | null;
  electricity_bill?: number | null;
  discount_amount?: number | null;
  paid_amount?: number | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The part of an invoice a points discount may touch. Mirrors the cap in
 * redeem_points_atomic (migration 20261002000700), which re-checks it on the
 * locked row:
 *   - only the coupon's own target: rent for "rent", water + electricity for "utility";
 *   - less every discount already on the invoice;
 *   - less what has been paid, assuming payments covered rent/utilities first,
 *     so a remainder made only of late fees / common fee / other fees / carried
 *     debt is never discountable.
 */
export const redeemableChargeFor = (invoice: RedeemableInvoiceLike, target: RedemptionTarget) => {
  const rent = toNumber(invoice.rent_amount);
  const utilities = toNumber(invoice.water_bill) + toNumber(invoice.electricity_bill);
  const discount = toNumber(invoice.discount_amount);
  const paid = toNumber(invoice.paid_amount);
  const targetRemaining = (target === "rent" ? rent : utilities) - discount;
  const unpaidRedeemable = rent + utilities - discount - paid;
  return Math.max(0, round2(Math.min(targetRemaining, unpaidRedeemable)));
};

/**
 * Whole points actually spent and the baht they buy, after the caps. Points are
 * floored so the discount never exceeds the cap, and the baht is derived from
 * the points (not the other way round) so the pair always matches the rate.
 */
export const planRedemptionAmounts = (
  requestedPoints: number,
  config: Pick<RewardsConfig, "points_per_baht" | "max_redemption_baht">,
  redeemableCharge: number,
) => {
  const ppb = config.points_per_baht;
  if (!(ppb > 0)) return { pointsSpent: 0, bahtApplied: 0 };
  const requested = Math.max(0, Math.floor(toNumber(requestedPoints)));
  const cappedBaht = clampRedemptionBaht(requested / ppb, config.max_redemption_baht, redeemableCharge);
  const pointsSpent = Math.min(requested, Math.floor(cappedBaht * ppb + 1e-9));
  return { pointsSpent, bahtApplied: round2(pointsSpent / ppb) };
};

/**
 * Redemptions that count toward the monthly limit: every 'redemption' row
 * created in the current Asia/Bangkok calendar month, INCLUDING ones later
 * reversed. A reversal is its own 'redemption_reversal' row and never hands the
 * slot back (same rule as redeem_points_atomic).
 */
export const redemptionsUsedThisMonth = (
  history: Pick<PointLedgerRow, "reason" | "created_at">[],
  now: Date = new Date(),
) => {
  const month = toBangkokMonth(now);
  return history.filter((row) => row.reason === "redemption" && toBangkokMonth(row.created_at) === month).length;
};

/** Ids of redemption rows that already have a paired reversal. */
export const reversedRedemptionIds = (history: Pick<PointLedgerRow, "reason" | "reverses_entry_id">[]) =>
  new Set(
    history
      .filter((row) => row.reason === "redemption_reversal" && row.reverses_entry_id)
      .map((row) => String(row.reverses_entry_id)),
  );

/**
 * Points earned, points redeemed (net of reversals) and the baht discount they
 * bought, kept apart. None of these is cash: cash received lives in
 * payment_batches / invoice_payment_allocations and is never summed with them.
 */
export const summarizePointsLedger = (history: Pick<PointLedgerRow, "reason" | "points" | "baht_equivalent">[]) => {
  let pointsEarned = 0;
  let pointsRedeemed = 0;
  let pointsReturned = 0;
  let otherAdjustments = 0;
  let bahtDiscount = 0;
  for (const row of history) {
    const points = toNumber(row.points);
    if (row.reason === "redemption") {
      pointsRedeemed += Math.abs(points);
      bahtDiscount += toNumber(row.baht_equivalent);
    } else if (row.reason === "redemption_reversal") {
      pointsReturned += Math.abs(points);
      bahtDiscount -= toNumber(row.baht_equivalent);
    } else if (row.reason === "manual_adjustment") {
      otherAdjustments += points;
    } else if (points > 0) {
      pointsEarned += points;
    }
  }
  return {
    pointsEarned,
    pointsRedeemedNet: pointsRedeemed - pointsReturned,
    pointsReturned,
    manualAdjustments: otherAdjustments,
    bahtDiscountNet: round2(bahtDiscount),
  };
};

const MONEY_TOLERANCE = 0.005;

const INVOICE_REDEMPTION_COLUMNS =
  "id,tenant_id,status,total_amount,paid_amount,discount_amount,late_fee_amount,additional_fees_total," +
  "additional_fees_breakdown,carry_forward_amount,rent_amount,water_bill,electricity_bill,common_fee";

/** The invoice values a redemption/reversal is computed from (sent as `expected`, checked under lock). */
export const redemptionExpectedColumns = (row: InvoiceMoneyRow & { total_amount?: number | null; paid_amount?: number | null }) => ({
  total_amount: toNumber(row.total_amount),
  discount_amount: toNumber(row.discount_amount),
  paid_amount: toNumber(row.paid_amount),
  late_fee_amount: toNumber(row.late_fee_amount),
  additional_fees_total: toNumber(row.additional_fees_total),
  carry_forward_amount: toNumber(row.carry_forward_amount),
  rent_amount: toNumber(row.rent_amount),
  water_bill: toNumber(row.water_bill),
  electricity_bill: toNumber(row.electricity_bill),
  common_fee: toNumber(row.common_fee),
});

/**
 * New money columns after changing the discount by `discountDelta` (positive
 * for a redemption, negative for its reversal), computed through the invoice
 * engine. Refuses when the stored total already disagrees with the engine:
 * writing a discount on top of a drifted total would bake the drift in.
 */
export const redemptionInvoiceColumns = (
  row: InvoiceMoneyRow & { total_amount?: number | null },
  discountDelta: number,
): InvoiceMoneyColumns => {
  const charges = chargesFromInvoiceRow(row);
  const engineTotal = computeInvoiceTotal(charges);
  if (Math.abs(engineTotal - toNumber(row.total_amount)) > MONEY_TOLERANCE) {
    throw new Error(
      `Invoice total (${toNumber(row.total_amount)}) does not match its charges (${round2(engineTotal)}); re-save the invoice before changing points discounts.`,
    );
  }
  const columns = toInvoiceMoneyColumns({ ...charges, discount: round2(charges.discount + discountDelta) });
  return { ...columns, total_amount: round2(columns.total_amount), discount_amount: round2(columns.discount_amount) };
};

/** Canonical Thai labels for each ledger reason — shared by the admin page, tenant LIFF page, and LINE notifications. */
export const POINTS_REASON_LABELS_TH: Record<string, string> = {
  rent_on_time: "ชำระตรงเวลา",
  streak_bonus: "โบนัสชำระตรงเวลาต่อเนื่อง",
  referral_bonus: "โบนัสแนะนำเพื่อน",
  milestone_3mo: "โบนัสครบ 3 เดือน",
  milestone_1yr: "โบนัสครบ 1 ปี",
  redemption: "แลกคะแนน",
  redemption_reversal: "ยกเลิกการแลกคะแนน (คืนแต้ม)",
  manual_adjustment: "ปรับปรุงคะแนนโดยผู้ดูแล",
};

// ── Orchestration (DB-touching) ───────────────────────────────────────────────

export type PointLedgerRow = {
  id: string;
  tenant_id: string;
  points: number;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  baht_equivalent: number;
  expires_at: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  notes: string | null;
  created_at: string;
  /** Set only on 'redemption_reversal' rows: the redemption they reverse. */
  reverses_entry_id?: string | null;
};

const LEDGER_COLUMNS =
  "id,tenant_id,points,reason,reference_type,reference_id,baht_equivalent,expires_at,idempotency_key,created_by,notes,created_at,reverses_entry_id";

export async function getRewardsConfig(supabase: SupabaseClient): Promise<RewardsConfig> {
  const { data, error } = await supabase.from("settings").select("rewards_config").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeRewardsConfig((data as any)?.rewards_config);
}

export async function getTenantPointBalance(supabase: SupabaseClient, tenantId: string, asOf?: string) {
  const asOfIso = asOf ?? new Date().toISOString();
  const { data, error } = await supabase
    .from("point_ledger_entries")
    .select("points")
    .eq("tenant_id", tenantId)
    .or(`expires_at.is.null,expires_at.gt.${asOfIso}`);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, row: any) => sum + toNumber(row.points), 0);
}

/**
 * Lifetime earned points — sum of every positive ledger entry ever (ignores
 * redemptions/negative adjustments and expiry), used only to resolve a
 * tenant's tier. Unlike getTenantPointBalance, this never decreases, so
 * spending points on a coupon never demotes a tenant's tier.
 */
export async function getTenantLifetimeEarnedPoints(supabase: SupabaseClient, tenantId: string) {
  const { data, error } = await supabase
    .from("point_ledger_entries")
    .select("points")
    .eq("tenant_id", tenantId)
    .gt("points", 0);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, row: any) => sum + toNumber(row.points), 0);
}

export async function listTenantLedger(supabase: SupabaseClient, tenantId: string): Promise<PointLedgerRow[]> {
  const { data, error } = await supabase
    .from("point_ledger_entries")
    .select(LEDGER_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PointLedgerRow[];
}

const expiryFor = (config: RewardsConfig) => {
  if (!config.point_expiry_months || config.point_expiry_months <= 0) return null;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + config.point_expiry_months);
  return expires.toISOString();
};

type UpsertLedgerFactResult = { entry: PointLedgerRow; isNew: boolean; changed: boolean };

/**
 * Insert-or-recompute for a config-driven ledger fact (rent_on_time,
 * streak_bonus, milestone_3mo, milestone_1yr — anything keyed by a
 * deterministic idempotency_key). If the fact was already recorded, its
 * `points`/`baht_equivalent` are recalculated from the *current* config and
 * updated in place when they've drifted — e.g. an admin raising the on-time
 * earning rate or a milestone bonus should be reflected the next time "sync"
 * runs, not frozen forever at whatever the rate was on first award. Only the
 * amount is ever touched; `expires_at`/`created_at` stay as originally set so
 * a recalculation never resets a point's expiry clock.
 */
async function upsertLedgerFact(
  supabase: SupabaseClient,
  entry: Omit<PointLedgerRow, "id" | "created_at" | "expires_at"> & { expires_at?: string | null },
): Promise<UpsertLedgerFactResult | null> {
  const { data: existing, error: existingError } = await supabase
    .from("point_ledger_entries")
    .select(LEDGER_COLUMNS)
    .eq("idempotency_key", entry.idempotency_key)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);

  if (existing) {
    const existingRow = existing as PointLedgerRow;
    if (existingRow.points === entry.points && existingRow.baht_equivalent === entry.baht_equivalent) {
      return { entry: existingRow, isNew: false, changed: false };
    }
    const { data: updated, error: updateError } = await supabase
      .from("point_ledger_entries")
      .update({ points: entry.points, baht_equivalent: entry.baht_equivalent })
      .eq("id", existingRow.id)
      .select(LEDGER_COLUMNS)
      .single();
    if (updateError) throw new Error(updateError.message);
    return { entry: updated as PointLedgerRow, isNew: false, changed: true };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("point_ledger_entries")
    .insert(entry)
    .select(LEDGER_COLUMNS)
    .single();
  // A unique-constraint conflict here means a concurrent call already inserted
  // the same fact between our existence check and this insert — treat it as
  // "already awarded" rather than a failure.
  if (insertError) {
    if (String(insertError.code) === "23505") return null;
    throw new Error(insertError.message);
  }
  return { entry: inserted as PointLedgerRow, isNew: true, changed: false };
}

export type SyncPointsResult = {
  awardedEntries: PointLedgerRow[];
  adjustedEntries: PointLedgerRow[];
  revokedEntries: PointLedgerRow[];
};

/**
 * Payment-derived reasons are the only ones sync is allowed to take back — see
 * the revocation step at the end of syncPointsForTenant. Redemptions, referrals,
 * manual adjustments and tenancy milestones are never auto-removed.
 */
const REVOCABLE_REASONS = ["rent_on_time", "streak_bonus"];

export async function syncPointsForTenant(
  supabase: SupabaseClient,
  tenantId: string,
  config?: RewardsConfig,
): Promise<SyncPointsResult> {
  const cfg = config ?? (await getRewardsConfig(supabase));
  const awardedEntries: PointLedgerRow[] = [];
  const adjustedEntries: PointLedgerRow[] = [];
  const revokedEntries: PointLedgerRow[] = [];
  // Every payment-derived fact that still qualifies on this run. Anything the
  // tenant holds under a REVOCABLE_REASONS key that isn't in here has stopped
  // qualifying and gets removed by the revocation step below.
  const expectedKeys = new Set<string>();

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id,move_in_date,move_out_date,status")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw new Error(tenantError.message);
  if (!tenant) return { awardedEntries, adjustedEntries, revokedEntries };

  const { data: paidInvoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id,due_date,start_date,total_amount,status,payment_history")
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .order("due_date", { ascending: true });
  if (invoicesError) throw new Error(invoicesError.message);

  // Rent-payment rewards (on-time + streak) only look at invoices from the
  // program's launch date onward — a program launched mid-tenancy doesn't
  // retroactively reward months of payments that predate it. Milestones
  // (below) are unaffected since they're evaluated against real tenancy
  // length, not payment history.
  const invoicesAsc = ((paidInvoices ?? []) as (LedgerInvoiceLike & { total_amount: number })[]).filter((invoice) =>
    isInvoiceWithinProgram(invoice, cfg.program_start_date),
  );

  // 1. On-time rent payment awards, one per qualifying invoice.
  for (const invoice of invoicesAsc) {
    if (!isPaymentOnTime(invoice)) continue;
    const points = pointsForRentPayment(invoice.total_amount, cfg);
    if (points <= 0) continue;
    expectedKeys.add(`rent_on_time:${invoice.id}`);
    const result = await upsertLedgerFact(supabase, {
      tenant_id: tenantId,
      points,
      reason: "rent_on_time",
      reference_type: "invoice",
      reference_id: invoice.id,
      baht_equivalent: bahtEquivalent(points, cfg),
      idempotency_key: `rent_on_time:${invoice.id}`,
      created_by: null,
      notes: null,
      expires_at: expiryFor(cfg),
    });
    if (result?.isNew) awardedEntries.push(result.entry);
    else if (result?.changed) adjustedEntries.push(result.entry);
  }

  // 2. Streak bonus every Nth consecutive on-time payment (resets on any late one).
  const progression = computeStreakProgression(invoicesAsc);
  for (const step of progression) {
    if (step.streak > 0 && step.streak % cfg.streak_length === 0) {
      expectedKeys.add(`streak_bonus:${step.invoiceId}`);
      const result = await upsertLedgerFact(supabase, {
        tenant_id: tenantId,
        points: cfg.streak_bonus_points,
        reason: "streak_bonus",
        reference_type: "invoice",
        reference_id: step.invoiceId,
        baht_equivalent: bahtEquivalent(cfg.streak_bonus_points, cfg),
        idempotency_key: `streak_bonus:${step.invoiceId}`,
        created_by: null,
        notes: null,
        expires_at: expiryFor(cfg),
      });
      if (result?.isNew) awardedEntries.push(result.entry);
      else if (result?.changed) adjustedEntries.push(result.entry);
    }
  }

  // 3. Tenancy milestones, computed against move_out_date if the tenant has
  // already left (so time after moving out never counts), otherwise today.
  // Each milestone's own achievement date (move_in_date + 3/12/24/... months)
  // must also fall on/after the program's launch — a milestone a tenant
  // already passed before the program existed doesn't retroactively count,
  // same reasoning as gating rent_on_time/streak by invoice start_date above.
  if (tenant.move_in_date) {
    const asOf = (tenant.move_out_date as string | null) ?? new Date().toISOString().slice(0, 10);
    const threeMoDate = addMonthsToDate(tenant.move_in_date, 3);
    if (
      hasReachedThreeMonthMilestone(tenant.move_in_date, asOf) &&
      isOnOrAfterProgramStart(threeMoDate, cfg.program_start_date)
    ) {
      const result = await upsertLedgerFact(supabase, {
        tenant_id: tenantId,
        points: cfg.milestone_3mo_points,
        reason: "milestone_3mo",
        reference_type: "tenant",
        reference_id: tenantId,
        baht_equivalent: bahtEquivalent(cfg.milestone_3mo_points, cfg),
        idempotency_key: `milestone_3mo:${tenantId}`,
        created_by: null,
        notes: null,
        expires_at: expiryFor(cfg),
      });
      if (result?.isNew) awardedEntries.push(result.entry);
      else if (result?.changed) adjustedEntries.push(result.entry);
    }

    const yearsReached = yearMilestonesReached(tenant.move_in_date, asOf, cfg.milestone_1yr_repeats);
    for (let year = 1; year <= yearsReached; year += 1) {
      const yearDate = addMonthsToDate(tenant.move_in_date, year * 12);
      if (!isOnOrAfterProgramStart(yearDate, cfg.program_start_date)) continue;
      const result = await upsertLedgerFact(supabase, {
        tenant_id: tenantId,
        points: cfg.milestone_1yr_points,
        reason: "milestone_1yr",
        reference_type: "tenant",
        reference_id: tenantId,
        baht_equivalent: bahtEquivalent(cfg.milestone_1yr_points, cfg),
        idempotency_key: `milestone_1yr:${tenantId}:${year}`,
        created_by: null,
        notes: `Year ${year}`,
        expires_at: expiryFor(cfg),
      });
      if (result?.isNew) awardedEntries.push(result.entry);
      else if (result?.changed) adjustedEntries.push(result.entry);
    }
  }

  // 4. Revoke payment-derived awards that no longer qualify. The award loops
  // above only `continue` past an invoice that fails isPaymentOnTime, so
  // without this a point once granted could never be taken back: correcting a
  // wrong due_date, re-dating a payment, un-paying an invoice or moving
  // program_start_date forward would all leave the stale award standing
  // forever, and re-running sync would never notice. Scoped to
  // REVOCABLE_REASONS so redemptions, referrals, manual adjustments and
  // milestones are never touched — a tenant must not silently lose points they
  // spent or an admin granted by hand.
  const { data: existingAwards, error: existingAwardsError } = await supabase
    .from("point_ledger_entries")
    .select(LEDGER_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("reason", REVOCABLE_REASONS);
  if (existingAwardsError) throw new Error(existingAwardsError.message);

  const staleAwards = ((existingAwards ?? []) as PointLedgerRow[]).filter(
    (row) => !row.idempotency_key || !expectedKeys.has(row.idempotency_key),
  );
  if (staleAwards.length > 0) {
    const { error: revokeError } = await supabase
      .from("point_ledger_entries")
      .delete()
      .in(
        "id",
        staleAwards.map((row) => row.id),
      );
    if (revokeError) throw new Error(revokeError.message);
    revokedEntries.push(...staleAwards);
  }

  return { awardedEntries, adjustedEntries, revokedEntries };
}

const OPEN_FOR_REDEMPTION_STATUSES = ["pending", "overdue", "partial"];

export type RedeemPointsOptions = {
  tenantId: string;
  invoiceId: string;
  target: RedemptionTarget;
  pointsToRedeem: number;
  /**
   * REQUIRED. One key per redemption attempt, reused on retry: a repeated key
   * replays the original redemption instead of spending points twice. It is
   * stored on both the ledger row and the invoice adjustment.
   */
  idempotencyKey: string;
  createdBy?: string | null;
  actor?: string | null;
};

export type RedeemPointsResult = {
  pointsSpent: number;
  bahtApplied: number;
  updatedInvoice: any;
  ledgerEntry: PointLedgerRow;
  /** True when the key had already been used: nothing new was written. */
  replay: boolean;
};

/** Strip the Postgres error prefix codes the functions raise, keeping the human message. */
const rpcErrorMessage = (message: string) => message.replace(/^[A-Z_]+:\s*/, "");

/**
 * Redeem points against an open invoice: ONE call to redeem_points_atomic,
 * which locks the invoice and the tenant's point rows, re-checks the balance,
 * the monthly limit and the discount cap, and writes the ledger row, the
 * 'points_redemption' adjustment, the invoice columns and a money_event in one
 * transaction (or nothing).
 *
 * This side only computes: the discount (rent/utilities only, see
 * redeemableChargeFor) and the invoice's new money columns through the
 * invoice engine. The database rejects the call if the invoice changed since
 * it was read (STALE_INVOICE) or if the columns do not equal old -/+ discount.
 */
export async function redeemPoints(
  supabase: SupabaseClient,
  options: RedeemPointsOptions,
  config?: RewardsConfig,
): Promise<RedeemPointsResult> {
  const { tenantId, invoiceId, target, pointsToRedeem } = options;
  const key = String(options.idempotencyKey ?? "").trim();
  if (!key) throw new Error("A redemption key is required.");
  if (target !== "rent" && target !== "utility") throw new Error("target must be rent or utility.");
  const cfg = config ?? (await getRewardsConfig(supabase));
  const requestedPoints = Math.max(0, Math.floor(toNumber(pointsToRedeem)));
  if (requestedPoints <= 0) throw new Error("Points to redeem must be greater than zero.");

  // Replay first: a retry must succeed quietly even though the first attempt
  // already used the points/limit/discount room that the checks below look at.
  const { data: existing, error: existingError } = await supabase
    .from("point_ledger_entries")
    .select(LEDGER_COLUMNS)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) {
    const row = existing as PointLedgerRow;
    if (row.tenant_id !== tenantId || row.reason !== "redemption" || row.reference_id !== invoiceId) {
      throw new Error("This redemption key was already used for a different request.");
    }
    const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
    return {
      pointsSpent: Math.abs(toNumber(row.points)),
      bahtApplied: toNumber(row.baht_equivalent),
      updatedInvoice: invoice ?? null,
      ledgerEntry: row,
      replay: true,
    };
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(INVOICE_REDEMPTION_COLUMNS)
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Invoice not found.");
  const row = invoice as any;
  if (String(row.tenant_id) !== tenantId) throw new Error("Invoice does not belong to this tenant.");
  if (!OPEN_FOR_REDEMPTION_STATUSES.includes(String(row.status))) {
    throw new Error("This invoice is not open for redemption.");
  }

  const { pointsSpent, bahtApplied } = planRedemptionAmounts(requestedPoints, cfg, redeemableChargeFor(row, target));
  if (pointsSpent <= 0 || bahtApplied <= 0) throw new Error("Nothing available to redeem against this invoice.");

  const expected = redemptionExpectedColumns(row);
  const next = redemptionInvoiceColumns(row, bahtApplied);

  const { data, error } = await supabase.rpc("redeem_points_atomic", {
    p: {
      tenant_id: tenantId,
      invoice_id: invoiceId,
      target,
      reference_key: key,
      points_to_spend: pointsSpent,
      baht_applied: bahtApplied,
      points_per_baht: cfg.points_per_baht,
      max_redemption_baht: cfg.max_redemption_baht,
      max_redemptions_per_month: cfg.max_redemptions_per_month,
      expected,
      new: {
        total_amount: next.total_amount,
        discount_amount: next.discount_amount,
        late_fee_amount: next.late_fee_amount,
        additional_fees_total: next.additional_fees_total,
        carry_forward_amount: next.carry_forward_amount,
      },
      created_by: options.createdBy ?? null,
      actor: options.actor ?? null,
    },
  });
  if (error) throw new Error(rpcErrorMessage(error.message));
  const result = data as any;
  return {
    pointsSpent: toNumber(result?.points_spent),
    bahtApplied: toNumber(result?.baht_applied),
    updatedInvoice: result?.invoice ?? null,
    ledgerEntry: result?.ledger_entry as PointLedgerRow,
    replay: !!result?.replay,
  };
}

export async function approveReferral(
  supabase: SupabaseClient,
  referralId: string,
  reviewerId: string | null,
  config?: RewardsConfig,
) {
  const cfg = config ?? (await getRewardsConfig(supabase));
  const { data: referral, error: referralError } = await supabase
    .from("tenant_referrals")
    .select("id,referrer_tenant_id,new_tenant_id,status")
    .eq("id", referralId)
    .single();
  if (referralError || !referral) throw new Error(referralError?.message ?? "Referral not found.");
  if (String((referral as any).status) !== "pending_approval") {
    throw new Error("Referral has already been reviewed.");
  }

  const { error: updateError } = await supabase
    .from("tenant_referrals")
    .update({ status: "approved", reviewed_at: new Date().toISOString(), reviewed_by: reviewerId })
    .eq("id", referralId);
  if (updateError) throw new Error(updateError.message);

  try {
    const { data: ledgerEntry, error: ledgerError } = await supabase
      .from("point_ledger_entries")
      .insert({
        tenant_id: (referral as any).referrer_tenant_id,
        points: cfg.referral_bonus_points,
        reason: "referral_bonus",
        reference_type: "tenant_referral",
        reference_id: referralId,
        baht_equivalent: bahtEquivalent(cfg.referral_bonus_points, cfg),
        expires_at: expiryFor(cfg),
        idempotency_key: `referral_bonus:${referralId}`,
        created_by: reviewerId,
        notes: null,
      })
      .select(LEDGER_COLUMNS)
      .single();
    if (ledgerError) throw new Error(ledgerError.message);
    return ledgerEntry as PointLedgerRow;
  } catch (err) {
    const { error: revertError } = await supabase
      .from("tenant_referrals")
      .update({ status: "pending_approval", reviewed_at: null, reviewed_by: null })
      .eq("id", referralId);
    if (revertError) {
      console.error("[points-ledger] Failed to revert referral after approval error:", referralId, revertError);
    }
    throw err;
  }
}

export async function rejectReferral(supabase: SupabaseClient, referralId: string, reviewerId: string | null) {
  const { data: referral, error: referralError } = await supabase
    .from("tenant_referrals")
    .select("id,status")
    .eq("id", referralId)
    .single();
  if (referralError || !referral) throw new Error(referralError?.message ?? "Referral not found.");
  if (String((referral as any).status) !== "pending_approval") {
    throw new Error("Referral has already been reviewed.");
  }
  const { error: updateError } = await supabase
    .from("tenant_referrals")
    .update({ status: "rejected", reviewed_at: new Date().toISOString(), reviewed_by: reviewerId })
    .eq("id", referralId);
  if (updateError) throw new Error(updateError.message);
}

export async function manualAdjustPoints(
  supabase: SupabaseClient,
  options: { tenantId: string; points: number; notes: string; createdBy: string | null },
  config?: RewardsConfig,
) {
  const cfg = config ?? (await getRewardsConfig(supabase));
  const points = Math.trunc(toNumber(options.points));
  if (points === 0) throw new Error("Adjustment must be a non-zero number of points.");
  const { data: ledgerEntry, error } = await supabase
    .from("point_ledger_entries")
    .insert({
      tenant_id: options.tenantId,
      points,
      reason: "manual_adjustment",
      reference_type: null,
      reference_id: null,
      baht_equivalent: bahtEquivalent(points, cfg),
      expires_at: points > 0 ? expiryFor(cfg) : null,
      idempotency_key: null,
      created_by: options.createdBy,
      notes: options.notes || null,
    })
    .select(LEDGER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return ledgerEntry as PointLedgerRow;
}

export type ReverseRedemptionOptions = {
  entryId: string;
  /** REQUIRED: why the redemption is being undone (kept on both reversal rows). */
  reason: string;
  createdBy?: string | null;
  actor?: string | null;
};

export type ReverseRedemptionResult = {
  originalEntry: PointLedgerRow;
  reversalEntry: PointLedgerRow;
  updatedInvoice: any;
  pointsReturned: number;
  bahtRestored: number;
};

/**
 * Undo a redemption as a PAIR of new rows through reverse_points_redemption:
 * a '+points' 'redemption_reversal' ledger row and a negative adjustment, both
 * linked to the originals under '<key>:reversal', plus the invoice's discount
 * removed (columns computed through the invoice engine). Nothing is deleted,
 * a redemption can be reversed once, and the monthly-limit slot it used stays
 * used (see redemptionsUsedThisMonth).
 */
export async function reverseRedemption(
  supabase: SupabaseClient,
  options: ReverseRedemptionOptions,
): Promise<ReverseRedemptionResult> {
  const reason = String(options.reason ?? "").trim();
  if (!reason) throw new Error("A reason is required to reverse a redemption.");

  const { data: entry, error: fetchError } = await supabase
    .from("point_ledger_entries")
    .select(LEDGER_COLUMNS)
    .eq("id", options.entryId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!entry) throw new Error("Ledger entry not found.");
  const original = entry as PointLedgerRow;
  if (original.reason !== "redemption") throw new Error("Only redemption entries can be reversed.");
  if (original.reference_type !== "invoice" || !original.reference_id) {
    throw new Error("Redemption has no invoice to restore.");
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(INVOICE_REDEMPTION_COLUMNS)
    .eq("id", original.reference_id)
    .single();
  if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Invoice not found.");

  const baht = toNumber(original.baht_equivalent);
  const expected = redemptionExpectedColumns(invoice as any);
  const next = redemptionInvoiceColumns(invoice as any, -baht);

  const { data, error } = await supabase.rpc("reverse_points_redemption", {
    p: {
      entry_id: original.id,
      reason,
      expected,
      new: {
        total_amount: next.total_amount,
        discount_amount: next.discount_amount,
        late_fee_amount: next.late_fee_amount,
        additional_fees_total: next.additional_fees_total,
        carry_forward_amount: next.carry_forward_amount,
      },
      created_by: options.createdBy ?? null,
      actor: options.actor ?? null,
    },
  });
  if (error) throw new Error(rpcErrorMessage(error.message));
  const result = data as any;
  return {
    originalEntry: result?.original_entry as PointLedgerRow,
    reversalEntry: result?.reversal_entry as PointLedgerRow,
    updatedInvoice: result?.invoice ?? null,
    pointsReturned: toNumber(result?.points_returned),
    bahtRestored: toNumber(result?.baht_restored),
  };
}

/**
 * Kept for existing callers. A redemption is never deleted any more: this posts
 * the paired reversal (points back AND discount removed) via reverseRedemption,
 * and returns the ORIGINAL entry as before.
 */
export async function deleteRedemption(
  supabase: SupabaseClient,
  entryId: string,
  options: { reason: string; createdBy?: string | null; actor?: string | null },
) {
  const result = await reverseRedemption(supabase, { entryId, ...options });
  return result.originalEntry;
}
