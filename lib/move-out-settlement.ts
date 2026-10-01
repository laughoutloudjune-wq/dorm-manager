/**
 * Move-out settlement planning — pure, no database calls.
 *
 * Mirrors, line for line, what the Postgres function `settle_move_out` does
 * with a tenant's deposit and advance rent (docs/audit/2026-09-29-late-fee-and-overdue-design.md
 * A5 / B5, decisions A and B), so the preview an admin confirms is the
 * settlement that actually happens:
 *
 *   1. credit = (forfeit ? 0 : max(0, deposit)) + max(0, advance), to 2 dp;
 *   2. the move-out bill takes min(credit, max(0, total − Σ allocations));
 *   3. every other open bill, ordered by due_date, start_date, created_at, id
 *      (Postgres ASC, NULLS LAST), has its whole `fee_due` waived (decision A)
 *      and takes min(remaining credit, charges_due) (decision B);
 *   4. whatever credit is left is a pending refund.
 *
 * The `p_older_bills` lines themselves (charges_due / fee_due and the two
 * compare-and-swap stamps) come from the balance engine; `olderBillPlanLine`
 * turns one engine result into the line the function expects.
 */
import { roundTo2 } from "./format";

/** One `p_older_bills` element, exactly as `settle_move_out` reads it. */
export type MoveOutOlderBillLine = {
  invoice_id: string;
  charges_due: number;
  fee_due: number;
  expected_paid_sum: number;
  expected_waived_sum: number;
};

/** What `olderBillPlanLine` needs to know about one open older bill. */
export type OlderBillFacts = {
  invoiceId: string;
  feeModel: "legacy" | "v2";
  /** `invoices.total_amount` as stored. */
  totalAmount: number;
  /** `invoices.paid_amount` as stored (the running-balance cache). */
  storedPaidAmount: number;
  /** Engine (`getInvoiceBalance`, as of today Bangkok) chargesDue. */
  engineChargesDue: number;
  /** Engine feeDue. */
  engineFeeDue: number;
  /** Σ non-voided allocations, any date — what `_dm_paid_sum(id, null)` returns. */
  paidSum: number;
  /** Σ max(0, amount) of non-voided waivers — what `_dm_waived_sum(id)` returns. */
  waivedSum: number;
};

/**
 * The `p_older_bills` line for one open older bill.
 *
 * `charges_due` is the engine's figure, additionally capped at:
 *   - `total_amount − Σ allocations` — the function rejects anything above it
 *     (`[bad_plan]`), and it only differs from the engine when a payment is
 *     dated after today;
 *   - legacy only: `total_amount − paid_amount`. Some legacy rows have
 *     `paid_amount` > Σ allocations (money recorded before the allocation
 *     table existed). The engine counts allocations only and would call such a
 *     bill unpaid, so the deposit would pay for it a second time. Same guard
 *     `record_payment`'s split builder applies (invoices actions route).
 * Lowering `charges_due` is always accepted by the function; it only checks
 * upper bounds.
 */
export function olderBillPlanLine(facts: OlderBillFacts): MoveOutOlderBillLine {
  let chargesDue = Math.max(0, facts.engineChargesDue);
  chargesDue = Math.min(chargesDue, Math.max(0, facts.totalAmount - facts.paidSum));
  if (facts.feeModel === "legacy") {
    chargesDue = Math.min(chargesDue, Math.max(0, facts.totalAmount - facts.storedPaidAmount));
  }
  return {
    invoice_id: facts.invoiceId,
    charges_due: roundTo2(chargesDue),
    fee_due: roundTo2(Math.max(0, facts.engineFeeDue)),
    expected_paid_sum: roundTo2(facts.paidSum),
    expected_waived_sum: roundTo2(facts.waivedSum),
  };
}

/** Ordering keys of an older bill — the columns `settle_move_out` sorts by. */
export type OlderBillOrderKeys = {
  invoiceId: string;
  dueDate: string | null;
  startDate: string | null;
  createdAt: string | null;
};

const compareNullsLast = (a: string | null, b: string | null): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * A timestamptz as a sortable key: epoch ms plus the full fractional second,
 * so two rows created in the same millisecond still order by microseconds as
 * Postgres orders them.
 */
const timestampKey = (value: string | null): [number, string] | null => {
  if (value == null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`move-out-settlement: created_at is not a valid timestamp: ${value}`);
  }
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return [ms, fraction.padEnd(9, "0")];
};

/**
 * `order by i.due_date, i.start_date, i.created_at, i.id` — Postgres ASC puts
 * NULLs last; `uuid` compares bytewise, which is lowercase-hex string order.
 */
