/** Pure helpers for the refund payout / void forms. The API and database re-validate everything. */

export type PayoutForm = {
  amount: string;
  paidAt: string; // datetime-local value, "YYYY-MM-DDTHH:mm" in the browser's zone
  method: string;
  recipient: string;
  reference: string;
  evidenceUrl: string;
};

export type FormErrors = Partial<Record<keyof PayoutForm, string>>;

export const round2 = (v: number) => Math.round(v * 100) / 100;

/** A date as a datetime-local input value (local time). */
export function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function defaultPayoutForm(outstanding: number, recipient: string | null, now: Date = new Date()): PayoutForm {
  return {
    amount: round2(outstanding).toFixed(2),
    paidAt: toLocalInputValue(now),
    method: "",
    recipient: recipient ?? "",
    reference: "",
    evidenceUrl: "",
  };
}

/** True when the string is a plain number with at most 2 decimals. */
export const hasAtMostTwoDecimals = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.trim());

export function validatePayoutForm(form: PayoutForm, outstanding: number, now: Date = new Date()): FormErrors {
  const errors: FormErrors = {};
  const amountText = form.amount.trim();
  const amount = Number(amountText);
  if (!amountText || !hasAtMostTwoDecimals(amountText) || !Number.isFinite(amount) || amount <= 0) {
    errors.amount = "ระบุจำนวนเงินมากกว่า 0 (ทศนิยมไม่เกิน 2 ตำแหน่ง)";
  } else if (round2(amount) > round2(outstanding)) {
    errors.amount = "จำนวนเงินเกินยอดค้างคืน";
  }
  const paid = new Date(form.paidAt);
  if (!form.paidAt || Number.isNaN(paid.getTime())) errors.paidAt = "ระบุวันเวลาที่จ่าย";
  else if (paid.getTime() > now.getTime()) errors.paidAt = "วันเวลาที่จ่ายต้องไม่เกินเวลาปัจจุบัน"; // same rule as the database: nothing after now, no tolerance
  if (!form.method.trim()) errors.method = "ระบุช่องทางการจ่าย";
  if (!form.recipient.trim()) errors.recipient = "ระบุผู้รับ";
  if (!form.reference.trim() && !form.evidenceUrl.trim()) {
    errors.reference = "ระบุเลขอ้างอิงหรือลิงก์หลักฐานอย่างน้อยหนึ่งอย่าง";
  }
  return errors;
}

export const isPayoutFormValid = (form: PayoutForm, outstanding: number, now?: Date) =>
  Object.keys(validatePayoutForm(form, outstanding, now)).length === 0;

export function buildRecordPayoutBody(tenantId: string, form: PayoutForm, idempotencyKey: string) {
  return {
    action: "record_refund_payout" as const,
    tenantId,
    amount: round2(Number(form.amount)),
    paidAt: new Date(form.paidAt).toISOString(),
    method: form.method.trim(),
    recipient: form.recipient.trim(),
    reference: form.reference.trim(),
    evidenceUrl: form.evidenceUrl.trim() || null,
    idempotencyKey,
  };
}

export const isReasonValid = (reason: string) => reason.trim().length > 0;

export function buildVoidPayoutBody(payoutId: string, reason: string) {
  return { action: "void_refund_payout" as const, payoutId, reason: reason.trim() };
}

export function buildVoidSettlementBody(settlementId: string, reason: string) {
  return { action: "void_settlement" as const, settlementId, reason: reason.trim() };
}

/** The settlements list is only requested for a user who is known to hold credits.view (no permission error on an accessible page). */
export const shouldLoadSettlements = (p: { loading: boolean; failed: boolean; canViewCredits: boolean }) =>
  !p.loading && !p.failed && p.canViewCredits;

/** A settlement can only be voided while it is active and no refund payout is live. */
export const canVoidSettlement = (s: { voidedAt: string | null; livePayouts: number }) =>
  !s.voidedAt && s.livePayouts === 0;
