/**
 * The invoice balance engine — ONE answer to "what does this bill owe today?"
 *
 * Implements section B2 of docs/audit/2026-09-29-late-fee-and-overdue-design.md.
 * Pure: no database calls, no side effects, never mutates its inputs. Every
 * screen (admin list, LINE, receipt, reports, dashboard, payment screen) is
 * meant to call this rather than add up an invoice's columns itself.
 *
 * Two fee models, selected by `invoice.fee_model`:
 *
 *   - `v2` (bills made from the 25 Oct 2026 cycle on): `total_amount` is the
 *     bill's own charges, fixed once sent. The late fee lives on the late bill
 *     itself, grows `late_fee_per_day` per day from `late_fee_start_date`, and
 *     stops on the earliest of: the day payments covered the charges, the
 *     pause date, or the tenant's handover. Nothing about the fee is stored;
 *     it is derived from the allocation rows, so voiding a payment restarts it
 *     from the right day automatically.
 *
 *   - `legacy` (everything made before the cut-over): a READ-ONLY adapter over
 *     the columns those rows actually have. Own charges are
 *     `total_amount − carry_forward_amount`, so a bundled bill does not count
 *     the bill it carried in a second time (room 109/1: 2,867 + 5,758 + 8,666
 *     stored, 8,666 really owed). The fee is the frozen
 *     `locked_late_fee_amount`, only while it was never billed elsewhere, never
 *     growing, and nothing at all once the tenant has left. The legacy path
 *     reads no v2-only invoice column.
 *
 * Every input field is REQUIRED (nullable where the database allows null).
 * That is deliberate, as in `lib/invoice-total.ts`: forgetting to select a
 * column must be a compile error, never a silent zero.
 *
 * `status` is calculated here, never read from `invoices.status`. The three
 * manual states and the slip-review flag are explicit inputs
 * (`manual_status`, `is_verifying`) that override the money-derived status;
 * the money figures are still computed in full underneath them.
 */
import { roundTo2, toNumber } from "./format";
import { bangkokYmd } from "./move-out-notice";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** `invoices.kind` (B1). `move_out` bills never accrue a late fee. */
export type InvoiceKind = "monthly" | "move_out";

/**
 * The statuses a person sets by hand (B1: `invoices.status` is "written only
 * by the system, except draft, cancelled, closed_unpaid"). Map it from the
 * stored `status` column when it holds one of these three, otherwise `null`.
 */
export type ManualInvoiceStatus = "draft" | "cancelled" | "closed_unpaid";

export type InvoiceBalanceStatus =
  | "draft"
  | "pending"
  | "partial"
  | "overdue"
  | "verifying"
  | "paid"
  | "closed_unpaid"
  | "cancelled";

/** The invoice's tenant, as far as the late fee cares. */
export type BalanceTenant = {
  /** `tenants.status`. `"inactive"` means the tenant has left. */
  status: string | null;
  /** `tenants.handover_date` (B1): key returned / room unlocked. Null until then. */
  handover_date: string | null;
  /** `tenants.tenancy_end_date` (B1): the date in their notice. */
  tenancy_end_date: string | null;
};

type BalanceInvoiceCommon = {
  id: string;
  /** Manual status override, or null when the status should come from money. */
  manual_status: ManualInvoiceStatus | null;
  /** A tenant's payment slip is waiting for admin review (B4 "flag"). */
  is_verifying: boolean;
  tenant: BalanceTenant;
};

/** A bill made on the new rules (from the 25 Oct 2026 cycle). */
export type V2BalanceInvoice = BalanceInvoiceCommon & {
  fee_model: "v2";
  kind: InvoiceKind;
  /** This bill's own charges only. Never includes another bill or any fee. */
  total_amount: number;
  due_date: string;
  /** First day the fee counts (normally the day after `due_date`). Null: no fee. */
  late_fee_start_date: string | null;
  late_fee_per_day: number | null;
  late_fee_paused_from: string | null;
};

/**
 * A bill made before the cut-over. Only columns every real legacy row has —
 * nothing added by the v2 migration apart from the `fee_model` tag itself.
 */
export type LegacyBalanceInvoice = BalanceInvoiceCommon & {
  fee_model: "legacy";
  /** As stored: may include a carried-in bill (`carry_forward_amount`). */
  total_amount: number | null;
  carry_forward_amount: number | null;
  due_date: string | null;
  /** The fee frozen when the bill was paid or carried. Final — never grows. */
  locked_late_fee_amount: number | null;
  /** Set once the frozen fee was moved onto another bill (or lost doing so). */
  late_fee_billed_at: string | null;
};

export type BalanceInvoice = V2BalanceInvoice | LegacyBalanceInvoice;