export function compareOlderBills(a: OlderBillOrderKeys, b: OlderBillOrderKeys): number {
  const byDue = compareNullsLast(a.dueDate, b.dueDate);
  if (byDue !== 0) return byDue;
  const byStart = compareNullsLast(a.startDate, b.startDate);
  if (byStart !== 0) return byStart;
  const ka = timestampKey(a.createdAt);
  const kb = timestampKey(b.createdAt);
  if (ka == null || kb == null) {
    if (ka != null) return -1;
    if (kb != null) return 1;
  } else if (ka[0] !== kb[0]) {
    return ka[0] - kb[0];
  } else if (ka[1] !== kb[1]) {
    return ka[1] < kb[1] ? -1 : 1;
  }
  const ia = a.invoiceId.toLowerCase();
  const ib = b.invoiceId.toLowerCase();
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export type SettlementMoveOutBill = {
  invoiceId: string;
  /** `invoices.total_amount` of the move-out bill. */
  totalAmount: number;
  /** Σ non-voided allocations on it (`_dm_paid_sum`). */
  paidSum: number;
};

export type SettlementPlanInput = {
  securityDeposit: number | null;
  advanceRent: number | null;
  forfeitDeposit: boolean;
  /** Null when `prepare_move_out_bill` has not run yet (settle would refuse). */
  moveOutBill: SettlementMoveOutBill | null;
  olderBills: ReadonlyArray<OlderBillOrderKeys & { line: MoveOutOlderBillLine }>;
};

export type SettlementPlanOlderBill = {
  invoiceId: string;
  chargesDue: number;
  /** The whole fee_due — waived by settle regardless of credit (decision A). */
  feeWaived: number;
  /** Credit settle will allocate to this bill. */
  creditApplied: number;
  /** charges_due − creditApplied: still owed after settlement, with no fee. */
  remainingDue: number;
};

export type SettlementPlan = {
  credit: { deposit: number; advanceRent: number; total: number };
  moveOutBill: {
    invoiceId: string;
    amountDue: number;
    creditApplied: number;
    remainingDue: number;
  } | null;
  /** In the order settle consumes credit. */
  olderBills: SettlementPlanOlderBill[];
  totalFeeWaived: number;
  creditApplied: number;
  refund: number;
  /** Still owed across all bills after settlement. */
  remainingOwed: number;
};

const toCents = (value: number) => Math.round(roundTo2(value) * 100);
const fromCents = (cents: number) => cents / 100;

/** The settlement `settle_move_out` would carry out on these inputs. */
export function planMoveOutSettlement(input: SettlementPlanInput): SettlementPlan {
  const deposit = input.forfeitDeposit ? 0 : Math.max(0, input.securityDeposit ?? 0);
  const advance = Math.max(0, input.advanceRent ?? 0);
  const creditCents = toCents(deposit + advance);
  let remaining = creditCents;
  let remainingOwed = 0;

  let moveOutBill: SettlementPlan["moveOutBill"] = null;
  if (input.moveOutBill) {
    const dueCents = Math.max(
      0,
      toCents(input.moveOutBill.totalAmount - input.moveOutBill.paidSum),
    );
    const take = Math.min(remaining, dueCents);
    remaining -= take;
    remainingOwed += dueCents - take;
    moveOutBill = {
      invoiceId: input.moveOutBill.invoiceId,
      amountDue: fromCents(dueCents),
      creditApplied: fromCents(take),
      remainingDue: fromCents(dueCents - take),
    };
  }

  let feeWaivedCents = 0;
  const olderBills = [...input.olderBills].sort(compareOlderBills).map((bill) => {
    const chargesCents = toCents(bill.line.charges_due);
    const feeCents = Math.max(0, toCents(bill.line.fee_due));
    feeWaivedCents += feeCents;
    const take = Math.max(0, Math.min(remaining, chargesCents));
    remaining -= take;
    remainingOwed += chargesCents - take;
    return {
      invoiceId: bill.invoiceId,
      chargesDue: fromCents(chargesCents),
      feeWaived: fromCents(feeCents),
      creditApplied: fromCents(take),
      remainingDue: fromCents(chargesCents - take),
    };
  });

  return {
    credit: {
      deposit: roundTo2(deposit),
      advanceRent: roundTo2(advance),
      total: fromCents(creditCents),
    },
    moveOutBill,
    olderBills,
    totalFeeWaived: fromCents(feeWaivedCents),
    creditApplied: fromCents(creditCents - remaining),
    refund: fromCents(remaining),
    remainingOwed: fromCents(remainingOwed),
  };
}
