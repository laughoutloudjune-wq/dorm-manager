/**
 * Invoice-specific utility functions extracted from InvoicesPageView.tsx.
 * These are pure functions that don't depend on React state.
 */
import { toNumber, toLocalDateString, formatMoney } from "./format";

// ── Date helpers ──────────────────────────────────────────────────────────────

export const parseDateOnly = (value: string) => {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

export const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const diffDaysInclusive = (start: Date, end: Date) => {
  const left = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const right = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((right - left) / 86400000) + 1;
};

export const fromDateText = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

export const isSameMonthAndYear = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();

// ── Formatting helpers ────────────────────────────────────────────────────────

export const shortInvoiceId = (value: string | null | undefined) => {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  return text.slice(0, 8).toUpperCase();
};

export const formatDateThai = (dateString: string) =>
  new Date(dateString).toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

export const formatPeriodLabel = (dateString: string | null | undefined) => {
  const text = String(dateString ?? "");
  if (!text || text.length < 7) return "-";
  const [year, month] = text.slice(0, 7).split("-");
  return `${month}/${year}`;
};

export const extractAllSlipUrls = (invoice: { slip_url?: string | null; payment_history?: any[] | null }): string[] => {
  const urls = new Set<string>();
  if (invoice.slip_url) urls.add(invoice.slip_url);
  const history = Array.isArray(invoice.payment_history) ? invoice.payment_history : [];
  for (const item of history) {
    if (item?.slip_url) urls.add(item.slip_url);
  }
  return Array.from(urls);
};

export const parseMoneyString = (value: string | null | undefined) => {
  const cleaned = String(value ?? "")
    .replace(/[^\d.-]/g, "")
    .trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const monthStartFromDate = (dateString: string) => {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
};

// ── Invoice status helpers ────────────────────────────────────────────────────

export const statusLabelThai = (status: string) => {
  if (status === "draft") return "ฉบับร่าง";
  if (status === "pending") return "รอชำระ";
  if (status === "partial") return "ชำระบางส่วน";
  if (status === "verifying") return "รอตรวจสอบ";
  if (status === "paid") return "ชำระแล้ว";
  if (status === "overdue") return "เกินกำหนด";
  if (status === "cancelled") return "ยกเลิก";
  return status;
};

export const isInvoiceDetailEditable = (status: string) => 
  ["draft", "pending", "partial", "overdue"].includes(status);

// Invoice status → colour, in ONE place. There used to be three independent
// maps for this (`statusVariant` below, plus the pill and row helpers here) and
// they disagreed: `statusVariant` classified `partial` as warning and
// `verifying` as info, while the pill painted them orange and sky. A status now
// resolves to a single semantic tone, and the pill/row helpers derive from it,
// so a badge and its table row can never drift apart again. `statusVariant`
// values are Badge variant names — keep them in sync with components/ui/Badge.
export const statusPillClass = (status: string) => {
  const variant = statusVariant[status as keyof typeof statusVariant] ?? "default";
  const byVariant: Record<string, string> = {
    default: "border-slate-200 bg-slate-50 text-slate-700",
    warning: "border-warning-200/70 bg-warning-50 text-warning-800",
    info: "border-primary-200/70 bg-primary-50 text-primary-700",
    success: "border-success-200/70 bg-success-50 text-success-700",
    danger: "border-danger-200/70 bg-danger-50 text-danger-700",
  };
  return byVariant[variant] ?? byVariant.default;
};

export const statusRowClass = (status: string) => {
  const variant = statusVariant[status as keyof typeof statusVariant] ?? "default";
  const byVariant: Record<string, string> = {
    default: "",
    warning: "bg-warning-50/40",
    info: "bg-primary-50/40",
    success: "bg-success-50/40",
    danger: "bg-danger-50/40",
  };
  return byVariant[variant] ?? "";
};

// ── Billing day helpers ───────────────────────────────────────────────────────

export const clampDay = (value: number | null | undefined, min = 1, max = 28) => {
  const day = toNumber(value ?? min);
  if (day < min) return min;
  if (day > max) return max;
  return Math.floor(day);
};

export const computeDateByDayInMonth = (baseDate: string, day: number | null | undefined) => {
  const date = new Date(baseDate);
  const normalized = clampDay(day ?? 1);
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth(), normalized));
};

