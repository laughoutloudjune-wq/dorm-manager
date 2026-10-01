/**
 * Plain-Thai explanations for the error / blocker / warning codes the new
 * move-out actions return (unlock_room, prepare_move_out_bill,
 * get_settlement_preview, settle_move_out, mark_refund_paid in
 * app/api/admin/tenants/actions/route.ts). Each says what is wrong and what
 * the admin should do about it. Pure — no React, no database.
 */

export type MoveOutIssue = { code: string; message?: string | null };

const MOVE_OUT_ISSUE_TEXT: Record<string, string> = {
  already_settled: "สรุปยอดย้ายออกของผู้เช่ารายนี้เรียบร้อยแล้ว ไม่ต้องทำซ้ำ",
  not_unlocked:
    "ยังไม่ได้ปลดล็อกห้อง — ไปที่ขั้นตอน “ปลดล็อกห้อง” ระบุวันที่คืนกุญแจ แล้วกดปลดล็อกก่อน",
  no_move_out_bill:
    "ยังไม่มีบิลย้ายออก — ไปที่ขั้นตอน “บิลย้ายออก” กรอกเลขมิเตอร์วันคืนกุญแจ แล้วกด “สร้างบิลย้ายออก”",
  bad_state:
    "ข้อมูลบิลย้ายออกผิดปกติ (เช่น มีบิลย้ายออกมากกว่า 1 ใบ บิลถูกปิดแบบไม่ชำระ หรือห้องไม่มีค่าเช่า) — ตรวจสอบที่หน้าใบแจ้งหนี้หรือข้อมูลห้อง",
  slip_pending:
    "มีสลิปของผู้เช่ารายนี้รอตรวจสอบ — อนุมัติหรือปฏิเสธสลิปที่หน้าใบแจ้งหนี้ก่อน แล้วค่อยสรุปยอด",
  unsent_monthly_draft:
    "มีบิลรายเดือนฉบับร่างที่ยังไม่ได้ส่ง — ส่งหรือยกเลิกบิลร่างนั้นที่หน้าใบแจ้งหนี้ก่อน ไม่อย่างนั้นค่าเช่าช่วงเดียวกันจะถูกคิดซ้ำ",
  room_transfer:
    "บิลรายเดือนล่าสุดเป็นของห้องอื่น (ผู้เช่าเคยย้ายห้อง) — ระบบสร้างบิลย้ายออกให้อัตโนมัติไม่ได้ ต้องสรุปยอดด้วยตนเอง",
  missing_meter_reading:
    "ไม่พบเลขมิเตอร์ครั้งก่อนของห้องนี้ — บันทึกมิเตอร์ของรอบบิลล่าสุดที่หน้ามิเตอร์ก่อน",
  meter_went_backwards:
    "เลขมิเตอร์ที่กรอกน้อยกว่าเลขครั้งก่อน — ตรวจสอบเลขมิเตอร์วันคืนกุญแจอีกครั้ง",
  move_out_bill_exists:
    "บิลย้ายออกถูกส่งแล้วหรือมีการชำระ/ยกเว้นค่าปรับแล้ว จึงสร้างใหม่ไม่ได้ — แก้ไขที่หน้าใบแจ้งหนี้แทน",
  bad_plan: "ยอดเงินมีการเปลี่ยนแปลงระหว่างดำเนินการ — กด “คำนวณใหม่” แล้วตรวจสอบอีกครั้ง",
  stale_balance: "ยอดเงินมีการเปลี่ยนแปลงระหว่างดำเนินการ — กด “คำนวณใหม่” แล้วตรวจสอบอีกครั้ง",
  over_allocation: "ยอดที่จะหักเกินยอดค้างจริง — กด “คำนวณใหม่” แล้วตรวจสอบอีกครั้ง",
  preview_changed: "ยอดเงินเปลี่ยนไปหลังจากแสดงตัวอย่าง — ตรวจสอบตัวเลขใหม่แล้วยืนยันอีกครั้ง",
  refund_already_paid: "รายการคืนเงินนี้ถูกบันทึกว่าจ่ายแล้ว",
  not_found: "ไม่พบข้อมูลที่ต้องการ — ลองรีเฟรชหน้า",
  bad_request: "ข้อมูลที่ส่งไม่ถูกต้อง",
  // Preview-only warnings (settle still runs).
  monthly_draft:
    "มีบิลรายเดือนฉบับร่างที่ยังไม่ได้ส่ง — การสรุปยอดจะไม่นำบิลร่างนี้มาคิด ถ้าต้องการให้รวม ให้ส่งบิลนั้นก่อน",
  charges_capped:
    "บิลเก่าบางใบมีประวัติการชำระแบบเดิมที่ไม่ตรงกับรายการรับเงิน ระบบหักเงินประกันไม่เกินยอดค้างที่บันทึกไว้บนบิล",
};

/**
 * Thai text for one issue. `bad_request` keeps the server's own message
 * (it names the exact field); an unknown code falls back to the server text.
 */
export function moveOutIssueText(issue: MoveOutIssue): string {
  const known = MOVE_OUT_ISSUE_TEXT[issue.code];
  if (issue.code === "bad_request" && issue.message) return `${known}: ${issue.message}`;
  if (known) return known;
  return issue.message?.trim() || "เกิดข้อผิดพลาด";
}
