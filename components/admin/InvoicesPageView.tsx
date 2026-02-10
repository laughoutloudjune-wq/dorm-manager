"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { FileText, Pencil, Printer, Send, Trash2, UploadCloud } from "lucide-react";

const statusVariant = {
  draft: "default",
  pending: "warning",
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
  additional_fees_total: number;
  additional_fees_breakdown: any[];
  notes: string | null;
  public_token: string;
  slip_url: string | null;
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

type PrintSettings = {
  dorm_name: string | null;
  dorm_address: string | null;
  water_rate: number | null;
  electricity_rate: number | null;
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
};

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

const emptyFeeItem = (): FeeLineItem => ({
  detail: "",
  unit: 1,
  price_per_unit: 0,
  total_amount: 0,
});

const feeItemsTotal = (items: FeeLineItem[]) =>
  items.reduce((sum, item) => sum + toNumber(item.total_amount), 0);

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

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
    additional_fees_total: toNumber(row.additional_fees_total),
    additional_fees_breakdown: Array.isArray(row.additional_fees_breakdown)
      ? row.additional_fees_breakdown
      : [],
    notes: row.notes ?? null,
    public_token: row.public_token,
    slip_url: row.slip_url ?? null,
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
  const [printSettings, setPrintSettings] = useState<PrintSettings | null>(null);
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethodRow | null>(null);
  const [editableFeeItems, setEditableFeeItems] = useState<FeeLineItem[]>([]);
  const [editableDiscountItems, setEditableDiscountItems] = useState<FeeLineItem[]>([]);

  const [form, setForm] = useState({
    issue_date: "",
    due_date: "",
    start_date: "",
    end_date: "",
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
    status: "pending",
    notes: "",
  });

  const applyPendingToOverdue = async () => {
    const today = toLocalDateString(new Date());
    const { error: overdueError } = await supabase
      .from("invoices")
      .update({ status: "overdue" })
      .eq("status", "pending")
      .lt("due_date", today);
    if (overdueError) {
      setError(overdueError.message);
    }
  };

  const applySlipToVerifying = async () => {
    const { error: verifyingError } = await supabase
      .from("invoices")
      .update({ status: "verifying" })
      .in("status", ["pending", "overdue"])
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
        "id,room_id,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,additional_fees_total,discount_amount,discount_breakdown,total_amount"
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

    await applySlipToVerifying();
    await applyPendingToOverdue();
    await syncMonthInvoicesWithSettings(year, month);

    const { data, error: fetchError } = await supabase
      .from("invoices")
      .select(
        "id,room_id,status,total_amount,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date),rooms(room_number,price_month,buildings(name))"
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
        () => {
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
      .select("dorm_name,dorm_address,water_rate,electricity_rate,billing_day,due_day,late_fee_start_day,additional_discounts")
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
    setSlipModalTitle(`Payment Slip - Room ${invoice.room_number}`);
    setSlipModalUrl(invoice.slip_url);
    setSlipModalOpen(true);
  };

  const updateInvoiceStatus = async (
    invoiceId: string,
    status: "pending" | "paid" | "overdue"
  ) => {
    const { error: statusError } = await supabase.from("invoices").update({ status }).eq("id", invoiceId);
    if (statusError) {
      setError(statusError.message);
      return;
    }
    await loadInvoices();
  };

  const openInvoice = (invoice: InvoiceRecord) => {
    const feeItems = toFeeItems(invoice.additional_fees_breakdown ?? []);
    const discountItems = toFeeItems(invoice.discount_breakdown ?? []);
    const todayLocal = toLocalDateString(new Date());
    const dueDateFromSetting = computeDateByDayInMonth(todayLocal, printSettings?.due_day);
    const lateStartFromSetting = computeDateByDayInMonth(
      todayLocal,
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
    setEditableDiscountItems(
      discountItems.length > 0
        ? discountItems
        : invoice.discount_amount > 0
          ? [{ detail: "ส่วนลด", unit: 1, price_per_unit: invoice.discount_amount, total_amount: invoice.discount_amount }]
          : []
    );
    setForm({
      issue_date: todayLocal,
      due_date: dueDateFromSetting,
      start_date: invoice.start_date,
      end_date: invoice.end_date,
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
      status: invoice.status,
      notes: invoice.notes || "",
    });
    setSlipPreview(invoice.slip_url);
    setDetailOpen(true);
  };

  const updateForm = (field: string, value: string | number) => {
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

  const toggleProrateInModal = (enabled: boolean) => {
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
    if (!activeInvoice) return;
    setSaving(true);

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
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
        additional_fees_total: feeItemsTotal(editableFeeItems),
        additional_fees_breakdown: editableFeeItems.map((item) => ({
          detail: item.detail,
          unit: toNumber(item.unit),
          price_per_unit: toNumber(item.price_per_unit),
          total_amount: toNumber(item.total_amount),
          amount: toNumber(item.total_amount),
          label: item.detail,
        })),
        total_amount: toNumber(form.total_amount),
        status: form.status,
        notes: form.notes,
      })
      .eq("id", activeInvoice.id);

    setSaving(false);
    setConfirmSaveOpen(false);

    if (updateError) {
      setError(updateError.message);
    } else {
      await loadInvoices();
      setDetailOpen(false);
    }
  };

  const deleteInvoices = async (invoiceIds: string[]) => {
    if (invoiceIds.length === 0) return;
    const { error: deleteError } = await supabase.from("invoices").delete().in("id", invoiceIds);
    if (deleteError) {
      setError(deleteError.message);
    } else {
      const idSet = new Set(invoiceIds);
      setInvoices((prev) => prev.filter((invoice) => !idSet.has(invoice.id)));
      setSelected((prev) => prev.filter((id) => !idSet.has(id)));
      if (activeInvoice && idSet.has(activeInvoice.id)) setDetailOpen(false);
    }
  };

  const handleUploadSlip = async (file?: File | null) => {
    if (!activeInvoice || !file) return;

    const bucket = "payment_slips";
    const filePath = `${activeInvoice.id}/${Date.now()}-${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, file, { upsert: true });

    if (uploadError) {
      setError(uploadError.message);
      return;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    const publicUrl = data.publicUrl;

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        slip_url: publicUrl,
        slip_uploaded_at: new Date().toISOString(),
        status: "verifying",
      })
      .eq("id", activeInvoice.id);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSlipPreview(publicUrl);
    await loadInvoices();
  };

  const sendToLine = async (invoice: InvoiceRecord) => {
    if (!invoice.tenant_line_user_id) {
      setError(`Missing LINE user id for ${invoice.tenant_name}`);
      return;
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
      setError(detail || "Failed to send LINE message");
    }
  };

  const sendSelectedToLine = async () => {
    for (const id of selected) {
      const invoice = invoices.find((item) => item.id === id);
      if (invoice) await sendToLine(invoice);
    }
  };

  const getInvoicePrintDetail = async (invoice: InvoiceRecord) => {
    setPreviewLoading(true);
    setPreviewInvoice(invoice);
    const readingMonth = monthStartFromDate(invoice.issue_date);
    const { data } = await supabase
      .from("meter_readings")
      .select("electricity_usage,water_usage")
      .eq("room_id", invoice.room_id)
      .eq("reading_month", readingMonth)
      .maybeSingle();
    setPreviewReading((data as MeterReadingRow) ?? null);
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

  const buildPrintHtml = (invoice: InvoiceRecord, reading: MeterReadingRow | null) => {
    const dormName = printSettings?.dorm_name || "หอพัก";
    const dormAddress = printSettings?.dorm_address || "-";
    const elecRate = toNumber(printSettings?.electricity_rate);
    const waterRate = toNumber(printSettings?.water_rate);
    const elecUnits = toNumber(reading?.electricity_usage);
    const waterUnits = toNumber(reading?.water_usage);
    const paymentText = getPaymentMethodLabel(invoice);
    const prorateSummary = calculateProratedRentByBillingDay(
      toNumber(invoice.room_price_month || invoice.rent_amount),
      invoice.tenant_move_in_date,
      printSettings?.billing_day
    );
    const showProrateFormula =
      !!prorateSummary && Math.abs(toNumber(invoice.rent_amount) - prorateSummary.rentAmount) < 0.01;
    const additionalRows = (invoice.additional_fees_breakdown ?? [])
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

    return `
      <html>
      <head>
        <title>ใบแจ้งหนี้ ${invoice.id}</title>
        <style>
          body { font-family: Sarabun, Tahoma, sans-serif; padding: 28px; color: #0f172a; }
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
            <p class="sub"><b>เลขที่ใบแจ้งหนี้:</b> ${invoice.id.slice(0, 8).toUpperCase()}</p>
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
              <tr>
                <td>ส่วนลด</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">-${formatMoney(invoice.discount_amount)}</td>
              </tr>
              <tr>
                <td>ค่าปรับล่าช้า</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">${formatMoney(invoice.late_fee_amount)}</td>
              </tr>
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

  const printInvoice = (invoice: InvoiceRecord, reading: MeterReadingRow | null) => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(buildPrintHtml(invoice, reading));

    win.document.close();
    win.focus();
    win.print();
  };

  const generateInvoices = async () => {
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

    const dueDay = clampDay((settings as any).due_day ?? 5);
    const lateFeeStartDay = clampDay((settings as any).late_fee_start_day ?? 6);
    const lateFeePerDay = toNumber((settings as any).late_fee_per_day ?? 0);
    const issueDateToday = new Date();
    const issueDateText = toLocalDateString(issueDateToday);
    const generatedDueDateText = toLocalDateString(
      new Date(issueDateToday.getFullYear(), issueDateToday.getMonth(), dueDay)
    );
    const generatedLateFeeStartDateText = toLocalDateString(
      new Date(issueDateToday.getFullYear(), issueDateToday.getMonth(), lateFeeStartDay)
    );

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

      const elecUnits = toNumber(reading.electricity_usage);
      const waterUnits = toNumber(reading.water_usage ?? reading.usage);

      const rentAmount = toNumber(roomRel?.price_month);

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

      const commonFee = toNumber(settings.common_fee);
      const lateFeeAmount = 0;
      const totalAmount =
        rentAmount + waterBill + elecBill + commonFee + additionalTotal + lateFeeAmount - discountAmount;

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
        additional_fees_total: additionalTotal,
        additional_fees_breakdown: additionalBreakdown,
        total_amount: totalAmount,
        status: "pending",
      };
      }) as any[];

    const generatedRoomIds = new Set(insertPayload.map((row: any) => row.room_id));
    if (insertPayload.length > 0) {
      const { error: insertError } = await supabase.from("invoices").insert(insertPayload);
      if (insertError) {
        setError(insertError.message);
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
        `Generated ${insertPayload.length} invoice(s). Skipped ${existingRoomIds.size} room(s) that already had invoices for this period.`
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

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-1">
          <Input
            label="Invoice Month"
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setConfirmGenerateOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20"
          >
            <FileText size={16} />
            Generate Monthly Invoices
          </button>
        </div>
      </div>

      {error && <span className="text-sm text-red-600">{error}</span>}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Loading invoices...
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
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Room</th>
                    <th className="px-4 py-3">Tenant</th>
                    <th className="px-4 py-3">Period</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">Slip</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {buildingInvoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.includes(invoice.id)}
                          onChange={() => toggleSelect(invoice.id)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant[invoice.status]}>{invoice.status}</Badge>
                          <details className="relative">
                            <summary className="cursor-pointer rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
                              Change
                            </summary>
                            <div className="absolute right-0 z-20 mt-1 w-32 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                              <button
                                onClick={() => void updateInvoiceStatus(invoice.id, "pending")}
                                className="block w-full rounded-md px-2 py-1 text-left text-xs font-medium text-amber-700 hover:bg-amber-50"
                              >
                                Pending
                              </button>
                              <button
                                onClick={() => void updateInvoiceStatus(invoice.id, "paid")}
                                className="block w-full rounded-md px-2 py-1 text-left text-xs font-medium text-green-700 hover:bg-green-50"
                              >
                                Paid
                              </button>
                              <button
                                onClick={() => void updateInvoiceStatus(invoice.id, "overdue")}
                                className="block w-full rounded-md px-2 py-1 text-left text-xs font-medium text-red-700 hover:bg-red-50"
                              >
                                Overdue
                              </button>
                            </div>
                          </details>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{invoice.room_number}</td>
                      <td className="px-4 py-3">{invoice.tenant_name}</td>
                      <td className="px-4 py-3">
                        {invoice.start_date} - {invoice.end_date}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {formatMoney(invoice.total_amount)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openSlipViewer(invoice)}
                          disabled={!invoice.slip_url}
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            invoice.slip_url
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : "bg-slate-100 text-slate-400"
                          }`}
                        >
                          {invoice.slip_url ? "View Slip" : "No Slip"}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <details className="relative">
                          <summary className="cursor-pointer rounded-lg bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-200">
                            Actions
                          </summary>
                          <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                            <button
                              onClick={() => openInvoice(invoice)}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-sky-700 hover:bg-sky-50"
                            >
                              <Pencil size={12} />
                              Edit
                            </button>
                            <button
                              onClick={() => void getInvoicePrintDetail(invoice)}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                            >
                              <Printer size={12} />
                              Preview
                            </button>
                            <button
                              onClick={() => {
                                setDeleteTargetIds([invoice.id]);
                                setConfirmDeleteOpen(true);
                              }}
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              <Trash2 size={12} />
                              Delete
                            </button>
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {selected.length > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 w-[min(90vw,720px)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-700">{selected.length} invoices selected</span>
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
                Print
              </button>
              <button
                onClick={() => {
                  if (selected.length === 0) return;
                  setDeleteTargetIds(selected);
                  setConfirmDeleteOpen(true);
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-red-600"
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={activeInvoice ? `Invoice ${activeInvoice.id}` : "Invoice Detail"}
        size="xl"
      >
        {activeInvoice && (
          <div className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Invoice</p>
                  <p className="text-lg font-semibold text-slate-900">Room {activeInvoice.room_number}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-400">Total</p>
                  <p className="text-xl font-semibold text-blue-700">{formatMoney(form.total_amount)}</p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="Issue Date"
                type="date"
                value={form.issue_date}
                onChange={(event) => updateForm("issue_date", event.target.value)}
              />
              <Input
                label="Due Date"
                type="date"
                value={form.due_date}
                onChange={(event) => updateForm("due_date", event.target.value)}
              />
              <Input
                label="Rent Amount"
                type="number"
                value={form.rent_amount}
                onChange={(event) => updateForm("rent_amount", event.target.value)}
              />
              <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <input
                  type="checkbox"
                  checked={useProrateInModal}
                  onChange={(event) => toggleProrateInModal(event.target.checked)}
                />
                Use pro-rate for this room invoice
              </label>
              {modalProrateSummary && (
                <div className="md:col-span-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Pro-rate formula: {modalProrateSummary.formulaText} (Move-in day {modalProrateSummary.moveInDay}, Billing day {modalProrateSummary.billingDay})
                </div>
              )}
              <Input
                label="Water Bill"
                type="number"
                value={form.water_bill}
                onChange={(event) => updateForm("water_bill", event.target.value)}
              />
              <Input
                label="Electricity Bill"
                type="number"
                value={form.electricity_bill}
                onChange={(event) => updateForm("electricity_bill", event.target.value)}
              />
              <Input
                label="Common Fee"
                type="number"
                value={form.common_fee}
                onChange={(event) => updateForm("common_fee", event.target.value)}
              />
              <Input
                label="Discount Total"
                type="number"
                value={form.discount_amount}
                readOnly
              />
              <Input
                label="Late Fee Amount"
                type="number"
                value={form.late_fee_amount}
                onChange={(event) => updateForm("late_fee_amount", event.target.value)}
              />
              <Input
                label="Additional Fees Total"
                type="number"
                value={form.additional_fees_total}
                readOnly
              />
              <Input label="Total Amount" type="number" value={form.total_amount} readOnly />
              <label className="text-sm text-slate-600">
                Status
                <select
                  value={form.status}
                  onChange={(event) => updateForm("status", event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm"
                >
                  {Object.keys(statusVariant).map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-3 rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">Additional Fee Details</p>
                <button
                  type="button"
                  onClick={() => setEditableFeeItems((prev) => [...prev, emptyFeeItem()])}
                  className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  Add Fee Row
                </button>
              </div>

              {editableFeeItems.length === 0 ? (
                <p className="text-xs text-slate-500">No additional fee rows.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-2 py-2 text-left">Detail</th>
                        <th className="px-2 py-2 text-right">Unit</th>
                        <th className="px-2 py-2 text-right">Price / Unit</th>
                        <th className="px-2 py-2 text-right">Total</th>
                        <th className="px-2 py-2 text-right">Action</th>
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
                              placeholder="e.g. Parking"
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
                              Remove
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
                <p className="text-sm font-semibold text-slate-700">Discount Details</p>
                <button
                  type="button"
                  onClick={() => setEditableDiscountItems((prev) => [...prev, emptyFeeItem()])}
                  className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  Add Discount Row
                </button>
              </div>

              {editableDiscountItems.length === 0 ? (
                <p className="text-xs text-slate-500">No discount rows.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-2 py-2 text-left">Detail</th>
                        <th className="px-2 py-2 text-right">Unit</th>
                        <th className="px-2 py-2 text-right">Price / Unit</th>
                        <th className="px-2 py-2 text-right">Total</th>
                        <th className="px-2 py-2 text-right">Action</th>
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
                              placeholder="e.g. Early payment"
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
                              Remove
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
              Notes
              <textarea
                value={form.notes}
                onChange={(event) => updateForm("notes", event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm"
                rows={3}
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <p className="text-sm font-semibold text-slate-700">Payment Slip</p>
                {slipPreview ? (
                  <img src={slipPreview} alt="Slip" className="rounded-xl border" />
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                    No slip uploaded yet.
                  </div>
                )}
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600">
                  <UploadCloud size={16} />
                  Upload Slip
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => handleUploadSlip(event.target.files?.[0])}
                  />
                </label>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-slate-700">Quick Actions</p>
                <button
                  onClick={() => void getInvoicePrintDetail(activeInvoice)}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
                >
                  <Printer size={16} />
                  Print Preview
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
                  className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600"
                >
                  <Trash2 size={16} />
                  Delete Invoice
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDetailOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={() => setConfirmSaveOpen(true)}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
              >
                Save Changes
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={slipModalOpen}
        onClose={() => setSlipModalOpen(false)}
        title={slipModalTitle || "Payment Slip"}
        size="lg"
      >
        {slipModalUrl ? (
          <div className="space-y-3">
            <img src={slipModalUrl} alt="Payment slip" className="w-full rounded-xl border border-slate-200" />
            <div className="flex justify-end">
              <button
                onClick={() => setSlipModalOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No slip image available.</p>
        )}
      </Modal>

      <ConfirmActionModal
        isOpen={confirmGenerateOpen}
        title="Generate Invoices"
        message={`Generate invoices for ${selectedMonth}?`}
        confirmLabel="Generate"
        loading={saving}
        onCancel={() => setConfirmGenerateOpen(false)}
        onConfirm={generateInvoices}
      />

      <ConfirmActionModal
        isOpen={confirmSaveOpen}
        title="Save Invoice"
        message="Apply changes to this invoice?"
        confirmLabel="Save"
        loading={saving}
        onCancel={() => setConfirmSaveOpen(false)}
        onConfirm={saveInvoice}
      />

      <ConfirmActionModal
        isOpen={confirmDeleteOpen}
        title="Delete Invoice"
        message={
          deleteTargetIds.length > 1
            ? `This action cannot be undone. Delete ${deleteTargetIds.length} invoices?`
            : "This action cannot be undone. Delete this invoice?"
        }
        confirmLabel="Delete"
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
        title="พรีวิวใบแจ้งหนี้"
        size="xl"
      >
        {previewInvoice && (
          <div className="space-y-5 text-sm text-slate-700">
            {previewLoading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">Loading preview...</div>
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
                      <span className="font-semibold">เลขที่ใบแจ้งหนี้:</span>{" "}
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
                          {toNumber(previewReading?.water_usage).toLocaleString("th-TH")} หน่วย
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatMoney(toNumber(printSettings?.water_rate))}
                        </td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.water_bill)}</td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าไฟ</td>
                        <td className="px-3 py-2 text-right">
                          {toNumber(previewReading?.electricity_usage).toLocaleString("th-TH")} หน่วย
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
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2">ค่าปรับล่าช้า</td>
                        <td className="px-3 py-2 text-right">-</td>
                        <td className="px-3 py-2 text-right">-</td>
                        <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.late_fee_amount)}</td>
                      </tr>
                      {(previewInvoice.additional_fees_breakdown ?? []).map((fee: any, idx: number) => (
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
                onClick={() => previewInvoice && printInvoice(previewInvoice, previewReading)}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
              >
                <Printer size={16} />
                พิมพ์ใบแจ้งหนี้
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
