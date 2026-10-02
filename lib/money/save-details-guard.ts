/**
 * Guard for the admin invoice `save_details` action. That action edits an
 * invoice's charges and metadata; it must never be a back door for recording
 * money (paid_amount / payment_history / slip) or for marking an invoice
 * paid/partial. Money is recorded only through the payment allocation path.
 */

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
