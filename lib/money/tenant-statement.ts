/**
 * Tenant statement builder — pure, no database, no network.
 *
 * Turns one invoice row + its payment allocations + its payment_history cache
 * into everything the tenant screen needs: non-overlapping charge lines,
 * credits kept apart from charges, each payment with the period(s) it was
 * applied to (reversed ones flagged), the balance left, money still UNDER
 * REVIEW (never counted as received), a plain-Thai status explanation with the
 * next action, and the late fee as either CHARGED or an ESTIMATE.
 *
 * Totals come from lib/invoice-total.ts only; the late_fee_amount /
 * additional_fees_total overlap is unpacked by chargesFromInvoiceRow, so a
 * carried debt or carried late-fee line is shown exactly once.
 */
import {
  chargesFromInvoiceRow,
  computeInvoiceTotal,
  type InvoiceMoneyRow,
} from "../invoice-total";
import { toNumber } from "../format";
import { estimateLateFee, type LateFeeEstimate, type LateFeePolicy } from "./late-fee";

export type StatementInvoiceRow = InvoiceMoneyRow & {
  id?: string | null;
  status?: string | null;
  total_amount?: number | null;
  paid_amount?: number | null;
  due_date?: string | null;
  start_date?: string | null;
  slip_url?: string | null;
  slip_uploaded_at?: string | null;
  late_fee_per_day?: number | null;
  late_fee_start_date?: string | null;
  waived_late_fee_amount?: number | null;
  locked_late_fee_amount?: number | null;
  discount_breakdown?: unknown;
};

export type StatementAllocation = {
  id?: string | null;
  payment_batch_id?: string | null;
  invoice_id?: string | null;
  amount?: number | null;
  paid_at?: string | null;
  slip_url?: string | null;
  source?: string | null;
  /** Billing period start (YYYY-MM-DD) of the invoice this row was applied to. */
  invoice_period?: string | null;
  reverses_allocation_id?: string | null;
  reversed_at?: string | null;
  reversal_reason?: string | null;
};

export type StatementHistoryEntry = Record<string, any>;

export type StatementOptions = {
  /** YYYY-MM-DD "today" for the late-fee estimate. Defaults to the current date. */
  asOf?: string;
  /** Override the display-only late-fee policy. */
  policy?: LateFeePolicy;
  /** Only pass when real data exists; otherwise the refund block is omitted. */
  refund?: { due: number; paid: number } | null;
  /**
   * Late fees approved and posted FROM this invoice (late_fee_charges rows with
   * this invoice as source; billed as a line on a later invoice), net of
   * waivers. When present they are the charged figure and no estimate is shown.
   */
  postedLateFees?: PostedLateFee[];
  /**
   * Carried-in debt (included in this invoice's total) whose SOURCE invoice is
   * fully settled, so it was paid on that invoice's allocations, not this one's.
   * Without it a carry-forward target keeps showing the carried amount as owed.
   * See lib/money/carry-in.ts.
   */
  carriedInSettled?: number;
};

export type PostedLateFee = { amount: number; waived: number; targetInvoiceId: string | null };

export type StatementLine = {
  key: "rent" | "water" | "electricity" | "commonFee" | "lateFee" | "carriedLateFee" | "fees" | "carryForward";
  labelTh: string;
  amount: number;
};

export type StatementPayment = {
  id: string;
  paidAt: string | null;
  /** Whole transfer (sum across every invoice it was split over). */
  amount: number;
  /** Portion applied to THIS invoice. */
  amountToThisInvoice: number;
  appliedTo: Array<{
    invoiceId: string | null;
    periodMonth: string | null;
    amount: number;
    isThisInvoice: boolean;
  }>;
  source: string | null;
  slipUrl: string | null;
  state: "confirmed" | "reversed";
  reversedReason: string | null;
};

export type StatementLateFee =
  | { state: "none" }
  | {
      state: "charged";
      amount: number;
      /** True when the amount is frozen in locked_late_fee_amount or posted as a charge. */
      locked: boolean;
      carriedAmount: number;
      /** Set when the fee was approved and billed on a later invoice (late_fee_charges). */
      postedOnInvoiceId?: string | null;
    }
  | {
      state: "estimate";
      /** NOT in the total or balance until charged. */
      amount: number;
      coveredFrom: string | null;
      coveredTo: string | null;
      days: number;
      formula: string;
      note: string;
    };