export const computeDateByDayNextMonth = (baseDate: string, day: number | null | undefined) => {
  const date = new Date(baseDate);
  const normalized = clampDay(day ?? 1);
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth() + 1, normalized));
};

// ── Fee / line-item helpers ───────────────────────────────────────────────────

export type FeeLineItem = {
  detail: string;
  unit: number;
  price_per_unit: number;
  total_amount: number;
};

export type CarryForwardItem = FeeLineItem & {
  source_invoice_id?: string | null;
};

export type LateFeeLineItem = FeeLineItem & {
  source_invoice_id?: string | null;
  snapshot_as_of?: string | null;
  days_overdue?: number;
  daily_rate?: number;
  original_amount?: number;
  waived_amount?: number;
};

export type TransferBreakdownItem = {
  label: string;
  value: string;
  amount?: number | null;
  editable?: boolean;
  kind?: "old_rent" | "new_rent" | "old_water" | "new_water" | "old_elec" | "new_elec" | null;
};

export const emptyFeeItem = (): FeeLineItem => ({
  detail: "",
  unit: 1,
  price_per_unit: 0,
  total_amount: 0,
});

export const emptyCarryForwardItem = (): CarryForwardItem => ({
  detail: "",
  unit: 1,
  price_per_unit: 0,
  total_amount: 0,
  source_invoice_id: null,
});

export const emptyLateFeeItem = (): LateFeeLineItem => ({
  detail: "",
  unit: 0,
  price_per_unit: 0,
  total_amount: 0,
  source_invoice_id: null,
  snapshot_as_of: null,
  days_overdue: 0,
  daily_rate: 0,
  original_amount: 0,
  waived_amount: 0,
});

export const feeItemsTotal = (items: FeeLineItem[]) =>
  items.reduce((sum, item) => sum + toNumber(item.total_amount), 0);

export const ROUND_DOWN_DISCOUNT_LABEL = "ปัดเศษลง";

// ── Row classification helpers ────────────────────────────────────────────────

export const isTransferBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "transfer_detail";

export const isCarryForwardBreakdownRow = (row: any) => {
  const type = String(row?.item_type ?? row?.type ?? "").toLowerCase();
  if (type === "carry_forward") return true;
  const label = String(row?.detail ?? row?.label ?? "").toLowerCase();
  return label.includes("ยอดยกมา") || label.includes("ค้างชำระ");
};

export const isLateFeeBreakdownRow = (row: any) => {
  const type = String(row?.item_type ?? row?.type ?? "").toLowerCase();
  if (type === "late_fee_line") return true;
  const label = String(row?.detail ?? row?.label ?? "").toLowerCase();
  return label.includes("ค่าปรับล่าช้า") || label.includes("late fee");
};

export const toChargeFeeRows = (rows: any[]) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter(
    (row) =>
      !isTransferBreakdownRow(row) &&
      !isCarryForwardBreakdownRow(row) &&
      !isLateFeeBreakdownRow(row)
  );
};

export const toCarryForwardRows = (rows: any[]) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((row) => isCarryForwardBreakdownRow(row));
};

export const toLateFeeRows = (rows: any[]) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((row) => isLateFeeBreakdownRow(row));
};

export const toFeeItems = (rows: any[]): FeeLineItem[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map((row) => {
    const detail = String(row.detail ?? row.label ?? "");
    const unit = toNumber(row.unit ?? 1);
    const price_per_unit = toNumber(row.price_per_unit ?? row.rate ?? row.value ?? row.amount ?? 0);
    const total_amount =
      row.total_amount != null ? toNumber(row.total_amount) : unit * price_per_unit;
    return { detail, unit, price_per_unit, total_amount };
  });
};

