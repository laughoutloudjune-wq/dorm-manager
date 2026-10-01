/**
 * Move-out refunds (table `refunds`, written by settle_move_out and
 * mark_refund_paid) shaped for display — pure, no database calls.
 *
 * A refund is money OUT. It is listed and totalled on its own and is never
 * netted against income: the income report and the daily digest keep their
 * received figures untouched and show refunds as a separate line.
 */
import { paymentMethodSnapshotLabel } from "./invoice-utils";

export type RefundStatus = "pending" | "paid";

/** One refund row ready for a table. */
export type RefundView = {
  id: string;
  tenantId: string;
  tenantName: string;
  room: string;
  building: string;
  amount: number;
  status: RefundStatus;
  /** ISO timestamp the refund was paid out; null while pending. */
  paidAt: string | null;
  /** What the admin typed as the method (e.g. โอนเงิน / เงินสด). */
  method: string | null;
  /** The frozen account the money left from, or null when none was chosen. */
  accountLabel: string | null;
  note: string | null;
  createdAt: string | null;
};

const one = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * A `refunds` row as the get_refunds action / reports route select it
 * (`tenants(full_name)`, `invoice:invoices(room_id,rooms(room_number,buildings(name)))`).
 */
export function toRefundView(row: any): RefundView {
  const tenant = one<any>(row?.tenants);
  const invoice = one<any>(row?.invoice);
  const room = one<any>(invoice?.rooms);
  const building = one<any>(room?.buildings);
  const snapshot = row?.payment_method_snapshot ?? null;
  return {
    id: String(row?.id ?? ""),
    tenantId: String(row?.tenant_id ?? ""),
    tenantName: tenant?.full_name ?? "-",
    room: room?.room_number ?? "-",
    building: building?.name ?? "-",
    amount: num(row?.amount),
    status: row?.status === "paid" ? "paid" : "pending",
    paidAt: row?.paid_at ?? null,
    method: row?.method ? String(row.method) : null,
    accountLabel: snapshot ? paymentMethodSnapshotLabel(snapshot) : null,
    note: row?.note ?? null,
    createdAt: row?.created_at ?? null,
  };
}

/** How a refund left — the `method` text mark_refund_paid stores. */
export const REFUND_METHOD_LABELS: Record<string, string> = {
  bank_transfer: "โอนเงิน",
  cash: "เงินสด",
};

export const refundMethodLabel = (method: string | null | undefined): string => {
  const key = String(method ?? "").trim();
  if (!key) return "-";
  return REFUND_METHOD_LABELS[key] ?? key;
};

/**
 * The `paidAt` to send for a refund paid on `dateYmd` (Bangkok calendar day).
 * Today → now (mark_refund_paid refuses a time in the future, and noon may not
 * have happened yet); an earlier day → noon Bangkok, so the day is unambiguous
 * in every time zone.
 */
export function refundPaidAtIso(dateYmd: string, todayYmd: string, now: Date = new Date()): string {
  if (dateYmd >= todayYmd) return now.toISOString();
  return new Date(`${dateYmd}T12:00:00+07:00`).toISOString();
}

/** Count and total (to 2 dp) of refunds with the given status. */
export function summarizeRefunds(
  refunds: readonly RefundView[],
  status: RefundStatus,
): { count: number; total: number } {
  let count = 0;
  let cents = 0;
  for (const refund of refunds) {
    if (refund.status !== status) continue;
    count += 1;
    cents += Math.round(refund.amount * 100);
  }
  return { count, total: cents / 100 };
}
