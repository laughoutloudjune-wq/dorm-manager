/**
 * The invoice total calculation engine — ONE definition of what an invoice costs.
 *
 * Before this existed, nine separate places in the codebase added up an invoice
 * total, and they disagreed. Each was written independently and each forgot
 * something different:
 *
 *   - `updateUtilityUnits` (editing a meter reading) omitted carry-forward, so
 *     adjusting a water reading silently erased a tenant's carried debt.
 *   - `toggleProrateInModal` omitted carry-forward AND carried late-fee lines.
 *   - `applyRoundDownTotal` omitted the invoice's own late fee, so the
 *     round-down discount was computed against the wrong figure.
 *   - `syncMonthInvoicesWithSettings` added `late_fee_amount` and
 *     `additional_fees_total` together, double-charging the late fee on every
 *     invoice-list load — which silently re-inflated invoices after each save.
 *
 * Those were not one bug repeated; they were nine copies of one calculation
 * drifting apart. The cure is the one this codebase already applied to
 * `dailyRentRate` and to invoice status colours: define it once.
 *
 * `InvoiceCharges` requires EVERY component. That is the point — omitting
 * carry-forward used to be invisible and merely produce a wrong number; now it
 * is a compile error. The mistake is not fixed, it is made impossible.
 */
import { toNumber } from "./format";

/**
 * Every component of an invoice's cost. All fields are required: a missing
 * term must never be silently treated as zero.
 */
export type InvoiceCharges = {
  rent: number;
  water: number;
  electricity: number;
  commonFee: number;
  /**
   * THIS invoice's own late fee — the penalty on its own overdue balance.
   * Distinct from `lateFeeItems`, which are penalties carried in from earlier
   * invoices as line items. Keeping them apart is what stops the two from
   * being added twice.
   */
  nativeLateFee: number;
  /** Late-fee line items carried in from earlier invoices. */
  lateFeeItems: number;
  /** Other additional charge line items (cleaning, repairs, and so on). */
  fees: number;
  /** Unpaid balance carried in from earlier invoices. */
  carryForward: number;
  /** Discounts, as a POSITIVE number. Subtracted by the engine. */
  discount: number;
};

/** What an invoice costs. The only definition. */
export const computeInvoiceTotal = (charges: InvoiceCharges): number =>
  toNumber(charges.rent) +
  toNumber(charges.water) +
  toNumber(charges.electricity) +
  toNumber(charges.commonFee) +
  toNumber(charges.nativeLateFee) +
  toNumber(charges.lateFeeItems) +
  toNumber(charges.fees) +
  toNumber(charges.carryForward) -
  toNumber(charges.discount);

/**
 * The invoice's total late fee, as stored in the `late_fee_amount` column:
 * its own penalty plus every carried late-fee line.
 */
export const totalLateFee = (charges: InvoiceCharges): number =>
  toNumber(charges.nativeLateFee) + toNumber(charges.lateFeeItems);

/**
 * The value of the `additional_fees_total` column.
 *
 * NOTE THE OVERLAP: this column has always included late-fee line items, and
 * so has `late_fee_amount`. The two columns therefore share the same figure,
 * and anything adding both must subtract it once. That trap is the reason the
 * late fee was being double-charged. The columns keep their historical meaning
 * here — the tenant app, receipts and reports all read them — but no caller has
 * to reason about the overlap any more: `chargesFromInvoiceRow` unpacks it, and
 * `computeInvoiceTotal` works from the unpacked parts where nothing overlaps.
 */
export const additionalFeesColumn = (charges: InvoiceCharges): number =>
  toNumber(charges.fees) + toNumber(charges.lateFeeItems);

/** The money columns an invoice row stores, all derived from one set of charges. */
export type InvoiceMoneyColumns = {
  total_amount: number;
  late_fee_amount: number;
  additional_fees_total: number;
  carry_forward_amount: number;
  discount_amount: number;
};

/**
 * Derive every stored money column from one set of charges, so the columns can
 * never disagree with the total or with each other.
 */
export const toInvoiceMoneyColumns = (
  charges: InvoiceCharges,
): InvoiceMoneyColumns => ({
  total_amount: computeInvoiceTotal(charges),
  late_fee_amount: totalLateFee(charges),
  additional_fees_total: additionalFeesColumn(charges),
  carry_forward_amount: toNumber(charges.carryForward),
  discount_amount: toNumber(charges.discount),
});

/** Sum of the late-fee LINE items inside an `additional_fees_breakdown`. */
export const lateFeeLineTotalOf = (breakdown: unknown): number => {
  const rows = Array.isArray(breakdown) ? breakdown : [];
  return rows
    .filter(
      (row: any) =>
        String(row?.item_type ?? row?.type ?? "").toLowerCase() ===
        "late_fee_line",
    )
    .reduce(
      (sum: number, row: any) =>
        sum + toNumber(row?.total_amount ?? row?.amount ?? 0),
      0,
    );
};

export type InvoiceMoneyRow = {
  rent_amount?: number | null;
  water_bill?: number | null;
  electricity_bill?: number | null;
  common_fee?: number | null;
  late_fee_amount?: number | null;
  additional_fees_total?: number | null;
  additional_fees_breakdown?: unknown;
  carry_forward_amount?: number | null;
  discount_amount?: number | null;
};

/**
 * Unpack a stored invoice row into non-overlapping charges.
 *
 * This is the ONE place the `late_fee_amount` / `additional_fees_total` overlap
 * is resolved. Both columns include the carried late-fee lines, so the shared
 * figure is removed from each to recover the invoice's own late fee and its
 * genuinely-other fees. Everything downstream then works from parts that do not
 * overlap, and cannot double-count.
 */
export const chargesFromInvoiceRow = (row: InvoiceMoneyRow): InvoiceCharges => {
  const lateFeeItems = lateFeeLineTotalOf(row.additional_fees_breakdown);
  return {
    rent: toNumber(row.rent_amount),
    water: toNumber(row.water_bill),
    electricity: toNumber(row.electricity_bill),
    commonFee: toNumber(row.common_fee),
    // `late_fee_amount` = own penalty + carried lines; remove the lines to
    // recover the invoice's own penalty on its own.
    nativeLateFee: Math.max(
      0,
      toNumber(row.late_fee_amount) - lateFeeItems,
    ),
    lateFeeItems,
    // `additional_fees_total` = other fees + carried lines; same subtraction.
    fees: Math.max(
      0,
      toNumber(row.additional_fees_total) - lateFeeItems,
    ),
    carryForward: toNumber(row.carry_forward_amount),
    discount: toNumber(row.discount_amount),
  };
};
