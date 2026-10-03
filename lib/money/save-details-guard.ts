/**
 * Guard for the admin invoice `save_details` action. That action edits an
 * invoice's charges and metadata; it must never be a back door for recording
 * money (paid_amount / payment_history / slip) or for marking an invoice
 * paid/partial. Money is recorded only through the payment allocation path.
 */
import {
  chargesFromInvoiceRow,
  lateFeeLineTotalOf,
  toInvoiceMoneyColumns,
  type InvoiceCharges,
  type InvoiceMoneyColumns,
} from "../invoice-total";
import { toNumber } from "../format";
import { toCarryForwardRows, toChargeFeeRows } from "../invoice-utils";

export const SAVE_DETAILS_ALLOWED_COLUMNS = [
  "issue_date",
  "due_date",
  "start_date",
  "end_date",
  "rent_amount",
  "water_bill",
  "electricity_bill",
  "common_fee",
  "discount_amount",
  "discount_breakdown",
  "late_fee_amount",
  "late_fee_per_day",
  "late_fee_start_date",
  "waived_late_fee_amount",
  "carry_forward_amount",
  "additional_fees_total",
  "additional_fees_breakdown",
  "total_amount",
  "status",
  "notes",
  // Set server-side when status leaves the paid/verifying/cancelled group.
  "locked_late_fee_amount",
] as const;

/** Columns the UI sends along that are silently dropped (and audited). */
export const SAVE_DETAILS_STRIPPED_COLUMNS = ["paid_amount"] as const;

/** Statuses that assert money was received; not settable via save_details. */
export const SAVE_DETAILS_BLOCKED_STATUSES = ["paid", "partial"] as const;

export type SaveDetailsGuardResult =
  | { ok: true; payload: Record<string, unknown>; stripped: Record<string, unknown> }
  | { ok: false; blocked: string[] };

export function guardSaveDetailsPayload(input: Record<string, unknown>): SaveDetailsGuardResult {
  const allowed = new Set<string>(SAVE_DETAILS_ALLOWED_COLUMNS);
  const stripCols = new Set<string>(SAVE_DETAILS_STRIPPED_COLUMNS);
  const payload: Record<string, unknown> = {};
  const stripped: Record<string, unknown> = {};
  const blocked: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (stripCols.has(key)) {
      stripped[key] = value;
    } else if (!allowed.has(key)) {
      blocked.push(key);
    } else if (
      key === "status" &&
      (SAVE_DETAILS_BLOCKED_STATUSES as readonly string[]).includes(String(value))
    ) {
      blocked.push(`status=${String(value)}`);
    } else {
      payload[key] = value;
    }
  }
  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, payload, stripped };
}

// ── Protected lines and server-side money recompute (finding 158) ─────────────
//
// `save_details` used to store whatever money columns and breakdowns the client
// sent. The client rebuilds every line from a short field list, so an ordinary
// edit dropped `late_fee_charge_id` / `covered_from` / `policy_version` /
// `posted_by` from an approved late-fee line (after which `waive_late_fee`
// fails LINE_NOT_FOUND), could re-price it, and could drop a points-redemption
// or move-out-credit discount (points spent / deposit consumed, no discount).
// The helpers below make the server the authority: protected lines are
// re-inserted exactly as stored, and every money column is recomputed through
// the one invoice-total engine on the merged row.

/** Invoices in these statuses cannot be edited through save_details at all. */
export const SAVE_DETAILS_LOCKED_STATUSES = ["paid", "verifying", "cancelled"] as const;

export const SAVE_DETAILS_LOCKED_MESSAGE =
  "ใบแจ้งหนี้นี้ชำระแล้ว รอตรวจสอบสลิป หรือถูกยกเลิกแล้ว จึงแก้ไขรายละเอียดไม่ได้";

export const isSaveDetailsLockedStatus = (status: unknown) =>
  (SAVE_DETAILS_LOCKED_STATUSES as readonly string[]).includes(String(status ?? ""));

/** Discount items written by a money flow, never by the invoice editor. */
export const PROTECTED_DISCOUNT_SOURCES = ["rewards_redemption", "move_out_credit"] as const;

export const isProtectedFeeLine = (row: any) => !!row?.late_fee_charge_id;

export const isProtectedDiscountItem = (row: any) =>
  (PROTECTED_DISCOUNT_SOURCES as readonly string[]).includes(String(row?.source ?? ""));

const lineAmount = (row: any) => toNumber(row?.total_amount ?? row?.amount ?? 0);
const sumLines = (rows: any[]) => rows.reduce((s, r) => s + lineAmount(r), 0);
const asRows = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const round2 = (n: number) => Math.round(n * 100) / 100;
const isLateFeeTyped = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase().startsWith("late_fee");

export type IgnoredProtectedEdit = {
  kind: "late_fee_line" | "discount";
  key: string;
  reason: "edited" | "removed" | "added";
};

/**
 * Re-insert every protected line from `existing` unchanged and drop whatever
 * the client sent in their place. A late-fee line the client sent for the same
 * source as a protected one is treated as the client's lossy copy of it (the
 * editor loses `late_fee_charge_id` when it loads the line) and dropped.
 * Breakdowns absent from `incoming` are left alone (returned undefined).
 */