export const toCarryForwardItems = (rows: any[]): CarryForwardItem[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map((row) => {
    const detail = String(row.detail ?? row.label ?? "");
    const unit = toNumber(row.unit ?? 1);
    const price_per_unit = toNumber(row.price_per_unit ?? row.rate ?? row.value ?? row.amount ?? 0);
    const total_amount =
      row.total_amount != null ? toNumber(row.total_amount) : unit * price_per_unit;
    return {
      detail,
      unit,
      price_per_unit,
      total_amount,
      source_invoice_id: row.source_invoice_id ?? null,
    };
  });
};

export const toLateFeeItems = (rows: any[]): LateFeeLineItem[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map((row) => {
    const unit = toNumber(row.unit ?? row.days_overdue ?? 0);
    const price_per_unit = toNumber(
      row.price_per_unit ?? row.daily_rate ?? row.rate ?? row.value ?? row.amount ?? 0
    );
    const original_amount =
      row.original_amount != null
        ? toNumber(row.original_amount)
        : row.total_amount != null
          ? toNumber(row.total_amount)
          : unit * price_per_unit;
    const waived_amount = toNumber(row.waived_amount ?? 0);
    const total_amount = Math.max(
      0,
      row.total_amount != null ? toNumber(row.total_amount) : original_amount - waived_amount
    );
    return {
      detail: String(row.detail ?? row.label ?? ""),
      unit,
      price_per_unit,
      total_amount,
      source_invoice_id: row.source_invoice_id ?? null,
      snapshot_as_of: row.snapshot_as_of ?? null,
      days_overdue: unit,
      daily_rate: price_per_unit,
      original_amount,
      waived_amount,
    };
  });
};

export const toTransferBreakdownItems = (rows: any[]): TransferBreakdownItem[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .filter((row) => isTransferBreakdownRow(row))
    .map((row) => {
      const label = String(row?.label ?? row?.detail ?? "").trim();
      const transferKindRaw = String(row?.transfer_kind ?? "").toLowerCase();
      const utilityKinds = ["old_water", "new_water", "old_elec", "new_elec"] as const;
      const inferredKind: TransferBreakdownItem["kind"] =
        transferKindRaw === "old_rent" || label.includes("ค่าเช่าห้องเดิม")
          ? "old_rent"
          : transferKindRaw === "new_rent" || label.includes("ค่าเช่าห้องใหม่")
            ? "new_rent"
            : (utilityKinds as readonly string[]).includes(transferKindRaw)
              ? (transferKindRaw as "old_water" | "new_water" | "old_elec" | "new_elec")
              : null;
      const isEditable = inferredKind === "old_rent" || inferredKind === "new_rent";
      const hasStoredAmount = row?.amount_value != null;
      return {
        label,
        value: String(row?.value ?? "").trim(),
        amount:
          hasStoredAmount
            ? toNumber(row.amount_value)
            : isEditable
              ? parseMoneyString(String(row?.value ?? ""))
              : null,
        editable: isEditable,
        kind: inferredKind,
      };
    })
    .filter((row) => row.label.length > 0 && row.value.length > 0);
};

// ── Billing calculation helpers ───────────────────────────────────────────────

export type AdditionalFee = {
  label: string;
  calc_type: "fixed" | "electricity_units" | "water_units";
  value: number;
};

