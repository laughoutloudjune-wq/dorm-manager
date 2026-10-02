/**
 * Pure display helpers for rendering a TenantStatement on tenant screens.
 * Display only: nothing here moves or recalculates money.
 */
import type { TenantStatement } from "./tenant-statement";

type RowLike = { total_amount?: number | null; paid_amount?: number | null };

const legacyBalance = (row: RowLike) =>
  Math.max(0, Number(row.total_amount ?? 0) - Number(row.paid_amount ?? 0));

/** Balance to show: the statement's confirmed-payment balance when present, else total - paid. */
export function displayBalance(row: RowLike, statement?: TenantStatement | null): number {
  return statement ? statement.balance : legacyBalance(row);
}

/** True when the statement balance disagrees with the legacy total - paid_amount figure. */
export function balanceDiffersFromLegacy(row: RowLike, statement?: TenantStatement | null): boolean {
  if (!statement) return false;
  return Math.abs(statement.balance - legacyBalance(row)) > 0.005;
}

/** Thai short month + year label for a YYYY-MM period, or null. */
export function periodLabel(periodMonth: string | null | undefined): string | null {
  if (!periodMonth || !/^\d{4}-\d{2}/.test(periodMonth)) return null;
  const d = new Date(`${periodMonth.slice(0, 7)}-01T00:00:00Z`);
  return d.toLocaleDateString("th-TH", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Thai summary of which billing periods a payment was applied to ("" when unknown). */
export function appliedToLabel(payment: TenantStatement["payments"][number]): string {
  const parts = payment.appliedTo
    .map((a) => periodLabel(a.periodMonth))
    .filter((x): x is string => !!x);
  return parts.length ? `ใช้กับงวด ${Array.from(new Set(parts)).join(", ")}` : "";
}
