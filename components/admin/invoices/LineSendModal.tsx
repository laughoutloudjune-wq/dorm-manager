"use client";

import { Modal } from "@/components/ui/Modal";
import { useInvoiceContext } from "./InvoiceContext";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Loader2, Plus, Printer, Save, Search, Trash2, UploadCloud, Mail, CheckCircle2, FileText, MailOpen, AlertCircle } from "lucide-react";
import { formatMoney, toLocalDateString } from "@/lib/format";
import { isInvoiceDetailEditable, formatPeriodLabel, formatDateThai } from "@/lib/invoice-utils";


export function LineSendModal() {
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

  return (
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
  );
}
