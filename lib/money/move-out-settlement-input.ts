/**
 * Glue between the move-out data we read and the two things that consume it:
 * `planMoveOutSettlement` (the arithmetic) and the `final_settle_move_out` RPC
 * (the atomic write). Pure — no database — so the admin preview and the API
 * route build the plan from exactly the same rules.
 *
 *  - rent period: whole billing months since the last non-draft invoice, plus
 *    the trailing days at `dailyRentRate` (the one canonical daily rate)
 *  - utilities: previous reading = the latest `meter_readings` row (read by the
 *    caller; this module never writes it), current reading = the move-out reading
 *  - held credit: the `tenant_credits` ledger per bucket once it has rows,
 *    otherwise the tenant's deposit / advance-rent columns
 *  - final invoice money columns: derived through `toInvoiceMoneyColumns`
 */
import { dailyRentRate } from "@/lib/invoice-utils";
import { getInvoiceOwnOutstanding } from "@/lib/invoice-ledger";
import { toInvoiceMoneyColumns, type InvoiceCharges } from "@/lib/invoice-total";
import type { MoveOutSettlementInput, MoveOutSettlementPlan } from "./settlement";

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Open statuses whose own outstanding counts as debt at move-out. */
export const MOVE_OUT_DEBT_STATUSES = ["draft", "pending", "partial", "overdue", "verifying"] as const;

export type HeldCredit = { deposit: number; advance: number; unapplied: number };

/**
 * What we hold for the tenant. The ledger is authoritative for a bucket once it
 * has any row for it; before that the tenant columns are. Unapplied overpayment
 * credit only ever lives in the ledger. Mirrors the HELD_MISMATCH check in
 * final_settle_move_out.
 */
export function resolveHeldCredit(
  tenant: { security_deposit_amount?: number | null; advance_rent_amount?: number | null },
  ledgerRows: Array<{ bucket: string; amount: number | string | null }>,
): HeldCredit {
  const rowsFor = (bucket: string) => ledgerRows.filter((r) => r.bucket === bucket);
  const sum = (rows: Array<{ amount: number | string | null }>) =>
    Math.round(rows.reduce((s, r) => s + num(r.amount), 0) * 100) / 100;
  const deposit = rowsFor("deposit");
  const advance = rowsFor("advance");
  return {
    deposit: deposit.length > 0 ? sum(deposit) : num(tenant.security_deposit_amount),
    advance: advance.length > 0 ? sum(advance) : num(tenant.advance_rent_amount),
    unapplied: sum(rowsFor("unapplied")),
  };
}

