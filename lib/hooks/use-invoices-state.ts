"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import {
  getCarryForwardCandidatesForTarget,
  calculateLateFeeAmount,
  toDateOnly,
  dayDiffInclusive,
} from "@/lib/invoice-ledger";
import {
  toNumber,
  roundTo2,
  formatMoney,
  toLocalDateString,
} from "@/lib/format";
import { roomNumberCompare } from "@/lib/tenant-utils";
import {
  parseDateOnly,
  addDays,
  diffDaysInclusive,
  fromDateText,
  isSameMonthAndYear,
  shortInvoiceId,
  formatDateThai,
  formatPeriodLabel,
  parseMoneyString,
  monthStartFromDate,
  statusLabelThai,
  isInvoiceDetailEditable,
  statusPillClass,
  statusRowClass,
  clampDay,
  computeDateByDayInMonth,
  computeDateByDayNextMonth,
  emptyFeeItem,
  emptyCarryForwardItem,
  emptyLateFeeItem,
  feeItemsTotal,
  ROUND_DOWN_DISCOUNT_LABEL,
  isTransferBreakdownRow,
  isCarryForwardBreakdownRow,
  isLateFeeBreakdownRow,
  toChargeFeeRows,
  toCarryForwardRows,
  toLateFeeRows,
  toFeeItems,
  toCarryForwardItems,
  toLateFeeItems,
  toTransferBreakdownItems,
  buildRuleBreakdown,
  calculateProratedRentByBillingDay,
  calculateWaterBillWithMinimum,
  calculateLateFeePreview,
  resolveElectricityUsage,
  resolveWaterUsage,
  serializeTransferBreakdownRows,
  parsePaymentMethodText,
  invoiceDisplayOutstanding,
  calculateInvoiceTransferRentProration,
  extractAllSlipUrls,
  type FeeLineItem,
  type CarryForwardItem,
  type LateFeeLineItem,
  type TransferBreakdownItem,
  type AdditionalFee,
  type MeterReadingRow,
  InvoiceRecord,
  ArrearsSnapshotItem,
  PrintSettings,
  PaymentMethodRow,
  normalizeInvoice,
  statusVariant,
} from "@/lib/invoice-utils";
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
  Search,
  Mail,
  MailOpen,
  UserPlus,
  LogOut,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export function useInvoicesState() {
  const supabase = useMemo(() => createClient(), []);
  const { can } = usePermissions();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeInvoice, setActiveInvoice] = useState<InvoiceRecord | null>(
    null,
  );
  const [activeReading, setActiveReading] = useState<MeterReadingRow | null>(
    null,
  );
  const [slipPreview, setSlipPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [useProrateInModal, setUseProrateInModal] = useState(false);
  const [slipModalOpen, setSlipModalOpen] = useState(false);
  const [slipModalUrl, setSlipModalUrl] = useState<string | string[] | null>(
    null,
  );
  const [slipModalTitle, setSlipModalTitle] = useState<string>("");

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceRecord | null>(
    null,
  );
  const [previewReading, setPreviewReading] = useState<MeterReadingRow | null>(
    null,
  );
  const [previewArrearsSnapshots, setPreviewArrearsSnapshots] = useState<
    ArrearsSnapshotItem[]
  >([]);
  const [previewDocType, setPreviewDocType] = useState<"invoice" | "receipt">(
    "invoice",
  );
  const [printSettings, setPrintSettings] = useState<PrintSettings | null>(
    null,
  );
  const [defaultPaymentMethod, setDefaultPaymentMethod] =
    useState<PaymentMethodRow | null>(null);
  const [editableFeeItems, setEditableFeeItems] = useState<FeeLineItem[]>([]);
  const [editableCarryForwardItems, setEditableCarryForwardItems] = useState<
    CarryForwardItem[]
  >([]);
  const [editableLateFeeItems, setEditableLateFeeItems] = useState<
    LateFeeLineItem[]
  >([]);
  const [arrearsSnapshots, setArrearsSnapshots] = useState<
    ArrearsSnapshotItem[]
  >([]);
  const [carryOverCandidates, setCarryOverCandidates] = useState<any[]>([]);
  const [carryOverCandidatesLoading, setCarryOverCandidatesLoading] =
    useState(false);
  const paymentIdempotencyKeyRef = useRef<string | null>(null);
  const [allocationResultNotice, setAllocationResultNotice] = useState<{
    batchId: string;
    lines: { invoiceId: string; label: string; amount: number }[];
    idempotentReplay?: boolean;
  } | null>(null);
  const [editableDiscountItems, setEditableDiscountItems] = useState<
    FeeLineItem[]
  >([]);
  const [transferBreakdownItems, setTransferBreakdownItems] = useState<
    TransferBreakdownItem[]
  >([]);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"full" | "partial">("full");
  const [paymentAmountInput, setPaymentAmountInput] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState(toLocalDateString(new Date()));
  const [paymentSlipFile, setPaymentSlipFile] = useState<File | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [lineSendModalOpen, setLineSendModalOpen] = useState(false);
  const [lineSendState, setLineSendState] = useState<
    "sending" | "success" | "error"
  >("sending");
  const [lineSendTitle, setLineSendTitle] = useState(
    "กำลังส่งใบแจ้งหนี้ไป LINE",
  );
  const [lineSendMessage, setLineSendMessage] = useState("กำลังดำเนินการ...");
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [moveOutWarnings, setMoveOutWarnings] = useState<any[]>([]);
  const [pendingMoveOutCount, setPendingMoveOutCount] = useState(0);

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
    waived_late_fee_amount: 0,
    locked_late_fee_amount: null as number | null,
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

  const applyPendingToOverdue = async (
    periodStart: string,
    periodEnd: string,
  ) => {
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

  const applySlipToVerifying = async (
    periodStart: string,
    periodEnd: string,
  ) => {
    const { error: verifyingError } = await supabase
      .from("invoices")
      .update({ status: "verifying" })
      .in("status", ["pending", "overdue"])
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd)
      .eq("paid_amount", 0)
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
        "id,room_id,status,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,carry_forward_amount,additional_fees_total,discount_amount,discount_breakdown,total_amount",
      )
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd);

    if (invoiceError || !invoicesInMonth || invoicesInMonth.length === 0)
      return;

    const roomIds = [
      ...new Set(
        invoicesInMonth.map((row: any) => row.room_id).filter(Boolean),
      ),
    ];
    const { data: readings } = await supabase
      .from("meter_readings")
      .select("room_id,electricity_usage,water_usage,usage")
      .eq("reading_month", monthKey)
      .in(
        "room_id",
        roomIds.length > 0 ? roomIds : ["00000000-0000-0000-0000-000000000000"],
      );
    const readingMap = new Map(
      (readings ?? []).map((row: any) => [row.room_id, row]),
    );

    const updates = (invoicesInMonth as any[])
      .map((invoice) => {
        if (!isInvoiceDetailEditable(String(invoice.status ?? ""))) {
          return null;
        }
        const reading = readingMap.get(invoice.room_id) ?? {};
        const elecUnits = toNumber(reading.electricity_usage);
        const waterUnits = toNumber(reading.water_usage ?? reading.usage);
        const discountBreakdown = buildRuleBreakdown(
          discountRules,
          elecUnits,
          waterUnits,
        );
        const discountAmount = discountBreakdown.reduce(
          (sum, fee) => sum + toNumber(fee.amount),
          0,
        );
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
      .filter(Boolean) as {
      id: string;
      discount_amount: number;
      discount_breakdown: any[];
      total_amount: number;
    }[];

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

    await applyPendingToOverdue(periodStart, periodEnd);
    await applySlipToVerifying(periodStart, periodEnd);

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
        "id,tenant_id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date,move_out_date,status),rooms(room_number,price_month,buildings(name))",
      )
      .eq("start_date", periodStart)
      .eq("end_date", periodEnd)
      .order("issue_date", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setInvoices([]);
    } else {
      const normalized = (data ?? []).map(normalizeInvoice);

      // Fetch all invoices for active tenants to accurately determine "new tenant" status
      const tenantIds = [...new Set(normalized.map((inv) => inv.tenant_id))];
      const { data: allTenantInvoices } =
        tenantIds.length > 0
          ? await supabase
              .from("invoices")
              .select("tenant_id,start_date")
              .in("tenant_id", tenantIds)
              .neq("status", "cancelled")
          : { data: [] };

      const invoicesByTenant = new Map<string, string[]>();
      for (const item of allTenantInvoices ?? []) {
        if (!item?.tenant_id) continue;
        const id = String(item.tenant_id);
        if (!invoicesByTenant.has(id)) invoicesByTenant.set(id, []);
        invoicesByTenant.get(id)!.push(String(item.start_date));
      }

      const hydrated = await Promise.all(
        normalized.map(async (invoice) => {
          const tenantInvoices = invoicesByTenant.get(invoice.tenant_id) ?? [];
          let earliestMonth: string | null = null;
          if (tenantInvoices.length > 0) {
            const earliestDate = [...tenantInvoices].sort(
              (a, b) => new Date(a).getTime() - new Date(b).getTime(),
            )[0];
            earliestMonth = earliestDate
              ? String(earliestDate).slice(0, 7)
              : null;
          }

          const invoiceMonth = invoice.start_date
            ? String(invoice.start_date).slice(0, 7)
            : null;
          const moveInDate = invoice.tenant_move_in_date
            ? new Date(invoice.tenant_move_in_date)
            : null;
          const invoiceDate = invoice.start_date
            ? new Date(invoice.start_date)
            : null;

          let diffMonths = -1;
          if (moveInDate && invoiceDate) {
            diffMonths =
              (invoiceDate.getFullYear() - moveInDate.getFullYear()) * 12 +
              (invoiceDate.getMonth() - moveInDate.getMonth());
          }

          const isFirstInvoice = Boolean(
            invoiceMonth &&
            (invoiceMonth === earliestMonth ||
              diffMonths === 0 ||
              diffMonths === 1),
          );

          const isWaitingMoveOut = Boolean(
            invoice.tenant_move_out_date && invoice.tenant_status === "active",
          );

          // We pass a new flag down to be used for the indicator
          const hydratedInvoice = {
            ...invoice,
            _is_first_regular_invoice: isFirstInvoice,
            _is_waiting_for_move_out: isWaitingMoveOut,
          };

          if (hydratedInvoice.slip_url) return hydratedInvoice;

          const { data: files, error: fileError } = await supabase.storage
            .from("payment_slips")
            .list(invoice.id, {
              limit: 1,
              sortBy: { column: "name", order: "desc" },
            });

          if (fileError || !files || files.length === 0) return hydratedInvoice;

          const latest = files[0];
          const { data: publicData } = supabase.storage
            .from("payment_slips")
            .getPublicUrl(`${invoice.id}/${latest.name}`);

          return {
            ...hydratedInvoice,
            slip_url: publicData.publicUrl,
          };
        }),
      );

      const sortedHydrated = [...hydrated].sort((a, b) => {
        const byBuilding = a.building_name.localeCompare(
          b.building_name,
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          },
        );
        if (byBuilding !== 0) return byBuilding;
        const byRoom = roomNumberCompare(a.room_number, b.room_number);
        if (byRoom !== 0) return byRoom;
        return (
          new Date(b.issue_date).getTime() - new Date(a.issue_date).getTime()
        );
      });
      setInvoices(sortedHydrated);
    }

    setLoading(false);
  };

  useEffect(() => {
    void loadInvoices();
  }, [selectedMonth]);

  const patchInvoiceInState = (
    invoiceId: string,
    patch: Partial<InvoiceRecord>,
  ) => {
    setInvoices((prev) =>
      prev.map((invoice) =>
        invoice.id === invoiceId ? { ...invoice, ...patch } : invoice,
      ),
    );
    setActiveInvoice((prev) =>
      prev && prev.id === invoiceId ? { ...prev, ...patch } : prev,
    );
  };

  useEffect(() => {
    const channel = supabase
      .channel("invoice-settings-realtime")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "settings",
          filter: "id=eq.1",
        },
        () => {
          void loadInvoices();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "invoices" },
        (payload: any) => {
          if (payload?.eventType === "UPDATE" && payload?.new?.id) {
            const invoiceId = String(payload.new.id);
            patchInvoiceInState(invoiceId, {
              status:
                (payload.new.status as keyof typeof statusVariant) ?? undefined,
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
                status:
                  (payload.new.status as keyof typeof statusVariant) ??
                  prev.status,
                paid_amount: toNumber(
                  payload.new.paid_amount ?? prev.paid_amount,
                ),
                total_amount: toNumber(
                  payload.new.total_amount ?? prev.total_amount,
                ),
              };
            });
            return;
          }
          void loadInvoices();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, selectedMonth]);

  useEffect(() => {
    void loadPrintConfig();
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadMoveOutWarnings = async () => {
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = toLocalDateString(
        new Date(
          Number(selectedMonth.slice(0, 4)),
          Number(selectedMonth.slice(5, 7)),
          0,
        ),
      );
      const { data, error: requestError } = await supabase
        .from("move_out_requests")
        .select(
          "id,tenant_id,requested_move_out_date,status,tenants(full_name,rooms(room_number))",
        )
        .in("status", ["requested", "approved"])
        .gte("requested_move_out_date", monthStart)
        .lte("requested_move_out_date", monthEnd)
        .order("requested_move_out_date", { ascending: true });
      if (!mounted) return;
      if (requestError) {
        setMoveOutWarnings([]);
        return;
      }
      setMoveOutWarnings(data ?? []);
    };
    void loadMoveOutWarnings();
    return () => {
      mounted = false;
    };
  }, [selectedMonth, supabase]);

  useEffect(() => {
    let mounted = true;
    /** Pending move-out work: open tenant request, or active tenant with move_out_date set (manual tab). Deduped by tenant. */
    const loadPendingMoveOutCount = async () => {
      const [requestsRes, tenantsRes] = await Promise.all([
        supabase
          .from("move_out_requests")
          .select("tenant_id")
          .eq("status", "requested"),
        supabase
          .from("tenants")
          .select("id")
          .not("move_out_date", "is", null)
          .eq("status", "active"),
      ]);
      if (!mounted) return;
      if (requestsRes.error || tenantsRes.error) {
        setPendingMoveOutCount(0);
        return;
      }
      const ids = new Set<string>();
      for (const row of requestsRes.data ?? []) {
        const id = String((row as { tenant_id?: string }).tenant_id ?? "");
        if (id) ids.add(id);
      }
      for (const row of tenantsRes.data ?? []) {
        const id = String((row as { id?: string }).id ?? "");
        if (id) ids.add(id);
      }
      setPendingMoveOutCount(ids.size);
    };
    void loadPendingMoveOutCount();
    const channel = supabase
      .channel("invoices-pending-move-out-badge")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "move_out_requests" },
        () => {
          void loadPendingMoveOutCount();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tenants" },
        () => {
          void loadPendingMoveOutCount();
        },
      )
      .subscribe();
    return () => {
      mounted = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  const loadPrintConfig = async () => {
    const { data: settingData } = await supabase
      .from("settings")
      .select(
        "dorm_name,dorm_address,water_rate,electricity_rate,water_min_units,water_min_price,billing_day,due_day,late_fee_start_day,additional_discounts",
      )
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

  const filteredInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((invoice) => {
      const haystacks = [
        invoice.room_number,
        invoice.tenant_name,
        invoice.building_name,
        invoice.status,
        invoice.public_token,
        invoice.id,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return haystacks.some((text) => text.includes(q));
    });
  }, [invoices, search]);

  const grouped = useMemo(() => {
    const groupedMap = filteredInvoices.reduce<Record<string, InvoiceRecord[]>>(
      (acc, invoice) => {
        if (!acc[invoice.building_name]) acc[invoice.building_name] = [];
        acc[invoice.building_name].push(invoice);
        return acc;
      },
      {},
    );
    for (const building of Object.keys(groupedMap)) {
      groupedMap[building] = groupedMap[building].sort((a, b) =>
        roomNumberCompare(a.room_number, b.room_number),
      );
    }
    return groupedMap;
  }, [filteredInvoices]);

  const visibleInvoiceIds = useMemo(
    () => filteredInvoices.map((invoice) => invoice.id),
    [filteredInvoices],
  );
  const selectedVisibleCount = useMemo(
    () => selected.filter((id) => visibleInvoiceIds.includes(id)).length,
    [selected, visibleInvoiceIds],
  );
  const allVisibleSelected =
    visibleInvoiceIds.length > 0 &&
    selectedVisibleCount === visibleInvoiceIds.length;

  useEffect(() => {
    setSelected((prev) => prev.filter((id) => visibleInvoiceIds.includes(id)));
  }, [visibleInvoiceIds]);

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
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
    const urls = extractAllSlipUrls(invoice);
    if (urls.length === 0) return;
    setSlipModalTitle(`สลิปการชำระเงิน - ห้อง ${invoice.room_number}`);
    setSlipModalUrl(urls);
    setSlipModalOpen(true);
  };

  const callInvoiceAdminAction = async (
    action: string,
    payload: Record<string, unknown>,
  ) => {
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
    status: keyof typeof statusVariant,
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
      const result = await callInvoiceAdminAction("update_status", {
        invoiceId,
        status,
      });
      const updatedInvoices = Array.isArray(result?.updatedInvoices)
        ? result.updatedInvoices
        : [];
      if (updatedInvoices.length > 0) {
        updatedInvoices.forEach((invoiceUpdate: any) => {
          patchInvoiceInState(String(invoiceUpdate.id), {
            paid_amount: toNumber(invoiceUpdate.paid_amount),
            payment_history: Array.isArray(invoiceUpdate.payment_history)
              ? invoiceUpdate.payment_history
              : undefined,
            status:
              (invoiceUpdate.status as keyof typeof statusVariant) ?? undefined,
            slip_url: invoiceUpdate.slip_url ?? undefined,
          });
        });
        const activeUpdated = updatedInvoices.find(
          (row: any) => String(row.id) === invoiceId,
        );
        if (activeUpdated && activeInvoice?.id === invoiceId) {
          setForm((prev) => ({
            ...prev,
            paid_amount: toNumber(activeUpdated.paid_amount),
            status:
              (activeUpdated.status as keyof typeof statusVariant) ??
              prev.status,
          }));
        }
      }
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
    });
    if (remaining <= 0) {
      setError("This invoice is already fully paid.");
      return;
    }

    const amountToPay =
      paymentMode === "full"
        ? remaining
        : Math.min(remaining, toNumber(paymentAmountInput));
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
      if (!paymentIdempotencyKeyRef.current) {
        paymentIdempotencyKeyRef.current =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const idempotencyKey = paymentIdempotencyKeyRef.current;
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
          idempotency_key: idempotencyKey,
        },
      });
      const updatedInvoices = Array.isArray(result?.updatedInvoices)
        ? result.updatedInvoices
        : [];
      const activeUpdated = updatedInvoices.find(
        (row: any) => row.id === activeInvoice.id,
      );
      const breakdown = Array.isArray(result?.allocationBreakdown)
        ? result.allocationBreakdown
        : [];
      const roomLabel = (invoiceId: string) =>
        invoices.find((inv) => inv.id === invoiceId)?.room_number ??
        shortInvoiceId(invoiceId);
      if (breakdown.length > 0) {
        setAllocationResultNotice({
          batchId: String(result?.paymentBatchId ?? ""),
          lines: breakdown.map((row: any) => ({
            invoiceId: String(row.invoiceId),
            label: `ห้อง ${roomLabel(String(row.invoiceId))}`,
            amount: toNumber(row.allocatedAmount),
          })),
          idempotentReplay: !!result?.idempotentReplay,
        });
      }

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
          status:
            (activeUpdated.status as keyof typeof statusVariant) ?? prev.status,
        }));
      }
      const activeNext = {
        ...activeInvoice,
        paid_amount: toNumber(
          activeUpdated?.paid_amount ?? activeInvoice.paid_amount,
        ),
        payment_history: Array.isArray(activeUpdated?.payment_history)
          ? activeUpdated.payment_history
          : activeInvoice.payment_history,
        status:
          (activeUpdated?.status as keyof typeof statusVariant) ??
          activeInvoice.status,
        slip_url: publicUrl ?? null,
      } as InvoiceRecord;
      setActiveInvoice((prev) =>
        prev
          ? {
              ...prev,
              paid_amount: toNumber(
                activeUpdated?.paid_amount ?? prev.paid_amount,
              ),
              payment_history: Array.isArray(activeUpdated?.payment_history)
                ? activeUpdated.payment_history
                : prev.payment_history,
              status:
                (activeUpdated?.status as keyof typeof statusVariant) ??
                prev.status,
              slip_url: publicUrl ?? null,
            }
          : prev,
      );
      updatedInvoices.forEach((invoiceUpdate: any) => {
        patchInvoiceInState(String(invoiceUpdate.id), {
          paid_amount: toNumber(invoiceUpdate.paid_amount),
          payment_history: Array.isArray(invoiceUpdate.payment_history)
            ? invoiceUpdate.payment_history
            : undefined,
          status:
            (invoiceUpdate.status as keyof typeof statusVariant) ?? undefined,
          slip_url: publicUrl ?? null,
        });
      });
      // Keep local modal state in sync without reloading the full page list.
      setActiveInvoice(activeNext);
      paymentIdempotencyKeyRef.current = null;
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
      `ยืนยันยกเลิกรายการชำระเงิน ${formatMoney(targetAmount)} ?`,
    );
    if (!confirmed) return;

    setPaymentSubmitting(true);
    try {
      const nextHistory = existingHistory.filter(
        (_, idx) => idx !== historyIndex,
      );
      const total = toNumber(form.total_amount || activeInvoice.total_amount);
      const currentPaid = toNumber(
        form.paid_amount || activeInvoice.paid_amount,
      );
      const nextPaidAmount = Math.max(0, currentPaid - targetAmount);
      const lastEntry =
        nextHistory.length > 0
          ? (nextHistory[nextHistory.length - 1] as any)
          : null;
      const nextSlipUrl =
        (lastEntry?.slip_url as string | null | undefined) ?? null;
      const nextSlipUploadedAt =
        (lastEntry?.paid_at as string | null | undefined) ?? null;
      const nextStatus: keyof typeof statusVariant =
        nextPaidAmount >= total
          ? "paid"
          : nextPaidAmount > 0
            ? "partial"
            : "pending";

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

      setForm((prev) => ({
        ...prev,
        paid_amount: nextPaidAmount,
        status: nextStatus,
      }));
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
          : prev,
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
      const paths = (files ?? []).map(
        (file) => `${activeInvoice.id}/${file.name}`,
      );
      if (paths.length > 0) {
        const { error: removeError } = await supabase.storage
          .from("payment_slips")
          .remove(paths);
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
    const chargeFeeRows = toChargeFeeRows(
      invoice.additional_fees_breakdown ?? [],
    );
    const feeItems = toFeeItems(chargeFeeRows);
    const carryForwardRows = toCarryForwardRows(
      invoice.additional_fees_breakdown ?? [],
    );
    const lateFeeRows = toLateFeeRows(invoice.additional_fees_breakdown ?? []);
    const carryForwardItems = toCarryForwardItems(carryForwardRows);
    const lateFeeItems = toLateFeeItems(lateFeeRows);
    const discountItems = toFeeItems(invoice.discount_breakdown ?? []);
    const transferItems = toTransferBreakdownItems(
      invoice.additional_fees_breakdown ?? [],
    );
    const todayLocal = toLocalDateString(new Date());
    const periodBaseDate =
      invoice.end_date ||
      invoice.start_date ||
      invoice.issue_date ||
      todayLocal;
    const dueDateFromSetting = computeDateByDayNextMonth(
      periodBaseDate,
      printSettings?.due_day,
    );
    const lateStartFromSetting = computeDateByDayNextMonth(
      periodBaseDate,
      printSettings?.late_fee_start_day,
    );
    const monthlyRent = toNumber(
      invoice.room_price_month || invoice.rent_amount,
    );
    const prorateSummary = calculateProratedRentByBillingDay(
      monthlyRent,
      invoice.tenant_move_in_date,
      printSettings?.billing_day,
    );
    const useProrateDefault =
      !!prorateSummary &&
      Math.abs(toNumber(invoice.rent_amount) - prorateSummary.rentAmount) <
        0.01;
    setActiveInvoice(invoice);
    setUseProrateInModal(useProrateDefault);
    setEditableFeeItems(feeItems.length > 0 ? feeItems : []);
    setEditableCarryForwardItems(
      carryForwardItems.length > 0 ? carryForwardItems : [],
    );
    setEditableLateFeeItems(lateFeeItems.length > 0 ? lateFeeItems : [],);
    setArrearsSnapshots([]);
    setTransferBreakdownItems(transferItems);
    setEditableDiscountItems(
      discountItems.length > 0
        ? discountItems
        : invoice.discount_amount > 0
          ? [
              {
                detail: "ส่วนลด",
                unit: 1,
                price_per_unit: invoice.discount_amount,
                total_amount: invoice.discount_amount,
              },
            ]
          : [],
    );
    const waterRate = toNumber(printSettings?.water_rate);
    const electricityRate = toNumber(printSettings?.electricity_rate);
    const inferredWaterUnits =
      waterRate > 0
        ? toNumber(invoice.water_bill) / waterRate
        : toNumber(invoice.water_bill);
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
      discount_amount:
        discountItems.length > 0
          ? feeItemsTotal(discountItems)
          : invoice.discount_amount,
      late_fee_amount:
        lateFeeItems.length > 0
          ? feeItemsTotal(lateFeeItems)
          : invoice.late_fee_amount,
      late_fee_per_day: invoice.late_fee_per_day,
      late_fee_start_date: invoice.late_fee_start_date || lateStartFromSetting,
      waived_late_fee_amount: toNumber((invoice as any).waived_late_fee_amount),
      locked_late_fee_amount: (invoice as any).locked_late_fee_amount ?? null,
      additional_fees_total:
        feeItems.length > 0
          ? feeItemsTotal(feeItems)
          : invoice.additional_fees_total,
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
    setAllocationResultNotice(null);
    paymentIdempotencyKeyRef.current = null;
    setCarryOverCandidates([]);
    setActiveReading(null);
    if (isInvoiceDetailEditable(String(invoice.status ?? "")) && invoice.tenant_id) {
      setCarryOverCandidatesLoading(true);
      void getCarryForwardCandidatesForTarget(
        supabase,
        invoice.tenant_id,
        invoice.start_date,
        invoice.id,
        invoice.issue_date || invoice.start_date,
      )
        .then((rows) => setCarryOverCandidates(rows))
        .catch(() => setCarryOverCandidates([]))
        .finally(() => setCarryOverCandidatesLoading(false));
    }

    // Replace inferred units with real meter usage for the invoice month.
    // This is important when water billing uses a minimum charge, where
    // water_bill / water_rate does not equal actual usage.
    try {
      const { data: snapshotRows } = await supabase
        .from("invoice_arrears_snapshots")
        .select(
          "id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate",
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
        })),
      );

      const readingMonth = monthStartFromDate(
        invoice.start_date || invoice.issue_date,
      );
      const { data } = await supabase
        .from("meter_readings")
        .select(
          "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading",
        )
        .eq("room_id", invoice.room_id)
        .eq("reading_month", readingMonth)
        .maybeSingle();

      const reading = (data as MeterReadingRow | null) ?? null;
      if (!reading) return;

      setActiveReading(reading);

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

  const updateUtilityUnits = (
    field: "water_units" | "electricity_units",
    value: string | number,
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    const units = toNumber(value);
    const waterRate = toNumber(printSettings?.water_rate);
    const waterMinUnits = toNumber(printSettings?.water_min_units);
    const waterMinPrice = toNumber(printSettings?.water_min_price);
    const electricityRate = toNumber(printSettings?.electricity_rate);

    setForm((prev) => {
      const next = { ...prev, [field]: units } as typeof prev;
      const nextWaterUnits =
        field === "water_units" ? units : toNumber(next.water_units);
      const nextWaterBill = calculateWaterBillWithMinimum(
        nextWaterUnits,
        waterRate,
        waterMinUnits,
        waterMinPrice,
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
        calculateCurrentFormLateFee(next) +
        toNumber(next.additional_fees_total);

      return {
        ...next,
        water_bill: nextWaterBill,
        electricity_bill: nextElectricityBill,
        total_amount: total,
      };
    });
  };

  const calculateCurrentFormLateFee = (formState: typeof form) => {
    if (formState.status === "draft") {
      return 0;
    }
    if (
      formState.locked_late_fee_amount !== null &&
      formState.locked_late_fee_amount !== undefined
    ) {
      return Math.max(0, toNumber(formState.locked_late_fee_amount));
    }
    
    // Static calculation based on the database state
    const dbTotalLateFee = toNumber(activeInvoice?.late_fee_amount);
    const dbCarryForwardLateFees = activeInvoice ? feeItemsTotal(toLateFeeItems(toLateFeeRows(activeInvoice.additional_fees_breakdown ?? []))) : 0;
    const dbNativeLateFee = Math.max(0, dbTotalLateFee - dbCarryForwardLateFees);
    const dbWaived = toNumber((activeInvoice as any)?.waived_late_fee_amount);
    
    // The \"raw\" late fee before any waivers were applied in the DB
    const staticRawAmount = dbNativeLateFee + dbWaived;

    return Math.max(0, staticRawAmount - toNumber(formState.waived_late_fee_amount));
  };

  const updateForm = (
    field: string,
    value: string | number,
    forceEdit = false,
  ) => {
    if (
      !forceEdit &&
      activeInvoice &&
      !isInvoiceDetailEditable(activeInvoice.status)
    )
      return;
    setForm((prev) => {
      const next = { ...prev, [field]: value } as typeof prev;
      const monthlyRent = toNumber(
        activeInvoice?.room_price_month ?? next.rent_amount,
      );
      const prorateSummary =
        useProrateInModal && activeInvoice
          ? calculateProratedRentByBillingDay(
              monthlyRent,
              activeInvoice.tenant_move_in_date,
              printSettings?.billing_day,
            )
          : null;
      const computedRent = prorateSummary
        ? prorateSummary.rentAmount
        : toNumber(next.rent_amount);
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const nextLateFeeItems = feeItemsTotal(editableLateFeeItems);
      const nativeLateFee = calculateCurrentFormLateFee(next);
      const nextLateFee = nativeLateFee + nextLateFeeItems;
      const total =
        computedRent +
        toNumber(next.water_bill) +
        toNumber(next.electricity_bill) +
        toNumber(next.common_fee) +
        nextDiscount * -1 +
        nextLateFee +
        nextAdditional;
      return {
        ...next,
        rent_amount: computedRent,
        additional_fees_total: nextAdditional,
        discount_amount: nextDiscount,
        late_fee_amount: nextLateFee,
        total_amount: total,
      };
    });
  };

  const updateCarryForwardItem = (
    index: number,
    field: keyof CarryForwardItem,
    value: string | number,
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
      }),
    );
  };

  const updateLateFeeItem = (
    index: number,
    field: keyof LateFeeLineItem,
    value: string | number,
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableLateFeeItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) return item;
        const next = { ...item, [field]: value } as LateFeeLineItem;
        const unit = Math.max(
          0,
          Math.round(
            toNumber(
              field === "days_overdue" || field === "unit"
                ? value
                : (next.days_overdue ?? next.unit),
            ),
          ),
        );
        const price_per_unit = Math.max(
          0,
          toNumber(
            field === "daily_rate" || field === "price_per_unit"
              ? value
              : (next.daily_rate ?? next.price_per_unit),
          ),
        );
        const manualTotal =
          field === "original_amount" || field === "total_amount"
            ? Math.max(0, toNumber(value))
            : null;
        const original_amount =
          manualTotal != null
            ? manualTotal
            : Math.max(0, unit * price_per_unit);
        const waived_amount = 0;
        const total_amount = original_amount;
        return {
          ...next,
          unit,
          price_per_unit,
          days_overdue: unit,
          daily_rate: price_per_unit,
          original_amount,
          waived_amount,
          total_amount,
        };
      }),
    );
  };

  const updateTransferBreakdownAmount = (
    index: number,
    value: string | number,
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setTransferBreakdownItems((prev) =>
      prev.map((item, idx) =>
        idx === index
          ? {
              ...item,
              amount: toNumber(value),
              value: formatMoney(toNumber(value)),
            }
          : item,
      ),
    );
  };

  const applyRoundDownTotal = () => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    const currentTotal =
      toNumber(form.rent_amount) +
      toNumber(form.water_bill) +
      toNumber(form.electricity_bill) +
      toNumber(form.common_fee) +
      feeItemsTotal(editableLateFeeItems) +
      feeItemsTotal(editableFeeItems) -
      feeItemsTotal(editableDiscountItems);
    const roundedTotal = Math.floor(currentTotal);
    const roundDownAmount = Number((currentTotal - roundedTotal).toFixed(2));
    if (roundDownAmount <= 0) return;

    setEditableDiscountItems((prev) => {
      const existingIndex = prev.findIndex(
        (item) =>
          String(item.detail ?? "").trim() === ROUND_DOWN_DISCOUNT_LABEL,
      );
      if (existingIndex >= 0) {
        return prev.map((item, index) =>
          index === existingIndex
            ? {
                ...item,
                unit: 1,
                price_per_unit: roundDownAmount,
                total_amount: roundDownAmount,
              }
            : item,
        );
      }
      return [
        ...prev,
        {
          detail: ROUND_DOWN_DISCOUNT_LABEL,
          unit: 1,
          price_per_unit: roundDownAmount,
          total_amount: roundDownAmount,
        },
      ];
    });
  };

  const recalculateTransferBreakdown = async () => {
    if (!activeInvoice) return;
    const transferDateRow = transferBreakdownItems.find((item) =>
      item.label.includes("วันที่ย้ายห้อง"),
    );
    const transferDate = String(transferDateRow?.value ?? "").trim();
    if (!transferDate) {
      setError("ไม่พบวันที่ย้ายห้องในใบแจ้งหนี้นี้");
      return;
    }

    const billingMonth = monthStartFromDate(
      activeInvoice.start_date || activeInvoice.issue_date,
    );
    const { data: transferRows, error: transferError } = await supabase
      .from("tenant_room_transfers")
      .select(
        "from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,new_prev_electricity,new_prev_water",
      )
      .eq("to_room_id", activeInvoice.room_id)
      .eq("billing_month", billingMonth)
      .eq("transfer_date", transferDate)
      .order("transfer_date", { ascending: false })
      .limit(1);

    if (transferError) {
      setError(transferError.message);
      return;
    }

    const transferRow = (transferRows ?? [])[0] as
      | {
          from_room_id: string;
          to_room_id: string;
          transfer_date: string;
          old_electric_usage?: number;
          old_water_usage?: number;
          new_prev_electricity?: number;
          new_prev_water?: number;
        }
      | undefined;
    if (!transferRow) {
      setError("ไม่พบข้อมูลย้ายห้องของงวดนี้สำหรับคำนวณใหม่");
      return;
    }

    const roomIds = [transferRow.from_room_id, transferRow.to_room_id];
    const { data: roomRows, error: roomError } = await supabase
      .from("rooms")
      .select("id,price_month")
      .in("id", roomIds);

    if (roomError) {
      setError(roomError.message);
      return;
    }

    const oldRoomRate = toNumber(
      roomRows?.find(
        (room: any) => String(room.id) === String(transferRow.from_room_id),
      )?.price_month,
    );
    const newRoomRate = toNumber(
      roomRows?.find(
        (room: any) => String(room.id) === String(transferRow.to_room_id),
      )?.price_month,
    );
    const recalculated = calculateInvoiceTransferRentProration(
      activeInvoice.start_date || billingMonth,
      activeInvoice.end_date ||
        toLocalDateString(
          new Date(
            parseDateOnly(billingMonth).getFullYear(),
            parseDateOnly(billingMonth).getMonth() + 1,
            0,
          ),
        ),
      transferRow.transfer_date,
      activeInvoice.tenant_move_in_date,
      oldRoomRate,
      newRoomRate,
    );

    // Fetch current meter reading for new room to compute new room units
    const { data: readingRows } = await supabase
      .from("meter_readings")
      .select("current_electricity,current_water,electricity_usage,water_usage")
      .eq("room_id", activeInvoice.room_id)
      .eq("billing_month", billingMonth)
      .limit(1);
    const reading = (readingRows ?? [])[0] as any;

    const electricityRate = toNumber(printSettings?.electricity_rate);
    const waterRate = toNumber(printSettings?.water_rate);
    const waterMinUnits = toNumber(printSettings?.water_min_units);
    const waterMinPrice = toNumber(printSettings?.water_min_price);

    const oldElecUnits = toNumber(transferRow.old_electric_usage ?? 0);
    const oldWaterUnits = toNumber(transferRow.old_water_usage ?? 0);

    const newPrevElec = toNumber(transferRow.new_prev_electricity ?? 0);
    const newPrevWater = toNumber(transferRow.new_prev_water ?? 0);
    const newElecUnits =
      newPrevElec > 0 && reading?.current_electricity != null
        ? Math.max(0, toNumber(reading.current_electricity) - newPrevElec)
        : toNumber(reading?.electricity_usage ?? 0);
    const newWaterUnits =
      newPrevWater > 0 && reading?.current_water != null
        ? Math.max(0, toNumber(reading.current_water) - newPrevWater)
        : toNumber(reading?.water_usage ?? 0);

    const oldElecBill = oldElecUnits * electricityRate;
    const oldWaterBill = calculateWaterBillWithMinimum(oldWaterUnits, waterRate, waterMinUnits, waterMinPrice);
    const newElecBill = newElecUnits * electricityRate;
    const newWaterBill = calculateWaterBillWithMinimum(newWaterUnits, waterRate, waterMinUnits, waterMinPrice);

    // Rebuild the full transfer breakdown with per-room utility rows
    const newItems = serializeTransferBreakdownRows([
      { label: "วันที่ย้ายห้อง", value: transferDate },
      {
        label: "ค่าเช่าห้องเดิม",
        value: formatMoney(recalculated.oldRentAmount),
        amount: recalculated.oldRentAmount,
        editable: true,
        kind: "old_rent",
      },
      {
        label: "ค่าเช่าห้องใหม่",
        value: formatMoney(recalculated.newRentAmount),
        amount: recalculated.newRentAmount,
        editable: true,
        kind: "new_rent",
      },
      {
        label: `ค่าน้ำห้องเดิม (${oldWaterUnits} หน่วย)`,
        value: `${oldWaterUnits} หน่วย × ${formatMoney(waterRate)} = ${formatMoney(oldWaterBill)}`,
        amount: oldWaterBill,
        kind: "old_water",
      },
      {
        label: `ค่าน้ำห้องใหม่ (${newWaterUnits} หน่วย)`,
        value: `${newWaterUnits} หน่วย × ${formatMoney(waterRate)} = ${formatMoney(newWaterBill)}`,
        amount: newWaterBill,
        kind: "new_water",
      },
      {
        label: `ค่าไฟห้องเดิม (${oldElecUnits} หน่วย)`,
        value: `${oldElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(oldElecBill)}`,
        amount: oldElecBill,
        kind: "old_elec",
      },
      {
        label: `ค่าไฟห้องใหม่ (${newElecUnits} หน่วย)`,
        value: `${newElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(newElecBill)}`,
        amount: newElecBill,
        kind: "new_elec",
      },
    ]);
    setTransferBreakdownItems(toTransferBreakdownItems(newItems));
    setError(null);
  };


  const recalculateCurrentInvoiceArrears = async (
    carryOverride?: CarryForwardItem[],
    lateOverride?: LateFeeLineItem[],
  ) => {
    if (!activeInvoice) return;
    const carry = carryOverride ?? editableCarryForwardItems;
    const late = lateOverride ?? editableLateFeeItems;
    const sourceIds = new Set<string>();
    carry.forEach((item) => {
      if (item.source_invoice_id) sourceIds.add(String(item.source_invoice_id));
    });
    late.forEach((item) => {
      if (item.source_invoice_id) sourceIds.add(String(item.source_invoice_id));
    });
    const useSnapshotIds =
      carryOverride === undefined && lateOverride === undefined;
    if (useSnapshotIds) {
      arrearsSnapshots.forEach((item) => {
        if (item.source_invoice_id)
          sourceIds.add(String(item.source_invoice_id));
      });
    }

    const sourceInvoiceIds = [...sourceIds];
    if (sourceInvoiceIds.length === 0) {
      setEditableCarryForwardItems([]);
      setEditableLateFeeItems([]);
      return;
    }

    setSaving(true);
    try {
      const candidates = await getCarryForwardCandidatesForTarget(
        supabase,
        activeInvoice.tenant_id,
        activeInvoice.start_date,
        activeInvoice.id,
        activeInvoice.issue_date || activeInvoice.start_date,
      );

      const filteredCandidates = candidates.filter((c) =>
        sourceInvoiceIds.includes(String(c.id)),
      );

      const nextCarryItems: CarryForwardItem[] = [];

      for (const row of filteredCandidates) {
        const outstanding = row.outstanding_amount;
        if (outstanding > 0) {
          const sourceLateFee = toNumber(row.late_fee_snapshot_amount);
          const actualLateFee = Math.min(outstanding, sourceLateFee);
          const actualRent = outstanding - actualLateFee;

          if (actualRent > 0) {
            nextCarryItems.push({
              detail: `ยอดค้างชำระงวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
              unit: 1,
              price_per_unit: actualRent,
              total_amount: actualRent,
              source_invoice_id: String(row.id),
            });
          }

          if (actualLateFee > 0) {
            nextCarryItems.push({
              detail: `ค่าปรับล่าช้างวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
              unit: 1,
              price_per_unit: actualLateFee,
              total_amount: actualLateFee,
              source_invoice_id: String(row.id),
            });
          }
        }
      }

      setEditableCarryForwardItems(nextCarryItems);
      // We no longer attach static snapshot late fees to the new invoice.
      // Late fees belong dynamically to the source invoice.
      setEditableLateFeeItems([]);

      setForm((prev) => {
        const nextLateFee = calculateCurrentFormLateFee(prev);
        const nextAdditional = feeItemsTotal(editableFeeItems);
        const nextDiscount = feeItemsTotal(editableDiscountItems);
        const nextCarry = feeItemsTotal(nextCarryItems);
        const total =
          toNumber(prev.rent_amount) +
          toNumber(prev.water_bill) +
          toNumber(prev.electricity_bill) +
          toNumber(prev.common_fee) +
          nextDiscount * -1 +
          nextLateFee +
          nextCarry +
          nextAdditional;
        return {
          ...prev,
          late_fee_amount: nextLateFee,
          total_amount: total,
        };
      });

      setError(null);
    } catch (error: any) {
      setError(error?.message ?? "Recalculate invoice failed.");
    } finally {
      setSaving(false);
    }
  };

  const toggleCarryOverFromCandidate = async (
    candidate: any,
    checked: boolean,
  ) => {
    if (!activeInvoice || !isInvoiceDetailEditable(activeInvoice.status))
      return;
    const cid = String(candidate?.id ?? "");
    if (!cid) return;

    if (checked) {
      if (
        editableCarryForwardItems.some(
          (x) => String(x.source_invoice_id) === cid,
        )
      )
        return;
      const outstanding = Math.max(0, toNumber(candidate.outstanding_amount));
      const newRow: CarryForwardItem = {
        detail: `ยอดค้างชำระงวด ${formatPeriodLabel(String(candidate.start_date ?? ""))}`,
        unit: 1,
        price_per_unit: outstanding,
        total_amount: outstanding,
        source_invoice_id: cid,
      };
      await recalculateCurrentInvoiceArrears(
        [...editableCarryForwardItems, newRow],
        editableLateFeeItems,
      );
      return;
    }

    const nextCarry = editableCarryForwardItems.filter(
      (x) => String(x.source_invoice_id) !== cid,
    );
    const nextLate = editableLateFeeItems.filter(
      (x) => String(x.source_invoice_id) !== cid,
    );
    await recalculateCurrentInvoiceArrears(nextCarry, nextLate);
  };

  const toggleProrateInModal = (enabled: boolean) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setUseProrateInModal(enabled);
    setForm((prev) => {
      if (!activeInvoice) return prev;
      const monthlyRent = toNumber(
        activeInvoice.room_price_month || prev.rent_amount,
      );
      const prorateSummary = calculateProratedRentByBillingDay(
        monthlyRent,
        activeInvoice.tenant_move_in_date,
        printSettings?.billing_day,
      );
      const nextRent =
        enabled && prorateSummary ? prorateSummary.rentAmount : monthlyRent;
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const nextLateFee = calculateCurrentFormLateFee(prev);
      const total =
        nextRent +
        toNumber(prev.water_bill) +
        toNumber(prev.electricity_bill) +
        toNumber(prev.common_fee) +
        nextDiscount * -1 +
        nextLateFee +
        nextAdditional;
      return { ...prev, rent_amount: nextRent, total_amount: total };
    });
  };

  const updateFeeItem = (
    index: number,
    field: keyof FeeLineItem,
    value: string | number,
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableFeeItems((prev) => {
      const next = prev.map((item, idx) =>
        idx === index ? { ...item, [field]: value } : item,
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
        const nextLateFee = calculateCurrentFormLateFee(formPrev);
        const total =
          toNumber(formPrev.rent_amount) +
          toNumber(formPrev.water_bill) +
          toNumber(formPrev.electricity_bill) +
          toNumber(formPrev.common_fee) +
          nextDiscount * -1 +
          nextLateFee +
          nextAdditional;
        return {
          ...formPrev,
          additional_fees_total: nextAdditional,
          discount_amount: nextDiscount,
          late_fee_amount: nextLateFee,
          total_amount: total,
        };
      });
      return normalized;
    });
  };

  const updateDiscountItem = (
    index: number,
    field: keyof FeeLineItem,
    value: string | number,
  ) => {
    if (activeInvoice && !isInvoiceDetailEditable(activeInvoice.status)) return;
    setEditableDiscountItems((prev) => {
      const next = prev.map((item, idx) =>
        idx === index ? { ...item, [field]: value } : item,
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
        const nextLateFee = calculateCurrentFormLateFee(formPrev);
        const total =
          toNumber(formPrev.rent_amount) +
          toNumber(formPrev.water_bill) +
          toNumber(formPrev.electricity_bill) +
          toNumber(formPrev.common_fee) +
          nextDiscount * -1 +
          nextLateFee +
          nextAdditional;
        return {
          ...formPrev,
          discount_amount: nextDiscount,
          late_fee_amount: nextLateFee,
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
      waived_late_fee_amount: toNumber(form.waived_late_fee_amount),
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
        ...editableLateFeeItems.map((item) => ({
          item_type: "late_fee_line",
          source_invoice_id: item.source_invoice_id ?? null,
          snapshot_as_of: item.snapshot_as_of ?? null,
          days_overdue: Math.max(
            0,
            Math.round(toNumber(item.days_overdue ?? item.unit)),
          ),
          daily_rate: Math.max(
            0,
            toNumber(item.daily_rate ?? item.price_per_unit),
          ),
          original_amount: Math.max(
            0,
            toNumber(
              item.original_amount ??
                toNumber(item.unit) * toNumber(item.price_per_unit),
            ),
          ),
          waived_amount: Math.max(0, toNumber(item.waived_amount)),
          detail: item.detail,
          unit: Math.max(0, Math.round(toNumber(item.unit))),
          price_per_unit: Math.max(0, toNumber(item.price_per_unit)),
          total_amount: Math.max(0, toNumber(item.total_amount)),
          amount: Math.max(0, toNumber(item.total_amount)),
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
      // Bug #3 fix: form.late_fee_amount already includes both:
      //   - native late fee for this invoice (from late_fee_start_date × rate - waived)
      //   - editableLateFeeItems (carry-forward late fees from other invoices)
      // (set together by updateForm via nativeLateFee + nextLateFeeItems)
      // So we must NOT add editableLateFeeItems again here.
      total_amount:
        toNumber(form.rent_amount) +
        toNumber(form.water_bill) +
        toNumber(form.electricity_bill) +
        toNumber(form.common_fee) +
        toNumber(form.late_fee_amount) +
        feeItemsTotal(editableFeeItems) -
        feeItemsTotal(editableDiscountItems),
      paid_amount: Math.min(
        toNumber(form.paid_amount),
        toNumber(form.total_amount),
      ),
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
    setActiveInvoice((prev) =>
      prev ? ({ ...prev, ...(payload as any) } as InvoiceRecord) : prev,
    );
    setDetailOpen(false);
  };

  const deleteInvoices = async (invoiceIds: string[]) => {
    if (!can("invoice.delete")) {
      setError("You do not have permission to delete invoices.");
      return;
    }
    if (invoiceIds.length === 0) return;

    const targetInvoices = invoices.filter((invoice) =>
      invoiceIds.includes(invoice.id),
    );
    const blocked = targetInvoices.filter((invoice) => {
      if (invoice.status === "draft") return false;
      return (
        !!invoice.slip_url ||
        invoice.status === "verifying" ||
        invoice.status === "paid"
      );
    });

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
        `ไม่สามารถลบใบแจ้งหนี้ได้ กรุณาลบสลิปการชำระเงินหรือเปลี่ยนสถานะก่อน ${details}`,
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

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      throw new Error("Session expired. Please log in again.");
    }

    const response = await fetch("/api/send-invoice", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        userId: invoice.tenant_line_user_id,
        invoiceId: invoice.id,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      const detail = [
        data?.error,
        data?.lineStatus && `LINE ${data.lineStatus}`,
        data?.lineMessage,
      ]
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
    setLineSendMessage(
      `กำลังส่งห้อง ${invoice.room_number} (${invoice.tenant_name})`,
    );
    try {
      await sendInvoiceToLineRequest(invoice);
      setLineSendState("success");
      setLineSendTitle("ส่งใบแจ้งหนี้สำเร็จ");
      setLineSendMessage(
        `ส่งไปยัง ${invoice.tenant_name} (ห้อง ${invoice.room_number}) เรียบร้อย`,
      );
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
    let skippedCount = 0;
    let failedCount = 0;
    const skippedRooms: string[] = [];
    const failedRooms: string[] = [];

    for (let i = 0; i < selectedInvoices.length; i += 1) {
      const invoice = selectedInvoices[i];
      setLineSendMessage(
        `กำลังส่ง ${i + 1}/${selectedInvoices.length}: ห้อง ${invoice.room_number} (${invoice.tenant_name})`,
      );

      if (!invoice.tenant_line_user_id) {
        skippedCount += 1;
        skippedRooms.push(invoice.room_number);
        continue;
      }

      try {
        await sendInvoiceToLineRequest(invoice);
        sentCount += 1;
      } catch (error: any) {
        failedCount += 1;
        failedRooms.push(
          `${invoice.room_number}: ${error?.message ?? "ส่งไม่สำเร็จ"}`,
        );
      }
    }

    const summaryParts = [
      `ส่งสำเร็จ ${sentCount}/${selectedInvoices.length} รายการ`,
    ];
    if (skippedCount > 0) {
      summaryParts.push(`ข้าม ${skippedCount} รายการ (ยังไม่เชื่อม LINE)`);
    }
    if (failedCount > 0) {
      summaryParts.push(`ล้มเหลว ${failedCount} รายการ`);
    }

    if (sentCount === 0 && (skippedCount > 0 || failedCount > 0)) {
      setLineSendState("error");
      setLineSendTitle("ส่งใบแจ้งหนี้ไม่สำเร็จ");
      setLineSendMessage(
        [
          summaryParts.join(" · "),
          skippedRooms.length > 0 ? `ข้าม: ${skippedRooms.join(", ")}` : "",
          failedRooms.length > 0 ? failedRooms.slice(0, 3).join(" | ") : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      setError(summaryParts.join(" · "));
    } else if (failedCount > 0 || skippedCount > 0) {
      setLineSendState("success");
      setLineSendTitle("ส่งใบแจ้งหนี้เสร็จ (มีบางรายการข้าม/ล้มเหลว)");
      setLineSendMessage(summaryParts.join(" · "));
    } else {
      setLineSendState("success");
      setLineSendTitle("ส่งใบแจ้งหนี้ครบแล้ว");
      setLineSendMessage(summaryParts.join(" · "));
    }
  };

  const getInvoicePrintDetail = async (
    invoice: InvoiceRecord,
    docType: "invoice" | "receipt" = "invoice",
  ) => {
    setPreviewLoading(true);
    setPreviewDocType(docType);
    setPreviewInvoice(invoice);
    const readingMonth = monthStartFromDate(
      invoice.start_date || invoice.issue_date,
    );
    const { data } = await supabase
      .from("meter_readings")
      .select(
        "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading",
      )
      .eq("room_id", invoice.room_id)
      .eq("reading_month", readingMonth)
      .maybeSingle();
    const { data: snapshotRows } = await supabase
      .from("invoice_arrears_snapshots")
      .select(
        "id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate",
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
      })),
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
    arrearsSnapshotRows: ArrearsSnapshotItem[] = [],
  ) => {
    const dormName = printSettings?.dorm_name || "หอพัก";
    const dormAddress = printSettings?.dorm_address || "-";
    const elecRate = toNumber(printSettings?.electricity_rate);
    const waterRate = toNumber(printSettings?.water_rate);
    const waterMinUnits = toNumber(printSettings?.water_min_units);
    const waterMinPrice = toNumber(printSettings?.water_min_price);
    const elecUnits = resolveElectricityUsage(reading);
    const waterUnits = resolveWaterUsage(reading);
    const paymentText = getPaymentMethodLabel(invoice);
    const prorateSummary = calculateProratedRentByBillingDay(
      toNumber(invoice.room_price_month || invoice.rent_amount),
      invoice.tenant_move_in_date,
      printSettings?.billing_day,
    );
    const showProrateFormula =
      !!prorateSummary &&
      Math.abs(toNumber(invoice.rent_amount) - prorateSummary.rentAmount) <
        0.01;
    const transferRows = toTransferBreakdownItems(
      invoice.additional_fees_breakdown ?? [],
    );
    const carryForwardRows = toCarryForwardRows(
      invoice.additional_fees_breakdown ?? [],
    );
    const lateFeeRows = toLateFeeItems(
      toLateFeeRows(invoice.additional_fees_breakdown ?? []),
    );
    const additionalRows = toChargeFeeRows(
      invoice.additional_fees_breakdown ?? [],
    )
      .map(
        (fee: any) => `
          <tr>
            <td>ค่าธรรมเนียมเพิ่มเติม - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(
                fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount,
              ),
            )}</td>
            <td class="text-right">${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`,
      )
      .join("");
    const carryForwardHtml = carryForwardRows
      .map(
        (fee: any) => `
          <tr>
            <td>ยอดค้างยกมา - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(
                fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount,
              ),
            )}</td>
            <td class="text-right">${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`,
      )
      .join("");
    const transferBreakdownRows = transferRows
      .map(
        (row) => `
          <tr>
            <td>${row.label}</td>
            <td class="text-right" colspan="3">${row.value}</td>
          </tr>`,
      )
      .join("");
    const normalizedDiscountRows =
      Array.isArray(invoice.discount_breakdown) &&
      invoice.discount_breakdown.length > 0
        ? invoice.discount_breakdown
        : invoice.discount_amount > 0
          ? [
              {
                detail: "ส่วนลด",
                unit: 1,
                total_amount: invoice.discount_amount,
                price_per_unit: invoice.discount_amount,
              },
            ]
          : [];
    const discountRows = normalizedDiscountRows
      .map(
        (fee: any) => `
          <tr>
            <td>ส่วนลด - ${fee.detail ?? fee.label ?? "-"}</td>
            <td class="text-right">${toNumber(fee.unit).toLocaleString("th-TH") || "-"}</td>
            <td class="text-right">${formatMoney(
              toNumber(
                fee.price_per_unit ?? fee.rate ?? fee.value ?? fee.amount,
              ),
            )}</td>
            <td class="text-right">-${formatMoney(toNumber(fee.total_amount ?? fee.amount))}</td>
          </tr>`,
      )
      .join("");
    const lateFeeRowsHtml =
      lateFeeRows.length > 0
        ? lateFeeRows
            .map(
              (row) => `
                <tr>
                  <td>${row.detail || `ค่าปรับล่าช้า - บิล ${shortInvoiceId(row.source_invoice_id)}`}</td>
                  <td class="text-right">${toNumber(row.days_overdue ?? row.unit).toLocaleString("th-TH")} วัน</td>
                  <td class="text-right">${formatMoney(toNumber(row.daily_rate ?? row.price_per_unit))}</td>
                  <td class="text-right">${formatMoney(row.total_amount)}</td>
                </tr>`,
            )
            .join("")
        : arrearsSnapshotRows.length > 0
          ? arrearsSnapshotRows
              .map(
                (row) => `
                  <tr>
                    <td>ค่าปรับล่าช้า - บิล ${shortInvoiceId(row.source_invoice_id)} (คำนวณถึง ${formatDateThai(row.snapshot_as_of)})</td>
                    <td class="text-right">${row.days_overdue.toLocaleString("th-TH")} วัน</td>
                    <td class="text-right">${formatMoney(row.daily_rate)}</td>
                    <td class="text-right">${formatMoney(row.late_fee_amount)}</td>
                  </tr>`,
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

    const documentTitle =
      docType === "receipt" ? "ใบเสร็จรับเงิน" : "ใบแจ้งหนี้";

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
              ${(() => {
                const utilityKinds = ["old_water", "new_water", "old_elec", "new_elec"];
                const utilityTransferItems = transferRows.filter((r) => utilityKinds.includes(r.kind ?? ""));
                if (utilityTransferItems.length > 0) {
                  // Per-room utility breakdown for mid-month transfer
                  const order = ["old_water", "old_elec", "new_water", "new_elec"];
                  return order.map((kind) => {
                    const item = utilityTransferItems.find((r) => r.kind === kind);
                    if (!item || toNumber(item.amount) == null) return "";
                    const amt = toNumber(item.amount ?? 0);
                    const match = item.label.match(/\((\d+)\s*หน่วย\)/);
                    const units = match ? parseInt(match[1], 10) : 0;
                    const rate = units > 0 ? amt / units : 0;
                    const isOld = kind.startsWith("old_");
                    return `<tr style="background:${isOld ? '#f0f9ff' : '#f0fdf4'}">
                      <td>${item.label}</td>
                      <td class="text-right">${units > 0 ? units + " หน่วย" : "-"}</td>
                      <td class="text-right">${units > 0 ? formatMoney(rate) : "-"}</td>
                      <td class="text-right">${formatMoney(amt)}</td>
                    </tr>`;
                  }).join("");
                }
                // Normal (non-transfer) water + electricity rows
                return `
                  <tr>
                    <td>ค่าน้ำ</td>
                    <td class="text-right">${
                      reading?.previous_water != null && reading?.current_water != null
                        ? `${reading.previous_water} - ${reading.current_water} = ${waterUnits.toLocaleString("th-TH")}`
                        : waterUnits.toLocaleString("th-TH")
                    } หน่วย</td>
                    <td class="text-right">${
                      waterUnits > 0 && waterUnits <= waterMinUnits && invoice.water_bill === waterMinPrice
                        ? `${formatMoney(waterRate)} <br><span style='font-size:11px;color:#64748b'>(ขั้นต่ำ ${waterMinUnits} หน่วย)</span>`
                        : waterUnits > 0
                        ? formatMoney(invoice.water_bill / waterUnits)
                        : formatMoney(waterRate)
                    }</td>
                    <td class="text-right">${formatMoney(invoice.water_bill)}</td>
                  </tr>
                  <tr>
                    <td>ค่าไฟ</td>
                    <td class="text-right">${
                      reading?.previous_electricity != null && reading?.current_electricity != null
                        ? `${reading.previous_electricity} - ${reading.current_electricity} = ${elecUnits.toLocaleString("th-TH")}`
                        : elecUnits.toLocaleString("th-TH")
                    } หน่วย</td>
                    <td class="text-right">${
                      elecUnits > 0
                      ? formatMoney(invoice.electricity_bill / elecUnits)
                      : formatMoney(elecRate)
                    }</td>
                    <td class="text-right">${formatMoney(invoice.electricity_bill)}</td>
                  </tr>`;
              })()}
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
    arrearsSnapshotRows: ArrearsSnapshotItem[] = [],
  ) => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      buildPrintHtml(invoice, reading, docType, arrearsSnapshotRows),
    );

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
        "water_rate,electricity_rate,common_fee,water_min_units,water_min_price,additional_fees,additional_discounts,billing_day,due_day,late_fee_start_day,late_fee_per_day",
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
    const issueDateText = toLocalDateString(
      new Date(year, month - 1, billingDay),
    );
    // Invoice period is the selected month, but due date / late fee start belong to the next month.
    const generatedDueDateText = toLocalDateString(
      new Date(year, month, dueDay),
    );
    const generatedLateFeeStartDateText = toLocalDateString(
      new Date(year, month, lateFeeStartDay),
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
      .select("id,room_id,full_name,move_in_date,move_out_date")
      .eq("status", "active")
      .is("move_out_date", null)
      .in("room_id", roomIds);

    if (tenantError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(tenantError.message);
      return;
    }

    const tenantByRoom = new Map<string, any>();
    for (const tenant of activeTenants ?? []) {
      if (!tenantByRoom.has(tenant.room_id))
        tenantByRoom.set(tenant.room_id, tenant);
    }

    const missingTenantRooms = occupiedRooms.filter(
      (room: any) => !tenantByRoom.has(room.id),
    );

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
          "tenant_id,from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,old_rent_amount,new_rent_amount,new_prev_electricity,new_prev_water",
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

    const transferRoomRateMap = new Map<string, number>();
    for (const room of occupiedRooms ?? []) {
      transferRoomRateMap.set(
        String((room as any).id),
        toNumber((room as any).price_month),
      );
    }
    const missingTransferRoomIds = Array.from(
      new Set(
        Array.from(transferByTenant.values()).flatMap((row: any) => [
          String(row?.from_room_id ?? ""),
          String(row?.to_room_id ?? ""),
        ]),
      ),
    ).filter((roomId) => roomId && !transferRoomRateMap.has(roomId));
    if (missingTransferRoomIds.length > 0) {
      const { data: extraTransferRooms, error: extraTransferRoomsError } =
        await supabase
          .from("rooms")
          .select("id,price_month")
          .in("id", missingTransferRoomIds);
      if (extraTransferRoomsError) {
        setSaving(false);
        setConfirmGenerateOpen(false);
        setError(extraTransferRoomsError.message);
        return;
      }
      for (const room of extraTransferRooms ?? []) {
        transferRoomRateMap.set(
          String((room as any).id),
          toNumber((room as any).price_month),
        );
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

    const existingRoomIds = new Set(
      (existingInvoices ?? []).map((row: any) => row.room_id),
    );
    const tenantsToGenerate = billingTenants.filter(
      (tenant: any) => !existingRoomIds.has(tenant.room_id),
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

    const tenantIdsToGenerate = tenantsToGenerate.map((tenant: any) =>
      String(tenant.id),
    );
    const { data: previousUnpaidInvoices, error: previousUnpaidError } =
      tenantIdsToGenerate.length > 0
        ? await supabase
            .from("invoices")
            .select(
              "id,tenant_id,start_date,due_date,total_amount,paid_amount,status,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount",
            )
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

    const sourceInvoiceIds = ((previousUnpaidInvoices ?? []) as any[]).map(
      (row) => String(row.id),
    );
    const { data: priorLateFeeSnapshots, error: priorSnapshotError } =
      sourceInvoiceIds.length > 0
        ? await supabase
            .from("invoice_arrears_snapshots")
            .select("source_invoice_id,snapshot_as_of")
            .in("source_invoice_id", sourceInvoiceIds)
            .order("snapshot_as_of", { ascending: false })
        : { data: [], error: null };

    if (priorSnapshotError) {
      setSaving(false);
      setConfirmGenerateOpen(false);
      setError(priorSnapshotError.message);
      return;
    }

    const lastSnapshotBySource = new Map<string, string>();
    for (const row of (priorLateFeeSnapshots ?? []) as any[]) {
      const sourceId = String(row.source_invoice_id ?? "");
      const snapshotAsOf = String(row.snapshot_as_of ?? "");
      if (!sourceId || !snapshotAsOf || lastSnapshotBySource.has(sourceId))
        continue;
      lastSnapshotBySource.set(sourceId, snapshotAsOf);
    }

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
      ((existingCarryForwards ?? []) as any[]).map((row) =>
        String(row.source_invoice_id),
      ),
    );
    const carryForwardByTenant = new Map<string, any[]>();
    for (const row of (previousUnpaidInvoices ?? []) as any[]) {
      // Do not skip carried invoices so they all appear in the checklist
      const outstanding = Math.max(
        0,
        toNumber(row.total_amount) - toNumber(row.paid_amount),
      );
      if (outstanding <= 0) continue;
      const generationDateText = issueDateText;
      const tenantId = String(row.tenant_id ?? "");
      if (!tenantId) continue;

      // Calculate the accrued late fee on this source invoice as of the generation date.
      // If the invoice already has a locked_late_fee_amount, use that (already frozen).
      const snapshotLateFee = calculateLateFeeAmount(
        {
          late_fee_start_date: row.late_fee_start_date ?? null,
          late_fee_per_day: row.late_fee_per_day ?? 0,
          waived_late_fee_amount: row.waived_late_fee_amount ?? 0,
          locked_late_fee_amount: row.locked_late_fee_amount ?? null,
        },
        generationDateText,
      );

      // Calculate days overdue for display
      const lateFeeStartDate = row.late_fee_start_date
        ? toDateOnly(row.late_fee_start_date)
        : null;
      const generationDate = toDateOnly(generationDateText);
      const daysOverdue =
        lateFeeStartDate && generationDate >= lateFeeStartDate
          ? dayDiffInclusive(lateFeeStartDate, generationDate)
          : 0;

      const currentRows = carryForwardByTenant.get(tenantId) ?? [];
      currentRows.push({
        ...row,
        outstanding_amount: outstanding,
        base_outstanding_amount: outstanding,
        snapshot_as_of: generationDateText,
        snapshot_late_fee_amount: snapshotLateFee,
        snapshot_days_overdue: daysOverdue,
        snapshot_daily_rate: toNumber(row.late_fee_per_day ?? 0),
      });
      carryForwardByTenant.set(tenantId, currentRows);
    }

    const { data: readings } = await supabase
      .from("meter_readings")
      .select("room_id,electricity_usage,water_usage,usage,current_electricity,current_water")
      .eq("reading_month", monthKey)
      .in(
        "room_id",
        roomIds.length ? roomIds : ["00000000-0000-0000-0000-000000000000"],
      );

    const readingMap = new Map(
      (readings ?? []).map((row: any) => [row.room_id, row]),
    );

    const additionalFees = Array.isArray(settings.additional_fees)
      ? (settings.additional_fees as AdditionalFee[])
      : [];
    const discountRules = Array.isArray((settings as any).additional_discounts)
      ? ((settings as any).additional_discounts as AdditionalFee[])
      : [];

    const insertPayload = tenantsToGenerate.map((tenant: any) => {
      const roomRel = Array.isArray(tenant.rooms)
        ? tenant.rooms[0]
        : tenant.rooms;
      const reading = readingMap.get(tenant.room_id) ?? {};
      const transfer = transferByTenant.get(String(tenant.id));
      const hasTransferToThisRoom =
        !!transfer &&
        String((transfer as any).to_room_id ?? "") === String(tenant.room_id);

      const newRoomElecUnits = hasTransferToThisRoom && toNumber((transfer as any).new_prev_electricity) > 0
        ? Math.max(0, toNumber(reading.current_electricity) - toNumber((transfer as any).new_prev_electricity))
        : toNumber(reading.electricity_usage);
      const newRoomWaterUnits = hasTransferToThisRoom && toNumber((transfer as any).new_prev_water) > 0
        ? Math.max(0, toNumber(reading.current_water) - toNumber((transfer as any).new_prev_water))
        : toNumber(reading.water_usage ?? reading.usage);
      const oldRoomElecUnits = hasTransferToThisRoom
        ? toNumber((transfer as any).old_electric_usage)
        : 0;
      const oldRoomWaterUnits = hasTransferToThisRoom
        ? toNumber((transfer as any).old_water_usage)
        : 0;
      const elecUnits = oldRoomElecUnits + newRoomElecUnits;
      const waterUnits = oldRoomWaterUnits + newRoomWaterUnits;

      const transferRentBreakdown = hasTransferToThisRoom
        ? calculateInvoiceTransferRentProration(
            toLocalDateString(startDate),
            toLocalDateString(endDate),
            String((transfer as any).transfer_date ?? issueDateText),
            tenant.move_in_date,
            toNumber(
              transferRoomRateMap.get(
                String((transfer as any).from_room_id ?? ""),
              ),
            ),
            toNumber(
              transferRoomRateMap.get(
                String((transfer as any).to_room_id ?? ""),
              ),
            ),
          )
        : null;
      const rentAmount = transferRentBreakdown
        ? transferRentBreakdown.oldRentAmount +
          transferRentBreakdown.newRentAmount
        : toNumber(roomRel?.price_month);

      const elecBill = elecUnits * toNumber(settings.electricity_rate);
      const waterBill = calculateWaterBillWithMinimum(
        waterUnits,
        toNumber(settings.water_rate),
        toNumber(settings.water_min_units),
        toNumber(settings.water_min_price),
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
        0,
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
        0,
      );
      const carryForwardRows =
        carryForwardByTenant.get(String(tenant.id)) ?? [];
      const carryForwardAmount = carryForwardRows.reduce(
        (sum, row) => sum + toNumber(row.base_outstanding_amount),
        0,
      );
      const carryForwardBreakdown = carryForwardRows.map((row) => ({
        item_type: "carry_forward",
        source_invoice_id: row.id,
        label: `ยอดค้างชำระงวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
        detail: `ยอดค้างชำระงวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
        unit: 1,
        price_per_unit: toNumber(row.base_outstanding_amount),
        total_amount: toNumber(row.base_outstanding_amount),
        amount: toNumber(row.base_outstanding_amount),
      }));

      // Carried late fees — one line item per source invoice that has an accrued late fee
      const lateFeeBreakdown = carryForwardRows
        .filter((row: any) => toNumber(row.snapshot_late_fee_amount) > 0)
        .map((row: any) => ({
          item_type: "late_fee",
          source_invoice_id: row.id,
          label: `ค่าปรับล่าช้างวด ${formatPeriodLabel(String(row.start_date ?? ""))} (${row.snapshot_days_overdue} วัน × ${toNumber(row.snapshot_daily_rate).toFixed(0)} บาท)`,
          detail: `ค่าปรับล่าช้างวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
          unit: toNumber(row.snapshot_days_overdue),
          price_per_unit: toNumber(row.snapshot_daily_rate),
          total_amount: toNumber(row.snapshot_late_fee_amount),
          amount: toNumber(row.snapshot_late_fee_amount),
          days_overdue: toNumber(row.snapshot_days_overdue),
          daily_rate: toNumber(row.snapshot_daily_rate),
          original_amount: toNumber(row.snapshot_late_fee_amount),
          waived_amount: 0,
        }));

      const carriedLateFeeTotal = lateFeeBreakdown.reduce(
        (sum: number, item: any) => sum + toNumber(item.total_amount),
        0,
      );

      const commonFee = toNumber(settings.common_fee);
      const totalAmount =
        rentAmount +
        waterBill +
        elecBill +
        commonFee +
        additionalTotal +
        carriedLateFeeTotal -
        discountAmount;
      // Per-room utility breakdown for mid-month transfers
      const electricityRate = toNumber(settings.electricity_rate);
      const waterRate = toNumber(settings.water_rate);
      const waterMinUnits = toNumber(settings.water_min_units);
      const waterMinPrice = toNumber(settings.water_min_price);
      const oldElecBill = hasTransferToThisRoom ? oldRoomElecUnits * electricityRate : 0;
      const oldWaterBill = hasTransferToThisRoom
        ? calculateWaterBillWithMinimum(oldRoomWaterUnits, waterRate, waterMinUnits, waterMinPrice)
        : 0;
      const newElecBill = hasTransferToThisRoom ? newRoomElecUnits * electricityRate : 0;
      const newWaterBill = hasTransferToThisRoom
        ? calculateWaterBillWithMinimum(newRoomWaterUnits, waterRate, waterMinUnits, waterMinPrice)
        : 0;

      const transferBreakdownRows = hasTransferToThisRoom
        ? serializeTransferBreakdownRows([
            {
              label: "วันที่ย้ายห้อง",
              value: String((transfer as any).transfer_date ?? "-"),
            },
            {
              label: "ค่าเช่าห้องเดิม",
              value: formatMoney(toNumber(transferRentBreakdown?.oldRentAmount)),
              amount: toNumber(transferRentBreakdown?.oldRentAmount),
              editable: true,
              kind: "old_rent",
            },
            {
              label: "ค่าเช่าห้องใหม่",
              value: formatMoney(toNumber(transferRentBreakdown?.newRentAmount)),
              amount: toNumber(transferRentBreakdown?.newRentAmount),
              editable: true,
              kind: "new_rent",
            },
            {
              label: `ค่าน้ำห้องเดิม (${oldRoomWaterUnits} หน่วย)`,
              value: `${oldRoomWaterUnits} หน่วย × ${formatMoney(waterRate)} = ${formatMoney(oldWaterBill)}`,
              amount: oldWaterBill,
              kind: "old_water",
            },
            {
              label: `ค่าน้ำห้องใหม่ (${newRoomWaterUnits} หน่วย)`,
              value: `${newRoomWaterUnits} หน่วย × ${formatMoney(waterRate)} = ${formatMoney(newWaterBill)}`,
              amount: newWaterBill,
              kind: "new_water",
            },
            {
              label: `ค่าไฟห้องเดิม (${oldRoomElecUnits} หน่วย)`,
              value: `${oldRoomElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(oldElecBill)}`,
              amount: oldElecBill,
              kind: "old_elec",
            },
            {
              label: `ค่าไฟห้องใหม่ (${newRoomElecUnits} หน่วย)`,
              value: `${newRoomElecUnits} หน่วย × ${formatMoney(electricityRate)} = ${formatMoney(newElecBill)}`,
              amount: newElecBill,
              kind: "new_elec",
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
        late_fee_amount: 0,
        late_fee_per_day: lateFeePerDay,
        late_fee_start_date: generatedLateFeeStartDateText,
        carry_forward_amount: carryForwardAmount,
        additional_fees_total: additionalTotal + carriedLateFeeTotal,
        additional_fees_breakdown: [
          ...carryForwardBreakdown,
          ...lateFeeBreakdown,
          ...additionalBreakdown,
          ...transferBreakdownRows,
        ],
        total_amount: totalAmount,
        notes: null,
        status: "draft",
      };
    }) as any[];

    const generatedRoomIds = new Set(
      insertPayload.map((row: any) => row.room_id),
    );
    if (insertPayload.length > 0) {
      const { data: insertedInvoices, error: insertError } = await supabase
        .from("invoices")
        .insert(insertPayload)
        .select("id,tenant_id");
      if (insertError) {
        setError(insertError.message);
      } else if ((insertedInvoices ?? []).length > 0) {
        const carryForwardInsertPayload = (insertedInvoices ?? []).flatMap(
          (row: any) => {
            const carryRows =
              carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? [];
            return carryRows.map((carryRow) => ({
              source_invoice_id: carryRow.id,
              target_invoice_id: row.id,
              amount: toNumber(carryRow.outstanding_amount),
            }));
          },
        );
        const arrearsSnapshotPayload = (insertedInvoices ?? []).flatMap(
          (row: any) => {
            const carryRows =
              carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? [];
            return carryRows.map((carryRow) => ({
              source_invoice_id: carryRow.id,
              target_invoice_id: row.id,
              snapshot_as_of: carryRow.snapshot_as_of,
              principal_amount: toNumber(carryRow.base_outstanding_amount),
              late_fee_amount: toNumber(carryRow.snapshot_late_fee_amount),
              days_overdue: Math.round(
                toNumber(carryRow.snapshot_days_overdue),
              ),
              daily_rate: toNumber(carryRow.snapshot_daily_rate),
            }));
          },
        );
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

        // Freeze the late fee on every source invoice that was carried forward.
        // This stops them from accruing further — their late fee now lives in the new invoice.
        const allSourceRows = (insertedInvoices ?? []).flatMap((row: any) =>
          carryForwardByTenant.get(String(row.tenant_id ?? "")) ?? [],
        );
        for (const carryRow of allSourceRows) {
          const freezeAmount = toNumber(carryRow.snapshot_late_fee_amount);
          // Only freeze if the late fee isn't already locked (avoid overwriting existing lock)
          if (carryRow.locked_late_fee_amount == null) {
            await supabase
              .from("invoices")
              .update({ locked_late_fee_amount: freezeAmount })
              .eq("id", carryRow.id);
          }
        }
      }
    } else {
      setError(
        "No new invoices generated. All rooms already have invoices for this period.",
      );
    }

    const occupiedRoomIds = new Set(occupiedRooms.map((room: any) => room.id));
    const billedRoomIds = new Set<string>([
      ...existingRoomIds,
      ...generatedRoomIds,
    ]);
    const roomNumberById = new Map<string, string>(
      occupiedRooms.map((room: any) => [room.id, room.room_number]),
    );
    const notBilledRoomIds = [...occupiedRoomIds].filter(
      (roomId) => !billedRoomIds.has(roomId),
    );

    const alerts: string[] = [];
    if (existingRoomIds.size > 0 && insertPayload.length > 0) {
      alerts.push(
        `สร้างใบแจ้งหนี้ ${insertPayload.length} รายการแล้ว และข้าม ${existingRoomIds.size} ห้องที่มีใบแจ้งหนี้ในงวดนี้อยู่แล้ว`,
      );
    }
    if (missingTenantRooms.length > 0) {
      const rooms = missingTenantRooms
        .map((room: any) => room.room_number)
        .join(", ");
      alerts.push(`Occupied room(s) missing active tenant: ${rooms}`);
    }
    if (notBilledRoomIds.length > 0) {
      const rooms = notBilledRoomIds
        .map((roomId) => roomNumberById.get(roomId) ?? roomId)
        .join(", ");
      alerts.push(
        `Billing audit failed. Occupied room(s) without invoice: ${rooms}`,
      );
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
          printSettings?.billing_day,
        )
      : null;
  const livePreviewRows = useMemo(() => {
    const rows: Array<{
      detail: string;
      unitLabel: string;
      pricePerUnit: number;
      total: number;
      tone?: string;
    }> = [];

    const transferRentItems = transferBreakdownItems.filter(
      (item) => item.editable && toNumber(item.amount) > 0,
    );

    if (transferRentItems.length > 0) {
      transferRentItems.forEach((item) => {
        rows.push({
          detail: item.label,
          unitLabel: "1 รายการ",
          pricePerUnit: toNumber(item.amount),
          total: toNumber(item.amount),
          tone: "sky",
        });
      });
    } else if (toNumber(form.rent_amount) > 0) {
      rows.push({
        detail: "ค่าเช่าห้อง",
        unitLabel: "1 เดือน",
        pricePerUnit: toNumber(form.rent_amount),
        total: toNumber(form.rent_amount),
      });
    }

    const transferUtilityKinds = ["old_water", "new_water", "old_elec", "new_elec"];
    const transferUtilityItems = transferBreakdownItems.filter(
      (item) => transferUtilityKinds.includes(item.kind ?? ""),
    );
    const hasTransferUtilityBreakdown = transferUtilityItems.length > 0;

    if (hasTransferUtilityBreakdown) {
      // Render per-room utility rows from the stored transfer breakdown
      const utilityOrder = ["old_water", "old_elec", "new_water", "new_elec"];
      const toneByKind: Record<string, string> = {
        old_water: "sky", old_elec: "sky", new_water: "sky", new_elec: "sky",
      };
      utilityOrder.forEach((kind) => {
        const item = transferUtilityItems.find((i) => i.kind === kind);
        if (item && toNumber(item.amount) >= 0) {
          const units = (() => {
            const match = item.label.match(/\((\d+)\s*หน่วย\)/);
            return match ? parseInt(match[1], 10) : 0;
          })();
          rows.push({
            detail: item.label,
            unitLabel: units > 0 ? `${units} หน่วย` : "1 รายการ",
            pricePerUnit: units > 0 ? roundTo2(toNumber(item.amount) / units) : toNumber(item.amount),
            total: toNumber(item.amount),
            tone: toneByKind[kind],
          });
        }
      });
    } else {
      if (toNumber(form.water_bill) > 0) {
        const units = toNumber(form.water_units);
        const isMinCharge = units > 0 && units <= toNumber(printSettings?.water_min_units) && toNumber(form.water_bill) === toNumber(printSettings?.water_min_price);
        rows.push({
          detail: "ค่าน้ำ" + (isMinCharge ? ` (เหมาจ่ายขั้นต่ำ ${formatMoney(toNumber(printSettings?.water_min_price))} บาท)` : ""),
          unitLabel:
            units > 0 && activeReading?.previous_water != null && activeReading?.current_water != null
              ? `${activeReading.previous_water} - ${activeReading.current_water} = ${units.toLocaleString("th-TH")} หน่วย`
              : units > 0
              ? `${units.toLocaleString("th-TH")} หน่วย`
              : "1 รายการ",
          pricePerUnit:
            isMinCharge
              ? toNumber(printSettings?.water_rate)
              : units > 0
              ? roundTo2(toNumber(form.water_bill) / units)
              : toNumber(form.water_bill),
          total: toNumber(form.water_bill),
          tone: isMinCharge ? "sky" : undefined,
        });
      }

      if (toNumber(form.electricity_bill) > 0) {
        const units = toNumber(form.electricity_units);
        rows.push({
          detail: "ค่าไฟฟ้า",
          unitLabel:
            units > 0 && activeReading?.previous_electricity != null && activeReading?.current_electricity != null
              ? `${activeReading.previous_electricity} - ${activeReading.current_electricity} = ${units.toLocaleString("th-TH")} หน่วย`
              : units > 0
              ? `${units.toLocaleString("th-TH")} หน่วย`
              : "1 รายการ",
          pricePerUnit:
            units > 0
              ? roundTo2(toNumber(form.electricity_bill) / units)
              : toNumber(form.electricity_bill),
          total: toNumber(form.electricity_bill),
        });
      }
    }

    if (toNumber(form.common_fee) > 0) {
      rows.push({
        detail: "ค่าส่วนกลาง",
        unitLabel: "1 รายการ",
        pricePerUnit: toNumber(form.common_fee),
        total: toNumber(form.common_fee),
      });
    }

    editableCarryForwardItems
      .filter((item) => toNumber(item.total_amount) > 0)
      .forEach((item) => {
        rows.push({
          detail: item.detail || "ยอดค้างยกมา",
          unitLabel: `${toNumber(item.unit).toLocaleString("th-TH")} รายการ`,
          pricePerUnit: toNumber(item.price_per_unit),
          total: toNumber(item.total_amount),
          tone: "amber",
        });
      });

    editableLateFeeItems
      .filter((item) => toNumber(item.total_amount) > 0)
      .forEach((item) => {
        rows.push({
          detail: item.detail || "ค่าปรับล่าช้า",
          unitLabel: `${toNumber(item.days_overdue ?? item.unit).toLocaleString("th-TH")} วัน`,
          pricePerUnit: toNumber(item.daily_rate ?? item.price_per_unit),
          total: toNumber(item.total_amount),
          tone: "amber",
        });
      });

    editableFeeItems
      .filter((item) => toNumber(item.total_amount) > 0)
      .forEach((item) => {
        rows.push({
          detail: item.detail || "ค่าธรรมเนียมเพิ่มเติม",
          unitLabel: `${toNumber(item.unit).toLocaleString("th-TH")} รายการ`,
          pricePerUnit: toNumber(item.price_per_unit),
          total: toNumber(item.total_amount),
        });
      });

    editableDiscountItems
      .filter((item) => toNumber(item.total_amount) > 0)
      .forEach((item) => {
        rows.push({
          detail: item.detail || "ส่วนลด",
          unitLabel: `${toNumber(item.unit).toLocaleString("th-TH")} รายการ`,
          pricePerUnit: toNumber(item.price_per_unit),
          total: -toNumber(item.total_amount),
          tone: "emerald",
        });
      });

    return rows;
  }, [
    editableCarryForwardItems,
    editableDiscountItems,
    editableFeeItems,
    editableLateFeeItems,
    form.common_fee,
    form.electricity_bill,
    form.electricity_units,
    form.rent_amount,
    form.water_bill,
    form.water_units,
    transferBreakdownItems,
    activeReading,
    printSettings,
  ]);
  const canEditDetails = activeInvoice
    ? isInvoiceDetailEditable(activeInvoice.status)
    : false;
  const hasEditableTransferRent = transferBreakdownItems.some(
    (item) => item.editable,
  );
  const canCreateInvoice = can("invoice.create");
  const canEditInvoice = can("invoice.edit");
  const canDeleteInvoice = can("invoice.delete");
  const canUpdateInvoiceStatus = can("invoice.status.update");
  const canRecordInvoicePayment = can("invoice.payment.record");

  useEffect(() => {
    setForm((prev) => {
      const nextAdditional = feeItemsTotal(editableFeeItems);
      const nextDiscount = feeItemsTotal(editableDiscountItems);
      const nextCarry = feeItemsTotal(editableCarryForwardItems);
      const nextLateFeeItems = feeItemsTotal(editableLateFeeItems);
      const nativeLateFee = calculateCurrentFormLateFee(prev);
      const nextLateFee = nativeLateFee + nextLateFeeItems;
      const total =
        toNumber(prev.rent_amount) +
        toNumber(prev.water_bill) +
        toNumber(prev.electricity_bill) +
        toNumber(prev.common_fee) +
        nextLateFee +
        nextAdditional -
        nextDiscount;
      return {
        ...prev,
        additional_fees_total: nextAdditional,
        discount_amount: nextDiscount,
        late_fee_amount: nextLateFee,
        total_amount: total,
        paid_amount: Math.min(toNumber(prev.paid_amount), total),
      };
    });
  }, [
    editableFeeItems,
    editableDiscountItems,
    editableCarryForwardItems,
    editableLateFeeItems,
  ]);

  useEffect(() => {
    const transferRentItems = transferBreakdownItems.filter(
      (item) => item.editable,
    );
    if (transferRentItems.length === 0) return;
    const transferRentTotal = transferRentItems.reduce(
      (sum, item) => sum + toNumber(item.amount),
      0,
    );
    const nextCarry = feeItemsTotal(editableCarryForwardItems);
    const nextLateFeeItems = feeItemsTotal(editableLateFeeItems);
    const nextAdditional = feeItemsTotal(editableFeeItems);
    const nextDiscount = feeItemsTotal(editableDiscountItems);
    setForm((prev) => {
      const nativeLateFee = calculateCurrentFormLateFee(prev);
      const nextLateFee = nativeLateFee + nextLateFeeItems;
      const total =
        transferRentTotal +
        toNumber(prev.water_bill) +
        toNumber(prev.electricity_bill) +
        toNumber(prev.common_fee) +
        nextLateFee +
        nextAdditional +
        nextCarry -
        nextDiscount;
      return {
        ...prev,
        rent_amount: transferRentTotal,
        additional_fees_total: nextAdditional,
        discount_amount: nextDiscount,
        late_fee_amount: nextLateFee,
        total_amount: total,
        paid_amount: Math.min(toNumber(prev.paid_amount), total),
      };
    });
  }, [
    editableCarryForwardItems,
    editableDiscountItems,
    editableFeeItems,
    editableLateFeeItems,
    transferBreakdownItems,
  ]);

  return {
    supabase,
    invoices,
    setInvoices,
    loading,
    setLoading,
    error,
    setError,
    search,
    setSearch,
    selected,
    setSelected,
    detailOpen,
    setDetailOpen,
    activeInvoice,
    setActiveInvoice,
    activeReading,
    slipPreview,
    setSlipPreview,
    saving,
    setSaving,
    selectedMonth,
    setSelectedMonth,
    useProrateInModal,
    setUseProrateInModal,
    slipModalOpen,
    setSlipModalOpen,
    slipModalUrl,
    setSlipModalUrl,
    slipModalTitle,
    setSlipModalTitle,
    confirmDeleteOpen,
    setConfirmDeleteOpen,
    deleteTargetIds,
    setDeleteTargetIds,
    confirmGenerateOpen,
    setConfirmGenerateOpen,
    confirmSaveOpen,
    setConfirmSaveOpen,
    previewOpen,
    setPreviewOpen,
    previewLoading,
    setPreviewLoading,
    previewInvoice,
    setPreviewInvoice,
    previewReading,
    setPreviewReading,
    previewArrearsSnapshots,
    setPreviewArrearsSnapshots,
    previewDocType,
    setPreviewDocType,
    printSettings,
    setPrintSettings,
    defaultPaymentMethod,
    setDefaultPaymentMethod,
    editableFeeItems,
    setEditableFeeItems,
    editableCarryForwardItems,
    setEditableCarryForwardItems,
    editableLateFeeItems,
    setEditableLateFeeItems,
    arrearsSnapshots,
    setArrearsSnapshots,
    carryOverCandidates,
    setCarryOverCandidates,
    carryOverCandidatesLoading,
    setCarryOverCandidatesLoading,
    paymentIdempotencyKeyRef,
    allocationResultNotice,
    setAllocationResultNotice,
    editableDiscountItems,
    setEditableDiscountItems,
    transferBreakdownItems,
    setTransferBreakdownItems,
    showPaymentForm,
    setShowPaymentForm,
    paymentMode,
    setPaymentMode,
    paymentAmountInput,
    setPaymentAmountInput,
    paymentDate,
    setPaymentDate,
    paymentSlipFile,
    setPaymentSlipFile,
    paymentSubmitting,
    setPaymentSubmitting,
    lineSendModalOpen,
    setLineSendModalOpen,
    lineSendState,
    setLineSendState,
    lineSendTitle,
    setLineSendTitle,
    lineSendMessage,
    setLineSendMessage,
    openActionMenuId,
    setOpenActionMenuId,
    moveOutWarnings,
    setMoveOutWarnings,
    pendingMoveOutCount,
    setPendingMoveOutCount,
    form,
    setForm,
    applyPendingToOverdue,
    applySlipToVerifying,
    syncMonthInvoicesWithSettings,
    loadInvoices,
    patchInvoiceInState,
    loadPrintConfig,
    filteredInvoices,
    grouped,
    visibleInvoiceIds,
    selectedVisibleCount,
    toggleSelect,
    toggleSelectAllVisible,
    openSlipViewer,
    callInvoiceAdminAction,
    updateInvoiceStatus,
    uploadSlipFile,
    submitPayment,
    cancelPaymentEntry,
    deletePaymentSlip,
    openInvoice,
    updateUtilityUnits,
    updateForm,
    updateCarryForwardItem,
    updateLateFeeItem,
    updateTransferBreakdownAmount,
    applyRoundDownTotal,
    recalculateTransferBreakdown,
    recalculateCurrentInvoiceArrears,
    toggleCarryOverFromCandidate,
    toggleProrateInModal,
    updateFeeItem,
    updateDiscountItem,
    saveInvoice,
    deleteInvoices,
    sendInvoiceToLineRequest,
    sendToLine,
    sendSelectedToLine,
    getInvoicePrintDetail,
    getPaymentMethodLabel,
    buildPrintHtml,
    printInvoice,
    generateInvoices,
    livePreviewRows,
    canEditDetails,
    hasEditableTransferRent,
    canCreateInvoice,
    canEditInvoice,
    canDeleteInvoice,
    canUpdateInvoiceStatus,
    canRecordInvoicePayment,
    allVisibleSelected,
    modalProrateSummary,
  };
}
