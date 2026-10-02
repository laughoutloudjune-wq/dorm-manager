/**
 * Display state of an invoice's payment EVIDENCE (the tenant's slip) — pure.
 *
 * A slip is evidence awaiting review, not money received. Money exists only
 * once an admin confirms an amount (a payment batch / allocation). This maps
 * the invoice row + its allocations/history onto one of six states so every
 * screen describes the slip the same way.
 */

export type SlipState =
  | "slip_submitted"
  | "under_review"
  | "approved"
  | "partially_allocated"
  | "balance_settled"
  | "declined";

export type SlipStateInput = {
  status?: string | null;
  slip_url?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  slip_rejections?: unknown;
  /** invoice_payment_allocations rows (reversed ones are ignored). */
  allocations?: Array<{
    amount?: number | null;
    reversed_at?: string | null;
    reverses_allocation_id?: string | null;
  }> | null;
  /** payment_history display cache; used only when allocations are not loaded. */
  payment_history?: unknown;
};

export type SlipStateInfo = {
  state: SlipState;
  label: string;
  nextAction: string;
  tone: "info" | "warning" | "success" | "danger";
};

const INFO: Record<SlipState, Omit<SlipStateInfo, "state">> = {
  slip_submitted: {
    label: "แนบสลิปแล้ว",
    nextAction: "สลิปยังไม่ถูกส่งตรวจสอบ ให้ผู้เช่าส่งสลิปอีกครั้ง",
    tone: "info",
  },
  under_review: {
    label: "รอตรวจสอบสลิป",
    nextAction: "ตรวจสลิป แล้วยืนยันยอดและวันเวลาที่โอนจริง หรือปฏิเสธสลิป",
    tone: "warning",
  },
  approved: {
    label: "ยืนยันชำระแล้ว",
    nextAction: "ไม่ต้องดำเนินการ",
    tone: "success",
  },
  partially_allocated: {
    label: "ชำระบางส่วน",
    nextAction: "รอผู้เช่าชำระยอดคงเหลือ",
    tone: "warning",
  },
  balance_settled: {
    label: "ชำระครบหลังผ่อนชำระ",
    nextAction: "ไม่ต้องดำเนินการ",
    tone: "success",
  },
  declined: {
    label: "สลิปถูกปฏิเสธ",
    nextAction: "รอผู้เช่าอัปโหลดสลิปใหม่",
    tone: "danger",
  },
};

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function countPayments(input: SlipStateInput): number {
  if (Array.isArray(input.allocations)) {
    return input.allocations.filter(
      (a) => !a.reversed_at && !a.reverses_allocation_id && num(a.amount) > 0,
    ).length;
  }
  if (Array.isArray(input.payment_history)) {
    return (input.payment_history as any[]).filter(
      (p) => p && num(p.amount) > 0 && !p.voided && !p.reversed,
    ).length;
  }
  return 0;
}

/** Returns null when the invoice has no payment evidence history at all. */
export function deriveSlipState(input: SlipStateInput): SlipStateInfo | null {
  const status = String(input.status ?? "");
  const total = num(input.total_amount);
  const paid = num(input.paid_amount);
  const hasSlip = Boolean(input.slip_url);
  const rejections = Array.isArray(input.slip_rejections) ? input.slip_rejections.length : 0;
  const payments = countPayments(input);

  let state: SlipState | null = null;
  if (status === "verifying" && hasSlip) state = "under_review";
  else if (status === "paid" && total > 0 && paid >= total) {
    state = payments >= 2 ? "balance_settled" : hasSlip || payments === 1 ? "approved" : null;
  } else if (paid > 0 && paid < total && (hasSlip || payments > 0) && status !== "cancelled") {
    state = "partially_allocated";
  } else if (!hasSlip && rejections > 0 && status !== "cancelled" && status !== "paid") {
    state = "declined";
  } else if (hasSlip && status !== "cancelled" && status !== "paid") {
    state = "slip_submitted";
  }
  return state ? { state, ...INFO[state] } : null;
}