export function mergeProtectedLines(
  existing: { additional_fees_breakdown?: unknown; discount_breakdown?: unknown },
  incoming: { additional_fees_breakdown?: unknown; discount_breakdown?: unknown },
): {
  additional_fees_breakdown: any[] | undefined;
  discount_breakdown: any[] | undefined;
  ignored: IgnoredProtectedEdit[];
} {
  const ignored: IgnoredProtectedEdit[] = [];

  let fees: any[] | undefined;
  if (incoming.additional_fees_breakdown !== undefined) {
    const kept = asRows(existing.additional_fees_breakdown).filter(isProtectedFeeLine);
    const keptSources = new Set(
      kept.map((r) => String(r.source_invoice_id ?? "")).filter(Boolean),
    );
    const seen = new Set<string>();
    const passed: any[] = [];
    for (const row of asRows(incoming.additional_fees_breakdown)) {
      const chargeId = row?.late_fee_charge_id ? String(row.late_fee_charge_id) : "";
      const sourceId = String(row?.source_invoice_id ?? "");
      const isCopy = !chargeId && isLateFeeTyped(row) && keptSources.has(sourceId);
      if (!chargeId && !isCopy) {
        passed.push(row);
        continue;
      }
      const original = chargeId
        ? kept.find((k) => String(k.late_fee_charge_id) === chargeId)
        : kept.find(
            (k) => String(k.source_invoice_id ?? "") === sourceId && !seen.has(String(k.late_fee_charge_id)),
          ) ?? kept.find((k) => String(k.source_invoice_id ?? "") === sourceId);
      if (!original) {
        ignored.push({ kind: "late_fee_line", key: chargeId, reason: "added" });
        continue;
      }
      seen.add(String(original.late_fee_charge_id));
      if (round2(lineAmount(original)) !== round2(lineAmount(row))) {
        ignored.push({ kind: "late_fee_line", key: String(original.late_fee_charge_id), reason: "edited" });
      }
    }
    for (const k of kept) {
      if (!seen.has(String(k.late_fee_charge_id))) {
        ignored.push({ kind: "late_fee_line", key: String(k.late_fee_charge_id), reason: "removed" });
      }
    }
    fees = [...passed, ...kept];
  }

  let discounts: any[] | undefined;
  if (incoming.discount_breakdown !== undefined) {
    const kept = asRows(existing.discount_breakdown).filter(isProtectedDiscountItem);
    const remaining = [...kept];
    const passed: any[] = [];
    for (const row of asRows(incoming.discount_breakdown)) {
      if (!isProtectedDiscountItem(row)) {
        passed.push(row);
        continue;
      }
      const exact = remaining.findIndex(
        (k) => k.source === row.source && round2(lineAmount(k)) === round2(lineAmount(row)),
      );
      const sameSource = exact >= 0 ? exact : remaining.findIndex((k) => k.source === row.source);
      if (sameSource < 0) {
        ignored.push({ kind: "discount", key: String(row.source), reason: "added" });
        continue;
      }
      if (exact < 0) ignored.push({ kind: "discount", key: String(row.source), reason: "edited" });
      remaining.splice(sameSource, 1);
    }
    for (const k of remaining) {
      ignored.push({ kind: "discount", key: String(k.source), reason: "removed" });
    }
    discounts = [...passed, ...kept];
  }

  return { additional_fees_breakdown: fees, discount_breakdown: discounts, ignored };
}

export type SaveDetailsBeforeRow = {
  rent_amount?: number | null;
  water_bill?: number | null;
  electricity_bill?: number | null;
  common_fee?: number | null;
  late_fee_amount?: number | null;
  additional_fees_total?: number | null;
  additional_fees_breakdown?: unknown;
  carry_forward_amount?: number | null;
  discount_amount?: number | null;
  discount_breakdown?: unknown;
  [key: string]: unknown;
};

/**
 * Merge protected lines into a guarded save_details payload and recompute every
 * stored money column with the invoice-total engine. Client-sent
 * `total_amount` / `late_fee_amount` / `additional_fees_total` /
 * `carry_forward_amount` / `discount_amount` are never stored as sent.
 *
 * The client's `late_fee_amount` is read only for the invoice's OWN penalty
 * (the editable late-fee field): it is unpacked against the client's own
 * late-fee lines by `chargesFromInvoiceRow`, and the merged lines are then
 * counted from the merged breakdown.
 */
export function recomputeSaveDetailsPayload(
  before: SaveDetailsBeforeRow,
  payload: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  charges: InvoiceCharges;
  columns: InvoiceMoneyColumns;
  ignored: IgnoredProtectedEdit[];
} {
  const merged = mergeProtectedLines(before, payload);
  const clientCharges = chargesFromInvoiceRow({ ...before, ...payload } as SaveDetailsBeforeRow);
  const beforeCharges = chargesFromInvoiceRow(before);

  const feeRows = merged.additional_fees_breakdown;
  const discountRows = merged.discount_breakdown;

  const charges: InvoiceCharges = {
    rent: clientCharges.rent,
    water: clientCharges.water,
    electricity: clientCharges.electricity,
    commonFee: clientCharges.commonFee,
    nativeLateFee: "late_fee_amount" in payload ? clientCharges.nativeLateFee : beforeCharges.nativeLateFee,
    lateFeeItems: feeRows ? lateFeeLineTotalOf(feeRows) : beforeCharges.lateFeeItems,
    fees: feeRows ? sumLines(toChargeFeeRows(feeRows)) : beforeCharges.fees,
    carryForward: feeRows ? sumLines(toCarryForwardRows(feeRows)) : beforeCharges.carryForward,
    discount: discountRows ? sumLines(discountRows) : beforeCharges.discount,
  };
  const columns = toInvoiceMoneyColumns(charges);

  const next: Record<string, unknown> = { ...payload, ...columns };
  if (feeRows) next.additional_fees_breakdown = feeRows;
  if (discountRows) next.discount_breakdown = discountRows;
  return { payload: next, charges, columns, ignored: merged.ignored };
}
