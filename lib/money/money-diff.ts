/** Invoice columns whose change is a money event worth auditing. */
export const INVOICE_MONEY_COLUMNS = [
  "total_amount",
  "paid_amount",
  "discount_amount",
  "late_fee_amount",
  "locked_late_fee_amount",
  "additional_fees_total",
  "carry_forward_amount",
  "status",
] as const;

export type MoneyColumnDiff = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

const same = (a: unknown, b: unknown) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  const bothNumericLike = (typeof a === "number" || typeof a === "string") && (typeof b === "number" || typeof b === "string");
  if (bothNumericLike && Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
    return na === nb;
  }
  return false;
};

/**
 * Compares the stored row with the update payload. Returns only the money
 * columns the payload actually changes, or null when none changed.
 */
export function diffMoneyColumns(
  beforeRow: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>,
): MoneyColumnDiff | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const col of INVOICE_MONEY_COLUMNS) {
    if (!(col in payload)) continue;
    const b = beforeRow?.[col] ?? null;
    const a = payload[col] ?? null;
    if (same(b, a)) continue;
    before[col] = b;
    after[col] = a;
  }
  return Object.keys(after).length > 0 ? { before, after } : null;
}

export type DeleteBlockInput = {
  id: string;
  paid_amount?: unknown;
  hasAllocation?: boolean;
  hasBatchTrigger?: boolean;
};

/** Invoice ids that must not be hard-deleted because money touched them. */
export function invoicesBlockedFromDelete(rows: DeleteBlockInput[]): string[] {
  return rows
    .filter((r) => Number(r.paid_amount ?? 0) > 0 || r.hasAllocation || r.hasBatchTrigger)
    .map((r) => r.id);
}