export const buildRuleBreakdown = (
  rules: AdditionalFee[],
  elecUnits: number,
  waterUnits: number
) =>
  rules.map((fee) => {
    const rate = toNumber(fee.value);
    let amount = 0;
    if (fee.calc_type === "fixed") amount = rate;
    if (fee.calc_type === "electricity_units") amount = elecUnits * rate;
    if (fee.calc_type === "water_units") amount = waterUnits * rate;
    const unit =
      fee.calc_type === "electricity_units"
        ? elecUnits
        : fee.calc_type === "water_units"
          ? waterUnits
          : 1;
    return {
      label: fee.label,
      detail: fee.label,
      calc_type: fee.calc_type,
      rate,
      unit,
      price_per_unit: rate,
      total_amount: amount,
      amount,
    };
  });

/**
 * Canonical daily rent rate: monthly rent split over a fixed 30-day cycle,
 * rounded DOWN to a whole baht. This is the one true rounding convention for
 * all rent proration in the app (move-in, room transfer, move-out) — do not
 * introduce another divisor or leave the daily rate unrounded elsewhere.
 */
export const dailyRentRate = (monthlyRent: number) => Math.floor(toNumber(monthlyRent) / 30);

export const calculateProratedRentByBillingDay = (
  monthlyRent: number,
  moveInDateText: string | null | undefined,
  billingDayInput: number | null | undefined
) => {
  if (!moveInDateText) return null;
  const moveInDate = fromDateText(moveInDateText);
  const moveInDay = Math.min(Math.max(moveInDate.getDate(), 1), 30);
  const billingDay = Math.min(Math.max(toNumber(billingDayInput ?? 1), 1), 30);
  const dailyRaw = monthlyRent / 30;
  const dailyRounded = dailyRentRate(monthlyRent);
  const occupiedDays =
    moveInDay <= billingDay
      ? billingDay - moveInDay + 1
      : (30 - moveInDay + 1) + billingDay;
  const rentAmount = dailyRounded * occupiedDays;

  return {
    moveInDay,
    billingDay,
    dailyRaw,
    dailyRounded,
    occupiedDays,
    rentAmount,
    formulaText: `${monthlyRent.toLocaleString("th-TH")} / 30 = ${dailyRaw.toFixed(2)} -> ${dailyRounded.toLocaleString(
      "th-TH"
    )} x ${occupiedDays.toLocaleString("th-TH")} = ${rentAmount.toLocaleString("th-TH")} บาท`,
  };
};

export const calculateWaterBillWithMinimum = (
  waterUnits: number,
  waterRate: number,
  waterMinUnits: number,
  waterMinPrice: number
) => {
  const usageBill = waterUnits * waterRate;
  if (waterUnits <= waterMinUnits) {
    const minimumByUnits = waterMinUnits * waterRate;
    const minimumFloor = Math.max(waterMinPrice, minimumByUnits);
    return Math.max(usageBill, minimumFloor);
  }
  return usageBill;
};

export const calculateLateFeePreview = (
  lateFeeStartDate: string | null | undefined,
  lateFeePerDay: number | null | undefined,
  asOfDateText: string
) => {
  if (!lateFeeStartDate) return { days: 0, amount: 0 };
  const rate = Math.max(0, toNumber(lateFeePerDay));
  if (rate <= 0) return { days: 0, amount: 0 };
  const startDate = fromDateText(lateFeeStartDate);
  const asOfDate = fromDateText(asOfDateText);
  if (asOfDate < startDate) return { days: 0, amount: 0 };
  const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const asOfUtc = Date.UTC(asOfDate.getFullYear(), asOfDate.getMonth(), asOfDate.getDate());
  const days = Math.floor((asOfUtc - startUtc) / 86400000) + 1;
  return { days, amount: days * rate };
};

// ── Meter reading helpers ─────────────────────────────────────────────────────

export type MeterReadingRow = {
  electricity_usage: number | null;
  water_usage: number | null;
  usage?: number | null;
  previous_electricity?: number | null;
  current_electricity?: number | null;
  previous_water?: number | null;
  current_water?: number | null;
  previous_reading?: number | null;
  current_reading?: number | null;
};