export type TenantStatement = {
  invoiceId: string | null;
  status: string;
  periodMonth: string | null;
  dueDate: string | null;
  lines: StatementLine[];
  charges: number;
  credits: Array<{ label: string; amount: number }>;
  creditsTotal: number;
  total: number;
  /** True when the stored total_amount equals the engine total. */
  totalMatchesRow: boolean;
  confirmedPaid: number;
  balance: number;
  /** Carried-in debt already settled on its source invoice (counted in total, not in balance). */
  carriedInSettled: number;
  payments: StatementPayment[];
  underReview: { active: boolean; slipUrl: string | null; uploadedAt: string | null; note: string } | null;
  lateFee: StatementLateFee;
  explanationTh: string;
  nextActionTh: string;
  refund?: { due: number; paid: number; outstanding: number };
};

/** Display-only policy mirroring today's settings: flat baht/day after the start date. */
export const defaultDisplayLateFeePolicy = (row: StatementInvoiceRow): LateFeePolicy => {
  const perDay = Math.max(0, toNumber(row.late_fee_per_day));
  let grace = 0;
  if (row.due_date && row.late_fee_start_date) {
    const diff = Math.round(
      (Date.parse(`${row.late_fee_start_date.slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${row.due_date.slice(0, 10)}T00:00:00Z`)) /
        86400000,
    );
    grace = Math.max(0, diff - 1);
  }
  return {
    version: "display-current-settings",
    effectiveFrom: "1970-01-01",
    graceDays: grace,
    rate: { kind: "flat", baht: perDay },
    partialPaymentsReduceBase: true,
    cap: null,
    rounding: "floor",
    compounding: false,
  };
};

const month = (v?: string | null) => (v ? String(v).slice(0, 7) : null);
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : null);
const baht = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

function buildPayments(
  invoiceId: string | null,
  allocations: StatementAllocation[],
  history: StatementHistoryEntry[],
): StatementPayment[] {
  if (allocations.length > 0) {
    const reversedIds = new Set<string>();
    const reasonById = new Map<string, string | null>();
    for (const a of allocations) {
      if (a.reverses_allocation_id) {
        reversedIds.add(String(a.reverses_allocation_id));
        reasonById.set(String(a.reverses_allocation_id), a.reversal_reason ?? null);
      }
    }
    // Real money rows only: negative reversal rows are bookkeeping, not payments.
    const real = allocations.filter((a) => !a.reverses_allocation_id && toNumber(a.amount) > 0);
    const groups = new Map<string, StatementAllocation[]>();
    real.forEach((a, i) => {
      const key = String(a.payment_batch_id ?? a.id ?? `alloc-${i}`);
      groups.set(key, [...(groups.get(key) ?? []), a]);
    });
    const out: StatementPayment[] = [];
    for (const [key, rows] of groups) {
      const isReversed = (a: StatementAllocation) =>
        !!a.reversed_at || (a.id != null && reversedIds.has(String(a.id)));
      const mine = rows.filter((a) => a.invoice_id == null || String(a.invoice_id) === invoiceId);
      if (mine.length === 0) continue;
      const allReversed = mine.every(isReversed);
      const first = rows[0];
      out.push({
        id: key,
        paidAt: first.paid_at ?? null,
        amount: rows.reduce((s, a) => s + toNumber(a.amount), 0),
        amountToThisInvoice: mine.reduce((s, a) => s + toNumber(a.amount), 0),
        appliedTo: rows.map((a) => ({
          invoiceId: a.invoice_id != null ? String(a.invoice_id) : null,
          periodMonth: month(a.invoice_period),
          amount: toNumber(a.amount),
          isThisInvoice: a.invoice_id == null || String(a.invoice_id) === invoiceId,
        })),
        source: first.source ?? null,
        slipUrl: rows.find((a) => a.slip_url)?.slip_url ?? null,
        state: allReversed ? "reversed" : "confirmed",
        reversedReason: allReversed
          ? (mine.map((a) => (a.id != null ? reasonById.get(String(a.id)) : null)).find(Boolean) ?? null)
          : null,
      });
    }
    return out.sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt)));
  }

  // Fallback: the display cache. Void entries mark their batch reversed.
  const voidedBatches = new Map<string, string | null>();
  for (const v of history) {
    if (String(v?.type ?? "") === "void" && v.payment_batch_id) {
      voidedBatches.set(String(v.payment_batch_id), v.reason ?? null);
    }
  }
  return history
    .filter((h) => String(h?.type ?? "") !== "void" && toNumber(h?.amount) > 0)
    .map((h, i) => {
      const batch = h.payment_batch_id ? String(h.payment_batch_id) : null;
      const reversed = batch != null && voidedBatches.has(batch);
      const amount = toNumber(h.amount);
      return {
        id: batch ?? `history-${i}`,
        paidAt: h.paid_at ?? h.created_at ?? null,
        amount,
        amountToThisInvoice: amount,
        appliedTo: [{ invoiceId, periodMonth: null, amount, isThisInvoice: true }],
        source: h.source ?? null,
        slipUrl: h.slip_url ?? null,
        state: reversed ? ("reversed" as const) : ("confirmed" as const),
        reversedReason: reversed ? (voidedBatches.get(batch!) ?? null) : null,
      };
    });
}