export type MoveOutRentPeriod = {
  /** Start of the final invoice: end of the last billed period. */
  startDate: string;
  fullMonths: number;
  prorateDays: number;
  dailyRate: number;
  fullMonthRent: number;
  proratedRent: number;
};

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (value: string) => {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/**
 * Rent owed for the period after the last billed invoice, up to the move-out
 * date: whole months at the monthly rent, then the remaining days at
 * `dailyRentRate(monthlyRent)`. `useProrate=false` charges no final-period rent.
 */
export function computeMoveOutRentPeriod(args: {
  lastBilledEndDate: string | null;
  moveOutDate: string;
  billingDay: number;
  monthlyRent: number;
  useProrate: boolean;
}): MoveOutRentPeriod {
  const moveOut = parseYmd(args.moveOutDate);
  const billingDay = Math.max(1, Math.min(28, Math.floor(num(args.billingDay)) || 25));
  const start = args.lastBilledEndDate
    ? parseYmd(args.lastBilledEndDate)
    : new Date(moveOut.getFullYear(), moveOut.getMonth() - 1, billingDay);

  let fullMonths = 0;
  let periodStart = new Date(start);
  let nextEnd = new Date(start);
  nextEnd.setMonth(nextEnd.getMonth() + 1);
  while (nextEnd <= moveOut) {
    fullMonths++;
    periodStart = new Date(nextEnd);
    nextEnd.setMonth(nextEnd.getMonth() + 1);
  }
  const prorateDays = Math.max(
    0,
    Math.floor(
      (Date.UTC(moveOut.getFullYear(), moveOut.getMonth(), moveOut.getDate()) -
        Date.UTC(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate())) /
        86400000,
    ),
  );
  const monthlyRent = num(args.monthlyRent);
  const dailyRate = dailyRentRate(monthlyRent);
  return {
    startDate: ymd(start),
    fullMonths,
    prorateDays,
    dailyRate,
    fullMonthRent: args.useProrate ? monthlyRent * fullMonths : 0,
    proratedRent: args.useProrate ? dailyRate * prorateDays : 0,
  };
}

export type OpenInvoiceRow = {
  id: string;
  start_date?: string | null;
  status?: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  carry_forward_amount?: number | null;
};

export type MoveOutFeeLineInput = { label: string; amount: number; reason?: string };

export type BuildPlanInputArgs = {
  period: MoveOutRentPeriod;
  previousElectricity: number;
  currentElectricity: number;
  previousWater: number;
  currentWater: number;
  electricityRate: number;
  waterRate: number;
  feeLines: MoveOutFeeLineInput[];
  openInvoices: OpenInvoiceRow[];
  held: HeldCredit;
  forfeitAmount: number;
  forfeitReason?: string | null;
  /** abandon_room: no final bill, only the existing debt. */
  debtOnly?: boolean;
};

export function buildMoveOutPlanInput(args: BuildPlanInputArgs): MoveOutSettlementInput {
  const debts = args.openInvoices
    .filter((inv) => (MOVE_OUT_DEBT_STATUSES as readonly string[]).includes(String(inv.status ?? "")))
    .map((inv) => ({
      invoiceId: String(inv.id),
      periodStart: String(inv.start_date ?? "").slice(0, 10),
      outstanding: getInvoiceOwnOutstanding(inv),
    }));
  const base: MoveOutSettlementInput = {
    proratedRent: 0,
    outstandingDebts: debts,
    securityDeposit: args.held.deposit,
    advanceRent: args.held.advance,
    unappliedCredit: args.held.unapplied,
    depositForfeiture: {
      forfeitAmount: num(args.forfeitAmount),
      reason: args.forfeitReason ?? undefined,
    },
  };
  if (args.debtOnly) return base;
  return {
    ...base,
    fullMonthRent: args.period.fullMonthRent,
    proratedRent: args.period.proratedRent,
    electricity: {
      previousReading: num(args.previousElectricity),
      currentReading: num(args.currentElectricity),
      rate: num(args.electricityRate),
    },
    water: {
      previousReading: num(args.previousWater),
      currentReading: num(args.currentWater),
      rate: num(args.waterRate),
    },
    // A fee line's label is its documented reason (what the admin typed).
    otherCharges: args.feeLines
      .filter((l) => num(l.amount) !== 0)
      .map((l) => ({ label: l.label.trim(), amount: num(l.amount), reason: (l.reason ?? l.label).trim() })),
  };
}

/** The final invoice's charges, from the plan. Credit used on the final bill is its discount. */
export function finalInvoiceCharges(plan: MoveOutSettlementPlan): InvoiceCharges {
  return {
    rent: plan.fullMonthRent,
    water: plan.water,
    electricity: plan.electricity,
    commonFee: 0,
    nativeLateFee: 0,
    lateFeeItems: 0,
    fees: Math.round((plan.proratedRent + plan.otherChargesTotal) * 100) / 100,
    carryForward: 0,
    discount: plan.finalBillPaidFromCredit,
  };
}

export type BuildRpcArgs = {
  tenantId: string;
  roomId: string;
  idempotencyKey: string;
  moveOutDate: string;
  createdBy: string | null;
  paidAt: string;
  plan: MoveOutSettlementPlan;
  period: MoveOutRentPeriod;
  openInvoices: OpenInvoiceRow[];
  source: "credit" | "abandon_room";
  /** null = no final invoice (abandon_room). */
  finalInvoice: null | {
    id: string;
    issueDate: string;
    dueDate: string;
    notes: string;
    meter: {
      electricityStart: number;
      electricityEnd: number;
      waterStart: number;
      waterEnd: number;
    };
  };
};

/** The exact `p` argument for public.final_settle_move_out. */
export function buildFinalSettlementRpcPayload(args: BuildRpcArgs) {
  const { plan } = args;
  const byId = new Map(args.openInvoices.map((inv) => [String(inv.id), inv]));
  const debts = plan.debtPayments
    .filter((d) => d.paidFromCredit > 0)
    .map((d) => ({ invoice_id: d.invoiceId, expected_paid_amount: num(byId.get(d.invoiceId)?.paid_amount) }));

  let invoice: Record<string, unknown> | null = null;
  let charges: InvoiceCharges | null = null;
  if (args.finalInvoice) {
    charges = finalInvoiceCharges(plan);
    const columns = toInvoiceMoneyColumns(charges);
    const breakdown: Array<Record<string, unknown>> = [];
    if (plan.proratedRent > 0) {
      breakdown.push({
        item_type: "prorate_rent",
        label: `ค่าเช่าส่วนเกิน ${args.period.prorateDays} วัน (Pro-rate)`,
        amount: plan.proratedRent,
      });
    }
    for (const c of plan.otherCharges) {
      breakdown.push({ item_type: "custom", label: c.label, amount: c.amount, reason: c.reason });
    }
    invoice = {
      id: args.finalInvoice.id,
      start_date: args.period.startDate,
      end_date: args.moveOutDate,
      issue_date: args.finalInvoice.issueDate,
      due_date: args.finalInvoice.dueDate,
      rent_amount: charges.rent,
      water_bill: charges.water,
      electricity_bill: charges.electricity,
      common_fee: charges.commonFee,
      ...columns,
      additional_fees_breakdown: breakdown,
      // The credit used on the final bill is recorded as a protected discount line (source 'move_out_credit'),
      // so a later invoice edit or recompute from the breakdown cannot erase it and make the tenant owe the
      // already-consumed deposit again (finding 167). It is not cash.
      discount_breakdown:
        plan.finalBillPaidFromCredit > 0
          ? [{ source: "move_out_credit", label: "หักจากเงินประกัน/ค่าเช่าล่วงหน้าที่ถืออยู่ (ไม่ใช่เงินสด)", amount: plan.finalBillPaidFromCredit }]
          : [],
      electricity_reading_start: args.finalInvoice.meter.electricityStart,
      electricity_reading_end: args.finalInvoice.meter.electricityEnd,
      water_reading_start: args.finalInvoice.meter.waterStart,
      water_reading_end: args.finalInvoice.meter.waterEnd,
      notes: args.finalInvoice.notes,
    };
  }

  return {
    tenant_id: args.tenantId,
    room_id: args.roomId,
    idempotency_key: args.idempotencyKey,
    move_out_date: args.moveOutDate,
    created_by: args.createdBy,
    paid_at: args.paidAt,
    source: args.source,
    settlement: plan,
    debts,
    invoice,
    charges,
  };
}