export const resolveElectricityUsage = (reading: MeterReadingRow | null | undefined) => {
  if (!reading) return 0;
  if (reading.electricity_usage != null) return toNumber(reading.electricity_usage);
  if (reading.current_electricity != null && reading.previous_electricity != null) {
    return toNumber(reading.current_electricity) - toNumber(reading.previous_electricity);
  }
  return 0;
};

export const resolveWaterUsage = (reading: MeterReadingRow | null | undefined) => {
  if (!reading) return 0;
  if (reading.water_usage != null) return toNumber(reading.water_usage);
  if (reading.usage != null) return toNumber(reading.usage);
  if (reading.current_water != null && reading.previous_water != null) {
    return toNumber(reading.current_water) - toNumber(reading.previous_water);
  }
  if (reading.current_reading != null && reading.previous_reading != null) {
    return toNumber(reading.current_reading) - toNumber(reading.previous_reading);
  }
  return 0;
};

// When no meter_readings row is found for the invoice's room/month (e.g. the
// row was never saved, or a room transfer means no reading exists under the
// new room_id), fall back to inferring units from the billed amount rather
// than showing 0. This can be inaccurate under a minimum-charge water rate,
// but it's closer to the truth than a bare zero.
export const resolveElectricityUsageForDisplay = (
  reading: MeterReadingRow | null | undefined,
  billAmount: number,
  rate: number,
) => (reading ? resolveElectricityUsage(reading) : rate > 0 ? billAmount / rate : billAmount);

export const resolveWaterUsageForDisplay = (
  reading: MeterReadingRow | null | undefined,
  billAmount: number,
  rate: number,
) => (reading ? resolveWaterUsage(reading) : rate > 0 ? billAmount / rate : billAmount);

// ── Serialization helpers ─────────────────────────────────────────────────────

export const serializeTransferBreakdownRows = (items: TransferBreakdownItem[]) =>
  items.map((item) => ({
    item_type: "transfer_detail",
    label: item.label,
    detail: item.label,
    value: item.editable
      ? `฿${formatMoney(toNumber(item.amount))}`
      : item.value,
    transfer_kind: item.kind ?? null,
    amount_value: item.amount != null ? toNumber(item.amount) : null,
    unit: 0,
    price_per_unit: 0,
    total_amount: 0,
    amount: 0,
  }));

/** Shown for money whose receiving account was never recorded. */
export const UNKNOWN_PAYMENT_METHOD = "ไม่ระบุบัญชี";

/**
 * Where a recorded payment came from — `payment_batches.source`.
 *
 * Every transaction must state its origin. Without this, a deposit
 * write-off from an abandoned room renders identically to a real bank
 * transfer, and an entry created by the status dropdown looks the same as one
 * an admin keyed in against a slip. Those are very different things and the
 * difference matters when auditing where money actually came from.
 */
export const PAYMENT_SOURCE_LABELS: Record<string, string> = {
  admin_webapp: "บันทึกโดยแอดมิน (หน้าเว็บ)",
  admin_liff_approve: "แอดมินอนุมัติสลิปผ่าน LINE",
  admin_status_paid: "เปลี่ยนสถานะเป็น “ชำระแล้ว”",
  abandon_room: "เครดิตจากการทิ้งห้อง (ไม่ใช่เงินโอน)",
  // Legacy/rare values kept so nothing renders as unknown unnecessarily.
  admin: "บันทึกโดยแอดมิน",
  tenant: "ผู้เช่าแจ้งชำระ",
  credit: "หักจากเครดิต (ไม่ใช่เงินโอน)",
};

export const paymentSourceLabel = (source: string | null | undefined): string => {
  const key = String(source ?? "").trim();
  if (!key) return "ไม่ระบุที่มา";
  return PAYMENT_SOURCE_LABELS[key] ?? key;
};

/**
 * True when the "payment" moved no actual money — a deposit/advance-rent
 * credit applied when a tenant abandoned the room. Nothing landed in a bank
 * account, so asking which account received it is meaningless.
 */