/** One `invoice_payment_allocations` row, with its batch's void state. */
export type BalanceAllocation = {
  invoice_id: string;
  amount: number;
  /** The batch's `paid_at` — when the money was transferred, not approved. */
  paid_at: string;
  /** The batch's `voided_at`. A voided batch's money never counts. */
  voided_at: string | null;
};

/** One `late_fee_waivers` row. */
export type BalanceWaiver = {
  invoice_id: string;
  amount: number;
  voided_at: string | null;
};

// ─── Output ──────────────────────────────────────────────────────────────────

export type InvoiceBalance = {
  /** This bill's own charges (rent, utilities, common fee, fees, discounts). */
  charges: number;
  /** min(paid, charges). Money covers charges before the fee. */
  chargesPaid: number;
  /** charges − chargesPaid. */
  chargesDue: number;
  /**
   * The day the fee stopped growing, as of `asOfBangkok`: the earliest of the
   * day payments covered `charges`, the pause date, or the handover date.
   * Null when no stop event has happened. Always null for legacy bills —
   * their fee is a frozen amount, not a day count (see `feeRunning`).
   */
  feeStopDate: string | null;
  /** `late_fee_start_date` .. (feeStopDate ?? asOf), inclusive, ≥ 0. Legacy: 0. */
  feeDays: number;
  /** v2: feeDays × late_fee_per_day. Legacy: the frozen amount, or 0. */
  feeAccrued: number;
  /** Non-voided waivers, capped at feeAccrued. */
  feeWaived: number;
  /** max(0, paid − charges). */
  feePaid: number;
  /** max(0, feeAccrued − feeWaived − feePaid). */
  feeDue: number;
  /** True while the fee is still growing day by day (v2 only). */
  feeRunning: boolean;
  /** charges + feeAccrued − feeWaived − paid, ≥ 0. Always chargesDue + feeDue. */
  amountDue: number;
  status: InvoiceBalanceStatus;
};

// ─── Dates ───────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A calendar date in Bangkok. A bare `YYYY-MM-DD` (a Postgres `date`) is taken
 * as already being a Bangkok date; anything else is parsed as a timestamp and
 * converted, so a transfer at 01:30 Bangkok time lands on its Bangkok day and
 * not the previous UTC one.
 */
