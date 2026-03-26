"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import {
  CheckCircle2,
  Loader2,
  Send,
  Trash2,
  UploadCloud,
  FileText,
  Pencil,
  Printer,
  AlertCircle,
  Mail,
  MailOpen,
  UserPlus,
} from "lucide-react";

const statusVariant = {
  draft: "default",
  pending: "warning",
  partial: "warning",
  verifying: "info",
  paid: "success",
  overdue: "danger",
  cancelled: "default",
} as const;

type InvoiceRecord = {
  id: string;
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
  opened_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  tenant_line_user_id: string | null;
  tenant_custom_payment_method: any;
  tenant_move_in_date: string | null;
  room_number: string;
  room_price_month: number;
  building_name: string;
};

type AdditionalFee = {
  label: string;
  calc_type: "fixed" | "electricity_units" | "water_units";
  value: number;
};

type FeeLineItem = {
  detail: string;
  unit: number;
  price_per_unit: number;
  total_amount: number;
};

type CarryForwardItem = FeeLineItem & {
  source_invoice_id?: string | null;
};

type ArrearsSnapshotItem = {
  id: string;
  source_invoice_id: string;
  snapshot_as_of: string;
  principal_amount: number;
  late_fee_amount: number;
  days_overdue: number;
  daily_rate: number;
};

type TransferBreakdownItem = {
  label: string;
  value: string;
};

type PrintSettings = {
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

type PaymentMethodRow = {
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

type MeterReadingRow = {
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

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortInvoiceId = (value: string | null | undefined) => {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  return text.slice(0, 8).toUpperCase();
};

const invoiceDisplayOutstanding = (invoice: Pick<InvoiceRecord, "total_amount" | "paid_amount" | "carry_forward_amount">) =>
  Math.max(0, toNumber(invoice.total_amount) - toNumber(invoice.paid_amount)) +
  Math.max(0, toNumber(invoice.carry_forward_amount));

const formatDateThai = (dateString: string) =>
  new Date(dateString).toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

const monthStartFromDate = (dateString: string) => {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
};

const parsePaymentMethodText = (method: any): string => {
  if (!method) return "-";
  if (typeof method === "string") return method;
  const label = method.label ?? method.type ?? "ช่องทางชำระเงิน";
  const bank = method.bank_name ?? method.bank ?? "";
  const accountName = method.account_name ?? method.name ?? "";
  const accountNumber = method.account_number ?? method.account ?? "";
  const parts = [label, bank, accountName, accountNumber].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "-";
};

const toFeeItems = (rows: any[]): FeeLineItem[] => {
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

const isTransferBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "transfer_detail";

const isCarryForwardBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "carry_forward";

const toTransferBreakdownItems = (rows: any[]): TransferBreakdownItem[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .filter((row) => isTransferBreakdownRow(row))
    .map((row) => ({
      label: String(row?.label ?? row?.detail ?? "").trim(),
      value: String(row?.value ?? "").trim(),
    }))
    .filter((row) => row.label.length > 0 && row.value.length > 0);
};

const toChargeFeeRows = (rows: any[]) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter(
    (row) =>
      !isTransferBreakdownRow(row) &&
      !isCarryForwardBreakdownRow(row)
  );
};

const toCarryForwardRows = (rows: any[]) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((row) => isCarryForwardBreakdownRow(row));
};

const toCarryForwardItems = (rows: any[]): CarryForwardItem[] => {
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

const serializeTransferBreakdownRows = (items: TransferBreakdownItem[]) =>
  items.map((item) => ({
    item_type: "transfer_detail",
    label: item.label,
    detail: item.label,
    value: item.value,
    unit: 0,
    price_per_unit: 0,
    total_amount: 0,
    amount: 0,
  }));

const emptyFeeItem = (): FeeLineItem => ({
  detail: "",
  unit: 1,
  price_per_unit: 0,
  total_amount: 0,
});

const emptyCarryForwardItem = (): CarryForwardItem => ({
  detail: "",
  unit: 1,
  price_per_unit: 0,
  total_amount: 0,
  source_invoice_id: null,
});

const feeItemsTotal = (items: FeeLineItem[]) =>
  items.reduce((sum, item) => sum + toNumber(item.total_amount), 0);

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const isInvoiceDetailEditable = (status: string) => status === "draft";

const statusPillClass = (status: string) => {
  if (status === "draft") return "bg-slate-100 text-slate-700 border-slate-300";
  if (status === "pending") return "bg-amber-100 text-amber-800 border-amber-300";
  if (status === "partial") return "bg-orange-100 text-orange-800 border-orange-300";
  if (status === "verifying") return "bg-sky-100 text-sky-800 border-sky-300";
  if (status === "paid") return "bg-green-100 text-green-800 border-green-300";
  if (status === "overdue") return "bg-red-100 text-red-800 border-red-300";
  return "bg-slate-100 text-slate-700 border-slate-300";
};

const statusRowClass = (status: string) => {
  if (status === "draft") return "bg-slate-50";
  if (status === "pending") return "bg-amber-50/50";
  if (status === "partial") return "bg-orange-50/60";
  if (status === "verifying") return "bg-sky-50/50";
  if (status === "paid") return "bg-green-50/50";
  if (status === "overdue") return "bg-red-50/50";
  return "";
};

const statusLabelThai = (status: string) => {
  if (status === "draft") return "ฉบับร่าง";
  if (status === "pending") return "รอชำระ";
  if (status === "partial") return "ชำระบางส่วน";
  if (status === "verifying") return "รอตรวจสอบ";
  if (status === "paid") return "ชำระแล้ว";
  if (status === "overdue") return "เกินกำหนด";
  if (status === "cancelled") return "ยกเลิก";
  return status;
};

const clampDay = (value: number | null | undefined, min = 1, max = 28) => {
  const day = toNumber(value ?? min);
  if (day < min) return min;
  if (day > max) return max;
  return Math.floor(day);
};

const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;

const computeDateByDayInMonth = (baseDate: string, day: number | null | undefined) => {
  const date = new Date(baseDate);
  const normalized = clampDay(day ?? 1);
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth(), normalized));
};

const computeDateByDayNextMonth = (baseDate: string, day: number | null | undefined) => {
  const date = new Date(baseDate);
  const normalized = clampDay(day ?? 1);
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth() + 1, normalized));
};