export const isNonCashPaymentSource = (source: string | null | undefined): boolean =>
  ["abandon_room", "credit"].includes(String(source ?? "").trim());

/**
 * Label a FROZEN payment-method snapshot (`payment_method_snapshot` on a
 * payment batch or allocation). Deliberately resolves nothing: a missing
 * snapshot means the receiving account is unrecoverable, and substituting the
 * tenant's CURRENT account there is the bug this whole mechanism exists to
 * prevent — it silently re-attributed every past month whenever a room's
 * account was re-assigned. Use `parsePaymentMethodText` for the account an
 * invoice should be paid INTO; use this for where money actually went.
 */
export const paymentMethodSnapshotLabel = (snapshot: any): string => {
  if (!snapshot) return UNKNOWN_PAYMENT_METHOD;
  if (typeof snapshot === "string")
    return snapshot.trim() || UNKNOWN_PAYMENT_METHOD;
  const label = snapshot.label ?? snapshot.bank_name ?? snapshot.type;
  return label ? String(label) : UNKNOWN_PAYMENT_METHOD;
};

export const parsePaymentMethodText = (method: any): string => {
  if (!method) return "-";
  if (typeof method === "string") return method;
  const label = method.label ?? method.type ?? "ช่องทางชำระเงิน";
  const bank = method.bank_name ?? method.bank ?? "";
  const accountName = method.account_name ?? method.name ?? "";
  const accountNumber = method.account_number ?? method.account ?? "";
  const parts = [label, bank, accountName, accountNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "-";
};

// ── Invoice display helpers ───────────────────────────────────────────────────

export const invoiceDisplayOutstanding = (invoice: { total_amount: number; paid_amount: number }) =>
  Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount));

// ── Transfer rent proration (invoice version) ─────────────────────────────────
// NOTE: This is the InvoicesPageView version which takes periodStart/periodEnd as params.
// It is different from the tenant-utils version used in tenant-editor-modal.

export const calculateInvoiceTransferRentProration = (
  periodStartText: string,
  periodEndText: string,
  transferDate: string,
  moveInDate: string | null | undefined,
  oldRoomRate: number,
  newRoomRate: number
) => {
  const periodStart = parseDateOnly(periodStartText);
  const periodEnd = parseDateOnly(periodEndText);
  const transferDateObj = parseDateOnly(transferDate);
  const moveInDateObj = moveInDate ? parseDateOnly(moveInDate) : null;
  const billingStart =
    moveInDateObj && moveInDateObj > periodStart ? moveInDateObj : periodStart;
  const billingEnd = periodEnd;
  const transferStart = transferDateObj < billingStart ? billingStart : transferDateObj;
  const dailyOldRate = dailyRentRate(oldRoomRate);
  const dailyNewRate = dailyRentRate(newRoomRate);

  let oldRoomDays = 0;
  if (transferStart > billingStart) {
    oldRoomDays = diffDaysInclusive(billingStart, addDays(transferStart, -1));
  }

  const newRoomDays =
    billingEnd >= transferStart ? diffDaysInclusive(transferStart, billingEnd) : 0;

  return {
    billingStart,
    oldRoomDays,
    newRoomDays,
    oldRentAmount: dailyOldRate * oldRoomDays,
    newRentAmount: dailyNewRate * newRoomDays,
  };
};


export const statusVariant = {
  draft: "default",
  pending: "warning",
  partial: "warning",
  verifying: "info",
  paid: "success",
  overdue: "danger",
  cancelled: "default",
} as const;

