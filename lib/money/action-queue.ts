/**
 * Pure helpers for the admin action queue. READ ONLY: nothing here posts a fee,
 * moves money or changes a status. It only decides what is waiting for a person.
 */
import { isLegacyInflatedPaid } from "@/lib/money/carry-in";
import { estimateLateFee, type LateFeeEstimate, type LateFeePolicy } from "@/lib/money/late-fee";

export type QueueSettings = {
  late_fee_start_day?: number | null;
  late_fee_per_day?: number | null;
};

export type QueueInvoice = {
  id: string;
  status: string | null;
  due_date: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  /** Carried-in share of total_amount. Without it the base falls back to raw total - paid. */
  carry_forward_amount?: number | null;
  slip_url?: string | null;
  late_fee_start_date?: string | null;
  late_fee_per_day?: number | null;
  locked_late_fee_amount?: number | null;
  tenantName?: string | null;
  roomNumber?: string | null;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const parseDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((parseDate(a) - parseDate(b)) / 86400000);

/** Calendar date in the dorm's timezone (Asia/Bangkok), YYYY-MM-DD. */
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

/** Slips awaiting review: status verifying AND a slip actually attached. */
export function isSlipAwaitingReview(inv: Pick<QueueInvoice, "status" | "slip_url">): boolean {
  return inv.status === "verifying" && !!inv.slip_url && inv.slip_url.trim() !== "";
}

/**
 * First day a late fee applies. Uses the invoice's own late_fee_start_date when
 * set; otherwise the settings' late_fee_start_day in the first month after the
 * due date where that day falls after it.
 */
export function firstLateFeeDay(dueDate: string, startDate: string | null | undefined, startDay: number): string {
  if (startDate) return startDate.slice(0, 10);
  const day = Math.min(28, Math.max(1, Math.floor(startDay) || 6));
  const [y, m] = dueDate.split("-").map(Number);
  let candidate = fmt(Date.UTC(y, m - 1, day));
  if (candidate <= dueDate) candidate = fmt(Date.UTC(y, m, day));
  return candidate;
}

/** Default policy matching today's settings: a flat baht-per-day fee, no cap, no grace beyond the start day. */
export function buildDefaultLateFeePolicy(
  settings: QueueSettings,
  invoice: Pick<QueueInvoice, "due_date" | "late_fee_start_date" | "late_fee_per_day">
): LateFeePolicy {
  const due = invoice.due_date ?? "1970-01-01";
  const first = firstLateFeeDay(due, invoice.late_fee_start_date, num(settings.late_fee_start_day) || 6);
  const perDay = num(invoice.late_fee_per_day) > 0 ? num(invoice.late_fee_per_day) : num(settings.late_fee_per_day);
  return {
    version: "current-settings",
    effectiveFrom: "1970-01-01",
    graceDays: Math.max(0, diffDays(first, due) - 1),
    rate: { kind: "flat", baht: Math.max(0, perDay) },
    partialPaymentsReduceBase: true,
    cap: null,
    rounding: "floor",
    compounding: false,
  };
}

export type LateFeeQueueRow = {
  invoiceId: string;
  tenantName: string | null;
  roomNumber: string | null;
  dueDate: string;
  outstanding: number;
  estimate: LateFeeEstimate;
  /** Fee already locked on the invoice; null means nothing locked/posted yet. */
  locked: number | null;
  /** estimate - locked (locked treated as 0 when null). */
  difference: number;
};

/** Overdue (unpaid, past due date) invoices with an estimate beside what is already locked. Read-only. */
export function buildLateFeeRows(invoices: QueueInvoice[], settings: QueueSettings, today: string): LateFeeQueueRow[] {
  const rows: LateFeeQueueRow[] = [];
  for (const inv of invoices) {
    if (!inv.due_date || !["pending", "partial", "overdue"].includes(inv.status ?? "")) continue;
    if (inv.due_date >= today) continue;
    // Own outstanding (same rule as getChainOwnOutstanding, inlined: invoice-ledger imports this
    // file): the carried-in share is billed on its source invoice, so it is not part of the base.
    const carry = Math.max(0, num(inv.carry_forward_amount));
    const outstanding =
      carry > 0 && !isLegacyInflatedPaid(inv.total_amount, inv.paid_amount, carry)
        ? Math.max(0, num(inv.total_amount) - carry - num(inv.paid_amount))
        : Math.max(0, num(inv.total_amount) - num(inv.paid_amount));
    if (outstanding <= 0) continue;
    const policy = buildDefaultLateFeePolicy(settings, inv);
    const estimate = estimateLateFee(policy, {
      dueDate: inv.due_date,
      asOf: today,
      outstanding,
      originalDue: num(inv.total_amount),
    });
    const locked =
      inv.locked_late_fee_amount === null || inv.locked_late_fee_amount === undefined
        ? null
        : num(inv.locked_late_fee_amount);
    rows.push({
      invoiceId: inv.id,
      tenantName: inv.tenantName ?? null,
      roomNumber: inv.roomNumber ?? null,
      dueDate: inv.due_date,
      outstanding,
      estimate,
      locked,
      difference: estimate.amount - (locked ?? 0),
    });
  }
  // Largest outstanding fee first, then oldest due date.
  return rows.sort((a, b) => b.difference - a.difference || a.dueDate.localeCompare(b.dueDate));
}

export type TenantCreditBalance = { tenant_id: string; unapplied_credit: number };
export type RefundOutstanding = { tenant_id: string; refund_outstanding: number };

/** Keep only balances that are actually positive (money held / owed). */
export const positiveUnapplied = (rows: TenantCreditBalance[]) =>
  rows.filter((r) => num(r.unapplied_credit) > 0).sort((a, b) => num(b.unapplied_credit) - num(a.unapplied_credit));
export const positiveRefunds = (rows: RefundOutstanding[]) =>
  rows.filter((r) => num(r.refund_outstanding) > 0).sort((a, b) => num(b.refund_outstanding) - num(a.refund_outstanding));

export const sumBy = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + num(pick(r)), 0);

export type SectionKey = "slips" | "late_fees" | "refunds" | "credits" | "reconciliation";
export type SectionState = "ready" | "unavailable";
export type QueueSectionCount = { key: SectionKey; count: number; state: SectionState };

/** Items needing attention across all available sections (unavailable sections count 0). */
export const totalQueueCount = (sections: QueueSectionCount[]) =>
  sections.reduce((s, x) => s + (x.state === "ready" ? x.count : 0), 0);
