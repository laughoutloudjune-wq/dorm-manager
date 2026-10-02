/** Validation of the CONFIRMED amount/date an admin enters when approving a slip. */

export type ApprovalInput = { amount: unknown; paidAt: unknown };
export type ApprovalParsed =
  | { ok: true; amount: number; paidAtIso: string }
  | { ok: false; error: string };

export const APPROVE_AMOUNT_REQUIRED =
  "กรุณาระบุยอดเงินที่โอนจริงที่ตรวจสอบแล้ว (ต้องมากกว่า 0)";
export const APPROVE_DATE_REQUIRED = "กรุณาระบุวันที่/เวลาที่โอนจริง";

/**
 * amount: positive finite number (2 dp). paidAt: full ISO datetime, or a
 * YYYY-MM-DD date (stored at 12:00 local, as before). Future times rejected.
 */
export function parseSlipApproval(input: ApprovalInput, now: Date = new Date()): ApprovalParsed {
  const raw = typeof input.amount === "string" ? input.amount.replace(/,/g, "").trim() : input.amount;
  const amount = typeof raw === "number" ? raw : raw === "" || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: APPROVE_AMOUNT_REQUIRED };

  const dateText = String(input.paidAt ?? "").trim();
  if (!dateText) return { ok: false, error: APPROVE_DATE_REQUIRED };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T12:00:00`) : new Date(dateText);
  if (Number.isNaN(d.getTime())) return { ok: false, error: APPROVE_DATE_REQUIRED };
  if (d.getTime() > now.getTime() + 24 * 3600 * 1000) {
    return { ok: false, error: "วันที่โอนต้องไม่เป็นวันในอนาคต" };
  }
  return { ok: true, amount: Math.round(amount * 100) / 100, paidAtIso: d.toISOString() };
}
