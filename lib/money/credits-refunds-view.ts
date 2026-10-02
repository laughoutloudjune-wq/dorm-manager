import { labelTh } from "@/lib/money/report-definitions";

/**
 * Pure helpers for the read-only credits and refunds page. No writes, no I/O.
 * Term labels come from report-definitions so this page cannot drift from the
 * rest of the reports.
 */

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v: number) => Math.round(v * 100) / 100;

export const CREDIT_LABELS = {
  depositHeld: "เงินประกันที่ถือไว้",
  advanceHeld: "ค่าเช่าล่วงหน้าที่ถือไว้",
  unappliedCredit: "เครดิตที่ยังไม่ได้ตัดชำระ",
  // Same wording as REPORT_TERMS, with an explicit qualifier for "due".
  refundDue: `${labelTh("refundDue")} (ยังไม่ได้จ่ายออก)`,
  refundPaid: labelTh("refundPaid"),
  refundOutstanding: "ยอดค้างคืน",
} as const;

export const PAYOUT_COLUMN_LABELS = {
  paidAt: "วันที่จ่าย",
  amount: "จำนวนเงิน",
  method: "ช่องทาง",
  recipient: "ผู้รับ",
  reference: "อ้างอิง",
  status: "สถานะ",
} as const;

export type TenantCreditRow = {
  tenant_id: string;
  bucket: string;
  amount: number | string | null;
};

export type CreditBalance = {
  tenantId: string;
  depositHeld: number;
  advanceHeld: number;
  unappliedCredit: number;
};

/** Fallback when the balances view is missing: sum tenant_credits rows per tenant and bucket. */
export function aggregateCredits(rows: TenantCreditRow[]): CreditBalance[] {
  const map = new Map<string, CreditBalance>();
  for (const r of rows) {
    const b = map.get(r.tenant_id) ?? { tenantId: r.tenant_id, depositHeld: 0, advanceHeld: 0, unappliedCredit: 0 };
    const amt = num(r.amount);
    if (r.bucket === "deposit") b.depositHeld += amt;
    else if (r.bucket === "advance") b.advanceHeld += amt;
    else if (r.bucket === "unapplied") b.unappliedCredit += amt;
    map.set(r.tenant_id, b);
  }
  return Array.from(map.values()).map((b) => ({
    ...b,
    depositHeld: round2(b.depositHeld),
    advanceHeld: round2(b.advanceHeld),
    unappliedCredit: round2(b.unappliedCredit),
  }));
}

/** Map rows of the tenant_credit_balances view. */
export const balancesFromView = (
  rows: { tenant_id: string; deposit_held: unknown; advance_held: unknown; unapplied_credit: unknown }[],
): CreditBalance[] =>
  rows.map((r) => ({
    tenantId: r.tenant_id,
    depositHeld: round2(num(r.deposit_held)),
    advanceHeld: round2(num(r.advance_held)),
    unappliedCredit: round2(num(r.unapplied_credit)),
  }));

export type RefundRow = {
  tenantId: string;
  refundDue: number;
  refundPaid: number;
  /** due - paid. Negative means paid out beyond what was due. */
  outstanding: number;
};

/** Always recompute outstanding as due - paid so the figures cannot disagree. */
export const refundRowsFromView = (
  rows: { tenant_id: string; refund_due: unknown; refund_paid: unknown }[],
): RefundRow[] =>
  rows.map((r) => {
    const refundDue = round2(num(r.refund_due));
    const refundPaid = round2(num(r.refund_paid));
    return { tenantId: r.tenant_id, refundDue, refundPaid, outstanding: round2(refundDue - refundPaid) };
  });

export type PayoutRow = {
  id: string;
  tenantId: string;
  amount: number;
  paidAt: string | null;
  method: string | null;
  recipient: string | null;
  reference: string | null;
  voided: boolean;
  voidReason: string | null;
};