const toBangkokDate = (value: string, field: string): string => {
  const text = String(value).trim();
  if (YMD.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invoice-balance: ${field} is not a valid date: ${value}`);
  }
  return bangkokYmd(parsed);
};

const ymdToUtcMs = (ymd: string): number => {
  const [year, month, day] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

/** Whole days from `from` to `to`, counting both ends. 0 or negative if `to` < `from`. */
const daysInclusive = (from: string, to: string): number =>
  Math.round((ymdToUtcMs(to) - ymdToUtcMs(from)) / DAY_MS) + 1;

const earliest = (dates: string[]): string | null =>
  dates.length === 0 ? null : dates.reduce((a, b) => (b < a ? b : a));

// ─── Pieces ──────────────────────────────────────────────────────────────────

/** Has this tenant left the room (handed over the key, or been settled)? */
const tenantHasLeft = (tenant: BalanceTenant): boolean =>
  tenant.status === "inactive" || tenant.handover_date != null;

type DatedPayment = { amount: number; date: string };

/**
 * The Bangkok date on which cumulative payments first reached `charges`, or
 * null if they never did. Only same-day totals matter, so payments are grouped
 * by date rather than ordered by timestamp.
 */
const dateChargesCovered = (
  payments: DatedPayment[],
  charges: number,
): string | null => {
  if (charges <= 0) return null;
  const sorted = [...payments].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    cumulative = roundTo2(cumulative + sorted[i].amount);
    const lastOfDay = i === sorted.length - 1 || sorted[i + 1].date !== sorted[i].date;
    if (lastOfDay && cumulative >= charges) return sorted[i].date;
  }
  return null;
};

type FeeResult = {
  charges: number;
  feeStopDate: string | null;
  feeDays: number;
  feeAccrued: number;
  feeRunning: boolean;
};

const legacyFee = (invoice: LegacyBalanceInvoice): FeeResult => {
  const charges = Math.max(
    0,
    roundTo2(toNumber(invoice.total_amount) - toNumber(invoice.carry_forward_amount)),
  );
  const frozen = invoice.locked_late_fee_amount;
  const feeAccrued =
    !tenantHasLeft(invoice.tenant) &&
    invoice.late_fee_billed_at == null &&
    frozen != null
      ? Math.max(0, roundTo2(toNumber(frozen)))
      : 0;
  return { charges, feeStopDate: null, feeDays: 0, feeAccrued, feeRunning: false };
};

const v2Fee = (
  invoice: V2BalanceInvoice,
  payments: DatedPayment[],
  asOf: string,
): FeeResult => {
  const charges = Math.max(0, roundTo2(toNumber(invoice.total_amount)));
  const rate = Math.max(0, toNumber(invoice.late_fee_per_day));
  const start = invoice.late_fee_start_date
    ? toBangkokDate(invoice.late_fee_start_date, "late_fee_start_date")
    : null;

  const stops: string[] = [];
  const covered = dateChargesCovered(payments, charges);
  if (covered) stops.push(covered);
  if (invoice.late_fee_paused_from) {
    stops.push(toBangkokDate(invoice.late_fee_paused_from, "late_fee_paused_from"));
  }

  const left = tenantHasLeft(invoice.tenant);
  let tenantStopKnown = true;
  if (left) {
    const tenantDates = [invoice.tenant.handover_date, invoice.tenant.tenancy_end_date]
      .filter((d): d is string => d != null)
      .map((d) => toBangkokDate(d, "tenant move-out date"));
    const tenantStop = earliest(tenantDates);
    if (tenantStop) stops.push(tenantStop);
    else tenantStopKnown = false;
  }

  // A stop dated after the as-of date hasn't happened yet as of that date.
  const feeStopDate = earliest(stops.filter((d) => d <= asOf));

  const accrues =
    invoice.kind !== "move_out" &&
    rate > 0 &&
    charges > 0 &&
    // A former tenant with no recorded leaving date: decision A drops a
    // leaving tenant's fees, and there is no day to stop the count on, so
    // none accrues rather than one growing forever.
    tenantStopKnown;

  if (!accrues || start === null) {
    return { charges, feeStopDate, feeDays: 0, feeAccrued: 0, feeRunning: false };
  }

  const feeDays = Math.max(0, daysInclusive(start, feeStopDate ?? asOf));
  return {
    charges,
    feeStopDate,
    feeDays,
    feeAccrued: roundTo2(feeDays * rate),
    feeRunning: feeStopDate === null && asOf >= start,
  };
};

const resolveStatus = (
  invoice: BalanceInvoice,
  amountDue: number,
  paid: number,
  asOf: string,
): InvoiceBalanceStatus => {
  // Manual states first (terminal ones before draft), then the slip flag.
  if (invoice.manual_status === "cancelled") return "cancelled";
  if (invoice.manual_status === "closed_unpaid") return "closed_unpaid";
  if (invoice.manual_status === "draft") return "draft";
  if (invoice.is_verifying) return "verifying";

  if (amountDue <= 0) return "paid";
  const dueDate = invoice.due_date ? toBangkokDate(invoice.due_date, "due_date") : null;
  if (dueDate !== null && asOf > dueDate) return "overdue";
  return paid > 0 ? "partial" : "pending";
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * What one bill owes as of `asOfBangkok` (a `YYYY-MM-DD` Bangkok date).
 *
 * `allocations` and `waivers` must belong to this invoice; a row for another
 * invoice throws rather than being silently counted. Voided rows are skipped,
 * and payments transferred after `asOfBangkok` are ignored, so the same call
 * answers "what was owed on the transfer date" for the payment screen.
 */
export function getInvoiceBalance(
  invoice: BalanceInvoice,
  allocations: readonly BalanceAllocation[],
  waivers: readonly BalanceWaiver[],
  asOfBangkok: string,
): InvoiceBalance {
  if (!YMD.test(asOfBangkok)) {
    throw new Error(
      `invoice-balance: asOfBangkok must be a YYYY-MM-DD date, got ${asOfBangkok}`,
    );
  }
  const asOf = asOfBangkok;

  for (const row of allocations) {
    if (row.invoice_id !== invoice.id) {
      throw new Error(
        `invoice-balance: allocation for invoice ${row.invoice_id} passed to invoice ${invoice.id}`,
      );
    }
  }
  for (const row of waivers) {
    if (row.invoice_id !== invoice.id) {
      throw new Error(
        `invoice-balance: waiver for invoice ${row.invoice_id} passed to invoice ${invoice.id}`,
      );
    }
  }

  const payments: DatedPayment[] = allocations
    .filter((row) => row.voided_at == null)
    .map((row) => ({
      amount: toNumber(row.amount),
      date: toBangkokDate(row.paid_at, "allocation paid_at"),
    }))
    .filter((row) => row.date <= asOf);
  const paid = Math.max(
    0,
    roundTo2(payments.reduce((sum, row) => sum + row.amount, 0)),
  );

  let fee: FeeResult;
  if (invoice.fee_model === "legacy") {
    fee = legacyFee(invoice);
  } else if (invoice.fee_model === "v2") {
    fee = v2Fee(invoice, payments, asOf);
  } else {
    // Rows come from the database; guard against an untagged or unknown model.
    throw new Error(
      `invoice-balance: unknown fee_model ${(invoice as { fee_model?: unknown }).fee_model} on invoice ${(invoice as { id?: unknown }).id}`,
    );
  }

  const { charges, feeAccrued } = fee;
  const waiverTotal = roundTo2(
    waivers
      .filter((row) => row.voided_at == null)
      .reduce((sum, row) => sum + Math.max(0, toNumber(row.amount)), 0),
  );
  const feeWaived = Math.min(waiverTotal, feeAccrued);

  const chargesPaid = Math.min(paid, charges);
  const chargesDue = roundTo2(charges - chargesPaid);
  const feePaid = Math.max(0, roundTo2(paid - charges));
  const feeDue = Math.max(0, roundTo2(feeAccrued - feeWaived - feePaid));
  const amountDue = Math.max(0, roundTo2(charges + feeAccrued - feeWaived - paid));

  return {
    charges,
    chargesPaid,
    chargesDue,
    feeStopDate: fee.feeStopDate,
    feeDays: fee.feeDays,
    feeAccrued,
    feeWaived,
    feePaid,
    feeDue,
    feeRunning: fee.feeRunning,
    amountDue,
    status: resolveStatus(invoice, amountDue, paid, asOf),
  };
}

export type TenantBalanceRow = {
  invoice: BalanceInvoice;
  balance: InvoiceBalance;
  /**
   * Whether this bill counts toward the tenant's total. False for `draft`
   * (not sent), `cancelled` and `closed_unpaid` (nothing to collect). A bill
   * awaiting slip review still counts: the money isn't recorded yet.
   */
  includedInTotal: boolean;
};

export type TenantBalance = {
  /** One row per bill, oldest due date first (bills with no due date first). */
  rows: TenantBalanceRow[];
  /** Sum of `amountDue` over the included rows. Each bill counted once. */
  amountDue: number;
};

const EXCLUDED_FROM_TOTAL: ReadonlySet<InvoiceBalanceStatus> = new Set([
  "draft",
  "cancelled",
  "closed_unpaid",
]);

/**
 * A tenant's bills side by side plus what they owe in total — the LINE view
 * (this month's bill next to older unpaid ones, never added into it) and the
 * payment screen. Takes the tenant's invoices and the allocation/waiver rows
 * for them as flat lists, the way they come back from three queries; each row
 * is routed to its own bill by `invoice_id`. A row naming a bill that isn't in
 * `invoices` throws, rather than being quietly dropped from the total.
 */
export function getTenantBalance(
  invoices: readonly BalanceInvoice[],
  allocations: readonly BalanceAllocation[],
  waivers: readonly BalanceWaiver[],
  asOfBangkok: string,
): TenantBalance {
  const allocationsById = new Map<string, BalanceAllocation[]>();
  const waiversById = new Map<string, BalanceWaiver[]>();
  for (const invoice of invoices) {
    if (allocationsById.has(invoice.id)) {
      throw new Error(`invoice-balance: invoice ${invoice.id} passed twice`);
    }
    allocationsById.set(invoice.id, []);
    waiversById.set(invoice.id, []);
  }
  for (const row of allocations) {
    const bucket = allocationsById.get(row.invoice_id);
    if (!bucket) {
      throw new Error(
        `invoice-balance: allocation for invoice ${row.invoice_id}, which is not in this tenant's list`,
      );
    }
    bucket.push(row);
  }
  for (const row of waivers) {
    const bucket = waiversById.get(row.invoice_id);
    if (!bucket) {
      throw new Error(
        `invoice-balance: waiver for invoice ${row.invoice_id}, which is not in this tenant's list`,
      );
    }
    bucket.push(row);
  }

  const rows: TenantBalanceRow[] = invoices.map((invoice) => {
    const balance = getInvoiceBalance(
      invoice,
      allocationsById.get(invoice.id) ?? [],
      waiversById.get(invoice.id) ?? [],
      asOfBangkok,
    );
    return {
      invoice,
      balance,
      includedInTotal: !EXCLUDED_FROM_TOTAL.has(balance.status),
    };
  });

  const dueKey = (row: TenantBalanceRow) =>
    row.invoice.due_date ? toBangkokDate(row.invoice.due_date, "due_date") : "";
  rows.sort((a, b) => {
    const left = dueKey(a);
    const right = dueKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const amountDue = roundTo2(
    rows
      .filter((row) => row.includedInTotal)
      .reduce((sum, row) => sum + row.balance.amountDue, 0),
  );

  return { rows, amountDue };
}