const calculateLateFeePreview = (
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

const isSameMonthAndYear = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();

const buildRuleBreakdown = (
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

const fromDateText = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

const calculateProratedRentByBillingDay = (
  monthlyRent: number,
  moveInDateText: string | null | undefined,
  billingDayInput: number | null | undefined
) => {
  if (!moveInDateText) return null;
  const moveInDate = fromDateText(moveInDateText);
  const moveInDay = Math.min(Math.max(moveInDate.getDate(), 1), 30);
  const billingDay = Math.min(Math.max(toNumber(billingDayInput ?? 1), 1), 30);
  const dailyRaw = monthlyRent / 30;
  const dailyRounded = Math.floor(dailyRaw);
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

const calculateWaterBillWithMinimum = (
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

const resolveElectricityUsage = (reading: MeterReadingRow | null | undefined) => {
  if (!reading) return 0;
  if (reading.electricity_usage != null) return toNumber(reading.electricity_usage);
  if (reading.current_electricity != null && reading.previous_electricity != null) {
    return toNumber(reading.current_electricity) - toNumber(reading.previous_electricity);
  }
  return 0;
};

const resolveWaterUsage = (reading: MeterReadingRow | null | undefined) => {
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

function normalizeInvoice(row: any): InvoiceRecord {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  const building = room?.buildings;
  const buildingItem = Array.isArray(building) ? building[0] : building;

  return {
    id: row.id,
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
    opened_count: toNumber(row.opened_count),
    first_opened_at: row.first_opened_at ?? null,
    last_opened_at: row.last_opened_at ?? null,
    tenant_name: tenant?.full_name ?? "Unknown",
    tenant_phone: tenant?.phone_number ?? null,
    tenant_line_user_id: tenant?.line_user_id ?? null,
    tenant_custom_payment_method: tenant?.custom_payment_method ?? null,
    tenant_move_in_date: tenant?.move_in_date ?? null,
    room_number: room?.room_number ?? "-",
    room_price_month: toNumber(room?.price_month),
    building_name: buildingItem?.name ?? "Unassigned",
  };
}

export default function InvoicesPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can } = usePermissions();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeInvoice, setActiveInvoice] = useState<InvoiceRecord | null>(null);
  const [slipPreview, setSlipPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [useProrateInModal, setUseProrateInModal] = useState(false);
  const [slipModalOpen, setSlipModalOpen] = useState(false);
  const [slipModalUrl, setSlipModalUrl] = useState<string | null>(null);
  const [slipModalTitle, setSlipModalTitle] = useState<string>("");

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceRecord | null>(null);
  const [previewReading, setPreviewReading] = useState<MeterReadingRow | null>(null);
  const [previewArrearsSnapshots, setPreviewArrearsSnapshots] = useState<ArrearsSnapshotItem[]>([]);
  const [previewDocType, setPreviewDocType] = useState<"invoice" | "receipt">("invoice");
  const [printSettings, setPrintSettings] = useState<PrintSettings | null>(null);
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethodRow | null>(null);
  const [editableFeeItems, setEditableFeeItems] = useState<FeeLineItem[]>([]);
  const [editableCarryForwardItems, setEditableCarryForwardItems] = useState<CarryForwardItem[]>([]);
  const [arrearsSnapshots, setArrearsSnapshots] = useState<ArrearsSnapshotItem[]>([]);
  const [editableDiscountItems, setEditableDiscountItems] = useState<FeeLineItem[]>([]);
  const [transferBreakdownItems, setTransferBreakdownItems] = useState<TransferBreakdownItem[]>(
    []
  );
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"full" | "partial">("full");
  const [paymentAmountInput, setPaymentAmountInput] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState(toLocalDateString(new Date()));
  const [paymentSlipFile, setPaymentSlipFile] = useState<File | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [lineSendModalOpen, setLineSendModalOpen] = useState(false);
  const [lineSendState, setLineSendState] = useState<"sending" | "success" | "error">("sending");
  const [lineSendTitle, setLineSendTitle] = useState("กำลังส่งใบแจ้งหนี้ไป LINE");
  const [lineSendMessage, setLineSendMessage] = useState("กำลังดำเนินการ...");
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const [form, setForm] = useState({
    issue_date: "",
    due_date: "",
    start_date: "",
    end_date: "",
    water_units: 0,
    electricity_units: 0,
    rent_amount: 0,
    water_bill: 0,
    electricity_bill: 0,
    common_fee: 0,
    discount_amount: 0,
    late_fee_amount: 0,
    late_fee_per_day: 0,
    late_fee_start_date: "",
    additional_fees_total: 0,
    total_amount: 0,
    paid_amount: 0,
    status: "pending",
    notes: "",
  });

  useEffect(() => {
    let mounted = true;
    const initLatestInvoiceMonth = async () => {
      const { data } = await supabase
        .from("invoices")
        .select("start_date")
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!mounted) return;
      const latestMonth = (data as any)?.start_date
        ? String((data as any).start_date).slice(0, 7)
        : null;
      if (latestMonth) {
        setSelectedMonth(latestMonth);
      }
    };
    void initLatestInvoiceMonth();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  useEffect(() => {
    if (!openActionMenuId) return;
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-invoice-action-menu]")) return;
      setOpenActionMenuId(null);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    return () => document.removeEventListener("mousedown", onDocPointerDown);
  }, [openActionMenuId]);

  const applyPendingToOverdue = async (periodStart: string, periodEnd: string) => {
    const today = toLocalDateString(new Date());
    const { error: overdueError } = await supabase
      .from("invoices")
      .update({ status: "overdue" })
      .eq("status", "pending")
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd)
      .is("slip_url", null)
      .lt("due_date", today);
    if (overdueError) {
      setError(overdueError.message);
    }
  };

  const applySlipToVerifying = async (periodStart: string, periodEnd: string) => {
    const { error: verifyingError } = await supabase
      .from("invoices")
      .update({ status: "verifying" })
      .in("status", ["pending", "overdue"])
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd)
      .not("slip_url", "is", null);
    if (verifyingError) {
      setError(verifyingError.message);
    }
  };

  const syncMonthInvoicesWithSettings = async (year: number, month: number) => {
    const periodStart = toLocalDateString(new Date(year, month - 1, 1));
    const periodEnd = toLocalDateString(new Date(year, month, 0));
    const monthKey = toLocalDateString(new Date(year, month - 1, 1));

    const { data: settings } = await supabase
      .from("settings")
      .select("additional_discounts")
      .eq("id", 1)
      .maybeSingle();

    const discountRules = Array.isArray((settings as any)?.additional_discounts)
      ? (((settings as any).additional_discounts ?? []) as AdditionalFee[])
      : [];

    const { data: invoicesInMonth, error: invoiceError } = await supabase
      .from("invoices")
      .select(
        "id,room_id,status,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,additional_fees_total,discount_amount,discount_breakdown,total_amount"
      )
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd);

    if (invoiceError || !invoicesInMonth || invoicesInMonth.length === 0) return;

    const roomIds = [...new Set(invoicesInMonth.map((row: any) => row.room_id).filter(Boolean))];
    const { data: readings } = await supabase
      .from("meter_readings")
      .select("room_id,electricity_usage,water_usage,usage")
      .eq("reading_month", monthKey)
      .in("room_id", roomIds.length > 0 ? roomIds : ["00000000-0000-0000-0000-000000000000"]);
    const readingMap = new Map((readings ?? []).map((row: any) => [row.room_id, row]));

    const updates = (invoicesInMonth as any[])
      .map((invoice) => {
        if (!isInvoiceDetailEditable(String(invoice.status ?? ""))) {
          return null;
        }
        const reading = readingMap.get(invoice.room_id) ?? {};
        const elecUnits = toNumber(reading.electricity_usage);
        const waterUnits = toNumber(reading.water_usage ?? reading.usage);
        const discountBreakdown = buildRuleBreakdown(discountRules, elecUnits, waterUnits);
        const discountAmount = discountBreakdown.reduce((sum, fee) => sum + toNumber(fee.amount), 0);
        const totalAmount =
          toNumber(invoice.rent_amount) +
          toNumber(invoice.water_bill) +
          toNumber(invoice.electricity_bill) +
          toNumber(invoice.common_fee) +
          toNumber(invoice.additional_fees_total) +
          toNumber(invoice.late_fee_amount) -
          discountAmount;

        const currentDiscount = toNumber(invoice.discount_amount);
        const currentTotal = toNumber(invoice.total_amount);
        if (
          Math.abs(currentDiscount - discountAmount) < 0.0001 &&
          Math.abs(currentTotal - totalAmount) < 0.0001
        ) {
          return null;
        }

        return {
          id: invoice.id as string,
          discount_amount: discountAmount,
          discount_breakdown: discountBreakdown,
          total_amount: totalAmount,
        };
      })
      .filter(Boolean) as { id: string; discount_amount: number; discount_breakdown: any[]; total_amount: number }[];

    if (updates.length === 0) return;
    for (const update of updates) {
      await supabase
        .from("invoices")
        .update({
          discount_amount: update.discount_amount,
          discount_breakdown: update.discount_breakdown,
          total_amount: update.total_amount,
        })
        .eq("id", update.id);
    }
  };

  const loadInvoices = async () => {
    setLoading(true);
    setError(null);

    const [year, month] = selectedMonth.split("-").map(Number);
    const periodStart = toLocalDateString(new Date(year, month - 1, 1));
    const periodEnd = toLocalDateString(new Date(year, month, 0));

    if (can("invoice.edit")) {
      try {
        await callInvoiceAdminAction("sync_overdue", {});
      } catch {
        // Ledger sync should not block invoice viewing.
      }
    }

    await syncMonthInvoicesWithSettings(year, month);

    const { data, error: fetchError } = await supabase
      .from("invoices")
      .select(
        "id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date),rooms(room_number,price_month,buildings(name))"
      )
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd)
      .order("issue_date", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setInvoices([]);
    } else {
      const normalized = (data ?? []).map(normalizeInvoice);

      const hydrated = await Promise.all(
        normalized.map(async (invoice) => {
          if (invoice.slip_url) return invoice;

          const { data: files, error: fileError } = await supabase.storage
            .from("payment_slips")
            .list(invoice.id, {
              limit: 1,
              sortBy: { column: "name", order: "desc" },
            });

          if (fileError || !files || files.length === 0) return invoice;

          const latest = files[0];
          const { data: publicData } = supabase.storage
            .from("payment_slips")
            .getPublicUrl(`${invoice.id}/${latest.name}`);

          return {
            ...invoice,
            slip_url: publicData.publicUrl,
          };
        })
      );

      const sortedHydrated = [...hydrated].sort((a, b) => {
        const byBuilding = a.building_name.localeCompare(b.building_name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (byBuilding !== 0) return byBuilding;
        const byRoom = roomNumberCompare(a.room_number, b.room_number);
        if (byRoom !== 0) return byRoom;
        return new Date(b.issue_date).getTime() - new Date(a.issue_date).getTime();
      });
      setInvoices(sortedHydrated);
    }

    setLoading(false);
  };

  useEffect(() => {
    void loadInvoices();
  }, [selectedMonth]);

  const patchInvoiceInState = (invoiceId: string, patch: Partial<InvoiceRecord>) => {
    setInvoices((prev) =>
      prev.map((invoice) => (invoice.id === invoiceId ? { ...invoice, ...patch } : invoice))
    );
    setActiveInvoice((prev) => (prev && prev.id === invoiceId ? { ...prev, ...patch } : prev));
  };

  useEffect(() => {
    const channel = supabase
      .channel("invoice-settings-realtime")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "settings", filter: "id=eq.1" },
        () => {
          void loadInvoices();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "invoices" },
        (payload: any) => {
          if (payload?.eventType === "UPDATE" && payload?.new?.id) {
            const invoiceId = String(payload.new.id);
            patchInvoiceInState(invoiceId, {
              status: (payload.new.status as keyof typeof statusVariant) ?? undefined,
              paid_amount: toNumber(payload.new.paid_amount),
              total_amount: toNumber(payload.new.total_amount),
              slip_url: payload.new.slip_url ?? null,
              opened_count: toNumber(payload.new.opened_count),
              first_opened_at: payload.new.first_opened_at ?? null,
              last_opened_at: payload.new.last_opened_at ?? null,
              payment_history: Array.isArray(payload.new.payment_history)
                ? payload.new.payment_history
                : undefined,
            });
            setForm((prev) => {
              if (activeInvoice?.id !== invoiceId) return prev;
              return {
                ...prev,
                status: (payload.new.status as keyof typeof statusVariant) ?? prev.status,
                paid_amount: toNumber(payload.new.paid_amount ?? prev.paid_amount),
                total_amount: toNumber(payload.new.total_amount ?? prev.total_amount),
              };
            });
            return;
          }
          void loadInvoices();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, selectedMonth]);

  useEffect(() => {
    void loadPrintConfig();
  }, []);

  const loadPrintConfig = async () => {
    const { data: settingData } = await supabase
      .from("settings")
      .select("dorm_name,dorm_address,water_rate,electricity_rate,water_min_units,water_min_price,billing_day,due_day,late_fee_start_day,additional_discounts")
      .eq("id", 1)
      .maybeSingle();
    setPrintSettings((settingData as PrintSettings) ?? null);

    const { data: paymentData } = await supabase
      .from("payment_methods")
      .select("label,bank_name,account_name,account_number,qr_url")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    setDefaultPaymentMethod((paymentData as PaymentMethodRow) ?? null);
  };

  const grouped = useMemo(() => {
    const groupedMap = invoices.reduce<Record<string, InvoiceRecord[]>>((acc, invoice) => {
      if (!acc[invoice.building_name]) acc[invoice.building_name] = [];
      acc[invoice.building_name].push(invoice);
      return acc;
    }, {});
    for (const building of Object.keys(groupedMap)) {
      groupedMap[building] = groupedMap[building].sort((a, b) =>
        roomNumberCompare(a.room_number, b.room_number)
      );
    }
    return groupedMap;
  }, [invoices]);

  const visibleInvoiceIds = useMemo(() => invoices.map((invoice) => invoice.id), [invoices]);
  const selectedVisibleCount = useMemo(
    () => selected.filter((id) => visibleInvoiceIds.includes(id)).length,
    [selected, visibleInvoiceIds]
  );
  const allVisibleSelected =
    visibleInvoiceIds.length > 0 && selectedVisibleCount === visibleInvoiceIds.length;

  useEffect(() => {
    setSelected((prev) => prev.filter((id) => visibleInvoiceIds.includes(id)));
  }, [visibleInvoiceIds]);

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleInvoiceIds.includes(id));
      }
      const next = new Set(prev);
      for (const id of visibleInvoiceIds) next.add(id);
      return [...next];
    });
  };

  const openSlipViewer = (invoice: InvoiceRecord) => {
    if (!invoice.slip_url) return;
    setSlipModalTitle(`สลิปการชำระเงิน - ห้อง ${invoice.room_number}`);
    setSlipModalUrl(invoice.slip_url);
    setSlipModalOpen(true);
  };

  const callInvoiceAdminAction = async (action: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      throw new Error("Session expired. Please log in again.");
    }
    const response = await fetch("/api/admin/invoices/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(dataJson?.error ?? "Invoice action failed.");
    }
    return dataJson;
  };

  const updateInvoiceStatus = async (
    invoiceId: string,
    status: keyof typeof statusVariant
  ) => {
    if (!can("invoice.status.update")) {
      setError("You do not have permission to change invoice status.");
      return;
    }
    const previousStatus =
      invoices.find((invoice) => invoice.id === invoiceId)?.status ??
      (activeInvoice?.id === invoiceId ? activeInvoice.status : undefined);

    patchInvoiceInState(invoiceId, { status });
    setForm((prev) => {
      if (activeInvoice?.id !== invoiceId) return prev;
      return { ...prev, status };
    });

    try {
      await callInvoiceAdminAction("update_status", { invoiceId, status });
    } catch (error: any) {
      if (previousStatus) {
        patchInvoiceInState(invoiceId, { status: previousStatus });
        setForm((prev) => {
          if (activeInvoice?.id !== invoiceId) return prev;
          return { ...prev, status: previousStatus };
        });
      }
      setError(error?.message ?? "Failed to update status.");
      return;
    }
  };

  const uploadSlipFile = async (invoiceId: string, file: File) => {
    const bucket = "payment_slips";
    const filePath = `${invoiceId}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, file, { upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    return data.publicUrl;
  };

  const submitPayment = async () => {
    if (!can("invoice.payment.record")) {
      setError("You do not have permission to record payment.");
      return;
    }
    if (!activeInvoice) return;
    const currentPaid = toNumber(form.paid_amount || activeInvoice.paid_amount);
    const total = toNumber(form.total_amount || activeInvoice.total_amount);
    const remaining = invoiceDisplayOutstanding({
      total_amount: total,
      paid_amount: currentPaid,
      carry_forward_amount: activeInvoice.carry_forward_amount,
    });
    if (remaining <= 0) {
      setError("This invoice is already fully paid.");
      return;
    }

    const amountToPay =
      paymentMode === "full" ? remaining : Math.min(remaining, toNumber(paymentAmountInput));
    if (amountToPay <= 0) {
      setError("Please enter a valid payment amount.");
      return;
    }

    if (!paymentDate) {
      setError("Please select payment date.");
      return;
    }

    setPaymentSubmitting(true);
    try {
      let publicUrl: string | null = activeInvoice.slip_url ?? null;
      if (paymentSlipFile) {
        publicUrl = await uploadSlipFile(activeInvoice.id, paymentSlipFile);
      }
      const paidAtIso = new Date(`${paymentDate}T12:00:00`).toISOString();
      const result = await callInvoiceAdminAction("record_payment", {
        invoiceId: activeInvoice.id,
        payment: {
          amount: amountToPay,
          mode: paymentMode,
          paid_at: paidAtIso,
          slip_url: publicUrl ?? null,
          source: "admin_webapp",
        },
      });
      const updatedInvoices = Array.isArray(result?.updatedInvoices) ? result.updatedInvoices : [];
      const activeUpdated = updatedInvoices.find((row: any) => row.id === activeInvoice.id);

      setError(null);
      setSlipPreview(publicUrl ?? null);
      setShowPaymentForm(false);
      setPaymentMode("full");
      setPaymentAmountInput("");
      setPaymentSlipFile(null);
      if (activeUpdated) {
        setForm((prev) => ({
          ...prev,
          paid_amount: toNumber(activeUpdated.paid_amount),
          status: (activeUpdated.status as keyof typeof statusVariant) ?? prev.status,
        }));
      }
      const activeNext = {
        ...activeInvoice,
        paid_amount: toNumber(activeUpdated?.paid_amount ?? activeInvoice.paid_amount),
        payment_history: Array.isArray(activeUpdated?.payment_history)
          ? activeUpdated.payment_history
          : activeInvoice.payment_history,
        status: (activeUpdated?.status as keyof typeof statusVariant) ?? activeInvoice.status,
        slip_url: publicUrl ?? null,
      } as InvoiceRecord;
      setActiveInvoice((prev) =>
        prev
          ? {
              ...prev,
              paid_amount: toNumber(activeUpdated?.paid_amount ?? prev.paid_amount),
              payment_history: Array.isArray(activeUpdated?.payment_history)
                ? activeUpdated.payment_history
                : prev.payment_history,
              status: (activeUpdated?.status as keyof typeof statusVariant) ?? prev.status,
              slip_url: publicUrl ?? null,
            }
          : prev
      );
      updatedInvoices.forEach((invoiceUpdate: any) => {
        patchInvoiceInState(String(invoiceUpdate.id), {
          paid_amount: toNumber(invoiceUpdate.paid_amount),
          payment_history: Array.isArray(invoiceUpdate.payment_history)
            ? invoiceUpdate.payment_history
            : undefined,
          status: (invoiceUpdate.status as keyof typeof statusVariant) ?? undefined,
          slip_url: publicUrl ?? null,
        });
      });
      // Keep local modal state in sync without reloading the full page list.
      setActiveInvoice(activeNext);
    } catch (paymentError: any) {
      setError(paymentError?.message ?? "Failed to process payment.");
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const cancelPaymentEntry = async (historyIndex: number) => {
    if (!can("invoice.payment.record")) {
      setError("ไม่มีสิทธิ์ยกเลิกรายการชำระเงิน");
      return;
    }
    if (!activeInvoice) return;
    const existingHistory = Array.isArray(activeInvoice.payment_history)
      ? activeInvoice.payment_history
      : [];
    if (historyIndex < 0 || historyIndex >= existingHistory.length) return;

    const target = existingHistory[historyIndex] as any;
    const targetAmount = Math.max(0, toNumber(target?.amount));
    const confirmed = window.confirm(
      `ยืนยันยกเลิกรายการชำระเงิน ${formatMoney(targetAmount)} ?`
    );
    if (!confirmed) return;

    setPaymentSubmitting(true);
    try {
      const nextHistory = existingHistory.filter((_, idx) => idx !== historyIndex);
      const total = toNumber(form.total_amount || activeInvoice.total_amount);
      const currentPaid = toNumber(form.paid_amount || activeInvoice.paid_amount);
      const nextPaidAmount = Math.max(0, currentPaid - targetAmount);
      const lastEntry = nextHistory.length > 0 ? (nextHistory[nextHistory.length - 1] as any) : null;
      const nextSlipUrl = (lastEntry?.slip_url as string | null | undefined) ?? null;
      const nextSlipUploadedAt = (lastEntry?.paid_at as string | null | undefined) ?? null;
      const nextStatus: keyof typeof statusVariant =
        nextPaidAmount >= total ? "paid" : nextPaidAmount > 0 ? "partial" : "pending";

      await callInvoiceAdminAction("record_payment", {
        invoiceId: activeInvoice.id,
        payload: {
          paid_amount: nextPaidAmount,
          payment_history: nextHistory,
          slip_url: nextSlipUrl,
          slip_uploaded_at: nextSlipUploadedAt,
          status: nextStatus,
        },
      });

      setForm((prev) => ({ ...prev, paid_amount: nextPaidAmount, status: nextStatus }));
      setSlipPreview(nextSlipUrl);
      setActiveInvoice((prev) =>
        prev
          ? {
              ...prev,
              paid_amount: nextPaidAmount,
              payment_history: nextHistory,
              status: nextStatus,
              slip_url: nextSlipUrl,
            }
          : prev
      );
      patchInvoiceInState(activeInvoice.id, {
        paid_amount: nextPaidAmount,
        payment_history: nextHistory,
        status: nextStatus,
        slip_url: nextSlipUrl,
      });
      setError(null);
    } catch (error: any) {
      setError(error?.message ?? "ยกเลิกรายการชำระเงินไม่สำเร็จ");
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const deletePaymentSlip = async () => {
    if (!can("invoice.payment.record")) {
      setError("ไม่มีสิทธิ์ลบสลิปการชำระเงิน");
      return;
    }
    if (!activeInvoice) return;
    try {
      const { data: files, error: listError } = await supabase.storage
        .from("payment_slips")
        .list(activeInvoice.id, { limit: 1000 });
      if (listError) throw new Error(listError.message);
      const paths = (files ?? []).map((file) => `${activeInvoice.id}/${file.name}`);
      if (paths.length > 0) {
        const { error: removeError } = await supabase.storage.from("payment_slips").remove(paths);
        if (removeError) throw new Error(removeError.message);
      }

      await callInvoiceAdminAction("record_payment", {
        invoiceId: activeInvoice.id,
        payload: {
          slip_url: null,
          slip_uploaded_at: null,
        },
      });
      setSlipPreview(null);
      setActiveInvoice((prev) => (prev ? { ...prev, slip_url: null } : prev));
      patchInvoiceInState(activeInvoice.id, { slip_url: null });
      setError(null);
    } catch (error: any) {
      setError(error?.message ?? "ลบสลิปการชำระเงินไม่สำเร็จ");
    }
  };

  const openInvoice = async (invoice: InvoiceRecord) => {
    const chargeFeeRows = toChargeFeeRows(invoice.additional_fees_breakdown ?? []);
    const feeItems = toFeeItems(chargeFeeRows);
    const carryForwardRows = toCarryForwardRows(invoice.additional_fees_breakdown ?? []);
    const carryForwardItems = toCarryForwardItems(carryForwardRows);
    const discountItems = toFeeItems(invoice.discount_breakdown ?? []);
    const transferItems = toTransferBreakdownItems(invoice.additional_fees_breakdown ?? []);
    const todayLocal = toLocalDateString(new Date());
    const periodBaseDate = invoice.end_date || invoice.start_date || invoice.issue_date || todayLocal;
    const dueDateFromSetting = computeDateByDayNextMonth(periodBaseDate, printSettings?.due_day);
    const lateStartFromSetting = computeDateByDayNextMonth(
      periodBaseDate,
      printSettings?.late_fee_start_day
    );
    const monthlyRent = toNumber(invoice.room_price_month || invoice.rent_amount);
    const prorateSummary = calculateProratedRentByBillingDay(
      monthlyRent,
      invoice.tenant_move_in_date,
      printSettings?.billing_day
    );
    const useProrateDefault =
      !!prorateSummary && Math.abs(toNumber(invoice.rent_amount) - prorateSummary.rentAmount) < 0.01;
    setActiveInvoice(invoice);
    setUseProrateInModal(useProrateDefault);
    setEditableFeeItems(feeItems.length > 0 ? feeItems : []);
    setEditableCarryForwardItems(carryForwardItems.length > 0 ? carryForwardItems : []);
    setArrearsSnapshots([]);
    setTransferBreakdownItems(transferItems);
    setEditableDiscountItems(
      discountItems.length > 0
        ? discountItems
        : invoice.discount_amount > 0
          ? [{ detail: "ส่วนลด", unit: 1, price_per_unit: invoice.discount_amount, total_amount: invoice.discount_amount }]
          : []
    );
    const waterRate = toNumber(printSettings?.water_rate);
    const electricityRate = toNumber(printSettings?.electricity_rate);
    const inferredWaterUnits =
      waterRate > 0 ? toNumber(invoice.water_bill) / waterRate : toNumber(invoice.water_bill);
    const inferredElectricityUnits =
      electricityRate > 0
        ? toNumber(invoice.electricity_bill) / electricityRate
        : toNumber(invoice.electricity_bill);

    setForm({
      issue_date: invoice.issue_date || todayLocal,
      due_date: dueDateFromSetting,
      start_date: invoice.start_date,
      end_date: invoice.end_date,
      water_units: inferredWaterUnits,
      electricity_units: inferredElectricityUnits,
      rent_amount: invoice.rent_amount,
      water_bill: invoice.water_bill,
      electricity_bill: invoice.electricity_bill,
      common_fee: invoice.common_fee,
      discount_amount: discountItems.length > 0 ? feeItemsTotal(discountItems) : invoice.discount_amount,
      late_fee_amount: invoice.late_fee_amount,
      late_fee_per_day: invoice.late_fee_per_day,
      late_fee_start_date: lateStartFromSetting,
      additional_fees_total:
        feeItems.length > 0 ? feeItemsTotal(feeItems) : invoice.additional_fees_total,
      total_amount: invoice.total_amount,
      paid_amount: invoice.paid_amount,
      status: invoice.status,
      notes: invoice.notes || "",
    });
    setShowPaymentForm(false);
    setPaymentMode("full");
    setPaymentAmountInput("");
    setPaymentDate(todayLocal);
    setPaymentSlipFile(null);
    setSlipPreview(invoice.slip_url);
    setDetailOpen(true);

    // Replace inferred units with real meter usage for the invoice month.
    // This is important when water billing uses a minimum charge, where
    // water_bill / water_rate does not equal actual usage.
    try {
      const { data: snapshotRows } = await supabase
        .from("invoice_arrears_snapshots")
        .select(
          "id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate"
        )
        .eq("target_invoice_id", invoice.id)
        .order("created_at", { ascending: true });
      setArrearsSnapshots(
        ((snapshotRows ?? []) as any[]).map((row) => ({
          id: String(row.id),
          source_invoice_id: String(row.source_invoice_id),
          snapshot_as_of: String(row.snapshot_as_of),
          principal_amount: toNumber(row.principal_amount),
          late_fee_amount: toNumber(row.late_fee_amount),
          days_overdue: Math.round(toNumber(row.days_overdue)),
          daily_rate: toNumber(row.daily_rate),
        }))
      );

      const readingMonth = monthStartFromDate(invoice.start_date || invoice.issue_date);
      const { data } = await supabase
        .from("meter_readings")
        .select(
          "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
        )
        .eq("room_id", invoice.room_id)
        .eq("reading_month", readingMonth)
        .maybeSingle();

      const reading = (data as MeterReadingRow | null) ?? null;
      if (!reading) return;

      setForm((prev) => ({
        ...prev,
        electricity_units: resolveElectricityUsage(reading),
        water_units: resolveWaterUsage(reading),
        // Keep billed totals as-is (already calculated from settings/minimum rules)
        electricity_bill: invoice.electricity_bill,
        water_bill: invoice.water_bill,
      }));
    } catch {
      // Non-blocking: modal can still open using inferred values.
    }
  };

  const updateUtilityUnits = (field: "water_units" | "electricity_units", value: string | number) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    const units = toNumber(value);
    const waterRate = toNumber(printSettings?.water_rate);
    const waterMinUnits = toNumber(printSettings?.water_min_units);
    const waterMinPrice = toNumber(printSettings?.water_min_price);
    const electricityRate = toNumber(printSettings?.electricity_rate);

    setForm((prev) => {
      const next = { ...prev, [field]: units } as typeof prev;
      const nextWaterUnits = field === "water_units" ? units : toNumber(next.water_units);
      const nextWaterBill = calculateWaterBillWithMinimum(
        nextWaterUnits,
        waterRate,
        waterMinUnits,
        waterMinPrice
      );
      const nextElectricityBill =
        field === "electricity_units"
          ? units * electricityRate
          : toNumber(next.electricity_units) * electricityRate;

      const total =
        toNumber(next.rent_amount) +
        nextWaterBill +
        nextElectricityBill +
        toNumber(next.common_fee) +
        toNumber(next.discount_amount) * -1 +
        toNumber(next.late_fee_amount) +
        toNumber(next.additional_fees_total);

      return {
        ...next,
        water_bill: nextWaterBill,
        electricity_bill: nextElectricityBill,
        total_amount: total,
      };
    });
  };

  const updateForm = (field: string, value: string | number) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setForm((prev) => {
      const next = { ...prev, [field]: value } as typeof prev;
      const monthlyRent = toNumber(activeInvoice?.room_price_month ?? next.rent_amount);
      const prorateSummary =
        useProrateInModal && activeInvoice
          ? calculateProratedRentByBillingDay(
              monthlyRent,
              activeInvoice.tenant_move_in_date,
              printSettings?.billing_day
            )
          : null;
      const computedRent = prorateSummary ? prorateSummary.rentAmount : toNumber(next.rent_amount);
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const total =
        computedRent +
        toNumber(next.water_bill) +
        toNumber(next.electricity_bill) +
        toNumber(next.common_fee) +
        nextDiscount * -1 +
        toNumber(next.late_fee_amount) +
        nextAdditional;
      return {
        ...next,
        rent_amount: computedRent,
        additional_fees_total: nextAdditional,
        discount_amount: nextDiscount,
        total_amount: total,
      };
    });
  };

  const updateCarryForwardItem = (
    index: number,
    field: keyof CarryForwardItem,
    value: string | number
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableCarryForwardItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) return item;
        const next = { ...item, [field]: value } as CarryForwardItem;
        const unit = toNumber(next.unit);
        const price_per_unit = toNumber(next.price_per_unit);
        const nextTotalAmount = unit * price_per_unit;
        return {
          ...next,
          unit,
          price_per_unit,
          total_amount: nextTotalAmount,
        };
      })
    );
  };

  const toggleProrateInModal = (enabled: boolean) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setUseProrateInModal(enabled);
    setForm((prev) => {
      if (!activeInvoice) return prev;
      const monthlyRent = toNumber(activeInvoice.room_price_month || prev.rent_amount);
      const prorateSummary = calculateProratedRentByBillingDay(
        monthlyRent,
        activeInvoice.tenant_move_in_date,
        printSettings?.billing_day
      );
      const nextRent = enabled && prorateSummary ? prorateSummary.rentAmount : monthlyRent;
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const total =
        nextRent +
        toNumber(prev.water_bill) +
        toNumber(prev.electricity_bill) +
        toNumber(prev.common_fee) +
        nextDiscount * -1 +
        toNumber(prev.late_fee_amount) +
        nextAdditional;
      return { ...prev, rent_amount: nextRent, total_amount: total };
    });
  };

  const updateFeeItem = (
    index: number,
    field: keyof FeeLineItem,
    value: string | number
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableFeeItems((prev) => {
      const next = prev.map((item, idx) =>
        idx === index ? { ...item, [field]: value } : item
      );
      const normalized = next.map((item) => {
        const unit = toNumber(item.unit);
        const price_per_unit = toNumber(item.price_per_unit);
        return {
          ...item,
          unit,
          price_per_unit,
          total_amount: unit * price_per_unit,
        };
      });
      const nextAdditional = feeItemsTotal(normalized);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      setForm((formPrev) => {
        const total =
          toNumber(formPrev.rent_amount) +
          toNumber(formPrev.water_bill) +
          toNumber(formPrev.electricity_bill) +
          toNumber(formPrev.common_fee) +
          nextDiscount * -1 +
          toNumber(formPrev.late_fee_amount) +
          nextAdditional;
        return {
          ...formPrev,
          additional_fees_total: nextAdditional,
          discount_amount: nextDiscount,
          total_amount: total,
        };
      });
      return normalized;
    });
  };

  const updateDiscountItem = (
    index: number,
    field: keyof FeeLineItem,
    value: string | number
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableDiscountItems((prev) => {
      const next = prev.map((item, idx) =>
        idx === index ? { ...item, [field]: value } : item
      );
      const normalized = next.map((item) => {
        const unit = toNumber(item.unit);
        const price_per_unit = toNumber(item.price_per_unit);
        return {
          ...item,
          unit,
          price_per_unit,
          total_amount: unit * price_per_unit,
        };
      });
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(normalized);
      setForm((formPrev) => {
        const total =
          toNumber(formPrev.rent_amount) +
          toNumber(formPrev.water_bill) +
          toNumber(formPrev.electricity_bill) +
          toNumber(formPrev.common_fee) +
          nextDiscount * -1 +
          toNumber(formPrev.late_fee_amount) +
          nextAdditional;
        return {
          ...formPrev,
          discount_amount: nextDiscount,
          total_amount: total,
        };
      });
      return normalized;
    });
  };

  const saveInvoice = async () => {
    if (!can("invoice.edit")) {
      setError("You do not have permission to edit invoice details.");
      return;
    }
    if (!activeInvoice) return;
    if (!isInvoiceDetailEditable(activeInvoice.status)) {
      setError("Only draft invoices can be edited.");
      return;
    }
    setSaving(true);

    const payload = {
      issue_date: form.issue_date,
      due_date: form.due_date,
      start_date: form.start_date,
      end_date: form.end_date,
      rent_amount: toNumber(form.rent_amount),
      water_bill: toNumber(form.water_bill),
      electricity_bill: toNumber(form.electricity_bill),
      common_fee: toNumber(form.common_fee),
      discount_amount: feeItemsTotal(editableDiscountItems),
      discount_breakdown: editableDiscountItems.map((item) => ({
        detail: item.detail,
        unit: toNumber(item.unit),
        price_per_unit: toNumber(item.price_per_unit),
        total_amount: toNumber(item.total_amount),
        amount: toNumber(item.total_amount),
        label: item.detail,
      })),
      late_fee_amount: toNumber(form.late_fee_amount),
      late_fee_per_day: toNumber(form.late_fee_per_day),
      late_fee_start_date: form.late_fee_start_date || null,
      carry_forward_amount: feeItemsTotal(editableCarryForwardItems),
      additional_fees_total: feeItemsTotal(editableFeeItems),
      additional_fees_breakdown: [
        ...editableCarryForwardItems.map((item) => ({
          item_type: "carry_forward",
          source_invoice_id: item.source_invoice_id ?? null,
          detail: item.detail,
          unit: toNumber(item.unit),
          price_per_unit: toNumber(item.price_per_unit),
          total_amount: toNumber(item.total_amount),
          amount: toNumber(item.total_amount),
          label: item.detail,
        })),
        ...editableFeeItems.map((item) => ({
          detail: item.detail,
          unit: toNumber(item.unit),
          price_per_unit: toNumber(item.price_per_unit),
          total_amount: toNumber(item.total_amount),
          amount: toNumber(item.total_amount),
          label: item.detail,
        })),
        ...serializeTransferBreakdownRows(transferBreakdownItems),
      ],
      total_amount: toNumber(form.total_amount),
      paid_amount: Math.min(toNumber(form.paid_amount), toNumber(form.total_amount)),
      status: form.status,
      notes: form.notes,
    };

    try {
      await callInvoiceAdminAction("save_details", {
        invoiceId: activeInvoice.id,
        payload,
      });
    } catch (error: any) {
      setSaving(false);
      setConfirmSaveOpen(false);
      setError(error?.message ?? "Failed to save invoice.");
      return;
    }

    setSaving(false);
    setConfirmSaveOpen(false);
    patchInvoiceInState(activeInvoice.id, payload as Partial<InvoiceRecord>);
    setActiveInvoice((prev) => (prev ? ({ ...prev, ...(payload as any) } as InvoiceRecord) : prev));
    setDetailOpen(false);
  };

  const deleteInvoices = async (invoiceIds: string[]) => {
    if (!can("invoice.delete")) {
      setError("You do not have permission to delete invoices.");
      return;
    }
    if (invoiceIds.length === 0) return;

    const targetInvoices = invoices.filter((invoice) => invoiceIds.includes(invoice.id));
    const blocked = targetInvoices.filter(
      (invoice) => !!invoice.slip_url || invoice.status === "verifying" || invoice.status === "paid"
    );

    if (blocked.length > 0) {
      const details = blocked
        .map((invoice) => {
          const reasons = [];
          if (invoice.slip_url) reasons.push("has payment slip");
          if (invoice.status === "verifying" || invoice.status === "paid") {
            reasons.push(`status is ${invoice.status}`);
          }
          return `Room ${invoice.room_number} (${reasons.join(", ")})`;
        })
        .join(" | ");
      setError(
        `ไม่สามารถลบใบแจ้งหนี้ได้ กรุณาลบสลิปการชำระเงินหรือเปลี่ยนสถานะก่อน ${details}`
      );
      return;
    }

    try {
      await callInvoiceAdminAction("delete_many", { invoiceIds });
      const idSet = new Set(invoiceIds);
      setInvoices((prev) => prev.filter((invoice) => !idSet.has(invoice.id)));
      setSelected((prev) => prev.filter((id) => !idSet.has(id)));
      if (activeInvoice && idSet.has(activeInvoice.id)) setDetailOpen(false);
    } catch (error: any) {
      setError(error?.message ?? "Failed to delete invoices.");
    }
  };

  const sendInvoiceToLineRequest = async (invoice: InvoiceRecord) => {
    if (!invoice.tenant_line_user_id) {
      throw new Error(`ไม่พบ LINE user id ของ ${invoice.tenant_name}`);
    }

    const response = await fetch("/api/send-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: invoice.tenant_line_user_id,
        invoiceId: invoice.id,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      const detail = [data?.error, data?.lineStatus && `LINE ${data.lineStatus}`, data?.lineMessage]
        .filter(Boolean)
        .join(" | ");
      throw new Error(detail || "ส่งข้อความ LINE ไม่สำเร็จ");
    }

    const nextStatus = invoice.status === "draft" ? "pending" : invoice.status;
    await updateInvoiceStatus(invoice.id, nextStatus);
  };

  const sendToLine = async (invoice: InvoiceRecord) => {
    setLineSendModalOpen(true);
    setLineSendState("sending");
    setLineSendTitle("กำลังส่งใบแจ้งหนี้ไป LINE");
    setLineSendMessage(`กำลังส่งห้อง ${invoice.room_number} (${invoice.tenant_name})`);
    try {
      await sendInvoiceToLineRequest(invoice);
      setLineSendState("success");
      setLineSendTitle("ส่งใบแจ้งหนี้สำเร็จ");
      setLineSendMessage(`ส่งไปยัง ${invoice.tenant_name} (ห้อง ${invoice.room_number}) เรียบร้อย`);
    } catch (error: any) {
      setLineSendState("error");
      setLineSendTitle("ส่งใบแจ้งหนี้ไม่สำเร็จ");
      setLineSendMessage(error?.message ?? "เกิดข้อผิดพลาดระหว่างส่ง LINE");
      setError(error?.message ?? "ส่ง LINE ไม่สำเร็จ");
    }
  };

  const sendSelectedToLine = async () => {
    const selectedInvoices = selected
      .map((id) => invoices.find((item) => item.id === id))
      .filter(Boolean) as InvoiceRecord[];
    if (selectedInvoices.length === 0) return;

    setLineSendModalOpen(true);
    setLineSendState("sending");
    setLineSendTitle("กำลังส่งใบแจ้งหนี้หลายรายการ");
    let sentCount = 0;
    try {
      for (let i = 0; i < selectedInvoices.length; i += 1) {
        const invoice = selectedInvoices[i];
        setLineSendMessage(
          `กำลังส่ง ${i + 1}/${selectedInvoices.length}: ห้อง ${invoice.room_number} (${invoice.tenant_name})`
        );
        await sendInvoiceToLineRequest(invoice);
        sentCount += 1;
      }
      setLineSendState("success");
      setLineSendTitle("ส่งใบแจ้งหนี้ครบแล้ว");
      setLineSendMessage(`ส่งสำเร็จ ${sentCount}/${selectedInvoices.length} รายการ`);
    } catch (error: any) {
      setLineSendState("error");
      setLineSendTitle("ส่งใบแจ้งหนี้บางรายการไม่สำเร็จ");
      setLineSendMessage(
        `${error?.message ?? "เกิดข้อผิดพลาด"} (ส่งสำเร็จ ${sentCount}/${selectedInvoices.length} รายการ)`
      );
      setError(error?.message ?? "ส่ง LINE ไม่สำเร็จ");
    }
  };

  const getInvoicePrintDetail = async (
    invoice: InvoiceRecord,
    docType: "invoice" | "receipt" = "invoice"
  ) => {
    setPreviewLoading(true);
    setPreviewDocType(docType);
    setPreviewInvoice(invoice);
    const readingMonth = monthStartFromDate(invoice.start_date || invoice.issue_date);
    const { data } = await supabase
      .from("meter_readings")
      .select(
        "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
      )
      .eq("room_id", invoice.room_id)
      .eq("reading_month", readingMonth)
      .maybeSingle();
    const { data: snapshotRows } = await supabase
      .from("invoice_arrears_snapshots")
      .select(
        "id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate"
      )
      .eq("target_invoice_id", invoice.id)
      .order("created_at", { ascending: true });
    setPreviewReading((data as MeterReadingRow) ?? null);
    setPreviewArrearsSnapshots(
      ((snapshotRows ?? []) as any[]).map((row) => ({
        id: String(row.id),
        source_invoice_id: String(row.source_invoice_id),
        snapshot_as_of: String(row.snapshot_as_of),
        principal_amount: toNumber(row.principal_amount),
        late_fee_amount: toNumber(row.late_fee_amount),
        days_overdue: Math.round(toNumber(row.days_overdue)),
        daily_rate: toNumber(row.daily_rate),
      }))
    );
    setPreviewLoading(false);
    setPreviewOpen(true);
  };

  const getPaymentMethodLabel = (invoice: InvoiceRecord) => {
    const custom = parsePaymentMethodText(invoice.tenant_custom_payment_method);
    if (custom !== "-") return custom;
    if (!defaultPaymentMethod) return "-";
    return [
      defaultPaymentMethod.label,
      defaultPaymentMethod.bank_name,
      defaultPaymentMethod.account_name,
      defaultPaymentMethod.account_number,
    ]
      .filter(Boolean)
      .join(" | ");
  };

  const buildPrintHtml = (
    invoice: InvoiceRecord,
    reading: MeterReadingRow | null,
    docType: "invoice" | "receipt" = "invoice",
    arrearsSnapshotRows: ArrearsSnapshotItem[] = []
  ) => {
    const dormName = printSettings?.dorm_name || "หอพัก";
    const dormAddress = printSettings?.dorm_address || "-";
    const elecRate = toNumber(printSettings?.electricity_rate);
    const waterRate = toNumber(printSettings?.water_rate);
    const elecUnits = resolveElectricityUsage(reading);
    const waterUnits = resolveWaterUsage(reading);
    const paymentText = getPaymentMethodLabel(invoice);
    const prorateSummary = calculateProratedRentByBillingDay(
      toNumber(invoice.room_price_month || invoice.rent_amount),
      invoice.tenant_move_in_date,
      printSettings?.billing_day
    );
    const showProrateFormula =
      !!prorateSummary && Math.abs(toNumber(invoice.rent_amount) - prorateSummary.rentAmount) < 0.01;
    const transferRows = toTransferBreakdownItems(invoice.additional_fees_breakdown ?? []);
    const carryForwardRows = toCarryForwardRows(invoice.additional_fees_breakdown ?? []);
    const additionalRows = toChargeFeeRows(invoice.additional_fees_breakdown ?? [])
      .map(
        (fee: any) => `
          <tr>
            <td>ค่าธรรมเนียมเพิ่มเติม - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
            )}</td>
            <td class="text-right">${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`
      )
      .join("");
    const carryForwardHtml = carryForwardRows
      .map(
        (fee: any) => `
          <tr>
            <td>ยอดค้างยกมา - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
            )}</td>
            <td class="text-right">${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`
      )
      .join("");
    const transferBreakdownRows = transferRows
      .map(
        (row) => `
          <tr>
            <td>${row.label}</td>
            <td class="text-right" colspan="3">${row.value}</td>
          </tr>`
      )
      .join("");
    const normalizedDiscountRows =
      Array.isArray(invoice.discount_breakdown) && invoice.discount_breakdown.length > 0
        ? invoice.discount_breakdown
        : invoice.discount_amount > 0
          ? [{ detail: "ส่วนลด", unit: 1, total_amount: invoice.discount_amount, price_per_unit: invoice.discount_amount }]
          : [];
    const discountRows = normalizedDiscountRows
      .map(
        (fee: any) => `
          <tr>
            <td>ส่วนลด - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
            )}</td>
            <td class="text-right">-${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`
      )
      .join("");
    const lateFeeRowsHtml =
      arrearsSnapshotRows.length > 0
        ? arrearsSnapshotRows
            .map(
              (row) => `
                <tr>
                  <td>ค่าปรับล่าช้า - บิล ${shortInvoiceId(row.source_invoice_id)} (คำนวณถึง ${formatDateThai(row.snapshot_as_of)})</td>
                  <td class="text-right">${row.days_overdue.toLocaleString("th-TH")} วัน</td>
                  <td class="text-right">${formatMoney(row.daily_rate)}</td>
                  <td class="text-right">${formatMoney(row.late_fee_amount)}</td>
                </tr>`
            )
            .join("")
        : invoice.late_fee_amount > 0
          ? `
              <tr>
                <td>ค่าปรับล่าช้า</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">${formatMoney(invoice.late_fee_amount)}</td>
              </tr>`
          : "";

    const documentTitle = docType === "receipt" ? "ใบเสร็จรับเงิน" : "ใบแจ้งหนี้";

    return `
      <html>
      <head>
        <title>${documentTitle} ${invoice.id}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>
          body { font-family: 'Google Sans', 'Google Sans Text', 'Product Sans', 'Noto Sans Thai', 'Sarabun', Tahoma, sans-serif; padding: 28px; color: #0f172a; }
          .row { display: flex; justify-content: space-between; gap: 24px; }
          .box { flex: 1; }
          .title { font-size: 24px; font-weight: 700; margin: 0 0 4px 0; }
          .sub { margin: 2px 0; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; margin-top: 14px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px; font-size: 14px; }
          th { background: #f8fafc; }
          .text-right { text-align: right; }
          .section { margin-top: 18px; }
          .total { font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="row">
          <div class="box">
            <p class="title">${dormName}</p>
            <p class="sub">${dormAddress}</p>
            <p class="sub">ผู้เช่า: ${invoice.tenant_name}</p>
            <p class="sub">ห้อง: ${invoice.room_number}</p>
            <p class="sub">โทร: ${invoice.tenant_phone || "-"}</p>
          </div>
          <div class="box" style="text-align:right">
            <p class="sub"><b>เลขที่${documentTitle}:</b> ${invoice.id.slice(0, 8).toUpperCase()}</p>
            <p class="sub"><b>เลขห้อง:</b> ${invoice.room_number}</p>
            <p class="sub"><b>วันที่:</b> ${formatDateThai(invoice.issue_date)}</p>
          </div>
        </div>

        <div class="section">
          <table>
            <thead>
              <tr>
                <th>รายละเอียด</th>
                <th class="text-right">หน่วย</th>
                <th class="text-right">ราคา/หน่วย</th>
                <th class="text-right">จำนวนเงิน</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ค่าเช่าห้องพัก</td>
                <td class="text-right">1 เดือน</td>
                <td class="text-right">${formatMoney(invoice.rent_amount)}</td>
                <td class="text-right">${formatMoney(invoice.rent_amount)}</td>
              </tr>
              ${
                showProrateFormula
                  ? `<tr>
                <td colspan="4" style="font-size:12px;background:#fffbeb;color:#92400e">
                  สูตรคำนวณ: ${prorateSummary?.formulaText}
                </td>
              </tr>`
                  : ""
              }
              <tr>
                <td>ค่าน้ำ</td>
                <td class="text-right">${waterUnits.toLocaleString("th-TH")} หน่วย</td>
                <td class="text-right">${formatMoney(waterRate)}</td>
                <td class="text-right">${formatMoney(invoice.water_bill)}</td>
              </tr>
              <tr>
                <td>ค่าไฟ</td>
                <td class="text-right">${elecUnits.toLocaleString("th-TH")} หน่วย</td>
                <td class="text-right">${formatMoney(elecRate)}</td>
                <td class="text-right">${formatMoney(invoice.electricity_bill)}</td>
              </tr>
              <tr>
                <td>ค่าส่วนกลาง</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">${formatMoney(invoice.common_fee)}</td>
              </tr>
              ${
                transferBreakdownRows
                  ? `<tr><td colspan="4" style="background:#eff6ff;color:#1d4ed8;font-weight:600">สรุปย้ายห้องกลางเดือน</td></tr>${transferBreakdownRows}`
                  : ""
              }
              ${carryForwardHtml}
              <tr>
                <td>ส่วนลด</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">-${formatMoney(invoice.discount_amount)}</td>
              </tr>
              ${lateFeeRowsHtml}
              ${additionalRows}
              ${discountRows}
              <tr class="total">
                <td colspan="3" class="text-right">ยอดรวมสุทธิ</td>
                <td class="text-right">${formatMoney(invoice.total_amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="section">
          <p class="sub"><b>ช่องทางชำระเงิน:</b> ${paymentText}</p>
          <p class="sub"><b>หมายเหตุ:</b> ${invoice.notes || "-"}</p>
        </div>
      </body>
      </html>
    `;
  };

  const printInvoice = (
    invoice: InvoiceRecord,
    reading: MeterReadingRow | null,
    docType: "invoice" | "receipt" = "invoice",
    arrearsSnapshotRows: ArrearsSnapshotItem[] = []
  ) => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(buildPrintHtml(invoice, reading, docType, arrearsSnapshotRows));

    win.document.close();
    win.focus();
    win.print();
  };

  const generateInvoices = async () => {
    if (!can("invoice.create")) {
      setError("You do not have permission to generate invoices.");
      return;
    }
    setSaving(true);
    setError(null);

    const [year, month] = selectedMonth.split("-").map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const monthKey = toLocalDateString(new Date(year, month - 1, 1));

    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select(
        "water_rate,electricity_rate,common_fee,water_min_units,water_min_price,additional_fees,additional_discounts,billing_day,due_day,late_fee_start_day,late_fee_per_day"
      )
      .eq("id", 1)
      .single();

    if (settingsError || !settings) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(settingsError?.message ?? "Settings not found");
      return;
    }

    const billingDay = clampDay((settings as any).billing_day ?? 1);
    const dueDay = clampDay((settings as any).due_day ?? 5);
    const lateFeeStartDay = clampDay((settings as any).late_fee_start_day ?? 6);
    const lateFeePerDay = toNumber((settings as any).late_fee_per_day ?? 0);
    const issueDateText = toLocalDateString(new Date(year, month - 1, billingDay));
    // Invoice period is the selected month, but due date / late fee start belong to the next month.
    const generatedDueDateText = toLocalDateString(new Date(year, month, dueDay));
    const generatedLateFeeStartDateText = toLocalDateString(new Date(year, month, lateFeeStartDay));

    const { data: occupiedRooms, error: roomError } = await supabase
      .from("rooms")
      .select("id,room_number,price_month")
      .eq("status", "occupied");

    if (roomError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(roomError.message);
      return;
    }

    if (!occupiedRooms || occupiedRooms.length === 0) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError("No occupied rooms found.");
      return;
    }

    const roomIds = occupiedRooms.map((room: any) => room.id);

    const { data: activeTenants, error: tenantError } = await supabase
      .from("tenants")
      .select("id,room_id,full_name,move_in_date")
      .eq("status", "active")
      .in("room_id", roomIds);

    if (tenantError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(tenantError.message);
      return;
    }

    const tenantByRoom = new Map<string, any>();
    for (const tenant of activeTenants ?? []) {
      if (!tenantByRoom.has(tenant.room_id)) tenantByRoom.set(tenant.room_id, tenant);
    }

    const missingTenantRooms = occupiedRooms.filter((room: any) => !tenantByRoom.has(room.id));

    const billingTenants = occupiedRooms
      .map((room: any) => {
        const tenant = tenantByRoom.get(room.id);
        if (!tenant) return null;
        return {
          id: tenant.id,
          room_id: room.id,
          move_in_date: tenant.move_in_date,
          rooms: {
            room_number: room.room_number,
            price_month: room.price_month,
          },
        };
      })
      .filter(Boolean) as any[];

    const transferByTenant = new Map<string, any>();
    if (billingTenants.length > 0) {
      const tenantIds = billingTenants.map((tenant: any) => String(tenant.id));
      const { data: transfers } = await supabase
        .from("tenant_room_transfers")
        .select(
          "tenant_id,from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,old_rent_amount,new_rent_amount"
        )
        .eq("billing_month", toLocalDateString(startDate))
        .in("tenant_id", tenantIds);
      for (const row of transfers ?? []) {
        const key = String((row as any).tenant_id);
        const previous = transferByTenant.get(key);
        if (!previous) {
          transferByTenant.set(key, row);
          continue;
        }
        const prevDate = String((previous as any).transfer_date ?? "");
        const currDate = String((row as any).transfer_date ?? "");
        if (currDate > prevDate) transferByTenant.set(key, row);
      }
    }

    const { data: existingInvoices, error: existingError } = await supabase
      .from("invoices")
      .select("room_id")
      .eq("start_date", toLocalDateString(startDate))
      .eq("end_date", toLocalDateString(endDate))
      .in("room_id", roomIds);

    if (existingError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(existingError.message);
      return;
    }

    const existingRoomIds = new Set((existingInvoices ?? []).map((row: any) => row.room_id));
    const tenantsToGenerate = billingTenants.filter(
      (tenant: any) => !existingRoomIds.has(tenant.room_id)
    );

    try {
      await callInvoiceAdminAction("sync_overdue", {
        beforeStartDate: toLocalDateString(startDate),
      });
    } catch (syncError: any) {
      setError(syncError?.message ?? "Sync overdue invoices failed.");
      setSaving(false);
      setConfirmGenerateOpen(false);
      return;
    }

    const tenantIdsToGenerate = tenantsToGenerate.map((tenant: any) => String(tenant.id));
    const { data: previousUnpaidInvoices, error: previousUnpaidError } =
      tenantIdsToGenerate.length > 0
        ? await supabase
            .from("invoices")
            .select("id,tenant_id,start_date,total_amount,paid_amount,status,late_fee_amount")
            .in("tenant_id", tenantIdsToGenerate)
            .lt("start_date", toLocalDateString(startDate))
            .in("status", ["pending", "partial", "overdue", "verifying"])
            .order("start_date", { ascending: true })
        : { data: [], error: null };

    if (previousUnpaidError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(previousUnpaidError.message);
      return;
    }

    const sourceInvoiceIds = ((previousUnpaidInvoices ?? []) as any[]).map((row) => String(row.id));
    const { data: existingCarryForwards, error: carryError } =
      sourceInvoiceIds.length > 0
        ? await supabase
            .from("invoice_carry_forwards")
            .select("source_invoice_id")
            .in("source_invoice_id", sourceInvoiceIds)
        : { data: [], error: null };

    if (carryError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(carryError.message);
      return;
    }

    const carriedInvoiceIds = new Set(
      ((existingCarryForwards ?? []) as any[]).map((row) => String(row.source_invoice_id))
    );
    const carryForwardByTenant = new Map<string, any[]>();
    for (const row of (previousUnpaidInvoices ?? []) as any[]) {
      if (carriedInvoiceIds.has(String(row.id))) continue;
      const outstanding = Math.max(
        0,
        toNumber(row.total_amount) - toNumber(row.paid_amount)
      );
      if (outstanding <= 0) continue;
      const generationDateText = issueDateText;
      const dailyRate = Math.max(0, lateFeePerDay);
      let snapshotLateFee = 0;
      let daysOverdue = 0;
      if (dailyRate > 0 && row.start_date) {
        const baseDate = new Date(`${String(row.start_date).slice(0, 7)}-01T00:00:00`);
        const start = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, lateFeeStartDay);
        const asOf = new Date(`${generationDateText}T00:00:00`);
        if (asOf >= start) {
          daysOverdue =
            Math.floor(
              (Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate()) -
                Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
                86400000
            ) + 1;
          snapshotLateFee = daysOverdue * dailyRate;
        }
      }
      const tenantId = String(row.tenant_id ?? "");
      if (!tenantId) continue;
      const currentRows = carryForwardByTenant.get(tenantId) ?? [];
      currentRows.push({
        ...row,
        outstanding_amount: outstanding,
        base_outstanding_amount: outstanding,
        snapshot_late_fee_amount: snapshotLateFee,
        snapshot_days_overdue: daysOverdue,
        snapshot_daily_rate: dailyRate,
        snapshot_as_of: generationDateText,
      });
      carryForwardByTenant.set(tenantId, currentRows);
    }

    const { data: readings } = await supabase
      .from("meter_readings")
      .select("room_id,electricity_usage,water_usage,usage")
      .eq("reading_month", monthKey)
      .in("room_id", roomIds.length ? roomIds : ["00000000-0000-0000-0000-000000000000"]);

    const readingMap = new Map((readings ?? []).map((row: any) => [row.room_id, row]));

    const additionalFees = Array.isArray(settings.additional_fees)
      ? (settings.additional_fees as AdditionalFee[])
      : [];
    const discountRules = Array.isArray((settings as any).additional_discounts)
      ? ((settings as any).additional_discounts as AdditionalFee[])
      : [];

    const insertPayload = tenantsToGenerate
      .map((tenant: any) => {
      const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
      const reading = readingMap.get(tenant.room_id) ?? {};
      const transfer = transferByTenant.get(String(tenant.id));
      const hasTransferToThisRoom =
        !!transfer && String((transfer as any).to_room_id ?? "") === String(tenant.room_id);

      const newRoomElecUnits = toNumber(reading.electricity_usage);
      const newRoomWaterUnits = toNumber(reading.water_usage ?? reading.usage);
      const oldRoomElecUnits = hasTransferToThisRoom ? toNumber((transfer as any).old_electric_usage) : 0;
      const oldRoomWaterUnits = hasTransferToThisRoom ? toNumber((transfer as any).old_water_usage) : 0;
      const elecUnits = oldRoomElecUnits + newRoomElecUnits;
      const waterUnits = oldRoomWaterUnits + newRoomWaterUnits;

      const rentAmount = hasTransferToThisRoom
        ? toNumber((transfer as any).old_rent_amount) + toNumber((transfer as any).new_rent_amount)
        : toNumber(roomRel?.price_month);

      const elecBill = elecUnits * toNumber(settings.electricity_rate);
      const waterBill = calculateWaterBillWithMinimum(
        waterUnits,
        toNumber(settings.water_rate),
        toNumber(settings.water_min_units),
        toNumber(settings.water_min_price)
      );

      const additionalBreakdown = additionalFees.map((fee) => {
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

      const additionalTotal = additionalBreakdown.reduce(
        (sum, fee) => sum + toNumber(fee.amount),
        0
      );
      const discountBreakdown = discountRules.map((fee) => {
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
      const discountAmount = discountBreakdown.reduce(
        (sum, fee) => sum + toNumber(fee.amount),
        0
      );
      const carryForwardRows = carryForwardByTenant.get(String(tenant.id)) ?? [];
      const carryForwardAmount = carryForwardRows.reduce(
        (sum, row) => sum + toNumber(row.base_outstanding_amount),
        0
      );
      const carryForwardLateFeeAmount = carryForwardRows.reduce(
        (sum, row) => sum + toNumber(row.snapshot_late_fee_amount),
        0
      );
      const carryForwardBreakdown = carryForwardRows.map((row) => ({
        item_type: "carry_forward",
        source_invoice_id: row.id,
        label: `ยอดค้างชำระงวด ${String(row.start_date ?? "").slice(0, 7)}`,
        detail: `ยอดค้างชำระงวด ${String(row.start_date ?? "").slice(0, 7)}`,
        unit: 1,
        price_per_unit: toNumber(row.base_outstanding_amount),
        total_amount: toNumber(row.base_outstanding_amount),
          amount: toNumber(row.base_outstanding_amount),
        }));

      const commonFee = toNumber(settings.common_fee);
      const lateFeeAmount = carryForwardLateFeeAmount;
      const totalAmount =
        rentAmount + waterBill + elecBill + commonFee + additionalTotal + lateFeeAmount - discountAmount;
      const transferBreakdownRows = hasTransferToThisRoom
        ? serializeTransferBreakdownRows([
            {
              label: "วันที่ย้ายห้อง",
              value: String((transfer as any).transfer_date ?? "-"),
            },
            {
              label: "ค่าเช่าห้องเดิม",
              value: formatMoney(toNumber((transfer as any).old_rent_amount)),
            },
            {
              label: "ค่าเช่าห้องใหม่",
              value: formatMoney(toNumber((transfer as any).new_rent_amount)),
            },
            {
              label: "หน่วยไฟฟ้า",
              value: `ห้องเดิม ${oldRoomElecUnits} + ห้องใหม่ ${newRoomElecUnits} = ${elecUnits} หน่วย`,
            },
            {
              label: "หน่วยน้ำ",
              value: `ห้องเดิม ${oldRoomWaterUnits} + ห้องใหม่ ${newRoomWaterUnits} = ${waterUnits} หน่วย`,
            },
          ])
        : [];

      return {
        tenant_id: tenant.id,
        room_id: tenant.room_id,
        issue_date: issueDateText,
        due_date: generatedDueDateText,
        start_date: toLocalDateString(startDate),
        end_date: toLocalDateString(endDate),
        rent_amount: rentAmount,
        water_bill: waterBill,
        electricity_bill: elecBill,
        common_fee: commonFee,
        discount_amount: discountAmount,
        discount_breakdown: discountBreakdown,
        late_fee_amount: lateFeeAmount,
        late_fee_per_day: lateFeePerDay,
        late_fee_start_date: generatedLateFeeStartDateText,
        carry_forward_amount: carryForwardAmount,
        additional_fees_total: additionalTotal,
        additional_fees_breakdown: [
          ...carryForwardBreakdown,
          ...additionalBreakdown,
          ...transferBreakdownRows,
        ],
        total_amount: totalAmount,
        notes: null,
        status: "draft",
      };
    }) as any[];

    const generatedRoomIds = new Set(insertPayload.map((row: any) => row.room_id));
    if (insertPayload.length > 0) {
      const { data: insertedInvoices, error: insertError } = await supabase
        .from("invoices")
        .insert(insertPayload)
        .select("id,tenant_id");
      if (insertError) {
        setError(insertError.message);
      } else if ((insertedInvoices ?? []).length > 0) {
        const carryForwardInsertPayload = (insertedInvoices ?? []).flatMap((row: any) => {
          const carryRows = carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? [];
          return carryRows.map((carryRow) => ({
            source_invoice_id: carryRow.id,
            target_invoice_id: row.id,
            amount: toNumber(carryRow.outstanding_amount),
          }));
        });
        const arrearsSnapshotPayload = (insertedInvoices ?? []).flatMap((row: any) => {
          const carryRows = carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? [];
          return carryRows.map((carryRow) => ({
            source_invoice_id: carryRow.id,
            target_invoice_id: row.id,
            snapshot_as_of: carryRow.snapshot_as_of,
            principal_amount: toNumber(carryRow.base_outstanding_amount),
            late_fee_amount: toNumber(carryRow.snapshot_late_fee_amount),
            days_overdue: Math.round(toNumber(carryRow.snapshot_days_overdue)),
            daily_rate: toNumber(carryRow.snapshot_daily_rate),
          }));
        });
        if (carryForwardInsertPayload.length > 0) {
          const { error: carryInsertError } = await supabase
            .from("invoice_carry_forwards")
            .insert(carryForwardInsertPayload);
          if (carryInsertError) {
            setError(carryInsertError.message);
          }
        }
        if (arrearsSnapshotPayload.length > 0) {
          const { error: snapshotInsertError } = await supabase
            .from("invoice_arrears_snapshots")
            .insert(arrearsSnapshotPayload);
          if (snapshotInsertError) {
            setError(snapshotInsertError.message);
          }
        }
      }
    } else {
      setError("No new invoices generated. All rooms already have invoices for this period.");
    }

    const occupiedRoomIds = new Set(occupiedRooms.map((room: any) => room.id));
    const billedRoomIds = new Set<string>([...existingRoomIds, ...generatedRoomIds]);
    const roomNumberById = new Map<string, string>(
      occupiedRooms.map((room: any) => [room.id, room.room_number])
    );
    const notBilledRoomIds = [...occupiedRoomIds].filter((roomId) => !billedRoomIds.has(roomId));

    const alerts: string[] = [];
    if (existingRoomIds.size > 0 && insertPayload.length > 0) {
      alerts.push(
        `สร้างใบแจ้งหนี้ ${insertPayload.length} รายการแล้ว และข้าม ${existingRoomIds.size} ห้องที่มีใบแจ้งหนี้ในงวดนี้อยู่แล้ว`
      );
    }
    if (missingTenantRooms.length > 0) {
      const rooms = missingTenantRooms.map((room: any) => room.room_number).join(", ");
      alerts.push(`Occupied room(s) missing active tenant: ${rooms}`);
    }
    if (notBilledRoomIds.length > 0) {
      const rooms = notBilledRoomIds
        .map((roomId) => roomNumberById.get(roomId) ?? roomId)
        .join(", ");
      alerts.push(`Billing audit failed. Occupied room(s) without invoice: ${rooms}`);
    }
    if (alerts.length > 0) {
      setError(alerts.join(" | "));
    }

    setSaving(false);
    setConfirmGenerateOpen(false);
    await loadInvoices();
  };

  const modalProrateSummary =
    activeInvoice && useProrateInModal
      ? calculateProratedRentByBillingDay(
          toNumber(activeInvoice.room_price_month || form.rent_amount),
          activeInvoice.tenant_move_in_date,
          printSettings?.billing_day
        )
      : null;
  const canEditDetails = activeInvoice ? isInvoiceDetailEditable(activeInvoice.status) : false;
  const canCreateInvoice = can("invoice.create");
  const canEditInvoice = can("invoice.edit");
  const canDeleteInvoice = can("invoice.delete");
  const canUpdateInvoiceStatus = can("invoice.status.update");
  const canRecordInvoicePayment = can("invoice.payment.record");
  const lateFeePreview = calculateLateFeePreview(
    form.late_fee_start_date || null,
    form.late_fee_per_day,
    toLocalDateString(new Date())
  );

  useEffect(() => {
    setForm((prev) => {
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const total =
        toNumber(prev.rent_amount) +
        toNumber(prev.water_bill) +
        toNumber(prev.electricity_bill) +
        toNumber(prev.common_fee) +
        toNumber(prev.late_fee_amount) +
        nextAdditional -
        nextDiscount;
      return {
        ...prev,
        additional_fees_total: nextAdditional,
        discount_amount: nextDiscount,
        total_amount: total,
        paid_amount: Math.min(toNumber(prev.paid_amount), total),
      };
    });
  }, [editableFeeItems, editableDiscountItems, editableCarryForwardItems]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-1">
          <Input
            label="เดือนใบแจ้งหนี้"
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setConfirmGenerateOpen(true)}
            disabled={!canCreateInvoice}
            title={!canCreateInvoice ? "ไม่มีสิทธิ์สร้างใบแจ้งหนี้" : undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            <FileText size={16} />
            สร้างใบแจ้งหนี้รายเดือน
          </button>
        </div>
      </div>

      {error && <span className="text-sm text-red-600">{error}</span>}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          กำลังโหลดใบแจ้งหนี้...
        </div>
      ) : (
        Object.entries(grouped)
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
          .map(([building, buildingInvoices]) => (
          <div key={building} className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        disabled={visibleInvoiceIds.length === 0}
                      />
                    </th>
                    <th className="px-4 py-3">สถานะ</th>
                    <th className="px-4 py-3">ห้อง</th>
                    <th className="px-4 py-3">ผู้เช่า</th>
                    <th className="px-4 py-3 text-center">เปิดดู</th>
                    <th className="px-4 py-3">รอบบิล</th>
                    <th className="px-4 py-3">ยอดรวม</th>
                    <th className="px-4 py-3">ชำระแล้ว</th>
                    <th className="px-4 py-3">คงเหลือ</th>
                    <th className="px-4 py-3">สลิป</th>
                    <th className="px-4 py-3">การทำรายการ</th>
                  </tr>
                </thead>
                <tbody>
                  {buildingInvoices.map((invoice) => {
                    const remaining = invoiceDisplayOutstanding(invoice);
                    return (
                    <tr
                      key={invoice.id}
                      onClick={() => void openInvoice(invoice)}
                      className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50/70 ${statusRowClass(invoice.status)}`}
                      title="คลิกเพื่อเปิดรายละเอียดใบแจ้งหนี้"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.includes(invoice.id)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSelect(invoice.id)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={invoice.status}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            void updateInvoiceStatus(invoice.id, event.target.value as keyof typeof statusVariant)
                          }
                          disabled={!canUpdateInvoiceStatus}
                          title={!canUpdateInvoiceStatus ? "ไม่มีสิทธิ์เปลี่ยนสถานะใบแจ้งหนี้" : undefined}
                          className={`w-36 rounded-lg border px-2 py-1 text-xs font-semibold capitalize disabled:cursor-not-allowed disabled:opacity-70 ${statusPillClass(
                            invoice.status
                          )}`}
                        >
                          {Object.keys(statusVariant).map((status) => (
                            <option key={status} value={status}>
                              {statusLabelThai(status)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{invoice.room_number}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span>{invoice.tenant_name}</span>
                          {invoice.tenant_move_in_date?.slice(0, 7) === selectedMonth && (
                            <span
                              title={`ผู้เช่าเข้าใหม่ (${invoice.tenant_move_in_date})`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700"
                            >
                              <UserPlus size={12} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          title={
                            invoice.opened_count > 0
                              ? `เปิดแล้ว ${invoice.opened_count} ครั้ง${invoice.last_opened_at ? ` | ล่าสุด ${new Date(invoice.last_opened_at).toLocaleString("th-TH")}` : ""}`
                              : "ยังไม่เปิดใบแจ้งหนี้"
                          }
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border ${
                            invoice.opened_count > 0
                              ? "border-blue-200 bg-blue-50 text-blue-700"
                              : "border-slate-200 bg-slate-50 text-slate-400"
                          }`}
                        >
                          {invoice.opened_count > 0 ? <MailOpen size={15} /> : <Mail size={15} />}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {invoice.start_date} - {invoice.end_date}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {formatMoney(invoice.total_amount)}
                        {invoice.carry_forward_amount > 0 && (
                          <p className="mt-1 text-[11px] font-medium text-amber-700">
                            มียอดค้างยกมา {formatMoney(invoice.carry_forward_amount)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-semibold text-emerald-700">
                        {formatMoney(toNumber(invoice.paid_amount))}
                      </td>
                      <td className="px-4 py-3 font-semibold text-rose-700">
                        {formatMoney(remaining)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            openSlipViewer(invoice);
                          }}
                          disabled={!invoice.slip_url}
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            invoice.slip_url
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : "bg-slate-100 text-slate-400"
                          }`}
                        >
                          {invoice.slip_url ? "ดูสลิป" : "ไม่มีสลิป"}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative" data-invoice-action-menu>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenActionMenuId((prev) => (prev === invoice.id ? null : invoice.id));
                            }}
                            className="cursor-pointer rounded-lg bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-200"
                          >
                            เมนู
                          </button>
                          {openActionMenuId === invoice.id && (
                          <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg animate-soft-pop">
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenActionMenuId(null);
                                void openInvoice(invoice);
                              }}
                              disabled={!(canEditInvoice || canRecordInvoicePayment || canUpdateInvoiceStatus)}
                              title={!(canEditInvoice || canRecordInvoicePayment || canUpdateInvoiceStatus) ? "ไม่มีสิทธิ์เปิดแก้ไขใบแจ้งหนี้" : undefined}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:text-red-400 disabled:hover:bg-transparent"
                            >
                              <Pencil size={12} />
                              เปิดรายละเอียด
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenActionMenuId(null);
                                void getInvoicePrintDetail(invoice);
                              }}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                            >
                              <Printer size={12} />
                              พรีวิว
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenActionMenuId(null);
                                void getInvoicePrintDetail(invoice, "receipt");
                              }}
                              disabled={!(invoice.status === "verifying" || invoice.status === "paid")}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
                            >
                              <FileText size={12} />
                              ใบเสร็จ
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenActionMenuId(null);
                                setDeleteTargetIds([invoice.id]);
                                setConfirmDeleteOpen(true);
                              }}
                              disabled={!canDeleteInvoice}
                              title={!canDeleteInvoice ? "ไม่มีสิทธิ์ลบใบแจ้งหนี้" : undefined}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-red-300 disabled:hover:bg-transparent"
                            >
                              <Trash2 size={12} />
                              ลบ
                            </button>
                          </div>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {selected.length > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 w-[min(90vw,720px)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-700">เลือกแล้ว {selected.length} ใบแจ้งหนี้</span>
            <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={sendSelectedToLine}
                  className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-3 py-2 text-white"
                >
                <Send size={14} />
                Send to LINE
              </button>
              <button
                onClick={() => {
                  const first = invoices.find((invoice) => selected.includes(invoice.id));
                  if (first) void getInvoicePrintDetail(first);
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-slate-600"
              >
                <Printer size={14} />
                พิมพ์
              </button>
              <button
                onClick={() => {
                  if (selected.length === 0) return;
                  setDeleteTargetIds(selected);
                  setConfirmDeleteOpen(true);
                }}
                disabled={!canDeleteInvoice}
                title={!canDeleteInvoice ? "ไม่มีสิทธิ์ลบใบแจ้งหนี้" : undefined}
                className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-red-600 disabled:cursor-not-allowed disabled:text-red-300"
              >
                <Trash2 size={14} />
                ลบ
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={activeInvoice ? `ใบแจ้งหนี้ ${shortInvoiceId(activeInvoice.id)}` : "รายละเอียดใบแจ้งหนี้"}
        size="xl"
      >
        {activeInvoice && (
          <div className="space-y-6">
            {!isInvoiceDetailEditable(activeInvoice.status) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                ปิดการแก้ไขรายละเอียดสำหรับสถานะ <b>{statusLabelThai(activeInvoice.status)}</b> หากต้องการแก้ไข
                ให้เปลี่ยนสถานะเป็น <b>ฉบับร่าง</b>
              </div>
            )}
            {(!canEditInvoice || !canUpdateInvoiceStatus || !canRecordInvoicePayment) && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                บางส่วนถูกล็อกตามสิทธิ์ของผู้ใช้ (ปุ่มที่ล็อกจะแสดงเคอร์เซอร์ห้ามใช้งาน)
              </div>
            )}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Invoice</p>
                  <p className="text-lg font-semibold text-slate-900">ห้อง {activeInvoice.room_number}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-400">ยอดรวม</p>
                  <p className="text-xl font-semibold text-blue-700">{formatMoney(form.total_amount)}</p>
                  {feeItemsTotal(editableCarryForwardItems) > 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      ยอดค้างยกมา: {formatMoney(feeItemsTotal(editableCarryForwardItems))}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-slate-400">ชำระแล้ว: {formatMoney(toNumber(form.paid_amount))}</p>
                  <p className="text-xs text-rose-600">
                    คงเหลือ:{" "}
                    {formatMoney(
                      invoiceDisplayOutstanding({
                        total_amount: form.total_amount,
                        paid_amount: toNumber(form.paid_amount),
                        carry_forward_amount: feeItemsTotal(editableCarryForwardItems),
                      })
                    )}
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span>
                      การเปิดดูใบแจ้งหนี้:{" "}
                      <b className={activeInvoice.opened_count > 0 ? "text-blue-700" : "text-slate-700"}>
                        {activeInvoice.opened_count > 0
                          ? `เปิดแล้ว ${activeInvoice.opened_count} ครั้ง`
                          : "ยังไม่เปิด"}
                      </b>
                    </span>
                    <span>
                      เปิดครั้งแรก:{" "}
                      <b>{activeInvoice.first_opened_at ? new Date(activeInvoice.first_opened_at).toLocaleString("th-TH") : "-"}</b>
                    </span>
                    <span>
                      ล่าสุด:{" "}
                      <b>{activeInvoice.last_opened_at ? new Date(activeInvoice.last_opened_at).toLocaleString("th-TH") : "-"}</b>
                    </span>
                  </div>
                </div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">สถานะ</p>
                <select
                  value={form.status}
                  onChange={(event) => {
                    const nextStatus = event.target.value as keyof typeof statusVariant;
                    setForm((prev) => ({ ...prev, status: nextStatus }));
                    void updateInvoiceStatus(activeInvoice.id, nextStatus);
                  }}
                  disabled={!canUpdateInvoiceStatus}
                  title={!canUpdateInvoiceStatus ? "ไม่มีสิทธิ์เปลี่ยนสถานะใบแจ้งหนี้" : undefined}
                  className={`w-full rounded-xl border px-4 py-3 text-base font-semibold capitalize disabled:cursor-not-allowed disabled:opacity-70 ${statusPillClass(
                    form.status
                  )}`}
                >
                  {Object.keys(statusVariant).map((status) => (
                    <option key={status} value={status}>
                      {statusLabelThai(status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    ส่วนการรับชำระ
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowPaymentForm((prev) => !prev)}
                    disabled={!canRecordInvoicePayment}
                    title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์บันทึกการชำระเงิน" : undefined}
                    className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {showPaymentForm ? "ปิด" : "ชำระเงิน"}
                  </button>
                </div>
                {showPaymentForm && (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      <p>ยอดรวม: {formatMoney(toNumber(form.total_amount))}</p>
                      <p>ชำระแล้ว: {formatMoney(toNumber(form.paid_amount))}</p>
                      <p>
                        คงเหลือ:{" "}
                        {formatMoney(
                          invoiceDisplayOutstanding({
                            total_amount: form.total_amount,
                            paid_amount: toNumber(form.paid_amount),
                            carry_forward_amount: feeItemsTotal(editableCarryForwardItems),
                          })
                        )}
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="text-xs font-semibold text-slate-600">ประวัติการชำระก่อนหน้า</p>
                      {activeInvoice.payment_history.length === 0 ? (
                        <p className="mt-2 text-xs text-slate-500">ยังไม่มีประวัติการชำระ</p>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {activeInvoice.payment_history.map((item: any, idx: number) => (
                            <div
                              key={`${item.paid_at ?? item.created_at ?? idx}-${idx}`}
                              className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                            >
                              <p className="font-semibold">{formatMoney(toNumber(item.amount))}</p>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <p>
                                  {(item.mode ?? "-").toString().toUpperCase()} |{" "}
                                  {item.paid_at ? new Date(item.paid_at).toLocaleString("th-TH") : "-"}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void cancelPaymentEntry(idx)}
                                  disabled={!canRecordInvoicePayment || paymentSubmitting}
                                  title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์ยกเลิกรายการชำระเงิน" : undefined}
                                  className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  ยกเลิกรายการ
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="text-xs font-semibold text-slate-600">1) เลือกประเภทการชำระ</p>
                      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-700">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="radio"
                            name="payment-mode"
                            checked={paymentMode === "full"}
                            onChange={() => setPaymentMode("full")}
                          />
                          ชำระเต็มจำนวน
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="radio"
                            name="payment-mode"
                            checked={paymentMode === "partial"}
                            onChange={() => setPaymentMode("partial")}
                          />
                          ชำระบางส่วน
                        </label>
                      </div>
                      {paymentMode === "partial" && (
                        <div className="mt-2">
                          <p className="mb-1 text-xs text-slate-500">จำนวนเงินที่ชำระบางส่วน</p>
                          <input
                            type="number"
                            min={0}
                            value={paymentAmountInput}
                            onChange={(event) => setPaymentAmountInput(event.target.value)}
                            className="w-full max-w-[220px] rounded-lg border border-slate-200 px-3 py-2 text-sm text-right"
                            placeholder="จำนวนเงิน"
                          />
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="text-xs font-semibold text-slate-600">2) วันที่ชำระและสลิป</p>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs text-slate-500">วันที่ชำระ</p>
                          <input
                            type="date"
                            value={paymentDate}
                            onChange={(event) => setPaymentDate(event.target.value)}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <p className="mb-1 text-xs text-slate-500">อัปโหลดรูปสลิป</p>
                          <label className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">
                            <UploadCloud size={14} />
                            {paymentSlipFile ? paymentSlipFile.name : "เลือกไฟล์"}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(event) => setPaymentSlipFile(event.target.files?.[0] ?? null)}
                            />
                          </label>
                        </div>
                      </div>
                      {slipPreview && (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-slate-500">สลิปปัจจุบัน</p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!slipPreview) return;
                                  setSlipModalTitle(
                                    `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`
                                  );
                                  setSlipModalUrl(slipPreview);
                                  setSlipModalOpen(true);
                                }}
                                className="rounded-md border border-blue-200 px-2 py-1 text-xs font-semibold text-blue-700"
                              >
                                เปิดภาพเต็ม
                              </button>
                              <button
                                type="button"
                                onClick={() => void deletePaymentSlip()}
                                disabled={!canRecordInvoicePayment || paymentSubmitting}
                                title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์ลบสลิปการชำระเงิน" : undefined}
                                className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                ลบสลิป
                              </button>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (!slipPreview) return;
                              setSlipModalTitle(
                                `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`
                              );
                              setSlipModalUrl(slipPreview);
                              setSlipModalOpen(true);
                            }}
                            className="mt-2 block w-full"
                            title="คลิกเพื่อดูสลิปขนาดเต็ม"
                          >
                            <img
                              src={slipPreview}
                              alt="สลิป"
                              className="max-h-56 w-full rounded-lg border object-contain"
                            />
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void submitPayment()}
                      disabled={paymentSubmitting || !canRecordInvoicePayment}
                      title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์บันทึกการชำระเงิน" : undefined}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {paymentSubmitting ? "กำลังบันทึก..." : "บันทึกการชำระ"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <fieldset
              disabled={!(canEditDetails && canEditInvoice)}
              className={!(canEditDetails && canEditInvoice) ? "cursor-not-allowed opacity-70" : ""}
            >
            <div className="space-y-3 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-700">รายละเอียดหลักใบแจ้งหนี้</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">รายการ</th>
                      <th className="px-3 py-2 text-left">ค่า</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">วันที่ออกบิล</td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={form.issue_date}
                          onChange={(event) => updateForm("issue_date", event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-1.5"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">วันครบกำหนดชำระ</td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={form.due_date}
                          onChange={(event) => updateForm("due_date", event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-1.5"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">ค่าเช่าห้อง</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.rent_amount}
                          onChange={(event) => updateForm("rent_amount", event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100 bg-amber-50">
                      <td className="px-3 py-2 font-medium text-amber-900">คำนวณ pro-rate</td>
                      <td className="px-3 py-2">
                        <label className="inline-flex items-center gap-2 text-amber-900">
                          <input
                            type="checkbox"
                            checked={useProrateInModal}
                            onChange={(event) => toggleProrateInModal(event.target.checked)}
                          />
                          ใช้การคิดค่าเช่าแบบ pro-rate สำหรับบิลนี้
                        </label>
                        {modalProrateSummary && (
                          <p className="mt-2 text-xs text-amber-800">
                            สูตรคำนวณ: {modalProrateSummary.formulaText} (วันเข้าอยู่{" "}
                            {modalProrateSummary.moveInDay}, วันตัดรอบ {modalProrateSummary.billingDay})
                          </p>
                        )}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        ค่าน้ำ
                        <p className="text-xs font-normal text-slate-500">
                          อัตรา: {formatMoney(toNumber(printSettings?.water_rate))}/หน่วย
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="mb-1 text-xs text-slate-500">หน่วย</p>
                            <input
                              type="number"
                              value={form.water_units}
                              onChange={(event) => updateUtilityUnits("water_units", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-slate-500">ยอดรวม</p>
                            <input
                              type="number"
                              value={form.water_bill}
                              onChange={(event) => updateForm("water_bill", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        ค่าไฟ
                        <p className="text-xs font-normal text-slate-500">
                          อัตรา: {formatMoney(toNumber(printSettings?.electricity_rate))}/หน่วย
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="mb-1 text-xs text-slate-500">หน่วย</p>
                            <input
                              type="number"
                              value={form.electricity_units}
                              onChange={(event) => updateUtilityUnits("electricity_units", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-slate-500">ยอดรวม</p>
                            <input
                              type="number"
                              value={form.electricity_bill}
                              onChange={(event) => updateForm("electricity_bill", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">ค่าส่วนกลาง</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.common_fee}
                          onChange={(event) => updateForm("common_fee", event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">รวมส่วนลด</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.discount_amount}
                          readOnly
                          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">ค่าปรับล่าช้า</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.late_fee_amount}
                          onChange={(event) => updateForm("late_fee_amount", event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-amber-200 bg-amber-50/60">
                      <td className="px-3 py-2 font-medium text-amber-900">
                        ส่วนคำนวณค่าปรับล่าช้า
                        <p className="text-xs font-normal text-amber-800">
                          ใช้วันเริ่มค่าปรับและอัตรารายวันเพื่อช่วยคำนวณยอด ณ วันนี้
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <div className="grid gap-2 md:grid-cols-3">
                          <div>
                            <p className="mb-1 text-xs text-amber-800">วันเริ่มคิดค่าปรับ</p>
                            <input
                              type="date"
                              value={form.late_fee_start_date}
                              onChange={(event) => updateForm("late_fee_start_date", event.target.value)}
                              className="w-full rounded-lg border border-amber-200 bg-white px-3 py-1.5"
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-amber-800">อัตราค่าปรับ/วัน</p>
                            <input
                              type="number"
                              value={form.late_fee_per_day}
                              onChange={(event) => updateForm("late_fee_per_day", event.target.value)}
                              className="w-full rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-right"
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-amber-800">ยอดคำนวณ ณ วันนี้</p>
                            <div className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-right text-sm font-semibold text-amber-900">
                              {formatMoney(lateFeePreview.amount)}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-amber-900">
                            เกินกำหนด {lateFeePreview.days.toLocaleString("th-TH")} วัน x{" "}
                            {formatMoney(toNumber(form.late_fee_per_day))}/วัน
                          </p>
                          <button
                            type="button"
                            onClick={() => updateForm("late_fee_amount", lateFeePreview.amount)}
                            className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800"
                          >
                            ใช้ยอดคำนวณนี้
                          </button>
                        </div>
                        {arrearsSnapshots.length > 0 && (
                          <div className="mt-3 overflow-x-auto rounded-xl border border-amber-200 bg-white">
                            <table className="w-full min-w-[760px] text-sm">
                              <thead className="bg-amber-100/70 text-amber-900">
                                <tr>
                                  <th className="px-3 py-2 text-left">บิลต้นทาง</th>
                                  <th className="px-3 py-2 text-left">คำนวณถึงวันที่</th>
                                  <th className="px-3 py-2 text-right">ยอดค้างต้นทาง</th>
                                  <th className="px-3 py-2 text-right">วันเกินกำหนด</th>
                                  <th className="px-3 py-2 text-right">อัตรา/วัน</th>
                                  <th className="px-3 py-2 text-right">ค่าปรับที่คิดในบิลนี้</th>
                                </tr>
                              </thead>
                              <tbody>
                                {arrearsSnapshots.map((row) => (
                                  <tr key={row.id} className="border-t border-amber-100">
                                    <td className="px-3 py-2 font-medium">
                                      {shortInvoiceId(row.source_invoice_id)}
                                    </td>
                                    <td className="px-3 py-2">{row.snapshot_as_of}</td>
                                    <td className="px-3 py-2 text-right">
                                      {formatMoney(row.principal_amount)}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {row.days_overdue.toLocaleString("th-TH")}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      {formatMoney(row.daily_rate)}
                                    </td>
                                    <td className="px-3 py-2 text-right font-semibold text-amber-900">
                                      {formatMoney(row.late_fee_amount)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">รวมค่าธรรมเนียมเพิ่มเติม</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.additional_fees_total}
                          readOnly
                          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                    <tr className="border-t border-slate-100 bg-slate-50">
                      <td className="px-3 py-2 font-semibold">ยอดรวมสุทธิ</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={form.total_amount}
                          readOnly
                          className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-right font-semibold"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {transferBreakdownItems.length > 0 && (
              <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
                <p className="text-sm font-semibold text-blue-900">สรุปย้ายห้องกลางเดือน</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-blue-100/70 text-blue-900">
                      <tr>
                        <th className="px-2 py-2 text-left">รายการ</th>
                        <th className="px-2 py-2 text-left">รายละเอียด</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transferBreakdownItems.map((item, index) => (
                        <tr key={`${item.label}-${index}`} className="border-t border-blue-100">
                          <td className="px-2 py-2 font-medium">{item.label}</td>
                          <td className="px-2 py-2">{item.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-amber-900">ยอดค้างยกมา</p>
                  <p className="text-xs text-amber-800">
                    แก้ไขหรือลบได้ในกรณีที่ต้องการปรับยอดค้างที่นำมาทบในบิลนี้
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditableCarryForwardItems((prev) => [...prev, emptyCarryForwardItem()])}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800"
                >
                  เพิ่มแถวยอดค้าง
                </button>
              </div>

              {editableCarryForwardItems.length === 0 ? (
                <p className="text-xs text-amber-800">ยังไม่มียอดค้างยกมาในบิลนี้</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-amber-100/80 text-amber-900">
                      <tr>
                        <th className="px-2 py-2 text-left">รายละเอียด</th>
                        <th className="px-2 py-2 text-left">อ้างอิงบิลเดิม</th>
                        <th className="px-2 py-2 text-right">หน่วย</th>
                        <th className="px-2 py-2 text-right">ราคา/หน่วย</th>
                        <th className="px-2 py-2 text-right">ยอดรวม</th>
                        <th className="px-2 py-2 text-right">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editableCarryForwardItems.map((item, index) => (
                        <tr key={`carry-${index}`} className="border-t border-amber-100">
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              value={item.detail}
                              onChange={(event) =>
                                updateCarryForwardItem(index, "detail", event.target.value)
                              }
                              className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1"
                              placeholder="เช่น ยอดค้างชำระงวด 2026-02"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <div className="space-y-1">
                              <input
                                type="text"
                                value={item.source_invoice_id ?? ""}
                                onChange={(event) =>
                                  updateCarryForwardItem(
                                    index,
                                    "source_invoice_id",
                                    event.target.value
                                  )
                                }
                                className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1"
                                placeholder="invoice id เดิม (ถ้ามี)"
                              />
                              <p className="text-[11px] text-amber-800">
                                เลขย่อ: {shortInvoiceId(item.source_invoice_id)}
                              </p>
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.unit}
                              onChange={(event) => updateCarryForwardItem(index, "unit", event.target.value)}
                              className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.price_per_unit}
                              onChange={(event) =>
                                updateCarryForwardItem(index, "price_per_unit", event.target.value)
                              }
                              className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-amber-950">
                            {formatMoney(toNumber(item.total_amount))}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setEditableCarryForwardItems((prev) =>
                                  prev.filter((_, idx) => idx !== index)
                                )
                              }
                              className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-red-600"
                            >
                              ลบ
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">รายละเอียดค่าธรรมเนียมเพิ่มเติม</p>
                <button
                  type="button"
                  onClick={() => setEditableFeeItems((prev) => [...prev, emptyFeeItem()])}
                  className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  เพิ่มแถวค่าธรรมเนียม
                </button>
              </div>

              {editableFeeItems.length === 0 ? (
                <p className="text-xs text-slate-500">ยังไม่มีรายการค่าธรรมเนียมเพิ่มเติม</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-2 py-2 text-left">รายละเอียด</th>
                        <th className="px-2 py-2 text-right">หน่วย</th>
                        <th className="px-2 py-2 text-right">ราคา/หน่วย</th>
                        <th className="px-2 py-2 text-right">ยอดรวม</th>
                        <th className="px-2 py-2 text-right">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editableFeeItems.map((item, index) => (
                        <tr key={index} className="border-t border-slate-100">
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              value={item.detail}
                              onChange={(event) => updateFeeItem(index, "detail", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-2 py-1"
                              placeholder="เช่น ค่าที่จอดรถ"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.unit}
                              onChange={(event) => updateFeeItem(index, "unit", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.price_per_unit}
                              onChange={(event) =>
                                updateFeeItem(index, "price_per_unit", event.target.value)
                              }
                              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-slate-900">
                            {formatMoney(toNumber(item.total_amount))}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setEditableFeeItems((prev) => {
                                  const next = prev.filter((_, idx) => idx !== index);
                                  const nextAdditional = feeItemsTotal(next);
                                  setForm((formPrev) => {
                                    const total =
                                      toNumber(formPrev.rent_amount) +
                                      toNumber(formPrev.water_bill) +
                                      toNumber(formPrev.electricity_bill) +
                                      toNumber(formPrev.common_fee) +
                                      toNumber(formPrev.discount_amount) * -1 +
                                      toNumber(formPrev.late_fee_amount) +
                                      nextAdditional;
                                    return {
                                      ...formPrev,
                                      additional_fees_total: nextAdditional,
                                      total_amount: total,
                                    };
                                  });
                                  return next;
                                })
                              }
                              className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600"
                            >
                              ลบ
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">รายละเอียดส่วนลด</p>
                <button
                  type="button"
                  onClick={() => setEditableDiscountItems((prev) => [...prev, emptyFeeItem()])}
                  className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  เพิ่มแถวส่วนลด
                </button>
              </div>

              {editableDiscountItems.length === 0 ? (
                <p className="text-xs text-slate-500">ยังไม่มีรายการส่วนลด</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-2 py-2 text-left">รายละเอียด</th>
                        <th className="px-2 py-2 text-right">หน่วย</th>
                        <th className="px-2 py-2 text-right">ราคา/หน่วย</th>
                        <th className="px-2 py-2 text-right">ยอดรวม</th>
                        <th className="px-2 py-2 text-right">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editableDiscountItems.map((item, index) => (
                        <tr key={index} className="border-t border-slate-100">
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              value={item.detail}
                              onChange={(event) => updateDiscountItem(index, "detail", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-2 py-1"
                              placeholder="เช่น ส่วนลดชำระก่อนกำหนด"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.unit}
                              onChange={(event) => updateDiscountItem(index, "unit", event.target.value)}
                              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              type="number"
                              value={item.price_per_unit}
                              onChange={(event) =>
                                updateDiscountItem(index, "price_per_unit", event.target.value)
                              }
                              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                            />
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-slate-900">
                            {formatMoney(toNumber(item.total_amount))}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setEditableDiscountItems((prev) => {
                                  const next = prev.filter((_, idx) => idx !== index);
                                  const nextAdditional = feeItemsTotal(editableFeeItems);
                                  const nextDiscount = feeItemsTotal(next);
                                  setForm((formPrev) => {
                                    const total =
                                      toNumber(formPrev.rent_amount) +
                                      toNumber(formPrev.water_bill) +
                                      toNumber(formPrev.electricity_bill) +
                                      toNumber(formPrev.common_fee) +
                                      nextDiscount * -1 +
                                      toNumber(formPrev.late_fee_amount) +
                                      nextAdditional;
                                    return {
                                      ...formPrev,
                                      discount_amount: nextDiscount,
                                      total_amount: total,
                                    };
                                  });
                                  return next;
                                })
                              }
                              className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600"
                            >
                              ลบ
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <label className="text-sm text-slate-600">
              หมายเหตุ
              <textarea
                value={form.notes}
                onChange={(event) => updateForm("notes", event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm"
                rows={3}
              />
            </label>
            </fieldset>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-slate-700">เมนูด่วน</p>
              <button
                onClick={() => void getInvoicePrintDetail(activeInvoice)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                <Printer size={16} />
                พรีวิวก่อนพิมพ์
              </button>
              <button
                onClick={() => void getInvoicePrintDetail(activeInvoice, "receipt")}
                disabled={!(activeInvoice.status === "verifying" || activeInvoice.status === "paid")}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 px-4 py-2 text-sm text-emerald-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                <FileText size={16} />
                พิมพ์ใบเสร็จ
              </button>
              <button
                onClick={() => sendToLine(activeInvoice)}
                className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm text-white"
              >
                <Send size={16} />
                Send to LINE
              </button>
              <button
                onClick={() => {
                  setDeleteTargetIds([activeInvoice.id]);
                  setConfirmDeleteOpen(true);
                }}
                disabled={!canDeleteInvoice}
                title={!canDeleteInvoice ? "ไม่มีสิทธิ์ลบใบแจ้งหนี้" : undefined}
                className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600 disabled:cursor-not-allowed disabled:text-red-300"
              >
                <Trash2 size={16} />
                ลบใบแจ้งหนี้
              </button>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDetailOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                ยกเลิก
              </button>
              <button
                onClick={() => setConfirmSaveOpen(true)}
                disabled={!(canEditDetails && canEditInvoice)}
                title={!(canEditDetails && canEditInvoice) ? "ไม่มีสิทธิ์แก้ไขรายละเอียดใบแจ้งหนี้" : undefined}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                บันทึกการเปลี่ยนแปลง
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={slipModalOpen}
        onClose={() => setSlipModalOpen(false)}
        title={slipModalTitle || "สลิปการชำระเงิน"}
        size="lg"
      >
        {slipModalUrl ? (
          <div className="space-y-3">
            <img src={slipModalUrl} alt="สลิปการชำระเงิน" className="w-full rounded-xl border border-slate-200" />
            <div className="flex justify-end">
              <button
                onClick={() => setSlipModalOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                ปิด
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">ไม่มีรูปสลิป</p>
        )}
      </Modal>

      <Modal
        isOpen={lineSendModalOpen}
        onClose={() => {
          if (lineSendState === "sending") return;
          setLineSendModalOpen(false);
        }}
        title={lineSendTitle}
        size="md"
      >
        <div className="space-y-4">
          <div
            className={`rounded-xl border p-4 text-sm ${
              lineSendState === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : lineSendState === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-blue-200 bg-blue-50 text-blue-800"
            }`}
          >
            <div className="flex items-start gap-3">
              {lineSendState === "sending" ? (
                <Loader2 size={18} className="mt-0.5 animate-spin" />
              ) : lineSendState === "success" ? (
                <CheckCircle2 size={18} className="mt-0.5" />
              ) : (
                <AlertCircle size={18} className="mt-0.5" />
              )}
              <p>{lineSendMessage}</p>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setLineSendModalOpen(false)}
              disabled={lineSendState === "sending"}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {lineSendState === "sending" ? "กำลังส่ง..." : "ปิด"}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmActionModal
        isOpen={confirmGenerateOpen}
        title="สร้างใบแจ้งหนี้"
        message={`สร้างใบแจ้งหนี้สำหรับเดือน ${selectedMonth} ใช่หรือไม่?`}
        confirmLabel="สร้าง"
        loading={saving}
        onCancel={() => setConfirmGenerateOpen(false)}
        onConfirm={generateInvoices}
      />

      <ConfirmActionModal
        isOpen={confirmSaveOpen}
        title="บันทึกใบแจ้งหนี้"
        message="ยืนยันการบันทึกการเปลี่ยนแปลงใบแจ้งหนี้นี้?"
        confirmLabel="บันทึก"
        loading={saving}
        onCancel={() => setConfirmSaveOpen(false)}
        onConfirm={saveInvoice}
      />

      <ConfirmActionModal
        isOpen={confirmDeleteOpen}
        title="ลบใบแจ้งหนี้"
        message={
          deleteTargetIds.length > 1
            ? `การกระทำนี้ไม่สามารถย้อนกลับได้ ต้องการลบ ${deleteTargetIds.length} ใบแจ้งหนี้หรือไม่?`
            : "การกระทำนี้ไม่สามารถย้อนกลับได้ ต้องการลบใบแจ้งหนี้นี้หรือไม่?"
        }
        confirmLabel="ลบ"
        loading={saving}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={async () => {
          if (deleteTargetIds.length === 0) return;
          setSaving(true);
          await deleteInvoices(deleteTargetIds);
          setSaving(false);
          setConfirmDeleteOpen(false);
          setDeleteTargetIds([]);
        }}
      />

      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={previewDocType === "receipt" ? "พรีวิวใบเสร็จรับเงิน" : "พรีวิวใบแจ้งหนี้"}
        size="xl"
      >
        {previewInvoice && (
          <div className="space-y-5 text-sm text-slate-700">
            {previewLoading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">กำลังโหลดพรีวิว...</div>
            ) : (
              <>
                <div className="flex flex-wrap justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
                  <div className="space-y-1">
                    <p className="text-lg font-bold text-slate-900">
                      {printSettings?.dorm_name || "หอพัก"}
                    </p>
                    <p>{printSettings?.dorm_address || "-"}</p>
                    <p>ผู้เช่า: {previewInvoice.tenant_name}</p>
                    <p>ห้อง: {previewInvoice.room_number}</p>
                    <p>โทร: {previewInvoice.tenant_phone || "-"}</p>
                  </div>
                  <div className="space-y-1 text-right">
                    <p>
                      <span className="font-semibold">
                        {previewDocType === "receipt" ? "เลขที่ใบเสร็จรับเงิน:" : "เลขที่ใบแจ้งหนี้:"}
                      </span>{" "}
                      {previewInvoice.id.slice(0, 8).toUpperCase()}
                    </p>
                    <p>
                      <span className="font-semibold">เลขห้อง:</span> {previewInvoice.room_number}
                    </p>
                    <p>
                      <span className="font-semibold">วันที่:</span>{" "}
                      {formatDateThai(previewInvoice.issue_date)}
                    </p>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">รายละเอียด</th>
                        <th className="px-3 py-2 text-right">หน่วย</th>
                        <th className="px-3 py-2 text-right">ราคา/หน่วย</th>
                        <th className="px-3 py-2 text-right">จำนวนเงิน</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าเช่าห้องพัก</td>
                        <td className="px-3 py-2 text-right">1 เดือน</td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.rent_amount)}</td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.rent_amount)}</td>
                      </tr>
                      {!!(() => {
                        const summary = calculateProratedRentByBillingDay(
                          toNumber(previewInvoice.room_price_month || previewInvoice.rent_amount),
                          previewInvoice.tenant_move_in_date,
                          printSettings?.billing_day
                        );
                        return (
                          summary &&
                          Math.abs(toNumber(previewInvoice.rent_amount) - summary.rentAmount) < 0.01
                        );
                      })() && (
                        <tr className="border-t border-amber-200 bg-amber-50">
                          <td className="px-3 py-2 text-xs text-amber-800" colSpan={4}>
                            สูตรคำนวณ:{" "}
                            {
                              calculateProratedRentByBillingDay(
                                toNumber(previewInvoice.room_price_month || previewInvoice.rent_amount),
                                previewInvoice.tenant_move_in_date,
                                printSettings?.billing_day
                              )?.formulaText
                            }
                          </td>
                        </tr>
                      )}
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าน้ำ</td>
                        <td className="px-3 py-2 text-right">
                          {resolveWaterUsage(previewReading).toLocaleString("th-TH")} หน่วย
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatMoney(toNumber(printSettings?.water_rate))}
                        </td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.water_bill)}</td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าไฟ</td>
                        <td className="px-3 py-2 text-right">
                          {resolveElectricityUsage(previewReading).toLocaleString("th-TH")} หน่วย
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatMoney(toNumber(printSettings?.electricity_rate))}
                        </td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.electricity_bill)}</td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าส่วนกลาง</td>
                        <td className="px-3 py-2 text-right">-</td>
                        <td className="px-3 py-2 text-right">-</td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.common_fee)}</td>
                      </tr>
                      {toTransferBreakdownItems(previewInvoice.additional_fees_breakdown ?? []).length > 0 && (
                        <tr className="border-t border-blue-200 bg-blue-50">
                          <td className="px-3 py-2 font-semibold text-blue-900" colSpan={4}>
                            สรุปย้ายห้องกลางเดือน
                          </td>
                        </tr>
                      )}
                      {toTransferBreakdownItems(previewInvoice.additional_fees_breakdown ?? []).map(
                        (row, idx) => (
                          <tr key={`transfer-${idx}`} className="border-t border-slate-100">
                            <td className="px-3 py-2">{row.label}</td>
                            <td className="px-3 py-2 text-right" colSpan={3}>
                              {row.value}
                            </td>
                          </tr>
                        )
                      )}
                      {toCarryForwardRows(previewInvoice.additional_fees_breakdown ?? []).map(
                        (fee: any, idx: number) => (
                          <tr
                            key={`carry-forward-${fee.label ?? fee.detail ?? ""}-${idx}`}
                            className="border-t border-amber-100 bg-amber-50/60"
                          >
                            <td className="px-3 py-2">
                              ยอดค้างยกมา - {fee.detail ?? fee.label ?? "-"}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {toNumber(fee.unit).toLocaleString("th-TH") || "-"}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatMoney(
                                toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-amber-900">
                              {formatMoney(toNumber(fee.total_amount ?? fee.amount))}
                            </td>
                          </tr>
                        )
                      )}
                      {(
                        Array.isArray(previewInvoice.discount_breakdown) && previewInvoice.discount_breakdown.length > 0
                          ? previewInvoice.discount_breakdown
                          : previewInvoice.discount_amount > 0
                            ? [{ detail: "ส่วนลด", unit: 1, total_amount: previewInvoice.discount_amount, price_per_unit: previewInvoice.discount_amount }]
                            : []
                      ).map((fee: any, idx: number) => (
                        <tr key={`discount-${fee.label ?? fee.detail ?? ""}-${idx}`} className="border-t border-slate-100">
                          <td className="px-3 py-2">ส่วนลด - {fee.detail ?? fee.label ?? "-"}</td>
                          <td className="px-3 py-2 text-right">
                            {toNumber(fee.unit).toLocaleString("th-TH") || "-"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            -{formatMoney(toNumber(fee.total_amount ?? fee.amount))}
                          </td>
                        </tr>
                      ))}
                      {previewArrearsSnapshots.length > 0 ? (
                        previewArrearsSnapshots.map((row) => (
                          <tr key={`preview-late-fee-${row.id}`} className="border-t border-amber-100 bg-amber-50/40">
                            <td className="px-3 py-2">
                              ค่าปรับล่าช้า - บิล {shortInvoiceId(row.source_invoice_id)} (คำนวณถึง{" "}
                              {formatDateThai(row.snapshot_as_of)})
                            </td>
                            <td className="px-3 py-2 text-right">
                              {row.days_overdue.toLocaleString("th-TH")} วัน
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatMoney(row.daily_rate)}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-amber-900">
                              {formatMoney(row.late_fee_amount)}
                            </td>
                          </tr>
                        ))
                      ) : previewInvoice.late_fee_amount > 0 ? (
                        <tr className="border-t border-slate-100">
                          <td className="px-3 py-2">ค่าปรับล่าช้า</td>
                          <td className="px-3 py-2 text-right">-</td>
                          <td className="px-3 py-2 text-right">-</td>
                          <td className="px-3 py-2 text-right">
                            {formatMoney(previewInvoice.late_fee_amount)}
                          </td>
                        </tr>
                      ) : null}
                      {toChargeFeeRows(previewInvoice.additional_fees_breakdown ?? []).map((fee: any, idx: number) => (
                        <tr key={`${fee.label}-${idx}`} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            ค่าธรรมเนียมเพิ่มเติม - {fee.detail ?? fee.label ?? "-"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {toNumber(fee.unit).toLocaleString("th-TH") || "-"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              toNumber(fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount)
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatMoney(toNumber(fee.total_amount ?? fee.amount))}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
                        <td className="px-3 py-2 text-right" colSpan={3}>
                          ยอดรวมสุทธิ
                        </td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.total_amount)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="space-y-1 rounded-xl border border-slate-200 bg-white p-4">
                  <p>
                    <span className="font-semibold">ช่องทางชำระเงิน:</span>{" "}
                    {getPaymentMethodLabel(previewInvoice)}
                  </p>
                  <p>
                    <span className="font-semibold">หมายเหตุ:</span> {previewInvoice.notes || "-"}
                  </p>
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPreviewOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                ปิด
              </button>
              <button
                onClick={() =>
                  previewInvoice &&
                  printInvoice(
                    previewInvoice,
                    previewReading,
                    previewDocType,
                    previewArrearsSnapshots
                  )
                }
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
              >
                <Printer size={16} />
                {previewDocType === "receipt" ? "พิมพ์ใบเสร็จรับเงิน" : "พิมพ์ใบแจ้งหนี้"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