export const payoutsFromRows = (rows: any[]): PayoutRow[] =>
  rows
    .map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      amount: round2(num(r.amount)),
      paidAt: r.paid_at ?? null,
      method: r.method ?? null,
      recipient: r.recipient ?? null,
      reference: r.reference ?? null,
      voided: Boolean(r.voided_at),
      voidReason: r.void_reason ?? null,
    }))
    .sort((a, b) => String(b.paidAt ?? "").localeCompare(String(a.paidAt ?? "")));

export type CreditsRefundsTotals = {
  depositHeld: number;
  advanceHeld: number;
  unappliedCredit: number;
  refundDue: number;
  refundPaid: number;
  outstanding: number;
};

export function summarizeTotals(balances: CreditBalance[], refunds: RefundRow[]): CreditsRefundsTotals {
  const sum = <T,>(rows: T[], f: (r: T) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
  const refundDue = sum(refunds, (r) => r.refundDue);
  const refundPaid = sum(refunds, (r) => r.refundPaid);
  return {
    depositHeld: sum(balances, (b) => b.depositHeld),
    advanceHeld: sum(balances, (b) => b.advanceHeld),
    unappliedCredit: sum(balances, (b) => b.unappliedCredit),
    refundDue,
    refundPaid,
    outstanding: round2(refundDue - refundPaid),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

export type NamedBalance = CreditBalance & { tenantName: string | null; roomNumber: string | null };
export type NamedRefund = RefundRow & { tenantName: string | null; roomNumber: string | null };
export type NamedPayout = PayoutRow & { tenantName: string | null; roomNumber: string | null };

export const balancesToCsv = (rows: NamedBalance[]) =>
  csv(
    ["ผู้เช่า", "ห้อง", CREDIT_LABELS.depositHeld, CREDIT_LABELS.advanceHeld, CREDIT_LABELS.unappliedCredit],
    rows.map((r) => [r.tenantName, r.roomNumber, r.depositHeld, r.advanceHeld, r.unappliedCredit]),
  );

export const refundsToCsv = (rows: NamedRefund[]) =>
  csv(
    ["ผู้เช่า", "ห้อง", CREDIT_LABELS.refundDue, CREDIT_LABELS.refundPaid, CREDIT_LABELS.refundOutstanding],
    rows.map((r) => [r.tenantName, r.roomNumber, r.refundDue, r.refundPaid, r.outstanding]),
  );

export const payoutStatusLabel = (voided: boolean) => (voided ? "ยกเลิกแล้ว (void)" : "จ่ายแล้ว");

export const payoutsToCsv = (rows: NamedPayout[]) =>
  csv(
    [
      "ผู้เช่า",
      "ห้อง",
      PAYOUT_COLUMN_LABELS.paidAt,
      PAYOUT_COLUMN_LABELS.amount,
      PAYOUT_COLUMN_LABELS.method,
      PAYOUT_COLUMN_LABELS.recipient,
      PAYOUT_COLUMN_LABELS.reference,
      PAYOUT_COLUMN_LABELS.status,
    ],
    rows.map((r) => [
      r.tenantName,
      r.roomNumber,
      r.paidAt,
      r.amount,
      r.method,
      r.recipient,
      r.reference,
      payoutStatusLabel(r.voided),
    ]),
  );

/** One CSV with the three sections stacked, each preceded by its title line. */
export const creditsRefundsToCsv = (data: {
  balances: NamedBalance[];
  refunds: NamedRefund[];
  payouts: NamedPayout[];
}) =>
  [
    "ยอดเครดิตผู้เช่า",
    balancesToCsv(data.balances),
    "",
    `${CREDIT_LABELS.refundDue} เทียบ ${CREDIT_LABELS.refundPaid}`,
    refundsToCsv(data.refunds),
    "",
    "รายการคืนเงิน",
    payoutsToCsv(data.payouts),
  ].join("\r\n");