export function buildTenantStatement(
  invoiceRow: StatementInvoiceRow,
  allocations: StatementAllocation[] = [],
  history: StatementHistoryEntry[] = [],
  options: StatementOptions = {},
): TenantStatement {
  const invoiceId = invoiceRow.id != null ? String(invoiceRow.id) : null;
  const status = String(invoiceRow.status ?? "pending");
  const c = chargesFromInvoiceRow(invoiceRow);
  const total = computeInvoiceTotal(c);

  const lines: StatementLine[] = (
    [
      ["rent", "ค่าเช่า", c.rent],
      ["water", "ค่าน้ำ", c.water],
      ["electricity", "ค่าไฟ", c.electricity],
      ["commonFee", "ค่าส่วนกลาง", c.commonFee],
      ["lateFee", "ค่าปรับล่าช้า", c.nativeLateFee],
      ["carriedLateFee", "ค่าปรับล่าช้าที่ยกมา", c.lateFeeItems],
      ["fees", "ค่าบริการอื่น ๆ", c.fees],
      ["carryForward", "ยอดค้างยกมา", c.carryForward],
    ] as Array<[StatementLine["key"], string, number]>
  )
    .filter(([, , amount]) => amount !== 0)
    .map(([key, labelTh, amount]) => ({ key, labelTh, amount }));
  const charges = total + c.discount;

  const breakdown = Array.isArray(invoiceRow.discount_breakdown) ? invoiceRow.discount_breakdown : [];
  let credits = breakdown
    .map((r: any) => ({
      label: String(r?.label ?? r?.detail ?? "ส่วนลด"),
      amount: Math.abs(toNumber(r?.total_amount ?? r?.amount)),
    }))
    .filter((r) => r.amount > 0);
  if (credits.length === 0 && c.discount > 0) credits = [{ label: "ส่วนลด", amount: c.discount }];

  const payments = buildPayments(invoiceId, allocations, history);
  const confirmedPaid = payments
    .filter((p) => p.state === "confirmed")
    .reduce((s, p) => s + p.amountToThisInvoice, 0);
  const carriedInSettled = Math.max(0, options.carriedInSettled ?? 0);
  const balance = Math.max(0, Math.round((total - confirmedPaid - carriedInSettled) * 100) / 100);

  const isCancelled = status === "cancelled";
  const isPaid = status === "paid" || (balance <= 0 && total > 0 && !isCancelled);
  const underReviewActive = status === "verifying";
  const underReview = underReviewActive
    ? {
        active: true,
        slipUrl: invoiceRow.slip_url ?? null,
        uploadedAt: invoiceRow.slip_uploaded_at ?? null,
        note: "สลิปที่ส่งมากำลังรอตรวจสอบ ยังไม่นับเป็นยอดที่ได้รับ",
      }
    : null;

  // Late fee
  const locked = invoiceRow.locked_late_fee_amount;
  let lateFee: StatementLateFee = { state: "none" };
  const posted = options.postedLateFees ?? [];
  if (posted.length > 0) {
    lateFee = {
      state: "charged",
      amount: posted.reduce((s, p) => s + toNumber(p.amount) - toNumber(p.waived), 0),
      locked: true,
      carriedAmount: c.lateFeeItems,
      postedOnInvoiceId: posted.find((p) => p.targetInvoiceId)?.targetInvoiceId ?? null,
    };
  } else if (locked !== null && locked !== undefined) {
    lateFee = { state: "charged", amount: toNumber(locked), locked: true, carriedAmount: c.lateFeeItems };
  } else if (c.nativeLateFee > 0 || c.lateFeeItems > 0) {
    lateFee = {
      state: "charged",
      amount: c.nativeLateFee + c.lateFeeItems,
      locked: false,
      carriedAmount: c.lateFeeItems,
    };
  } else if (!isPaid && !isCancelled && invoiceRow.due_date) {
    const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
    const policy = options.policy ?? defaultDisplayLateFeePolicy(invoiceRow);
    const est: LateFeeEstimate = estimateLateFee(policy, {
      dueDate: day(invoiceRow.due_date)!,
      asOf,
      outstanding: balance,
      originalDue: total,
      waived: toNumber(invoiceRow.waived_late_fee_amount),
    });
    if (est.amount > 0) {
      lateFee = {
        state: "estimate",
        amount: est.amount,
        coveredFrom: est.coveredFrom,
        coveredTo: est.coveredTo,
        days: est.daysCharged,
        formula: est.formula,
        note: "เป็นยอดประมาณการ ยังไม่ถูกเรียกเก็บ จะคิดจริงเมื่อชำระครบหรือยกยอดไปบิลถัดไป",
      };
    }
  }

  // Status explanation
  let explanationTh: string;
  let nextActionTh: string;
  if (isCancelled) {
    explanationTh = "บิลนี้ถูกยกเลิกแล้ว";
    nextActionTh = "ไม่ต้องชำระเงินสำหรับบิลนี้";
  } else if (status === "draft") {
    explanationTh = "บิลนี้ยังไม่ออกอย่างเป็นทางการ";
    nextActionTh = "รอผู้ดูแลออกบิล ยังไม่ต้องชำระ";
  } else if (underReviewActive) {
    explanationTh = "ได้รับสลิปของคุณแล้ว กำลังรอผู้ดูแลตรวจสอบ ยอดนี้ยังไม่นับเป็นยอดที่ชำระแล้ว";
    nextActionTh = "รอการยืนยันจากผู้ดูแล ไม่ต้องโอนซ้ำ";
  } else if (isPaid) {
    explanationTh = "ชำระครบแล้ว";
    nextActionTh = "ไม่มียอดค้างชำระ";
  } else if (confirmedPaid > 0) {
    explanationTh = `ชำระแล้วบางส่วน ฿${baht(confirmedPaid)} คงเหลือ ฿${baht(balance)}`;
    nextActionTh = `ชำระยอดคงเหลือ ฿${baht(balance)} ให้ครบ`;
  } else if (status === "overdue") {
    explanationTh = `เลยกำหนดชำระแล้ว ยอดค้าง ฿${baht(balance)}`;
    nextActionTh = `ชำระ ฿${baht(balance)} โดยเร็วเพื่อหลีกเลี่ยงค่าปรับเพิ่ม แล้วอัปโหลดสลิป`;
  } else {
    explanationTh = `ยังไม่ได้ชำระ ยอดที่ต้องชำระ ฿${baht(balance)}`;
    nextActionTh = `โอนเงิน ฿${baht(balance)} ตามกำหนด แล้วอัปโหลดสลิป`;
  }

  const stmt: TenantStatement = {
    invoiceId,
    status,
    periodMonth: month(invoiceRow.start_date),
    dueDate: day(invoiceRow.due_date),
    lines,
    charges,
    credits,
    creditsTotal: c.discount,
    total,
    totalMatchesRow: invoiceRow.total_amount == null || toNumber(invoiceRow.total_amount) === total,
    confirmedPaid,
    balance,
    carriedInSettled,
    payments,
    underReview,
    lateFee,
    explanationTh,
    nextActionTh,
  };
  if (options.refund) {
    stmt.refund = {
      due: options.refund.due,
      paid: options.refund.paid,
      outstanding: Math.max(0, options.refund.due - options.refund.paid),
    };
  }
  return stmt;
}
