"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import {
  computeInvoiceTotal,
  chargesFromInvoiceRow,
} from "@/lib/invoice-total";
import { usePermissions } from "@/lib/use-permissions";
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
  formatLateFeeWindow,
  lateFeeWindowStartDate,
  buildLateFeeLineDetail,
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
  buildTransferWaterBreakdown,
  calculateLateFeePreview,
  resolveElectricityUsage,
  resolveWaterUsage,
  resolveElectricityUsageForDisplay,
  resolveWaterUsageForDisplay,
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
  // `error` still drives existing conditional rendering (loading/empty-state
  // checks elsewhere), so it's kept as-is rather than removed — but every
  // failure now ALSO surfaces as a toast, since some callers (e.g. the
  // invoice list) were rendering it as a permanently-visible inline banner
  // that sat over the page content instead of a dismissing notification.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
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
  const splitPaymentIdempotencyKeyRef = useRef<string | null>(null);
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
  const [showSplitPaymentModal, setShowSplitPaymentModal] = useState(false);
  const [splitPaymentInvoices, setSplitPaymentInvoices] = useState<
    {
      id: string;
      start_date: string;
      total_amount: number;
      paid_amount: number;
      outstanding: number;
    }[]
  >([]);
  const [splitPaymentAmounts, setSplitPaymentAmounts] = useState<
    Record<string, string>
  >({});
  const [splitPaymentLoading, setSplitPaymentLoading] = useState(false);
  const [splitPaymentSubmitting, setSplitPaymentSubmitting] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [declineSubmitting, setDeclineSubmitting] = useState(false);
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
    // Moved server-side (finding C1) — see get_latest_invoice_month in
    // app/api/admin/invoices/actions/route.ts.
    const initLatestInvoiceMonth = async () => {
      try {
        const result = await callInvoiceAdminAction("get_latest_invoice_month", {});
        if (!mounted) return;
        const latestMonth = result?.startDate ? String(result.startDate).slice(0, 7) : null;
        if (latestMonth) {
          setSelectedMonth(latestMonth);
        }
      } catch {
        // Non-blocking: falls back to the default selected month.
      }
    };
    void initLatestInvoiceMonth();
    return () => {
      mounted = false;
    };
  }, []);

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

  // Both status transitions below (and syncMonthInvoicesWithSettings further
  // down) now happen through a single server action each
  // (app/api/admin/invoices/actions/route.ts, "sync_period_statuses" /
  // "sync_period_discounts") instead of writing to `invoices` directly from
  // the browser with the anon key — finding C1,
  // docs/audit/2026-09-29-system-audit-detailed.md. Kept as separate
  // functions with unchanged signatures/names so nothing else that calls
  // them (loadInvoices, and the wider invoices context type/exports) has to
  // change. Gated server-side on "tenant.view" rather than an edit
  // permission, since this ran unconditionally for every viewer who opened
  // the list before — a narrower gate would be a real regression, not just
  // a relocation.
  const applyPendingToOverdue = async (
    periodStart: string,
    periodEnd: string,
  ) => {
    try {
      await callInvoiceAdminAction("sync_period_statuses", { periodStart, periodEnd });
    } catch (err: any) {
      setError(err?.message ?? "Failed to sync invoice statuses.");
    }
  };

  // No-op: sync_period_statuses (triggered by applyPendingToOverdue, called
  // right before this in loadInvoices) already covers this transition too
  // in the same server call. Left in place, unchanged signature, rather than
  // removed, so loadInvoices' call sequence doesn't need to change.
  const applySlipToVerifying = async (
    _periodStart: string,
    _periodEnd: string,
  ) => {};

  const syncMonthInvoicesWithSettings = async (year: number, month: number) => {
    try {
      await callInvoiceAdminAction("sync_period_discounts", { year, month });
    } catch (err: any) {
      setError(err?.message ?? "Failed to sync invoice discounts.");
    }
  };

  // silent=true is used by the background poll that replaced the old
  // "invoice-settings-realtime" Realtime subscription (finding C1 — that
  // subscription connected straight to the database with the browser's own
  // session) — it re-runs the exact same load/sync but skips the loading
  // spinner so it doesn't flicker the page every poll while an admin is
  // actively looking at it.
  const loadInvoices = async (silent = false) => {
    if (!silent) setLoading(true);
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

    // Moved server-side (finding C1) — see get_invoices_for_period in
    // app/api/admin/invoices/actions/route.ts. That action also runs the
    // "does this tenant have an earlier invoice" check and the slip-
    // recovery storage lookup that used to happen here; only the client-
    // side hydration/sort below is left client-side.
    const result = await callInvoiceAdminAction("get_invoices_for_period", {
      periodStart,
      periodEnd,
    }).catch((err: any) => {
      setError(err?.message ?? "Failed to load invoices.");
      return null;
    });

    if (!result) {
      setInvoices([]);
    } else {
      const normalized = (result.invoices ?? []).map(normalizeInvoice);
      const recoveredSlipUrls = (result.recoveredSlipUrls ?? {}) as Record<string, string>;

      // Fetch all invoices for active tenants to accurately determine "new tenant" status
      const invoicesByTenant = new Map<string, string[]>();
      for (const item of result.tenantInvoicesForNewCheck ?? []) {
        if (!item?.tenant_id) continue;
        const id = String(item.tenant_id);
        if (!invoicesByTenant.has(id)) invoicesByTenant.set(id, []);
        invoicesByTenant.get(id)!.push(String(item.start_date));
      }

      const hydrated = normalized.map((invoice: any) => {
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

        // The "new tenant" badge marks the tenant's actual first invoice
        // only — not a second month afterward. It used to also flag any
        // invoice exactly one calendar month after move-in, which kept the
        // badge showing on a completely normal second invoice (and, for a
        // tenant who moved in on the 1st with no proration at all, made
        // both their first AND second invoice look "new").
        const isFirstInvoice = Boolean(invoiceMonth && invoiceMonth === earliestMonth);

        const isWaitingMoveOut = Boolean(
          invoice.tenant_move_out_date && invoice.tenant_status === "active",
        );

        // We pass a new flag down to be used for the indicator
        return {
          ...invoice,
          _is_first_regular_invoice: isFirstInvoice,
          _is_waiting_for_move_out: isWaitingMoveOut,
          slip_url: invoice.slip_url || recoveredSlipUrls[String(invoice.id)] || null,
        };
      });

      const sortedHydrated = [...hydrated]
        .filter((inv) => !inv._is_waiting_for_move_out)
        .sort((a, b) => {
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

    if (!silent) setLoading(false);
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

  // Replaced the "invoice-settings-realtime" Realtime subscription with
  // plain polling (finding C1 — Realtime meant the browser held a direct,
  // permanent connection to the database with the admin's own session,
  // separate from every other read in this app, which all now go through
  // an authenticated server route instead). Neither a settings change nor
  // an invoice update from elsewhere needs to appear within the second —
  // a periodic silent reload keeps the list close enough to live without
  // that direct connection.
  useEffect(() => {
    const interval = setInterval(() => {
      void loadInvoices(true);
    }, 20000);
    return () => clearInterval(interval);
  }, [selectedMonth]);

  useEffect(() => {
    void loadPrintConfig();
  }, []);

  useEffect(() => {
    let mounted = true;
    // Moved server-side (finding C1) — see get_move_out_warnings in
    // app/api/admin/invoices/actions/route.ts.
    const loadMoveOutWarnings = async () => {
      const monthStart = `${selectedMonth}-01`;
      const monthEnd = toLocalDateString(
        new Date(
          Number(selectedMonth.slice(0, 4)),
          Number(selectedMonth.slice(5, 7)),
          0,
        ),
      );
      try {
        const result = await callInvoiceAdminAction("get_move_out_warnings", {
          monthStart,
          monthEnd,
        });
        if (!mounted) return;
        setMoveOutWarnings(result?.warnings ?? []);
      } catch {
        if (mounted) setMoveOutWarnings([]);
      }
    };
    void loadMoveOutWarnings();
    return () => {
      mounted = false;
    };
  }, [selectedMonth]);

  useEffect(() => {
    let mounted = true;
    /** Pending move-out work: open tenant request, or active tenant with move_out_date set (manual tab). Deduped by tenant. */
    // Moved server-side (finding C1) — see get_pending_move_out_count in
    // app/api/admin/invoices/actions/route.ts. Previously kept live via a
    // Realtime subscription (a direct, permanent database connection from
    // the browser's own session); replaced with polling, same as the
    // invoice list's background refresh above.
    const loadPendingMoveOutCount = async () => {
      try {
        const result = await callInvoiceAdminAction("get_pending_move_out_count", {});
        if (!mounted) return;
        setPendingMoveOutCount(Number(result?.count ?? 0));
      } catch {
        if (mounted) setPendingMoveOutCount(0);
      }
    };
    void loadPendingMoveOutCount();
    const interval = setInterval(() => {
      void loadPendingMoveOutCount();
    }, 20000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Moved server-side (finding C1) — see get_print_config in
  // app/api/admin/invoices/actions/route.ts.
  const loadPrintConfig = async () => {
    try {
      const result = await callInvoiceAdminAction("get_print_config", {});
      setPrintSettings((result?.settings as PrintSettings) ?? null);
      setDefaultPaymentMethod((result?.defaultPaymentMethod as PaymentMethodRow) ?? null);
    } catch {
      // Non-blocking: print preview can still open with blank settings.
    }
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

  // Moved server-side (finding C1) — this used to upload straight into the
  // payment_slips storage bucket from the browser with the anon key. See
  // app/api/admin/invoices/upload-slip/route.ts.
  const uploadSlipFile = async (invoiceId: string, file: File) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session expired. Please log in again.");

    const body = new FormData();
    body.append("file", file);
    body.append("invoiceId", invoiceId);

    const response = await fetch("/api/admin/invoices/upload-slip", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error ?? "Failed to upload slip.");
    return result.url as string;
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

    const inputAmount = toNumber(paymentAmountInput);
    // This invoice's own balance is a DEFAULT, never a cap, and never a reason
    // to refuse. A payment recorded here is allocated across the whole
    // carry-forward chain server-side (oldest invoice first), so an invoice
    // that looks settled on its own row can still legitimately take money for
    // the invoices carried into it — room 212/2's May invoice reads
    // 7,594/7,594 while April, carried into it, still owes 1,400. Capping at
    // `remaining` made that payment impossible to record.
    // `applyInvoicePaymentAllocation` caps at the chain's real outstanding and
    // rejects the payment outright if nothing is owed anywhere, so the server
    // stays the authority on what can actually be applied.
    const amountToPay = inputAmount > 0 ? inputAmount : remaining;

    if (amountToPay <= 0) {
      setError("กรุณากรอกจำนวนเงินที่ต้องการบันทึก");
      return;
    }

    const finalPaymentMode =
      remaining > 0 && amountToPay >= remaining ? "full" : "partial";

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
          mode: finalPaymentMode,
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
      toast.success("บันทึกการชำระเงินเรียบร้อยแล้ว");
      setShowPaymentForm(false);
      setPaymentMode("full");
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
          activeUpdated?.paid_amount ??
            toNumber(activeInvoice.paid_amount) + amountToPay,
        ),
        payment_history: Array.isArray(activeUpdated?.payment_history)
          ? activeUpdated.payment_history
          : activeInvoice.payment_history,
        status:
          (activeUpdated?.status as keyof typeof statusVariant) ??
          activeInvoice.status,
        slip_url: publicUrl ?? null,
      } as InvoiceRecord;
      
      const newRemaining = invoiceDisplayOutstanding({
        total_amount: toNumber(form.total_amount || activeInvoice.total_amount),
        paid_amount: activeNext.paid_amount,
      });
      setPaymentAmountInput(newRemaining > 0 ? String(newRemaining) : "");

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

  // Opens the "choose which invoices this payment goes to" picker for the
  // active invoice's tenant — every open invoice across every billing
  // period, not just this one, so a lump sum or installment covering real
  // arrears can be pointed at specific months instead of the automatic
  // oldest-first split in `submitPayment`.
  const openSplitPaymentModal = async () => {
    if (!can("invoice.payment.record")) {
      setError("You do not have permission to record payment.");
      return;
    }
    if (!activeInvoice) return;
    setShowSplitPaymentModal(true);
    setSplitPaymentAmounts({});
    splitPaymentIdempotencyKeyRef.current = null;
    setSplitPaymentLoading(true);
    try {
      // Moved server-side (finding C1) — see get_open_invoices_for_tenant
      // in app/api/admin/invoices/actions/route.ts.
      const result = await callInvoiceAdminAction("get_open_invoices_for_tenant", {
        tenantId: activeInvoice.tenant_id,
      });
      const rows = (result?.invoices ?? [])
        .map((row: any) => ({
          id: String(row.id),
          start_date: String(row.start_date ?? ""),
          total_amount: toNumber(row.total_amount),
          paid_amount: toNumber(row.paid_amount),
          outstanding: Math.max(
            0,
            toNumber(row.total_amount) - toNumber(row.paid_amount),
          ),
        }))
        .filter((row: any) => row.outstanding > 0);
      setSplitPaymentInvoices(rows);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load open invoices.");
      setShowSplitPaymentModal(false);
    } finally {
      setSplitPaymentLoading(false);
    }
  };

  const closeSplitPaymentModal = () => {
    setShowSplitPaymentModal(false);
    setSplitPaymentInvoices([]);
    setSplitPaymentAmounts({});
  };

  const updateSplitPaymentAmount = (invoiceId: string, value: string) => {
    setSplitPaymentAmounts((prev) => ({ ...prev, [invoiceId]: value }));
  };

  const submitSplitPayment = async (options: {
    slipFile?: File | null;
    paidAt?: string;
  } = {}) => {
    if (!can("invoice.payment.record")) {
      setError("You do not have permission to record payment.");
      return;
    }
    if (!activeInvoice) return;

    const allocations = splitPaymentInvoices
      .map((inv) => ({
        invoiceId: inv.id,
        amount: toNumber(splitPaymentAmounts[inv.id]),
      }))
      .filter((row) => row.amount > 0);

    if (allocations.length === 0) {
      setError("เลือกอย่างน้อยหนึ่งใบแจ้งหนี้และระบุจำนวนเงิน");
      return;
    }

    // Mirrors the server's own cap so a mistake shows up immediately
    // instead of round-tripping to the server first.
    for (const row of allocations) {
      const invoice = splitPaymentInvoices.find((inv) => inv.id === row.invoiceId);
      if (invoice && row.amount > invoice.outstanding + 0.005) {
        setError(
          `ยอดที่กรอกเกินยอดค้างชำระของงวด ${formatPeriodLabel(invoice.start_date)} (ค้างชำระ ${formatMoney(invoice.outstanding)})`,
        );
        return;
      }
    }

    setSplitPaymentSubmitting(true);
    try {
      if (!splitPaymentIdempotencyKeyRef.current) {
        splitPaymentIdempotencyKeyRef.current =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const idempotencyKey = splitPaymentIdempotencyKeyRef.current;

      let publicUrl: string | null = null;
      if (options.slipFile) {
        publicUrl = await uploadSlipFile(allocations[0].invoiceId, options.slipFile);
      }
      const paidAtIso = new Date(
        `${options.paidAt ?? paymentDate}T12:00:00`,
      ).toISOString();

      const result = await callInvoiceAdminAction("record_split_payment", {
        tenantId: activeInvoice.tenant_id,
        allocations,
        payment: {
          paid_at: paidAtIso,
          slip_url: publicUrl,
          mode: "partial",
          source: "admin_webapp",
          idempotency_key: idempotencyKey,
        },
      });

      const breakdown = Array.isArray(result?.allocationBreakdown)
        ? result.allocationBreakdown
        : [];
      if (breakdown.length > 0) {
        setAllocationResultNotice({
          batchId: String(result?.paymentBatchId ?? ""),
          lines: breakdown.map((row: any) => ({
            invoiceId: String(row.invoiceId),
            label: `งวด ${formatPeriodLabel(
              splitPaymentInvoices.find((i) => i.id === row.invoiceId)?.start_date ?? "",
            )}`,
            amount: toNumber(row.allocatedAmount),
          })),
          idempotentReplay: !!result?.idempotentReplay,
        });
      }

      const updatedInvoices = Array.isArray(result?.updatedInvoices)
        ? result.updatedInvoices
        : [];
      updatedInvoices.forEach((invoiceUpdate: any) => {
        patchInvoiceInState(String(invoiceUpdate.id), {
          paid_amount: toNumber(invoiceUpdate.paid_amount),
          payment_history: Array.isArray(invoiceUpdate.payment_history)
            ? invoiceUpdate.payment_history
            : undefined,
          status: (invoiceUpdate.status as keyof typeof statusVariant) ?? undefined,
        });
      });

      // The active invoice may not have been one of the picked invoices at
      // all — it might only be a downstream invoice that bundles one of them
      // as carried debt (refreshed server-side by refreshCarryForwardTargets).
      // Re-fetch it directly rather than relying on the action's own
      // response, so its total is correct on screen either way. Moved
      // server-side (finding C1) — see get_invoice_snapshot in
      // app/api/admin/invoices/actions/route.ts.
      const snapshotResult = await callInvoiceAdminAction("get_invoice_snapshot", {
        invoiceId: activeInvoice.id,
      }).catch(() => null);
      const refreshedActive = snapshotResult?.invoice ?? null;
      if (refreshedActive) {
        patchInvoiceInState(String((refreshedActive as any).id), {
          paid_amount: toNumber((refreshedActive as any).paid_amount),
          status:
            ((refreshedActive as any).status as keyof typeof statusVariant) ??
            undefined,
          total_amount: toNumber((refreshedActive as any).total_amount),
          carry_forward_amount: toNumber((refreshedActive as any).carry_forward_amount),
          additional_fees_total: toNumber((refreshedActive as any).additional_fees_total),
          additional_fees_breakdown: Array.isArray(
            (refreshedActive as any).additional_fees_breakdown,
          )
            ? (refreshedActive as any).additional_fees_breakdown
            : undefined,
          payment_history: Array.isArray((refreshedActive as any).payment_history)
            ? (refreshedActive as any).payment_history
            : undefined,
        });
        setForm((prev) => ({
          ...prev,
          paid_amount: toNumber((refreshedActive as any).paid_amount),
          total_amount: toNumber((refreshedActive as any).total_amount),
          status:
            ((refreshedActive as any).status as keyof typeof statusVariant) ??
            prev.status,
        }));
      }

      toast.success("บันทึกการชำระเงินเรียบร้อยแล้ว");
      closeSplitPaymentModal();
      splitPaymentIdempotencyKeyRef.current = null;
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to process payment.");
    } finally {
      setSplitPaymentSubmitting(false);
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
      // Moved server-side (finding C1) — see delete_payment_slip_files in
      // app/api/admin/invoices/actions/route.ts.
      await callInvoiceAdminAction("delete_payment_slip_files", {
        invoiceId: activeInvoice.id,
      });

      // The invoice-level column is only half the reference: every
      // payment_history entry recorded alongside this slip embeds its own
      // copy (`applyInvoicePaymentAllocation` stamps `slip_url` onto each
      // invoice's history entry at payment time). Clearing only the column
      // left that embedded copy behind, so `extractAllSlipUrls` — which
      // unions the column with every history entry's slip_url — kept
      // resurrecting the "deleted" slip on the next refresh.
      const history = Array.isArray(activeInvoice.payment_history)
        ? activeInvoice.payment_history
        : [];
      const clearedHistory = history.map((entry: any) =>
        entry?.slip_url ? { ...entry, slip_url: null } : entry,
      );

      await callInvoiceAdminAction("record_payment", {
        invoiceId: activeInvoice.id,
        payload: {
          slip_url: null,
          slip_uploaded_at: null,
          payment_history: clearedHistory,
        },
      });
      setSlipPreview(null);
      setActiveInvoice((prev) =>
        prev ? { ...prev, slip_url: null, payment_history: clearedHistory } : prev,
      );
      patchInvoiceInState(activeInvoice.id, {
        slip_url: null,
        payment_history: clearedHistory,
      });
      setError(null);
    } catch (error: any) {
      setError(error?.message ?? "ลบสลิปการชำระเงินไม่สำเร็จ");
    }
  };

  /**
   * Declines the slip a tenant uploaded, sending the invoice back to
   * pending/overdue/partial so they can submit a new one. Unlike
   * deletePaymentSlip this does not touch the storage bucket — the server keeps
   * the rejected image referenced from slip_rejections for audit.
   */
  const declineSlip = async () => {
    if (!can("invoice.payment.record")) {
      setError("ไม่มีสิทธิ์ปฏิเสธสลิปการชำระเงิน");
      return;
    }
    if (!activeInvoice) return;
    const reason = declineReason.trim();
    if (!reason) {
      setError("กรุณาระบุเหตุผลที่ปฏิเสธสลิป");
      return;
    }

    setDeclineSubmitting(true);
    try {
      const result = await callInvoiceAdminAction("decline_slip", {
        invoiceId: activeInvoice.id,
        reason,
      });
      const nextStatus = String(result?.nextStatus ?? "pending");
      setForm((prev) => ({ ...prev, status: nextStatus as any }));
      setSlipPreview(null);
      setActiveInvoice((prev) =>
        prev ? { ...prev, status: nextStatus as any, slip_url: null } : prev,
      );
      patchInvoiceInState(activeInvoice.id, {
        status: nextStatus as any,
        slip_url: null,
      });
      setDeclineModalOpen(false);
      setDeclineReason("");
      setError(null);
    } catch (error: any) {
      setError(error?.message ?? "ปฏิเสธสลิปไม่สำเร็จ");
    } finally {
      setDeclineSubmitting(false);
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
    
    const remaining = invoiceDisplayOutstanding({
      total_amount: invoice.total_amount,
      paid_amount: invoice.paid_amount,
    });
    setPaymentAmountInput(remaining > 0 ? String(remaining) : "");
    
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setPaymentSlipFile(null);
    setSlipPreview(invoice.slip_url);
    setDetailOpen(true);
    setAllocationResultNotice(null);
    paymentIdempotencyKeyRef.current = null;
    setCarryOverCandidates([]);
    setActiveReading(null);
    if (isInvoiceDetailEditable(String(invoice.status ?? "")) && invoice.tenant_id) {
      setCarryOverCandidatesLoading(true);
      // Moved server-side (finding C1) — see get_carry_forward_candidates
      // in app/api/admin/invoices/actions/route.ts.
      void callInvoiceAdminAction("get_carry_forward_candidates", {
        tenantId: invoice.tenant_id,
        beforeStartDate: invoice.start_date,
        targetInvoiceId: invoice.id,
        valuationDate: invoice.issue_date || invoice.start_date,
      })
        .then((result: any) => setCarryOverCandidates(result?.candidates ?? []))
        .catch(() => setCarryOverCandidates([]))
        .finally(() => setCarryOverCandidatesLoading(false));
    }

    // Replace inferred units with real meter usage for the invoice month.
    // This is important when water billing uses a minimum charge, where
    // water_bill / water_rate does not equal actual usage. Moved
    // server-side (finding C1) — see get_invoice_reading_and_arrears in
    // app/api/admin/invoices/actions/route.ts.
    try {
      const readingMonth = monthStartFromDate(
        invoice.start_date || invoice.issue_date,
      );
      const result = await callInvoiceAdminAction("get_invoice_reading_and_arrears", {
        invoiceId: invoice.id,
        roomId: invoice.room_id,
        readingMonth,
      });
      const snapshotRows = result?.arrearsSnapshots ?? [];
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

      const reading = (result?.reading as MeterReadingRow | null) ?? null;
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

      // Previously omitted carry-forward, so editing a meter reading silently
      // erased a tenant's carried debt from the bill.
      const total = computeInvoiceTotal({
        rent: toNumber(next.rent_amount),
        water: nextWaterBill,
        electricity: nextElectricityBill,
        commonFee: toNumber(next.common_fee),
        nativeLateFee: calculateCurrentFormLateFee(next),
        lateFeeItems: feeItemsTotal(editableLateFeeItems),
        fees: feeItemsTotal(editableFeeItems),
        carryForward: feeItemsTotal(editableCarryForwardItems),
        discount: feeItemsTotal(editableDiscountItems),
      });

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
      const nextCarry = feeItemsTotal(editableCarryForwardItems);
      const nativeLateFee = calculateCurrentFormLateFee(next);
      const nextLateFee = nativeLateFee + nextLateFeeItems;
      const total = computeInvoiceTotal({
        rent: computedRent,
        water: toNumber(next.water_bill),
        electricity: toNumber(next.electricity_bill),
        commonFee: toNumber(next.common_fee),
        nativeLateFee,
        lateFeeItems: nextLateFeeItems,
        fees: nextAdditional,
        carryForward: nextCarry,
        discount: nextDiscount,
      });
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
    // Moved server-side (finding C1) — see get_transfer_recalc_data in
    // app/api/admin/invoices/actions/route.ts.
    const recalcResult = await callInvoiceAdminAction("get_transfer_recalc_data", {
      roomId: activeInvoice.room_id,
      billingMonth,
      transferDate,
    }).catch((err: any) => {
      setError(err?.message ?? "Failed to load transfer data.");
      return null;
    });
    if (!recalcResult) return;

    const transferRow = recalcResult.transferRow as
      | {
          from_room_id: string;
          to_room_id: string;
          transfer_date: string;
          old_electric_usage?: number;
          old_water_usage?: number;
          new_prev_electricity?: number;
          new_prev_water?: number;
        }
      | null;
    if (!transferRow) {
      setError("ไม่พบข้อมูลย้ายห้องของงวดนี้สำหรับคำนวณใหม่");
      return;
    }

    const roomRows = recalcResult.roomRows ?? [];
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

    // Current meter reading for the new room, to compute new-room units —
    // fetched server-side above, as part of get_transfer_recalc_data.
    const reading = (recalcResult.reading ?? null) as any;

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
    const newElecBill = newElecUnits * electricityRate;
    const waterBreakdownItems = buildTransferWaterBreakdown(
      oldWaterUnits,
      newWaterUnits,
      waterRate,
      waterMinUnits,
      waterMinPrice
    );

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
      ...waterBreakdownItems,
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
      // Nothing tracked to look up — leave existing items alone rather than
      // wiping them. This used to clear the arrays unconditionally, which
      // also destroyed manually-typed items (no source_invoice_id, so they
      // never affected `sourceIds` either way) any time no carried source
      // happened to be tracked.
      return;
    }

    setSaving(true);
    try {
      const valuationDate = activeInvoice.issue_date || activeInvoice.start_date;
      // Moved server-side (finding C1) — see get_carry_forward_candidates
      // in app/api/admin/invoices/actions/route.ts.
      const carryForwardResult = await callInvoiceAdminAction("get_carry_forward_candidates", {
        tenantId: activeInvoice.tenant_id,
        beforeStartDate: activeInvoice.start_date,
        targetInvoiceId: activeInvoice.id,
        valuationDate,
      });
      const candidates = carryForwardResult?.candidates ?? [];

      const filteredCandidates = candidates.filter((c: any) =>
        sourceInvoiceIds.includes(String(c.id)),
      );

      const nextCarryItems: CarryForwardItem[] = [];
      const nextLateFeeItems: LateFeeLineItem[] = [];

      for (const row of filteredCandidates) {
        const outstanding = row.outstanding_amount;
        if (outstanding > 0) {
          nextCarryItems.push({
            detail: `ยอดค้างชำระงวด ${formatPeriodLabel(String(row.start_date ?? ""))}`,
            unit: 1,
            price_per_unit: outstanding,
            total_amount: outstanding,
            source_invoice_id: String(row.id),
          });
        }

        const snapshotLateFee = toNumber(row.late_fee_snapshot_amount);
        if (snapshotLateFee > 0) {
          const daysOverdue = toNumber(row.late_fee_snapshot_days);
          const dailyRate = toNumber(row.late_fee_per_day);
          // A still-open source's window genuinely runs through today's
          // recalculation date. A PAID source's window is fixed at whatever
          // was actually frozen — `late_fee_snapshot_as_of` (derived from the
          // frozen amount and day count) reflects that true end date, which
          // can be well before `valuationDate` if the recalculation happens
          // later than the payment did.
          const windowAsOf = row.late_fee_snapshot_as_of ?? valuationDate;
          nextLateFeeItems.push({
            detail: buildLateFeeLineDetail(String(row.start_date ?? ""), daysOverdue, dailyRate, windowAsOf),
            unit: daysOverdue,
            price_per_unit: dailyRate,
            total_amount: snapshotLateFee,
            source_invoice_id: String(row.id),
            days_overdue: daysOverdue,
            daily_rate: dailyRate,
            snapshot_as_of: windowAsOf,
            original_amount: snapshotLateFee,
            waived_amount: 0,
          });
        }
      }

      // Preserve anything recalculate has no fresh data for: a manually-typed
      // item (no source_invoice_id), or one whose source invoice is no
      // longer offered as a candidate at all — which, per
      // getCarryForwardCandidatesForTarget, is every source whose late fee
      // is already billed elsewhere. Recalculate should only ever ADD or
      // REFRESH a still-eligible source, never silently delete something
      // that's already correctly on this invoice (this used to drop an
      // already-billed carried-in late fee the instant anyone recalculated).
      const candidateIds = new Set(filteredCandidates.map((c: any) => String(c.id)));

      const preservedCarryItems = carry.filter(
        (item) => !item.source_invoice_id || !candidateIds.has(item.source_invoice_id),
      );
      setEditableCarryForwardItems([...nextCarryItems, ...preservedCarryItems]);

      const preservedLateFeeItems = late.filter(
        (item) => !item.source_invoice_id || !candidateIds.has(item.source_invoice_id),
      );
      setEditableLateFeeItems([...nextLateFeeItems, ...preservedLateFeeItems]);

      setForm((prev) => {
        const nextLateFee = calculateCurrentFormLateFee(prev);
        const nextAdditional = feeItemsTotal(editableFeeItems);
        const nextDiscount = feeItemsTotal(editableDiscountItems);
        const nextCarry = feeItemsTotal(nextCarryItems);
        const total = computeInvoiceTotal({
          rent: toNumber(prev.rent_amount),
          water: toNumber(prev.water_bill),
          electricity: toNumber(prev.electricity_bill),
          commonFee: toNumber(prev.common_fee),
          // `nextLateFee` here is already own penalty + carried lines, so it
          // is passed whole and the line component left at zero.
          nativeLateFee: nextLateFee,
          lateFeeItems: 0,
          fees: nextAdditional,
          carryForward: nextCarry,
          discount: nextDiscount,
        });
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
      // Previously omitted carry-forward and carried late-fee lines, so
      // toggling proration wiped both out of the total.
      const total = computeInvoiceTotal({
        rent: nextRent,
        water: toNumber(prev.water_bill),
        electricity: toNumber(prev.electricity_bill),
        commonFee: toNumber(prev.common_fee),
        nativeLateFee: nextLateFee,
        lateFeeItems: feeItemsTotal(editableLateFeeItems),
        fees: nextAdditional,
        carryForward: feeItemsTotal(editableCarryForwardItems),
        discount: nextDiscount,
      });
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
        const total = computeInvoiceTotal({
          rent: toNumber(formPrev.rent_amount),
          water: toNumber(formPrev.water_bill),
          electricity: toNumber(formPrev.electricity_bill),
          commonFee: toNumber(formPrev.common_fee),
          // `nextLateFee` is already own penalty + carried lines, so it's
          // passed whole and the line component left at zero — same
          // convention as the neighbouring recalculate flow above.
          nativeLateFee: nextLateFee,
          lateFeeItems: 0,
          fees: nextAdditional,
          carryForward: feeItemsTotal(editableCarryForwardItems),
          discount: nextDiscount,
        });
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
        const total = computeInvoiceTotal({
          rent: toNumber(formPrev.rent_amount),
          water: toNumber(formPrev.water_bill),
          electricity: toNumber(formPrev.electricity_bill),
          commonFee: toNumber(formPrev.common_fee),
          // `nextLateFee` is already own penalty + carried lines, so it's
          // passed whole and the line component left at zero — same
          // convention as the neighbouring recalculate flow above.
          nativeLateFee: nextLateFee,
          lateFeeItems: 0,
          fees: nextAdditional,
          carryForward: feeItemsTotal(editableCarryForwardItems),
          discount: nextDiscount,
        });
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

    // One total, used for both the stored amount and the paid_amount cap.
    const savedTotal = computeInvoiceTotal({
      rent: toNumber(form.rent_amount),
      water: toNumber(form.water_bill),
      electricity: toNumber(form.electricity_bill),
      commonFee: toNumber(form.common_fee),
      // `form.late_fee_amount` is already own penalty + carried lines, so it is
      // passed whole with the line component at zero — the engine must never be
      // handed the same figure twice.
      nativeLateFee: toNumber(form.late_fee_amount),
      lateFeeItems: 0,
      fees: feeItemsTotal(editableFeeItems),
      carryForward: feeItemsTotal(editableCarryForwardItems),
      discount: feeItemsTotal(editableDiscountItems),
    });

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
        // Preserve origin tag ("rule" / "rewards_redemption") so an
        // unrelated edit elsewhere on this invoice doesn't erase it — the
        // monthly rule resync and points redemption both rely on it to know
        // which lines are theirs to touch.
        ...(item.source ? { source: item.source } : {}),
      })),
      late_fee_amount: toNumber(form.late_fee_amount),
      late_fee_per_day: toNumber(form.late_fee_per_day),
      late_fee_start_date: form.late_fee_start_date || null,
      waived_late_fee_amount: toNumber(form.waived_late_fee_amount),
      carry_forward_amount: feeItemsTotal(editableCarryForwardItems),
      additional_fees_total: feeItemsTotal(editableFeeItems) + feeItemsTotal(editableLateFeeItems),
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
      total_amount: savedTotal,
      // Capped by the SAME total, not a second hand-rolled copy of it. The old
      // cap added `form.late_fee_amount` (already own penalty + carried lines)
      // and then the carried lines a second time, so it sat one late fee above
      // the real total and could let paid_amount exceed what was owed.
      paid_amount: Math.min(toNumber(form.paid_amount), savedTotal),
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
    toast.success("บันทึกข้อมูลใบแจ้งหนี้เรียบร้อยแล้ว");
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
    // Moved server-side (finding C1) — see get_invoice_reading_and_arrears
    // in app/api/admin/invoices/actions/route.ts (same action the
    // detail-modal hydration above uses).
    const readingMonth = monthStartFromDate(
      invoice.start_date || invoice.issue_date,
    );
    const result = await callInvoiceAdminAction("get_invoice_reading_and_arrears", {
      invoiceId: invoice.id,
      roomId: invoice.room_id,
      readingMonth,
    }).catch(() => null);
    const snapshotRows = result?.arrearsSnapshots ?? [];
    setPreviewReading((result?.reading as MeterReadingRow) ?? null);
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
    const elecUnits = resolveElectricityUsageForDisplay(reading, toNumber(invoice.electricity_bill), elecRate);
    const waterUnits = resolveWaterUsageForDisplay(reading, toNumber(invoice.water_bill), waterRate);
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
                    <td>ค่าปรับล่าช้า - บิล ${shortInvoiceId(row.source_invoice_id)}${(() => {
                      const window = formatLateFeeWindow(row.snapshot_as_of, row.days_overdue);
                      return window ? ` (${window})` : ` (คำนวณถึง ${formatDateThai(row.snapshot_as_of)})`;
                    })()}</td>
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
                const utilityKinds = ["old_water", "new_water", "old_elec", "new_elec", "water_min_adjustment"];
                const utilityTransferItems = transferRows.filter((r) => utilityKinds.includes(r.kind ?? ""));
                if (utilityTransferItems.length > 0) {
                  // Per-room utility breakdown for mid-month transfer
                  const order = ["old_water", "old_elec", "new_water", "new_elec", "water_min_adjustment"];
                  return order.map((kind) => {
                    const item = utilityTransferItems.find((r) => r.kind === kind);
                    if (!item || toNumber(item.amount) == null) return "";
                    const amt = toNumber(item.amount ?? 0);
                    const match = item.label.match(/\((\d+)\s*หน่วย\)/);
                    const units = match ? parseInt(match[1], 10) : 0;
                    const rate = units > 0 ? amt / units : 0;
                    const rowColor =
                      kind === "water_min_adjustment"
                        ? "#fffbeb"
                        : kind.startsWith("old_")
                          ? "#f0f9ff"
                          : "#f0fdf4";
                    return `<tr style="background:${rowColor}">
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
    if (!win) {
      setError("เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปสำหรับเว็บไซต์นี้แล้วลองอีกครั้ง");
      return;
    }
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

    // Moved server-side (finding C1) — this used to run entirely in the
    // browser with the anon key: reading rooms/tenants/settings/meter
    // readings, computing every invoice's proration/late-fee/discount, and
    // inserting the result, all with no permission check tied to the writes
    // themselves. Every computation is unchanged, just relocated — see
    // generate_invoices in app/api/admin/invoices/actions/route.ts.
    try {
      const result = await callInvoiceAdminAction("generate_invoices", { year, month });

      const alerts: string[] = Array.isArray(result?.alerts) ? result.alerts : [];
      const bookkeepingFailures: string[] = Array.isArray(result?.bookkeepingFailures)
        ? result.bookkeepingFailures
        : [];

      if (bookkeepingFailures.length > 0) {
        toast.error(bookkeepingFailures.join(" | "), { duration: 15000 });
      }
      if (result?.errorMessage) {
        setError(String(result.errorMessage));
      }
      if (result?.carryForwardNotice) {
        toast.info(
          `${result.carryForwardNotice.tenantCount} ผู้เช่ายังมีใบแจ้งหนี้ค้างชำระจากงวดก่อนหน้า รวม ${formatMoney(
            result.carryForwardNotice.pendingTotal,
          )} บาท`,
          { duration: 10000 },
        );
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to generate invoices.");
    } finally {
      setSaving(false);
      setConfirmGenerateOpen(false);
      await loadInvoices();
    }
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

    const transferUtilityKinds = ["old_water", "new_water", "old_elec", "new_elec", "water_min_adjustment"];
    const transferUtilityItems = transferBreakdownItems.filter(
      (item) => transferUtilityKinds.includes(item.kind ?? ""),
    );
    const hasTransferUtilityBreakdown = transferUtilityItems.length > 0;

    if (hasTransferUtilityBreakdown) {
      // Render per-room utility rows from the stored transfer breakdown
      const utilityOrder = ["old_water", "old_elec", "new_water", "new_elec", "water_min_adjustment"];
      const toneByKind: Record<string, string> = {
        old_water: "sky", old_elec: "sky", new_water: "sky", new_elec: "sky",
        water_min_adjustment: "amber",
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
      const total = computeInvoiceTotal({
        rent: toNumber(prev.rent_amount),
        water: toNumber(prev.water_bill),
        electricity: toNumber(prev.electricity_bill),
        commonFee: toNumber(prev.common_fee),
        nativeLateFee,
        lateFeeItems: nextLateFeeItems,
        fees: nextAdditional,
        carryForward: nextCarry,
        discount: nextDiscount,
      });
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
      const total = computeInvoiceTotal({
        rent: transferRentTotal,
        water: toNumber(prev.water_bill),
        electricity: toNumber(prev.electricity_bill),
        commonFee: toNumber(prev.common_fee),
        nativeLateFee,
        lateFeeItems: nextLateFeeItems,
        fees: nextAdditional,
        carryForward: nextCarry,
        discount: nextDiscount,
      });
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
    showSplitPaymentModal,
    splitPaymentInvoices,
    splitPaymentAmounts,
    splitPaymentLoading,
    splitPaymentSubmitting,
    openSplitPaymentModal,
    closeSplitPaymentModal,
    updateSplitPaymentAmount,
    submitSplitPayment,
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
    declineModalOpen,
    setDeclineModalOpen,
    declineReason,
    setDeclineReason,
    declineSubmitting,
    declineSlip,
    openInvoice,
    updateUtilityUnits,
    updateForm,
    updateCarryForwardItem,
    updateLateFeeItem,
    updateTransferBreakdownAmount,
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
