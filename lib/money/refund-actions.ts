/**
 * Pure helpers for the refund-payout and settlement-correction API
 * (app/api/admin/refunds/actions/route.ts, migration 20261002000650).
 * The database functions are the authority; this only builds payloads and turns their
 * error codes into HTTP statuses and plain Thai messages.
 */

export type RefundActionError = { status: number; message: string };

const MESSAGES: Array<[RegExp, number, string]> = [
  [/^NOT_SETTLED/, 409, "ผู้เช่ายังไม่มีการสรุปยอดย้ายออก จึงยังไม่มียอดคืนเงิน"],
  [/^REFUND_EXCEEDS_DUE/, 409, "จำนวนเงินเกินยอดที่ต้องคืนคงเหลือ"],
  [/^IDEMPOTENCY_CONFLICT/, 409, "คำขอนี้ถูกใช้แล้วกับจำนวนเงินหรือผู้เช่าอื่น กรุณารีเฟรชแล้วลองใหม่"],
  [/^ALREADY_VOIDED/, 409, "รายการนี้ถูกยกเลิกไปแล้ว"],
  [/^REASON_REQUIRED/, 400, "ต้องระบุเหตุผล"],
  [/^PAID_AT_IN_FUTURE/, 400, "วันเวลาที่จ่ายต้องไม่เกินเวลาปัจจุบัน"],
  [/^INVALID_PAYLOAD/, 400, "ข้อมูลไม่ครบหรือไม่ถูกต้อง"],
  [/^TENANT_NOT_FOUND|^PAYOUT_NOT_FOUND|^SETTLEMENT_NOT_FOUND/, 404, "ไม่พบรายการที่ระบุ"],
  [/^SETTLEMENT_HAS_PAYOUT/, 409, "มีการจ่ายเงินคืนไปแล้ว ต้องยกเลิกรายการจ่ายเงินคืนก่อน จึงจะยกเลิกการสรุปยอดได้"],
  [/^ROOM_REOCCUPIED/, 409, "ห้องนี้มีผู้เช่าใหม่เข้าอยู่แล้ว จึงยกเลิกการสรุปยอดไม่ได้"],
  [/^TENANT_STATE_CHANGED/, 409, "สถานะผู้เช่าเปลี่ยนไปหลังสรุปยอด จึงยกเลิกอัตโนมัติไม่ได้"],
  [/^FINAL_INVOICE_HAS_PAYMENTS/, 409, "ใบแจ้งหนี้ปิดยอดมีการชำระเงินแล้ว จึงยกเลิกการสรุปยอดไม่ได้"],
  [/^SETTLEMENT_VOID_WOULD_MAKE_NEGATIVE/, 409, "การยกเลิกจะทำให้ยอดชำระของบิลเก่าติดลบ กรุณาตรวจสอบก่อน"],
  [/^LATER_ACTIVITY/, 409, "หลังการสรุปยอดนี้มีรายการใหม่เกิดขึ้นแล้ว จึงยกเลิกอัตโนมัติไม่ได้ เพราะจะทับข้อมูลใหม่"],
  [/^BEFORE_STATE_MISSING/, 409, "การสรุปยอดนี้ไม่ได้บันทึกสถานะก่อนสรุปยอดไว้ จึงยกเลิกอัตโนมัติไม่ได้ ต้องแก้ไขข้อมูลผู้เช่าด้วยตนเองและบันทึกเหตุผล"],
  [/^CROSS_TENANT_CARRY/, 409, "พบรายการยกยอดข้ามผู้เช่า กรุณาตรวจสอบข้อมูลก่อน"],
  [/^ROOM_UNKNOWN|^BATCH_ALREADY_VOIDED/, 409, "ข้อมูลการสรุปยอดไม่สมบูรณ์ ต้องตรวจสอบด้วยตนเอง"],
];

export function explainRefundError(message: string): RefundActionError {
  const text = String(message ?? "").trim();
  for (const [re, status, th] of MESSAGES) {
    if (re.test(text)) return { status, message: `${th} (${text.split(/\s/)[0]})` };
  }
  return { status: 500, message: text || "เกิดข้อผิดพลาด" };
}

export type SettlementRowInput = {
  id: string;
  tenant_id: string;
  voided_at: string | null;
};

export type TenantRefundTotals = { due: number; paid: number; livePayouts: number };

/**
 * refund_due_vs_paid is per TENANT, not per settlement. A tenant can have several settlements over time (earlier ones voided),
 * so only the live settlement carries the tenant's refund figures; voided rows get null and show a dash. The figures are
 * returned under `tenantRefund` so the UI can label them as tenant-level.
 */
export function tenantRefundForSettlement(row: SettlementRowInput, totals: TenantRefundTotals | undefined): TenantRefundTotals | null {
  if (row.voided_at) return null;
  return totals ?? { due: 0, paid: 0, livePayouts: 0 };
}

export type RefundPayoutInput = {
  tenantId?: unknown;
  amount?: unknown;
  paidAt?: unknown;
  method?: unknown;
  recipient?: unknown;
  reference?: unknown;
  evidenceUrl?: unknown;
  idempotencyKey?: unknown;
};

/** Builds the record_refund_payout payload. The database re-validates everything. */
export function buildRefundPayoutPayload(input: RefundPayoutInput, actor: string) {
  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
  return {
    tenant_id: String(input.tenantId ?? ""),
    amount: Number.isFinite(amount) ? amount : null,
    paid_at: String(input.paidAt ?? ""),
    method: String(input.method ?? ""),
    recipient: String(input.recipient ?? ""),
    reference: input.reference == null ? "" : String(input.reference),
    evidence_url: input.evidenceUrl == null ? null : String(input.evidenceUrl),
    idempotency_key: String(input.idempotencyKey ?? ""),
    actor,
  };
}