export type InvoiceRecord = {
  id: string;
  tenant_id: string;
  room_id: string;
  status: keyof typeof statusVariant;
  total_amount: number;
  issue_date: string;
  due_date: string;
  start_date: string;
  end_date: string;
  rent_amount: number;
  water_bill: number;
  electricity_bill: number;
  common_fee: number;
  discount_amount: number;
  discount_breakdown: any[];
  late_fee_amount: number;
  late_fee_per_day: number;
  late_fee_start_date: string | null;
  carry_forward_amount: number;
  additional_fees_total: number;
  additional_fees_breakdown: any[];
  paid_amount: number;
  payment_history: any[];
  notes: string | null;
  public_token: string;
  slip_url: string | null;
  /** Append-only log of declined slips — see lib/slip-review.ts. Never contains accepted payments. */
  slip_rejections: any[];
  opened_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  tenant_line_user_id: string | null;
  tenant_custom_payment_method: any;
  tenant_move_in_date: string | null;
  tenant_move_out_date: string | null;
  tenant_status: string;
  room_number: string;
  room_price_month: number;
  building_name: string;
};

export type ArrearsSnapshotItem = {
  id: string;
  source_invoice_id: string;
  snapshot_as_of: string;
  principal_amount: number;
  late_fee_amount: number;
  days_overdue: number;
  daily_rate: number;
};

export type PrintSettings = {
  dorm_name: string | null;
  dorm_address: string | null;
  water_rate: number | null;
  electricity_rate: number | null;
  water_min_units?: number | null;
  water_min_price?: number | null;
  billing_day: number | null;
  due_day: number | null;
  late_fee_start_day: number | null;
  additional_discounts: AdditionalFee[] | null;
};

export type PaymentMethodRow = {
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

export function normalizeInvoice(row: any): InvoiceRecord {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  const building = room?.buildings;
  const buildingItem = Array.isArray(building) ? building[0] : building;

  return {
    id: row.id,
    tenant_id: String(row.tenant_id ?? ""),
    room_id: row.room_id,
    status: row.status,
    total_amount: toNumber(row.total_amount),
    issue_date: row.issue_date,
    due_date: row.due_date,
    start_date: row.start_date,
    end_date: row.end_date,
    rent_amount: toNumber(row.rent_amount),
    water_bill: toNumber(row.water_bill),
    electricity_bill: toNumber(row.electricity_bill),
    common_fee: toNumber(row.common_fee),
    discount_amount: toNumber(row.discount_amount),
    discount_breakdown: Array.isArray(row.discount_breakdown) ? row.discount_breakdown : [],
    late_fee_amount: toNumber(row.late_fee_amount),
    late_fee_per_day: toNumber(row.late_fee_per_day),
    late_fee_start_date: row.late_fee_start_date ?? null,
    carry_forward_amount: toNumber(row.carry_forward_amount),
    additional_fees_total: toNumber(row.additional_fees_total),
    additional_fees_breakdown: Array.isArray(row.additional_fees_breakdown)
      ? row.additional_fees_breakdown
      : [],
    paid_amount: toNumber(row.paid_amount),
    payment_history: Array.isArray(row.payment_history) ? row.payment_history : [],
    notes: row.notes ?? null,
    public_token: row.public_token,
    slip_url: row.slip_url ?? null,
    slip_rejections: Array.isArray(row.slip_rejections) ? row.slip_rejections : [],
    opened_count: toNumber(row.opened_count),
    first_opened_at: row.first_opened_at ?? null,
    last_opened_at: row.last_opened_at ?? null,
    tenant_name: tenant?.full_name ?? "Unknown",
    tenant_phone: tenant?.phone_number ?? null,
    tenant_line_user_id: tenant?.line_user_id ?? null,
    tenant_custom_payment_method: tenant?.custom_payment_method ?? null,
    tenant_move_in_date: tenant?.move_in_date ?? null,
    tenant_move_out_date: tenant?.move_out_date ?? null,
    tenant_status: tenant?.status ?? "active",
    room_number: room?.room_number ?? "-",
    room_price_month: toNumber(room?.price_month),
    building_name: buildingItem?.name ?? "Unassigned",
  };
}
