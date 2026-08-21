"use client";
import React from "react";

import { Modal } from "@/components/ui/Modal";
import { buttonClasses } from "@/components/ui/Button";
import { useInvoiceContext } from "./InvoiceContext";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import {
  Loader2,
  Plus,
  Printer,
  Save,
  Search,
  Trash2,
  UploadCloud,
  Mail,
  CheckCircle2,
  FileText,
  MailOpen,
  AlertCircle,
  Send,
  RefreshCw,
} from "lucide-react";
import { formatMoney, toLocalDateString, toNumber } from "@/lib/format";
import {
  isInvoiceDetailEditable,
  formatPeriodLabel,
  formatDateThai,
  shortInvoiceId,
  statusLabelThai,
  feeItemsTotal,
  invoiceDisplayOutstanding,
  statusVariant,
  statusPillClass,
  emptyLateFeeItem,
  emptyCarryForwardItem,
  emptyFeeItem,
  calculateProratedRentByBillingDay,
  calculateLateFeePreview,
  paymentMethodSnapshotLabel,
  UNKNOWN_PAYMENT_METHOD,
  paymentSourceLabel,
  isNonCashPaymentSource,
} from "@/lib/invoice-utils";

export function InvoiceDetailModal() {
  const {
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
    setDeclineModalOpen,
    declineSubmitting,
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
  } = useInvoiceContext();

  const modalProrateSummary = React.useMemo(() => {
    if (!activeInvoice || !activeInvoice.tenant_move_in_date || !printSettings)
      return null;
    return calculateProratedRentByBillingDay(
      activeInvoice.room_price_month,

      activeInvoice.tenant_move_in_date,
      printSettings.billing_day || 1,
    );
  }, [activeInvoice, printSettings]);

  const [activeTab, setActiveTab] = React.useState('preview');

  // ── Payment chain ─────────────────────────────────────────────────────────
  // A payment is recorded against ONE invoice but settles a whole carry-forward
  // chain oldest-first, so this invoice's own `payment_history` slice ("฿2,000
  // on 12 Aug") is meaningless on its own — it looks like a partial payment even
  // when the tenant paid in full. `invoice_payment_allocations` has always held
  // the real split; nothing had ever read it. This loads the full batch behind
  // every payment that touched this invoice.
  type ChainLine = {
    id: string;
    invoiceId: string;
    amount: number;
    period: string;
    /** Raw start_date — the label is "MM/YYYY" and sorts wrong. */
    periodSortKey: string;
    roomNumber: string;
    isThisInvoice: boolean;
  };
  type PaymentChain = {
    batchId: string;
    paidAt: string | null;
    amountReceived: number;
    methodLabel: string;
    slipUrl: string | null;
    triggerInvoiceId: string | null;
    /** payment_batches.source — where this money came from. */
    source: string | null;
    appliedHere: number;
    lines: ChainLine[];
  };
  const [paymentChains, setPaymentChains] = React.useState<PaymentChain[]>([]);
  const [chainsLoading, setChainsLoading] = React.useState(false);
  const [chainReloadToken, setChainReloadToken] = React.useState(0);
  const [deletingBatchId, setDeletingBatchId] = React.useState<string | null>(null);

  // Old payments recorded before payment_method_snapshot existed have no
  // recoverable account — the admin is the only remaining source of truth if
  // they happen to know (e.g. from an old bank statement) which account a
  // specific transfer landed in. This lets them attach it after the fact.
  const [assignableMethods, setAssignableMethods] = React.useState<
    { id: string; label: string; bank_name: string; account_name: string; account_number: string }[]
  >([]);
  const [assigningBatchId, setAssigningBatchId] = React.useState<string | null>(null);
  const [assignSelection, setAssignSelection] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!detailOpen) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("payment_methods")
        .select("id,label,bank_name,account_name,account_number")
        .order("label", { ascending: true });
      if (!cancelled) setAssignableMethods((data ?? []) as any[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [detailOpen, supabase]);

  const assignPaymentBatchMethod = async (paymentBatchId: string) => {
    const methodId = assignSelection[paymentBatchId];
    if (!methodId) return;
    setAssigningBatchId(paymentBatchId);
    try {
      await callInvoiceAdminAction("assign_payment_batch_method", {
        paymentBatchId,
        methodId,
      });
      // Re-derive the label locally instead of a full reload — the batch and
      // every allocation sharing it just got the same snapshot.
      const chosen = assignableMethods.find((m) => m.id === methodId);
      const label = chosen?.label || chosen?.bank_name || null;
      if (label) {
        setPaymentChains((prev) =>
          prev.map((chain) =>
            chain.batchId === paymentBatchId
              ? { ...chain, methodLabel: label }
              : chain,
          ),
        );
      }
    } catch (err: any) {
      setError(err?.message ?? "ไม่สามารถบันทึกบัญชีที่รับเงินได้");
    } finally {
      setAssigningBatchId(null);
    }
  };

  const activeInvoiceId = activeInvoice?.id ? String(activeInvoice.id) : "";

  React.useEffect(() => {
    if (!activeInvoiceId || activeTab !== "payments") {
      return;
    }
    let cancelled = false;

    const loadChains = async () => {
      setChainsLoading(true);
      // Which payments touched this invoice…
      const { data: mine } = await supabase
        .from("invoice_payment_allocations")
        .select("payment_batch_id")
        .eq("invoice_id", activeInvoiceId);
      const batchIds = [
        ...new Set(
          (mine ?? [])
            .map((row: any) => String(row.payment_batch_id ?? ""))
            .filter(Boolean),
        ),
      ];
      if (cancelled) return;
      if (batchIds.length === 0) {
        setPaymentChains([]);
        setChainsLoading(false);
        return;
      }

      // …and everything else those same payments were split across. The FK hint
      // is required — invoice_payment_allocations has two foreign keys to
      // invoices (invoice_id and trigger_invoice_id), so a bare embed is
      // ambiguous.
      const [allocationsRes, batchesRes] = await Promise.all([
        supabase
          .from("invoice_payment_allocations")
          .select(
            "id,payment_batch_id,invoice_id,amount,paid_at,slip_url,payment_method_snapshot," +
              "invoice:invoices!invoice_payment_allocations_invoice_id_fkey(id,start_date,rooms(room_number))",
          )
          .in("payment_batch_id", batchIds),
        supabase
          .from("payment_batches")
          .select("id,amount_received,paid_at,slip_url,source,trigger_invoice_id,payment_method_snapshot")
          .in("id", batchIds),
      ]);
      if (cancelled) return;

      const batchById = new Map(
        (batchesRes.data ?? []).map((row: any) => [String(row.id), row]),
      );
      const grouped = new Map<string, PaymentChain>();

      for (const row of allocationsRes.data ?? []) {
        const batchId = String((row as any).payment_batch_id ?? "");
        if (!batchId) continue;
        const batch = batchById.get(batchId) as any;
        const invoice = Array.isArray((row as any).invoice)
          ? (row as any).invoice[0]
          : (row as any).invoice;
        const room = Array.isArray(invoice?.rooms) ? invoice.rooms[0] : invoice?.rooms;

        const chain =
          grouped.get(batchId) ??
          ({
            batchId,
            paidAt: batch?.paid_at ?? (row as any).paid_at ?? null,
            // Fall back to summing the slices for legacy batches.
            amountReceived: toNumber(batch?.amount_received),
            methodLabel: paymentMethodSnapshotLabel(
              batch?.payment_method_snapshot ?? (row as any).payment_method_snapshot,
            ),
            slipUrl: batch?.slip_url ?? (row as any).slip_url ?? null,
            triggerInvoiceId: batch?.trigger_invoice_id
              ? String(batch.trigger_invoice_id)
              : null,
            source: batch?.source ?? (row as any).source ?? null,
            appliedHere: 0,
            lines: [],
          } as PaymentChain);

        const invoiceId = String((row as any).invoice_id ?? "");
        const amount = toNumber((row as any).amount);
        const isThisInvoice = invoiceId === activeInvoiceId;
        if (isThisInvoice) chain.appliedHere += amount;
        chain.lines.push({
          id: String((row as any).id),
          invoiceId,
          amount,
          period: formatPeriodLabel(invoice?.start_date),
          periodSortKey: String(invoice?.start_date ?? ""),
          roomNumber: room?.room_number ?? "-",
          isThisInvoice,
        });
        grouped.set(batchId, chain);
      }

      const chains = [...grouped.values()].map((chain) => ({
        ...chain,
        amountReceived:
          chain.amountReceived > 0
            ? chain.amountReceived
            : chain.lines.reduce((sum, line) => sum + line.amount, 0),
        lines: chain.lines.sort((a, b) =>
          a.periodSortKey.localeCompare(b.periodSortKey),
        ),
      }));
      chains.sort(
        (a, b) =>
          new Date(b.paidAt ?? 0).getTime() - new Date(a.paidAt ?? 0).getTime(),
      );

      setPaymentChains(chains);
      setChainsLoading(false);
    };

    void loadChains();
    return () => {
      cancelled = true;
    };
    // activeInvoice.payment_history is in the deps so the chain refreshes right
    // after a payment is recorded or cancelled. chainReloadToken is bumped
    // after a manual batch delete to force a refetch without needing
    // activeInvoice's own fields to have changed.
  }, [
    activeInvoiceId,
    activeTab,
    supabase,
    activeInvoice?.payment_history,
    chainReloadToken,
  ]);

  const deletePaymentBatch = async (batchId: string) => {
    const confirmed = window.confirm(
      "ยืนยันการลบรายการชำระเงินนี้?\n\nการลบนี้จะลบรายการออกจากทุกใบแจ้งหนี้ที่เงินก้อนนี้ถูกแบ่งไปชำระ และไม่สามารถย้อนกลับได้ผ่านหน้านี้",
    );
    if (!confirmed) return;
    setDeletingBatchId(batchId);
    try {
      const result = await callInvoiceAdminAction("delete_payment_batch", {
        paymentBatchId: batchId,
      });
      const mismatches = Array.isArray(result?.mismatches) ? result.mismatches : [];
      if (mismatches.length > 0) {
        const isSelf = mismatches.some(
          (m: any) => String(m.invoiceId) === activeInvoiceId,
        );
        setError(
          (isSelf
            ? "ลบรายการชำระเงินแล้ว แต่ยอดที่ชำระของใบแจ้งหนี้นี้ยังไม่ตรงกับรายการที่เหลืออยู่ กรุณาตรวจสอบและแก้ไขยอดในแท็บรายละเอียด"
            : "ลบรายการชำระเงินแล้ว แต่มีใบแจ้งหนี้อื่นที่เงินก้อนนี้เคยตัดชำระ ซึ่งยอดที่ชำระอาจไม่ตรงกับรายการที่เหลืออยู่ กรุณาตรวจสอบใบแจ้งหนี้ที่เกี่ยวข้อง") +
            ` (${mismatches.length} ใบ)`,
        );
      }
      setChainReloadToken((n) => n + 1);
    } catch (err: any) {
      setError(err?.message ?? "ไม่สามารถลบรายการชำระเงินได้");
    } finally {
      setDeletingBatchId(null);
    }
  };

  const TABS = [
    { id: 'preview', label: 'ภาพรวม', icon: <FileText size={18} /> },
    { id: 'meters', label: 'มิเตอร์และค่าเช่า', icon: <CheckCircle2 size={18} /> },
    { id: 'fees', label: 'ค่าปรับและอื่นๆ', icon: <AlertCircle size={18} /> },
    { id: 'payments', label: 'การชำระเงิน', icon: <CheckCircle2 size={18} /> },
  ];

  return (
    <Modal
      isOpen={detailOpen}
      onClose={() => setDetailOpen(false)}
      title={
        activeInvoice
          ? `ใบแจ้งหนี้ ${shortInvoiceId(activeInvoice.id)}`
          : "รายละเอียดใบแจ้งหนี้"
      }
      size="4xl"
    >
      {activeInvoice && (
        <div className="flex flex-col lg:flex-row h-full max-h-[85vh] bg-white overflow-hidden rounded-control">
          {/* SIDEBAR */}
          <div className="w-full shrink-0 flex-col border-r border-slate-200 bg-slate-50 lg:w-[260px] flex">
            <div className="p-5 border-b border-slate-200">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Invoice
              </p>
              <h2 className="mt-1 text-2xl font-bold text-slate-900">
                ห้อง {activeInvoice.room_number}
              </h2>
              <div className="mt-2">
                <select
                  value={form.status}
                  onChange={(event) => {
                    const nextStatus = event.target.value as keyof typeof statusVariant;
                    setForm((prev) => ({ ...prev, status: nextStatus }));
                    void updateInvoiceStatus(activeInvoice.id, nextStatus);
                  }}
                  disabled={!canUpdateInvoiceStatus}
                  title={!canUpdateInvoiceStatus ? "ไม่มีสิทธิ์เปลี่ยนสถานะใบแจ้งหนี้" : undefined}
                  className={`w-full rounded-control border border-slate-200 px-3 py-2 text-sm font-bold capitalize transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-70 ${statusPillClass(form.status)}`}
                >
                  {Object.keys(statusVariant).map((status) => (
                    <option key={status} value={status}>
                      {statusLabelThai(status)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            
            <nav className="flex-1 overflow-y-auto p-4 space-y-2">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center gap-3 rounded-control px-4 py-3 text-sm font-semibold transition-all ${
                      isActive
                        ? "bg-primary-600 text-white shadow-float-md"
                        : "text-slate-600 hover:bg-white hover:shadow-sm border border-transparent hover:border-slate-200"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                );
              })}
            </nav>

            <div className="border-t border-slate-200 p-5 bg-white space-y-4">
              <div>
                <div className="flex justify-between text-sm text-slate-500">
                  <span>ยอดรวม</span>
                  <span className="font-semibold text-slate-900">{formatMoney(form.total_amount)}</span>
                </div>
                <div className="flex justify-between text-sm text-success-600 mt-1.5">
                  <span>ชำระแล้ว</span>
                  <span className="font-semibold">{formatMoney(toNumber(form.paid_amount))}</span>
                </div>
                <div className="flex justify-between text-base text-danger-600 mt-3 font-bold border-t border-slate-100 pt-3">
                  <span>คงเหลือ</span>
                  <span>
                    {formatMoney(
                      invoiceDisplayOutstanding({
                        total_amount: form.total_amount,
                        paid_amount: toNumber(form.paid_amount),
                      })
                    )}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setConfirmSaveOpen(true)}
                disabled={!(canEditDetails && canEditInvoice)}
                className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
              >
                <Save size={18} /> บันทึกใบแจ้งหนี้
              </button>
            </div>
          </div>

          {/* MAIN CONTENT AREA */}
          <div className="flex-1 bg-slate-50/50 overflow-y-auto relative p-6 lg:p-8">
            
            {/* TAB: PREVIEW */}
            {activeTab === 'preview' && (
              <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-2xl font-bold text-slate-900">ภาพรวมใบแจ้งหนี้</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setPreviewDocType("invoice");
                        setPreviewInvoice(activeInvoice);
                        setPreviewOpen(true);
                      }}
                      className={buttonClasses({ variant: "secondary" })}
                    >
                      <Printer size={16} /> พิมพ์ใบแจ้งหนี้
                    </button>
                    <button
                      onClick={() => {
                        setPreviewDocType("receipt");
                        setPreviewInvoice(activeInvoice);
                        setPreviewOpen(true);
                      }}
                      className={buttonClasses({ variant: "secondary" })}
                    >
                      <Printer size={16} /> พิมพ์ใบเสร็จ
                    </button>
                    <button
                      onClick={() => sendToLine(activeInvoice)}
                      className="flex items-center gap-2 rounded-control bg-[#06C755] px-4 py-2 text-sm font-semibold text-white hover:bg-[#05b34c] transition-colors shadow-sm"
                    >
                      <Send size={16} /> ส่ง LINE
                    </button>
                    <button
                      onClick={() => {
                        setDeleteTargetIds([activeInvoice.id]);
                        setConfirmDeleteOpen(true);
                      }}
                      disabled={!canDeleteInvoice}
                      title={!canDeleteInvoice ? "ไม่มีสิทธิ์ลบใบแจ้งหนี้" : undefined}
                      className="flex items-center gap-2 rounded-control border border-danger-200 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-600 hover:bg-danger-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 size={16} /> ลบ
                    </button>
                  </div>
                </div>

                {(!canEditInvoice || !canUpdateInvoiceStatus || !canRecordInvoicePayment) && (
                  <div className="rounded-card border border-danger-200 bg-danger-50 p-4 text-sm text-danger-700 flex gap-3">
                    <AlertCircle className="shrink-0" size={20} />
                    <span>บางส่วนถูกล็อกตามสิทธิ์ของผู้ใช้ (ปุ่มที่ล็อกจะแสดงเคอร์เซอร์ห้ามใช้งาน)</span>
                  </div>
                )}
                {!isInvoiceDetailEditable(activeInvoice.status) && (
                  <div className="rounded-card border border-warning-200 bg-warning-50 p-4 text-sm text-warning-800 flex gap-3">
                    <AlertCircle className="shrink-0" size={20} />
                    <span>ปิดการแก้ไขรายละเอียดสำหรับสถานะ <b>{statusLabelThai(activeInvoice.status)}</b> หากต้องการแก้ไข ให้เปลี่ยนสถานะเป็น <b>ฉบับร่าง</b></span>
                  </div>
                )}
                {activeInvoice.status === "verifying" && (
                  <div className="rounded-card border border-primary-200 bg-primary-50 p-4 text-sm text-primary-800 flex gap-3 items-center">
                    <AlertCircle className="shrink-0 text-primary-600" size={20} />
                    <div className="flex-1">
                      <b className="block text-primary-900 mb-0.5">รอตรวจสอบการชำระเงิน</b>
                      <span>ผู้เช่าได้อัปโหลดหลักฐานการโอนเงินแล้ว กรุณาไปที่แท็บ <button onClick={() => setActiveTab('payments')} className="underline font-bold hover:text-primary-600">ประวัติการชำระเงิน</button> เพื่อตรวจสอบสลิปและยืนยัน</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDeclineModalOpen(true)}
                      disabled={!canRecordInvoicePayment || declineSubmitting}
                      className={buttonClasses({ variant: "danger", size: "sm", className: "shrink-0" })}
                    >
                      ปฏิเสธสลิป
                    </button>
                  </div>
                )}

                {Array.isArray(activeInvoice.slip_rejections) && activeInvoice.slip_rejections.length > 0 && (
                  <div className="rounded-card border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
                    <div className="flex gap-3">
                      <AlertCircle className="shrink-0 text-danger-600" size={20} />
                      <div className="flex-1 space-y-2">
                        <b className="block text-danger-900">
                          เคยปฏิเสธสลิป {activeInvoice.slip_rejections.length} ครั้ง
                        </b>
                        {activeInvoice.slip_rejections
                          .slice()
                          .reverse()
                          .map((rejection: any, idx: number) => (
                            <div key={idx} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-xs font-semibold text-danger-700">
                                {rejection?.rejected_at ? formatDateThai(rejection.rejected_at) : "-"}
                              </span>
                              <span className="text-xs text-danger-800">{rejection?.reason ?? "-"}</span>
                              {rejection?.slip_url && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSlipModalTitle("สลิปที่ถูกปฏิเสธ");
                                    setSlipModalUrl(rejection.slip_url);
                                    setSlipModalOpen(true);
                                  }}
                                  className="text-xs font-bold text-danger-600 underline hover:text-danger-800"
                                >
                                  ดูสลิปเดิม
                                </button>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* THE LIVE PREVIEW CARD */}
                <div className="overflow-hidden rounded-panel border border-slate-200 shadow-float-lg bg-white mt-8">
                  <div className="border-b border-slate-200 bg-slate-50/50 px-6 py-4 flex justify-between items-center">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-slate-400 font-semibold">Live Preview</p>
                      <h4 className="font-bold text-slate-900 mt-1">หน้าตาฝั่งผู้เช่า</h4>
                    </div>
                  </div>
                  <div className="p-8 space-y-8 bg-white relative">
                    <div className="absolute top-0 right-0 p-8 opacity-5">
                      <FileText size={160} />
                    </div>
                    {/* Header */}
                    <div className="flex justify-between items-start relative z-10">
                      <div>
                        <p className="text-sm font-bold text-primary-600 uppercase tracking-widest">
                          {form.status === "paid" ? "RECEIPT" : "INVOICE"}
                        </p>
                        <h1 className="text-5xl font-black text-slate-900 mt-2">Room {activeInvoice.room_number}</h1>
                        <p className="text-sm font-semibold text-slate-500 mt-3">
                          รอบบิล: {form.start_date || "-"} ถึง {form.end_date || "-"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs uppercase tracking-widest text-slate-400 font-bold">ยอดรวมทั้งสิ้น</p>
                        <p className="text-5xl font-black text-success-600 mt-2 tracking-tighter">{formatMoney(toNumber(form.total_amount))}</p>
                        <button
                          type="button"
                          onClick={applyRoundDownTotal}
                          disabled={!canEditDetails || saving}
                          className="text-xs font-bold text-slate-500 hover:text-slate-800 underline mt-1 transition disabled:opacity-50"
                        >
                          ปัดเศษลง
                        </button>
                      </div>
                    </div>
                    
                    {/* Items */}
                    <div className="space-y-4 relative z-10">
                      {livePreviewRows.length === 0 ? (
                        <p className="text-sm text-slate-400 text-center py-8 font-medium">ยังไม่มีรายการแสดงในใบแจ้งหนี้</p>
                      ) : (
                        livePreviewRows.map((row, index) => (
                          <div
                            key={`${row.detail}-${index}`}
                            className={`flex items-center justify-between p-4 rounded-card transition-all hover:scale-[1.01] ${
                              row.tone === "amber"
                                ? "border border-warning-200 bg-warning-50 text-warning-900"
                                : row.tone === "sky"
                                  ? "border border-primary-200 bg-primary-50 text-primary-900"
                                  : "border border-slate-100 bg-slate-50 text-slate-800"
                            }`}
                          >
                            <span>
                              <span className="block font-bold text-base">{row.detail}</span>
                              <span className="block text-xs font-semibold mt-1 opacity-60">
                                {row.unitLabel} x {formatMoney(Math.abs(row.pricePerUnit))}
                              </span>
                            </span>
                            <span className={`font-black text-xl ${row.total < 0 ? "text-success-600" : ""}`}>
                              {row.total < 0 ? "-" : ""}
                              {formatMoney(Math.abs(row.total))}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: METERS */}
            {activeTab === 'meters' && (
              <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h3 className="text-2xl font-bold text-slate-900">มิเตอร์และค่าเช่า</h3>
                
                <fieldset
                  disabled={!(canEditDetails && canEditInvoice)}
                  className={`space-y-8 ${!(canEditDetails && canEditInvoice) ? "opacity-70" : ""}`}
                >
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-slate-700">วันที่ออกบิล</label>
                      <input
                        type="date"
                        value={form.issue_date}
                        onChange={(event) => updateForm("issue_date", event.target.value)}
                        className="w-full rounded-control border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm font-medium transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-slate-700">ครบกำหนดชำระ</label>
                      <input
                        type="date"
                        value={form.due_date}
                        onChange={(event) => updateForm("due_date", event.target.value)}
                        className="w-full rounded-control border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm font-medium transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                      />
                    </div>
                  </div>

                  <div className="rounded-panel border border-slate-200 bg-white p-6 shadow-sm space-y-6">
                    <div className="flex items-center justify-between">
                      <h4 className="text-lg font-bold text-slate-800">ค่าเช่าห้องพัก</h4>
                      <p className="text-3xl font-black tracking-tight text-primary-600">{formatMoney(form.rent_amount)}</p>
                    </div>

                    {modalProrateSummary && (
                      <div className="rounded-card border border-primary-200 bg-primary-50 p-5">
                        <label className="flex items-center gap-3 font-semibold text-primary-900 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useProrateInModal}
                            onChange={(e) => toggleProrateInModal(e.target.checked)}
                            className="w-5 h-5 rounded border-primary-300 text-primary-600 focus:ring-primary-600"
                          />
                          คิดค่าเช่าเฉลี่ยตามวัน (Prorate)
                        </label>
                        {useProrateInModal && (
                          <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-primary-800">
                            <div className="bg-white/50 p-4 rounded-card">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">วันที่เข้าพัก</span>
                              <span className="block mt-1 font-black text-lg">{activeInvoice.tenant_move_in_date ? formatDateThai(activeInvoice.tenant_move_in_date) : "-"}</span>
                            </div>
                            <div className="bg-white/50 p-4 rounded-card">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">วันตัดรอบบิล</span>
                              <span className="block mt-1 font-black text-lg">{printSettings?.billing_day || 1}</span>
                            </div>
                            <div className="bg-white/50 p-4 rounded-card">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">จำนวนวัน</span>
                              <span className="block mt-1 font-black text-lg">{modalProrateSummary.occupiedDays} / 30 วัน</span>
                            </div>
                            <div className="bg-primary-100 p-4 rounded-card shadow-sm">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-70">ค่าเช่าเฉลี่ย</span>
                              <span className="block mt-1 font-black text-2xl tracking-tighter">{formatMoney(modalProrateSummary.rentAmount)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid lg:grid-cols-2 gap-6">
                    {/* Electricity */}
                    <div className="rounded-panel border border-warning-200 bg-warning-50/50 p-6 space-y-5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-warning-900 flex items-center gap-2">
                          <AlertCircle size={20} className="text-warning-500" /> มิเตอร์ไฟฟ้า
                        </h4>
                        <p className="text-2xl font-black text-warning-700 tracking-tight">{formatMoney(form.electricity_bill)}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-warning-800 uppercase tracking-widest">หน่วยที่ใช้</label>
                          <input
                            type="number"
                            value={form.electricity_units}
                            onChange={(e) => updateUtilityUnits("electricity_units", e.target.value)}
                            className="w-full rounded-control border border-warning-200 bg-white px-4 py-3 text-sm text-right font-bold shadow-sm transition focus:border-warning-500 focus:ring-1 focus:ring-warning-500"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-warning-800 uppercase tracking-widest">ยอดรวม</label>
                          <input
                            type="number"
                            value={form.electricity_bill}
                            onChange={(e) => updateForm("electricity_bill", e.target.value)}
                            className="w-full rounded-control border border-warning-300 bg-white px-4 py-3 text-sm text-right font-black shadow-sm transition focus:border-warning-500 focus:ring-1 focus:ring-warning-500"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-warning-800 pt-3 border-t border-warning-200/50">
                        <span></span>
                        <span>เรท: {printSettings?.electricity_rate || 0}/หน่วย</span>
                      </div>
                    </div>

                    {/* Water */}
                    <div className="rounded-panel border border-primary-200 bg-primary-50/50 p-6 space-y-5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-primary-900 flex items-center gap-2">
                          <AlertCircle size={20} className="text-primary-500" /> มิเตอร์น้ำประปา
                        </h4>
                        <p className="text-2xl font-black text-primary-700 tracking-tight">{formatMoney(form.water_bill)}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-primary-800 uppercase tracking-widest">หน่วยที่ใช้</label>
                          <input
                            type="number"
                            value={form.water_units}
                            onChange={(e) => updateUtilityUnits("water_units", e.target.value)}
                            className="w-full rounded-control border border-primary-200 bg-white px-4 py-3 text-sm text-right font-bold shadow-sm transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-primary-800 uppercase tracking-widest">ยอดรวม</label>
                          <input
                            type="number"
                            value={form.water_bill}
                            onChange={(e) => updateForm("water_bill", e.target.value)}
                            className="w-full rounded-control border border-primary-300 bg-white px-4 py-3 text-sm text-right font-black shadow-sm transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-primary-800 pt-3 border-t border-primary-200/50">
                        <span></span>
                        <span>เรท: {printSettings?.water_rate || 0}/หน่วย</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">หมายเหตุใบแจ้งหนี้</label>
                    <textarea
                      value={form.notes}
                      onChange={(event) => updateForm("notes", event.target.value)}
                      className="w-full rounded-card border border-slate-200 bg-white px-5 py-4 text-sm font-medium shadow-sm transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                      rows={4}
                      placeholder="เขียนหมายเหตุเพิ่มเติมที่จะแสดงในบิล..."
                    />
                  </div>
                </fieldset>
              </div>
            )}

            {/* TAB: FEES */}
            {activeTab === 'fees' && (
              <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between items-center bg-white p-6 rounded-panel border border-slate-200 shadow-sm">
                  <h3 className="text-2xl font-bold text-slate-900">ค่าปรับและรายการอื่นๆ</h3>
                  <div className="text-right">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">ยอดรวมทั้งสิ้น (Grand Total)</p>
                    <p className="text-3xl font-black text-success-600 tracking-tighter">{formatMoney(form.total_amount)}</p>
                  </div>
                </div>
                
                <fieldset disabled={!(canEditDetails && canEditInvoice)} className={!(canEditDetails && canEditInvoice) ? "opacity-70" : ""}>
                  
                  {/* Carry Forwards */}
                  <div className="rounded-panel border border-warning-200 bg-white shadow-sm overflow-hidden">
                    <div className="bg-warning-50 px-6 py-5 border-b border-warning-200 flex justify-between items-center">
                      <h4 className="font-bold text-warning-900">ยอดยกมา (ค้างชำระ)</h4>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => recalculateCurrentInvoiceArrears()}
                          className={buttonClasses({ variant: "subtle", size: "sm" })}
                        >
                          <RefreshCw size={14} />
                          คำนวณใหม่
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditableCarryForwardItems((prev) => [...prev, emptyCarryForwardItem()])}
                          className="text-xs font-bold text-warning-700 bg-warning-100 px-4 py-2 rounded-control transition hover:bg-warning-200"
                        >
                          + เพิ่มยอดยกมา
                        </button>
                      </div>
                    </div>
                    <div className="p-6 bg-warning-50/10">
                      {carryOverCandidatesLoading ? (
                        <p className="text-sm text-warning-700/50 text-center py-4 font-bold animate-pulse">กำลังโหลดบิลค้าง...</p>
                      ) : carryOverCandidates.length > 0 && (
                        <div className="mb-6 space-y-2 border-b border-warning-200/60 pb-6">
                          <p className="text-xs font-bold text-warning-800/60 uppercase tracking-wider mb-3">ดึงยอดค้างจากเดือนก่อน</p>
                          {carryOverCandidates.map((c: any) => {
                            const selected = editableCarryForwardItems.some(
                              (item) => String(item.source_invoice_id) === String(c.id),
                            );
                            return (
                              <label
                                key={String(c.id)}
                                className={`flex cursor-pointer items-start gap-4 rounded-control border ${selected ? 'border-warning-400 bg-warning-50/50' : 'border-warning-200 bg-white'} px-4 py-3 shadow-sm hover:border-warning-400 transition`}
                              >
                                <input
                                  type="checkbox"
                                  className="mt-1 h-4 w-4 rounded border-warning-300 text-warning-600 focus:ring-warning-500"
                                  checked={selected}
                                  onChange={(event) => void toggleCarryOverFromCandidate(c, event.target.checked)}
                                />
                                <div className="flex-1">
                                  <span className="font-bold text-slate-800 block text-sm">
                                    งวด {formatPeriodLabel(String(c.start_date ?? ""))}
                                  </span>
                                  <span className="mt-1 block text-xs font-semibold text-slate-500">
                                    ค้าง {formatMoney(toNumber(c.outstanding_amount))} 
                                  </span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {editableCarryForwardItems.length === 0 ? (
                        <p className="text-sm text-warning-700/50 text-center py-6 font-bold">ไม่มียอดยกมา</p>
                      ) : (
                        <div className="space-y-4">
                          {editableCarryForwardItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateCarryForwardItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดยอดค้าง"
                                className="flex-1 rounded-control border border-warning-200 px-4 py-3 text-sm font-semibold transition focus:border-warning-400 focus:ring-1 focus:ring-warning-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateCarryForwardItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-control border border-warning-200 px-4 py-3 text-sm text-right font-bold transition focus:border-warning-400 focus:ring-1 focus:ring-warning-400"
                              />
                              <span className="text-warning-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateCarryForwardItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-control border border-warning-300 px-4 py-3 text-sm text-right font-black text-warning-700 transition focus:border-warning-400 focus:ring-1 focus:ring-warning-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableCarryForwardItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-danger-400 p-3 hover:bg-danger-50 hover:text-danger-600 rounded-control transition opacity-50 group-hover:opacity-100"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Late Fees */}
                  <div className="rounded-panel border border-danger-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-danger-50 px-6 py-5 border-b border-danger-200 flex justify-between items-center">
                      <h4 className="font-bold text-danger-900">ค่าปรับล่าช้า</h4>
                      <button
                        type="button"
                        onClick={() => setEditableLateFeeItems((prev) => [...prev, emptyLateFeeItem()])}
                        className="text-xs font-bold text-danger-700 bg-danger-100 px-4 py-2 rounded-control transition hover:bg-danger-200"
                      >
                        + เพิ่มค่าปรับ
                      </button>
                    </div>
                    <div className="p-6 bg-danger-50/10">
                      <div className="mb-6 space-y-2 border-b border-danger-200/60 pb-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-bold text-danger-800/60 uppercase tracking-wider">ค่าปรับล่าช้าอัตโนมัติ</p>
                            <p className="text-sm text-slate-600 mt-1">คำนวณจากยอดค้างชำระ (สรุปยอดเมื่อออกบิลรอบถัดไป)</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                value={Math.max(0, toNumber(form.late_fee_amount) - feeItemsTotal(editableLateFeeItems))}
                                readOnly
                                className="w-28 rounded-control border border-danger-200 bg-white px-3 py-2 text-right font-black text-danger-700 shadow-sm"
                              />
                              <span className="text-sm font-bold text-danger-500">บาท</span>
                            </div>
                            <button
                              type="button"
                              disabled={
                                saving ||
                                (Math.max(0, toNumber(form.late_fee_amount) - feeItemsTotal(editableLateFeeItems)) === 0 &&
                                  Number(form.waived_late_fee_amount) === 0)
                              }
                              onClick={() => {
                                if (Number(form.waived_late_fee_amount) > 0) {
                                  updateForm("waived_late_fee_amount", 0, true);
                                } else {
                                  updateForm("waived_late_fee_amount", 999999, true);
                                }
                              }}
                              className={`whitespace-nowrap rounded-control border px-4 py-2 text-xs font-bold transition disabled:opacity-50 disabled:cursor-not-allowed ${
                                Number(form.waived_late_fee_amount) > 0
                                  ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                  : "border-danger-200 bg-danger-50 text-danger-600 hover:bg-danger-100"
                              }`}
                            >
                              {Number(form.waived_late_fee_amount) > 0 ? "เรียกเก็บตามเดิม" : "ยกเว้นค่าปรับนี้"}
                            </button>
                          </div>
                        </div>
                        {form.locked_late_fee_amount !== null && (
                          <p className="text-2xs text-success-600 font-bold mt-2">
                            ✓ ล็อกค่าปรับแล้วเนื่องจากมีการชำระเงิน
                          </p>
                        )}
                      </div>

                      {editableLateFeeItems.length === 0 ? (
                        <p className="text-sm text-danger-700/50 text-center py-6 font-bold">ไม่มีรายการค่าปรับเพิ่มเติม</p>
                      ) : (
                        <div className="space-y-4">
                          {editableLateFeeItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateLateFeeItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดค่าปรับ"
                                className="flex-1 rounded-control border border-danger-200 px-4 py-3 text-sm font-semibold transition focus:border-danger-400 focus:ring-1 focus:ring-danger-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateLateFeeItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-control border border-danger-200 px-4 py-3 text-sm text-right font-bold transition focus:border-danger-400 focus:ring-1 focus:ring-danger-400"
                              />
                              <span className="text-danger-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateLateFeeItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-control border border-danger-300 px-4 py-3 text-sm text-right font-black text-danger-700 transition focus:border-danger-400 focus:ring-1 focus:ring-danger-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableLateFeeItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-danger-400 p-3 hover:bg-danger-50 hover:text-danger-600 rounded-control transition opacity-50 group-hover:opacity-100"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Additional Fees */}
                  <div className="rounded-panel border border-slate-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-slate-50 px-6 py-5 border-b border-slate-200 flex justify-between items-center">
                      <h4 className="font-bold text-slate-800">รายการค่าธรรมเนียมเพิ่มเติม</h4>
                      <button
                        type="button"
                        onClick={() => setEditableFeeItems((prev) => [...prev, emptyFeeItem()])}
                        className="text-xs font-bold text-slate-700 bg-slate-200 px-4 py-2 rounded-control transition hover:bg-slate-300"
                      >
                        + เพิ่มรายการ
                      </button>
                    </div>
                    <div className="p-6">
                      {editableFeeItems.length === 0 ? (
                        <p className="text-sm text-slate-400 text-center py-6 font-bold">ไม่มีรายการ</p>
                      ) : (
                        <div className="space-y-4">
                          {editableFeeItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateFeeItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียด"
                                className="flex-1 rounded-control border border-slate-200 px-4 py-3 text-sm font-semibold transition focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateFeeItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-control border border-slate-200 px-4 py-3 text-sm text-right font-bold transition focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                              />
                              <span className="text-slate-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateFeeItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-control border border-slate-300 px-4 py-3 text-sm text-right font-black transition focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableFeeItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-danger-400 p-3 hover:bg-danger-50 hover:text-danger-600 rounded-control transition opacity-50 group-hover:opacity-100"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Discounts */}
                  <div className="rounded-panel border border-success-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-success-50 px-6 py-5 border-b border-success-200 flex justify-between items-center">
                      <h4 className="font-bold text-success-800">รายการส่วนลด</h4>
                      <button
                        type="button"
                        onClick={() => setEditableDiscountItems((prev) => [...prev, emptyFeeItem()])}
                        className="text-xs font-bold text-success-700 bg-success-100 px-4 py-2 rounded-control transition hover:bg-success-200"
                      >
                        + เพิ่มส่วนลด
                      </button>
                    </div>
                    <div className="p-6 bg-success-50/20">
                      {editableDiscountItems.length === 0 ? (
                        <p className="text-sm text-success-700/50 text-center py-6 font-bold">ไม่มีรายการส่วนลด</p>
                      ) : (
                        <div className="space-y-4">
                          {editableDiscountItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateDiscountItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดส่วนลด"
                                className="flex-1 rounded-control border border-success-200 px-4 py-3 text-sm font-semibold transition focus:border-success-400 focus:ring-1 focus:ring-success-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateDiscountItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-control border border-success-200 px-4 py-3 text-sm text-right font-bold transition focus:border-success-400 focus:ring-1 focus:ring-success-400"
                              />
                              <span className="text-success-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateDiscountItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-control border border-success-300 px-4 py-3 text-sm text-right font-black text-success-700 transition focus:border-success-400 focus:ring-1 focus:ring-success-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableDiscountItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-danger-400 p-3 hover:bg-danger-50 hover:text-danger-600 rounded-control transition opacity-50 group-hover:opacity-100"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {transferBreakdownItems.length > 0 && (
                    <div className="rounded-panel border border-primary-200 bg-white shadow-sm overflow-hidden mt-8">
                      <div className="bg-primary-50 px-6 py-5 border-b border-primary-200 flex justify-between items-center">
                        <h4 className="font-bold text-primary-900">สรุปย้ายห้องกลางเดือน</h4>
                        <button
                          type="button"
                          onClick={() => void recalculateTransferBreakdown()}
                          disabled={!canEditDetails || saving}
                          className={buttonClasses({ variant: "subtle", size: "sm" })}
                        >
                          คำนวณย้ายห้องใหม่
                        </button>
                      </div>
                      <div className="p-6 bg-primary-50/10">
                        <p className="text-sm text-slate-500 mb-4">แก้ยอดค่าเช่าห้องเดิมและห้องใหม่ได้โดยตรง หากการคำนวณอัตโนมัติไม่ตรงหน้างาน</p>
                        <div className="space-y-3">
                          {transferBreakdownItems.map((item, index) => (
                            <div key={index} className="flex justify-between items-center p-3 rounded-control border border-primary-100 bg-white">
                              <span className="text-sm font-semibold text-slate-700">{item.label}</span>
                              {item.editable ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="number"
                                    value={toNumber(item.amount)}
                                    onChange={(event) => updateTransferBreakdownAmount(index, event.target.value)}
                                    className="w-32 rounded-control border border-primary-200 px-3 py-2 text-sm text-right font-bold transition focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                                    disabled={!canEditDetails || saving}
                                  />
                                  <span className="text-sm text-slate-500 font-bold">บาท</span>
                                </div>
                              ) : (
                                <span className="text-sm font-bold text-slate-700">{item.value}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                </fieldset>
              </div>
            )}

            {/* TAB: PAYMENTS */}
            {activeTab === 'payments' && (
              <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h3 className="text-2xl font-bold text-slate-900">ประวัติการชำระเงิน</h3>
                
                {chainsLoading ? (
                  <div className="rounded-panel border border-slate-200 bg-white py-16 text-center shadow-sm">
                    <Loader2 className="mx-auto animate-spin text-slate-400" size={28} />
                  </div>
                ) : paymentChains.length > 0 ? (
                  <div className="space-y-4">
                    {paymentChains.map((chain) => {
                      const coversOthers = chain.lines.length > 1;
                      return (
                        <div
                          key={chain.batchId}
                          className="rounded-panel border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-float-md"
                        >
                          {/* What the tenant actually transferred */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-5">
                              <div className="h-14 w-14 rounded-full bg-success-100 flex items-center justify-center text-success-600 shadow-inner">
                                <CheckCircle2 size={28} />
                              </div>
                              <div>
                                <p className="font-black text-slate-900 text-lg">
                                  {isNonCashPaymentSource(chain.source)
                                    ? `หักเครดิต ${formatMoney(chain.amountReceived)}`
                                    : `รับชำระ ${formatMoney(chain.amountReceived)}`}
                                </p>
                                {/* Every transaction states where it came from. */}
                                <p
                                  className={
                                    isNonCashPaymentSource(chain.source)
                                      ? "mt-0.5 inline-block rounded-full bg-warning-100 px-2 py-0.5 text-2xs font-bold text-warning-700"
                                      : "mt-0.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-bold text-slate-600"
                                  }
                                >
                                  ที่มา: {paymentSourceLabel(chain.source)}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-3">
                                  <p className="text-sm font-semibold text-slate-500">
                                    วันที่ชำระ: {chain.paidAt ? formatDateThai(chain.paidAt) : "-"}
                                  </p>
                                  {chain.methodLabel === UNKNOWN_PAYMENT_METHOD &&
                                  !isNonCashPaymentSource(chain.source) &&
                                  canRecordInvoicePayment &&
                                  assignableMethods.length > 0 ? (
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-semibold text-slate-400">
                                        เข้าบัญชี: {UNKNOWN_PAYMENT_METHOD}
                                      </span>
                                      <select
                                        value={assignSelection[chain.batchId] ?? ""}
                                        onChange={(e) =>
                                          setAssignSelection((prev) => ({
                                            ...prev,
                                            [chain.batchId]: e.target.value,
                                          }))
                                        }
                                        className="h-8 rounded-control border border-slate-200 px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary-500"
                                      >
                                        <option value="">ระบุบัญชีที่รับเงินจริง...</option>
                                        {assignableMethods.map((m) => (
                                          <option key={m.id} value={m.id}>
                                            {m.label || m.bank_name} · {m.account_number}
                                          </option>
                                        ))}
                                      </select>
                                      <button
                                        type="button"
                                        onClick={() => assignPaymentBatchMethod(chain.batchId)}
                                        disabled={
                                          !assignSelection[chain.batchId] ||
                                          assigningBatchId === chain.batchId
                                        }
                                        className={buttonClasses({ variant: "subtle", size: "sm" })}
                                      >
                                        {assigningBatchId === chain.batchId ? "กำลังบันทึก..." : "บันทึก"}
                                      </button>
                                    </div>
                                  ) : isNonCashPaymentSource(chain.source) ? null : (
                                    <span
                                      className={
                                        chain.methodLabel === UNKNOWN_PAYMENT_METHOD
                                          ? "text-sm font-semibold text-slate-400"
                                          : "text-sm font-semibold text-slate-600"
                                      }
                                    >
                                      เข้าบัญชี: {chain.methodLabel}
                                    </span>
                                  )}
                                  {chain.slipUrl && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSlipModalTitle(
                                          `สลิปการชำระเงิน - จำนวน ${formatMoney(chain.amountReceived)}`,
                                        );
                                        setSlipModalUrl(chain.slipUrl);
                                        setSlipModalOpen(true);
                                      }}
                                      className={buttonClasses({ variant: "subtle", size: "sm" })}
                                    >
                                      ดูสลิป
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
                                ตัดเข้าใบนี้
                              </p>
                              <p className="text-3xl font-black tracking-tighter text-success-600">
                                {formatMoney(chain.appliedHere)}
                              </p>
                              {canRecordInvoicePayment && (
                                <button
                                  type="button"
                                  onClick={() => void deletePaymentBatch(chain.batchId)}
                                  disabled={deletingBatchId === chain.batchId}
                                  className="mt-2 text-xs font-bold text-danger-500 hover:text-danger-700 disabled:opacity-50 transition"
                                >
                                  {deletingBatchId === chain.batchId
                                    ? "กำลังลบ..."
                                    : "ลบรายการนี้ (พบว่าซ้ำ/ผิดพลาด)"}
                                </button>
                              )}
                            </div>
                          </div>

                          {/* How that one payment was split. Shown whenever it covered
                              more than this invoice — otherwise the amount above reads
                              as a short payment when the tenant in fact settled several
                              months at once. */}
                          {coversOthers && (
                            <div className="mt-5 rounded-card border border-slate-100 bg-slate-50 p-4">
                              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                                เงินก้อนนี้ถูกแบ่งไปชำระ {chain.lines.length} ใบ (ตัดใบเก่าก่อน)
                              </p>
                              <div className="space-y-1.5">
                                {chain.lines.map((line) => (
                                  <div
                                    key={line.id}
                                    className={
                                      line.isThisInvoice
                                        ? "flex items-center justify-between rounded-control bg-white px-3 py-2 text-sm font-bold text-slate-900 ring-1 ring-primary-200"
                                        : "flex items-center justify-between px-3 py-2 text-sm text-slate-600"
                                    }
                                  >
                                    <span>
                                      ห้อง {line.roomNumber} · งวด {line.period}
                                      {line.isThisInvoice && (
                                        <span className="ml-2 rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-bold text-primary-700">
                                          ใบนี้
                                        </span>
                                      )}
                                    </span>
                                    <span>{formatMoney(line.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : Array.isArray(activeInvoice.payment_history) &&
                  activeInvoice.payment_history.length > 0 ? (
                  /* Payments recorded before allocation rows existed: the split was
                     never captured, so only this invoice's own slice can be shown. */
                  <div className="space-y-4">
                    {activeInvoice.payment_history.map((payment, idx) => (
                      <div key={idx} className="flex justify-between items-center p-6 rounded-panel border border-slate-200 shadow-sm bg-white transition hover:shadow-float-md">
                        <div className="flex items-center gap-5">
                          <div className="h-14 w-14 rounded-full bg-success-100 flex items-center justify-center text-success-600 shadow-inner">
                            <CheckCircle2 size={28} />
                          </div>
                          <div>
                            <p className="font-black text-slate-900 text-lg">
                              ตัดเข้าใบนี้ {formatMoney(toNumber(payment.amount))}
                            </p>
                            <p
                              className={
                                isNonCashPaymentSource((payment as any).source)
                                  ? "mt-0.5 inline-block rounded-full bg-warning-100 px-2 py-0.5 text-2xs font-bold text-warning-700"
                                  : "mt-0.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-bold text-slate-600"
                              }
                            >
                              ที่มา: {paymentSourceLabel((payment as any).source)}
                            </p>
                            <div className="flex items-center gap-3 mt-1">
                              <p className="text-sm font-semibold text-slate-500">วันที่ชำระ: {payment.paid_at ? formatDateThai(payment.paid_at) : "-"}</p>
                              {payment.slip_url && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSlipModalTitle(
                                      `สลิปการชำระเงิน - จำนวน ${formatMoney(payment.amount)}`,
                                    );
                                    setSlipModalUrl(payment.slip_url);
                                    setSlipModalOpen(true);
                                  }}
                                  className={buttonClasses({ variant: "subtle", size: "sm" })}
                                >
                                  ดูสลิป
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <button
                            onClick={() => cancelPaymentEntry(idx)}
                            disabled={!canRecordInvoicePayment || paymentSubmitting}
                            className="text-xs font-bold text-danger-500 hover:text-danger-700 disabled:opacity-50 transition"
                          >
                            ยกเลิกรายการ
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-panel border border-dashed border-slate-300 py-16 text-center bg-white shadow-sm">
                    <p className="text-slate-500 font-bold">ยังไม่มีประวัติการชำระเงินสำหรับใบแจ้งหนี้นี้</p>
                  </div>
                )}
                
                {/* NEW PAYMENT FORM */}
                <div className="mt-10 pt-8 border-t border-slate-200">
                  <h4 className="text-xl font-bold text-slate-900 mb-6">เพิ่มการชำระเงินใหม่</h4>
                  
                  <div className="rounded-panel border border-slate-200 bg-white p-6 shadow-sm space-y-6">
                    <div className="grid sm:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-slate-700">วันที่ชำระ</label>
                        <input
                          type="date"
                          value={paymentDate}
                          onChange={(e) => setPaymentDate(e.target.value)}
                          className="w-full rounded-control border border-slate-200 px-4 py-3 text-sm shadow-sm font-medium transition focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-slate-700">จำนวนเงิน</label>
                        <input
                          type="number"
                          value={paymentAmountInput}
                          onChange={(e) => setPaymentAmountInput(e.target.value)}
                          className="w-full rounded-control border border-slate-300 px-4 py-3 text-sm shadow-sm font-black text-success-700 transition focus:border-success-500 focus:ring-1 focus:ring-success-500"
                          placeholder="กรอกจำนวนเงิน"
                        />
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <label className="text-sm font-bold text-slate-700">สลิปโอนเงิน (ถ้ามี)</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => setPaymentSlipFile(e.target.files?.[0] ?? null)}
                          className="w-full rounded-control border border-slate-200 px-4 py-3 text-sm bg-slate-50 file:border-0 file:bg-white file:px-4 file:py-2 file:rounded-control file:mr-4 file:text-sm file:font-bold shadow-inner"
                        />
                        {slipPreview && (
                          <div className="mt-4 rounded-card border border-slate-200 bg-slate-50 p-4 shadow-sm">
                            <div className="flex items-center justify-between gap-4 mb-3">
                              <p className="text-sm font-bold text-slate-700">สลิปปัจจุบัน</p>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!slipPreview) return;
                                    setSlipModalTitle(
                                      `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`,
                                    );
                                    setSlipModalUrl(slipPreview);
                                    setSlipModalOpen(true);
                                  }}
                                  className={buttonClasses({ variant: "subtle", size: "sm" })}
                                >
                                  เปิดภาพเต็ม
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deletePaymentSlip()}
                                  disabled={!canRecordInvoicePayment || paymentSubmitting}
                                  className="rounded-lg border border-danger-200 bg-white px-3 py-1.5 text-xs font-bold text-danger-600 hover:bg-danger-50 disabled:opacity-50 transition shadow-sm"
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
                                  `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`,
                                );
                                setSlipModalUrl(slipPreview);
                                setSlipModalOpen(true);
                              }}
                              className="block w-full overflow-hidden rounded-control border border-slate-200 bg-white hover:border-primary-300 transition"
                            >
                              <img
                                src={slipPreview}
                                alt="สลิป"
                                className="max-h-[32rem] w-full object-contain p-2"
                              />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end pt-4 border-t border-slate-100">
                      <button
                        onClick={() => submitPayment()}
                        disabled={!canRecordInvoicePayment || paymentSubmitting}
                        className={buttonClasses({ variant: "success", size: "lg" })}
                      >
                        {paymentSubmitting ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />}
                        บันทึกการชำระเงิน
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </Modal>
  );
}

