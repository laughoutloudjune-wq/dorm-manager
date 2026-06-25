"use client";
import React from "react";

import { Modal } from "@/components/ui/Modal";
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
        <div className="flex flex-col xl:flex-row gap-6 h-full max-h-[85vh]">
          {/* --- LEFT COLUMN: Overview & Actions --- */}
          <div className="w-full xl:w-[420px] shrink-0 flex flex-col gap-5 overflow-y-auto pr-2 pb-4">
          {!isInvoiceDetailEditable(activeInvoice.status) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ปิดการแก้ไขรายละเอียดสำหรับสถานะ{" "}
              <b>{statusLabelThai(activeInvoice.status)}</b> หากต้องการแก้ไข
              ให้เปลี่ยนสถานะเป็น <b>ฉบับร่าง</b>
            </div>
          )}
          {(!canEditInvoice ||
            !canUpdateInvoiceStatus ||
            !canRecordInvoicePayment) && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              บางส่วนถูกล็อกตามสิทธิ์ของผู้ใช้
              (ปุ่มที่ล็อกจะแสดงเคอร์เซอร์ห้ามใช้งาน)
            </div>
          )}
          {allocationResultNotice &&
            allocationResultNotice.lines.length > 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                <p className="font-semibold">
                  {allocationResultNotice.idempotentReplay
                    ? "ผลการจัดสรรเงิน (ซ้ำ — ใช้คีย์ idempotency เดิม)"
                    : "จัดสรรเงินสำเร็จ"}
                </p>
                <p className="mt-1 text-xs text-emerald-800">
                  Batch:{" "}
                  {allocationResultNotice.batchId.slice(0, 8).toUpperCase()}…
                </p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
                  {allocationResultNotice.lines.map((line) => (
                    <li key={line.invoiceId}>
                      {line.label}: {formatMoney(line.amount)}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setAllocationResultNotice(null)}
                  className="mt-2 text-xs font-semibold text-emerald-800 underline"
                >
                  ปิดข้อความนี้
                </button>
              </div>
            )}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  Invoice
                </p>
                <p className="text-lg font-semibold text-slate-900">
                  ห้อง {activeInvoice.room_number}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-400">ยอดรวม</p>
                <p className="text-xl font-semibold text-blue-700">
                  {formatMoney(form.total_amount)}
                </p>
                {feeItemsTotal(editableCarryForwardItems) > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    ยอดค้างยกมา:{" "}
                    {formatMoney(feeItemsTotal(editableCarryForwardItems))}
                  </p>
                )}
                {feeItemsTotal(editableLateFeeItems) > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    ค่าปรับล่าช้า:{" "}
                    {formatMoney(feeItemsTotal(editableLateFeeItems))} (
                    {editableLateFeeItems.length} รายการ)
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-400">
                  ชำระแล้ว: {formatMoney(toNumber(form.paid_amount))}
                </p>
                <p className="text-xs text-rose-600">
                  คงเหลือ:{" "}
                  {formatMoney(
                    invoiceDisplayOutstanding({
                      total_amount: form.total_amount,
                      paid_amount: toNumber(form.paid_amount),
                    }),
                  )}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>
                    การเปิดดูใบแจ้งหนี้:{" "}
                    <b
                      className={
                        activeInvoice.opened_count > 0
                          ? "text-blue-700"
                          : "text-slate-700"
                      }
                    >
                      {activeInvoice.opened_count > 0
                        ? `เปิดแล้ว ${activeInvoice.opened_count} ครั้ง`
                        : "ยังไม่เปิด"}
                    </b>
                  </span>
                  <span>
                    เปิดครั้งแรก:{" "}
                    <b>
                      {activeInvoice.first_opened_at
                        ? new Date(
                            activeInvoice.first_opened_at,
                          ).toLocaleString("th-TH")
                        : "-"}
                    </b>
                  </span>
                  <span>
                    ล่าสุด:{" "}
                    <b>
                      {activeInvoice.last_opened_at
                        ? new Date(activeInvoice.last_opened_at).toLocaleString(
                            "th-TH",
                          )
                        : "-"}
                    </b>
                  </span>
                </div>
              </div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                สถานะ
              </p>
              <select
                value={form.status}
                onChange={(event) => {
                  const nextStatus = event.target
                    .value as keyof typeof statusVariant;
                  setForm((prev) => ({ ...prev, status: nextStatus }));
                  void updateInvoiceStatus(activeInvoice.id, nextStatus);
                }}
                disabled={!canUpdateInvoiceStatus}
                title={
                  !canUpdateInvoiceStatus
                    ? "ไม่มีสิทธิ์เปลี่ยนสถานะใบแจ้งหนี้"
                    : undefined
                }
                className={`w-full rounded-xl border px-4 py-3 text-base font-semibold capitalize disabled:cursor-not-allowed disabled:opacity-70 ${statusPillClass(
                  form.status,
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
                  title={
                    !canRecordInvoicePayment
                      ? "ไม่มีสิทธิ์บันทึกการชำระเงิน"
                      : undefined
                  }
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
                        }),
                      )}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs font-semibold text-slate-600">
                      ประวัติการชำระก่อนหน้า
                    </p>
                    {activeInvoice.payment_history.length === 0 ? (
                      <p className="mt-2 text-xs text-slate-500">
                        ยังไม่มีประวัติการชำระ
                      </p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {activeInvoice.payment_history.map(
                          (item: any, idx: number) => (
                            <div
                              key={`${item.paid_at ?? item.created_at ?? idx}-${idx}`}
                              className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                            >
                              <p className="font-semibold">
                                {formatMoney(toNumber(item.amount))}
                              </p>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <p>
                                  {(item.mode ?? "-").toString().toUpperCase()}{" "}
                                  |{" "}
                                  {item.paid_at
                                    ? new Date(item.paid_at).toLocaleString(
                                        "th-TH",
                                      )
                                    : "-"}
                                </p>
                                <div className="flex items-center gap-2">
                                  {item.slip_url && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSlipModalTitle(
                                          `สลิปการชำระเงิน - จำนวน ${formatMoney(toNumber(item.amount))}`,
                                        );
                                        setSlipModalUrl(item.slip_url);
                                        setSlipModalOpen(true);
                                      }}
                                      className="rounded-md border border-blue-200 px-2 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50"
                                    >
                                      ดูสลิป
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => void cancelPaymentEntry(idx)}
                                    disabled={
                                      !canRecordInvoicePayment ||
                                      paymentSubmitting
                                    }
                                    title={
                                      !canRecordInvoicePayment
                                        ? "ไม่มีสิทธิ์ยกเลิกรายการชำระเงิน"
                                        : undefined
                                    }
                                    className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-red-50"
                                  >
                                    ยกเลิกรายการ
                                  </button>
                                </div>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs font-semibold text-slate-600">
                      1) เลือกประเภทการชำระ
                    </p>
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
                        <p className="mb-1 text-xs text-slate-500">
                          จำนวนเงินที่ชำระบางส่วน
                        </p>
                        <input
                          type="number"
                          min={0}
                          value={paymentAmountInput}
                          onChange={(event) =>
                            setPaymentAmountInput(event.target.value)
                          }
                          className="w-full max-w-[220px] rounded-lg border border-slate-200 px-3 py-2 text-sm text-right"
                          placeholder="จำนวนเงิน"
                        />
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs font-semibold text-slate-600">
                      2) วันที่ชำระและสลิป
                    </p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs text-slate-500">
                          วันที่ชำระ
                        </p>
                        <input
                          type="date"
                          value={paymentDate}
                          onChange={(event) =>
                            setPaymentDate(event.target.value)
                          }
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <p className="mb-1 text-xs text-slate-500">
                          อัปโหลดรูปสลิป
                        </p>
                        <label className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">
                          <UploadCloud size={14} />
                          {paymentSlipFile ? paymentSlipFile.name : "เลือกไฟล์"}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) =>
                              setPaymentSlipFile(
                                event.target.files?.[0] ?? null,
                              )
                            }
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
                                  `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`,
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
                              disabled={
                                !canRecordInvoicePayment || paymentSubmitting
                              }
                              title={
                                !canRecordInvoicePayment
                                  ? "ไม่มีสิทธิ์ลบสลิปการชำระเงิน"
                                  : undefined
                              }
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
                              `สลิปการชำระเงิน - ห้อง ${activeInvoice?.room_number ?? "-"}`,
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
                    title={
                      !canRecordInvoicePayment
                        ? "ไม่มีสิทธิ์บันทึกการชำระเงิน"
                        : undefined
                    }
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {paymentSubmitting ? "กำลังบันทึก..." : "บันทึกการชำระ"}
                  </button>
                </div>
              )}
            </div>
          </div>

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
              onClick={() =>
                void getInvoicePrintDetail(activeInvoice, "receipt")
              }
              disabled={
                !(
                  activeInvoice.status === "verifying" ||
                  activeInvoice.status === "paid"
                )
              }
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
              title={
                !(canEditDetails && canEditInvoice)
                  ? "ไม่มีสิทธิ์แก้ไขรายละเอียดใบแจ้งหนี้"
                  : undefined
              }
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              บันทึกการเปลี่ยนแปลง
            </button>
          </div>

          {/* --- RIGHT COLUMN: Detailed Breakdown --- */}
          <div className="flex-1 min-w-0 flex flex-col gap-6">
            <div className="grid items-start gap-6 xl:grid-cols-1 2xl:grid-cols-[1fr_400px]">
            <fieldset
              disabled={!(canEditDetails && canEditInvoice)}
              className={`min-w-0 ${!(canEditDetails && canEditInvoice) ? "cursor-not-allowed opacity-70" : ""}`}
            >
              <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <p className="text-sm font-semibold text-slate-700">
                  รายละเอียดหลักใบแจ้งหนี้
                </p>
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
                            onChange={(event) =>
                              updateForm("issue_date", event.target.value)
                            }
                            className="w-full rounded-lg border border-slate-200 px-3 py-1.5"
                          />
                        </td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">
                          วันครบกำหนดชำระ
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="date"
                            value={form.due_date}
                            onChange={(event) =>
                              updateForm("due_date", event.target.value)
                            }
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
                            onChange={(event) =>
                              updateForm("rent_amount", event.target.value)
                            }
                            readOnly={hasEditableTransferRent}
                            className={`w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right ${
                              hasEditableTransferRent ? "bg-slate-50" : ""
                            }`}
                          />
                          {hasEditableTransferRent && (
                            <p className="mt-1 text-xs text-slate-500">
                              บิลนี้มีย้ายห้องกลางเดือน
                              กรุณาแก้ยอดในส่วนสรุปย้ายห้องด้านล่าง
                            </p>
                          )}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-100 bg-amber-50">
                        <td className="px-3 py-2 font-medium text-amber-900">
                          คำนวณ pro-rate
                        </td>
                        <td className="px-3 py-2">
                          <label className="inline-flex items-center gap-2 text-amber-900">
                            <input
                              type="checkbox"
                              checked={useProrateInModal}
                              onChange={(event) =>
                                toggleProrateInModal(event.target.checked)
                              }
                            />
                            ใช้การคิดค่าเช่าแบบ pro-rate สำหรับบิลนี้
                          </label>
                          {modalProrateSummary && (
                            <p className="mt-2 text-xs text-amber-800">
                              สูตรคำนวณ: {modalProrateSummary.formulaText}{" "}
                              (วันเข้าอยู่ {modalProrateSummary.moveInDay},
                              วันตัดรอบ {modalProrateSummary.billingDay})
                            </p>
                          )}
                        </td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">
                          ค่าน้ำ
                          <p className="text-xs font-normal text-slate-500">
                            อัตรา:{" "}
                            {formatMoney(toNumber(printSettings?.water_rate))}
                            /หน่วย
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="mb-1 text-xs text-slate-500">
                                หน่วย
                              </p>
                              <input
                                type="number"
                                value={form.water_units}
                                onChange={(event) =>
                                  updateUtilityUnits(
                                    "water_units",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                              />
                            </div>
                            <div>
                              <p className="mb-1 text-xs text-slate-500">
                                ยอดรวม
                              </p>
                              <input
                                type="number"
                                value={form.water_bill}
                                onChange={(event) =>
                                  updateForm("water_bill", event.target.value)
                                }
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
                            อัตรา:{" "}
                            {formatMoney(
                              toNumber(printSettings?.electricity_rate),
                            )}
                            /หน่วย
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="mb-1 text-xs text-slate-500">
                                หน่วย
                              </p>
                              <input
                                type="number"
                                value={form.electricity_units}
                                onChange={(event) =>
                                  updateUtilityUnits(
                                    "electricity_units",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-right"
                              />
                            </div>
                            <div>
                              <p className="mb-1 text-xs text-slate-500">
                                ยอดรวม
                              </p>
                              <input
                                type="number"
                                value={form.electricity_bill}
                                onChange={(event) =>
                                  updateForm(
                                    "electricity_bill",
                                    event.target.value,
                                  )
                                }
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
                            onChange={(event) =>
                              updateForm("common_fee", event.target.value)
                            }
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
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                value={form.late_fee_amount}
                                readOnly
                                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right font-semibold text-amber-700"
                              />
                              <button
                                type="button"
                                disabled={
                                  saving ||
                                  (Number(form.late_fee_amount) === 0 &&
                                    Number(form.waived_late_fee_amount) === 0)
                                }
                                onClick={() => {
                                  if (Number(form.waived_late_fee_amount) > 0) {
                                    updateForm(
                                      "waived_late_fee_amount",
                                      0,
                                      true,
                                    );
                                  } else {
                                    // Use a very large number to ensure it stays fully waived forever
                                    // even as days continue to pass and rawLateFee grows.
                                    updateForm(
                                      "waived_late_fee_amount",
                                      999999,
                                      true,
                                    );
                                  }
                                }}
                                className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                                  Number(form.waived_late_fee_amount) > 0
                                    ? "border-slate-300 bg-slate-100 text-slate-700"
                                    : "border-red-200 bg-red-50 text-red-600"
                                }`}
                              >
                                {Number(form.waived_late_fee_amount) > 0
                                  ? "เรียกเก็บตามเดิม"
                                  : "ยกเว้นทั้งหมด"}
                              </button>
                            </div>
                            {form.locked_late_fee_amount !== null ? (
                              <p className="text-[11px] text-green-600 text-right font-medium">
                                ✓ ล็อกค่าปรับแล้วเนื่องจากชำระเงิน
                              </p>
                            ) : null}
                          </div>
                        </td>
                      </tr>

                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">
                          รวมค่าธรรมเนียมเพิ่มเติม
                        </td>
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
                          <div className="space-y-2">
                            <input
                              type="number"
                              value={form.total_amount}
                              readOnly
                              className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-right font-semibold"
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void recalculateCurrentInvoiceArrears()
                                }
                                disabled={!canEditDetails || saving}
                                className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                ⟳ คำนวณใหม่
                              </button>
                              <button
                                type="button"
                                onClick={applyRoundDownTotal}
                                disabled={!canEditDetails || saving}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                ปัดยอดลง
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {transferBreakdownItems.length > 0 && (
                <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-blue-900">
                        สรุปย้ายห้องกลางเดือน
                      </p>
                      <p className="text-xs text-blue-800">
                        แก้ยอดค่าเช่าห้องเดิมและห้องใหม่ได้โดยตรง
                        หากการคำนวณอัตโนมัติไม่ตรงหน้างาน
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void recalculateTransferBreakdown()}
                      disabled={!canEditDetails || saving}
                      className="rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      คำนวณย้ายห้องใหม่
                    </button>
                  </div>
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
                          <tr
                            key={`${item.label}-${index}`}
                            className="border-t border-blue-100"
                          >
                            <td className="px-2 py-2 font-medium">
                              {item.label}
                            </td>
                            <td className="px-2 py-2">
                              {item.editable ? (
                                <input
                                  type="number"
                                  value={toNumber(item.amount)}
                                  onChange={(event) =>
                                    updateTransferBreakdownAmount(
                                      index,
                                      event.target.value,
                                    )
                                  }
                                  className="w-full rounded-lg border border-blue-200 bg-white px-2 py-1 text-right"
                                  disabled={!canEditDetails || saving}
                                />
                              ) : (
                                item.value
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {canEditDetails && activeInvoice.status === "draft" && (
                <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
                  <div>
                    <p className="text-sm font-semibold text-emerald-900">
                      บิลค้างจากเดือนก่อน (เลือกเพื่อยกมา)
                    </p>
                    <p className="text-xs text-emerald-800">
                      แสดงบิลที่ค้างชำระและยังไม่ถูกยกไปบิลอื่น
                      (หรือยกมาที่บิลนี้อยู่แล้ว)
                      เมื่อเลือกแล้วระบบจะใส่รหัสอ้างอิงบิลต้นทางให้โดยอัตโนมัติ
                    </p>
                  </div>
                  {carryOverCandidatesLoading ? (
                    <p className="text-xs text-emerald-800">
                      กำลังโหลดรายการ...
                    </p>
                  ) : carryOverCandidates.length === 0 ? (
                    <p className="text-xs text-emerald-800">
                      ไม่พบบิลค้างที่นำมาทบได้
                    </p>
                  ) : (
                    <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                      {carryOverCandidates.map((c: any) => {
                        const selected = editableCarryForwardItems.some(
                          (item) =>
                            String(item.source_invoice_id) === String(c.id),
                        );
                        return (
                          <label
                            key={String(c.id)}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm shadow-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={selected}
                              onChange={(event) =>
                                void toggleCarryOverFromCandidate(
                                  c,
                                  event.target.checked,
                                )
                              }
                            />
                            <span className="min-w-0 flex-1">
                              <span className="font-medium text-slate-900">
                                งวด{" "}
                                {formatPeriodLabel(String(c.start_date ?? ""))}
                              </span>
                              <span className="mt-0.5 block text-xs text-slate-600">
                                ค้าง{" "}
                                {formatMoney(toNumber(c.outstanding_amount))}
                                {toNumber(c.late_fee_snapshot_amount) > 0
                                  ? ` · ค่าปรับโดยประมาณ ${formatMoney(toNumber(c.late_fee_snapshot_amount))} (คิดจาก ${c.late_fee_snapshot_days} วัน)`
                                  : ""}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-amber-900">
                      ยอดค้างยกมา
                    </p>
                    <p className="text-xs text-amber-800">
                      แก้ไขหรือลบได้ในกรณีที่ต้องการปรับยอดค้างที่นำมาทบในบิลนี้
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setEditableCarryForwardItems((prev) => [
                        ...prev,
                        emptyCarryForwardItem(),
                      ])
                    }
                    className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800"
                  >
                    เพิ่มแถวยอดค้าง
                  </button>
                </div>

                {editableCarryForwardItems.length === 0 ? (
                  <p className="text-xs text-amber-800">
                    ยังไม่มียอดค้างยกมาในบิลนี้
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-amber-100/80 text-amber-900">
                        <tr>
                          <th className="px-2 py-2 text-left">รายละเอียด</th>
                          <th className="px-2 py-2 text-right">หน่วย</th>
                          <th className="px-2 py-2 text-right">ราคา/หน่วย</th>
                          <th className="px-2 py-2 text-right">ยอดรวม</th>
                          <th className="px-2 py-2 text-right">จัดการ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {editableCarryForwardItems.map((item, index) => (
                          <tr
                            key={`carry-${index}`}
                            className="border-t border-amber-100"
                          >
                            <td className="px-2 py-2">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(event) =>
                                  updateCarryForwardItem(
                                    index,
                                    "detail",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1"
                                placeholder="เช่น ยอดค้างชำระงวด 2026-02"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(event) =>
                                  updateCarryForwardItem(
                                    index,
                                    "unit",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-amber-200 bg-white px-2 py-1 text-right"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(event) =>
                                  updateCarryForwardItem(
                                    index,
                                    "price_per_unit",
                                    event.target.value,
                                  )
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
                                    prev.filter((_, idx) => idx !== index),
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
                  <p className="text-sm font-semibold text-slate-700">
                    รายละเอียดค่าธรรมเนียมเพิ่มเติม
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setEditableFeeItems((prev) => [...prev, emptyFeeItem()])
                    }
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                  >
                    เพิ่มแถวค่าธรรมเนียม
                  </button>
                </div>

                {editableFeeItems.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    ยังไม่มีรายการค่าธรรมเนียมเพิ่มเติม
                  </p>
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
                                onChange={(event) =>
                                  updateFeeItem(
                                    index,
                                    "detail",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-2 py-1"
                                placeholder="เช่น ค่าที่จอดรถ"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(event) =>
                                  updateFeeItem(
                                    index,
                                    "unit",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(event) =>
                                  updateFeeItem(
                                    index,
                                    "price_per_unit",
                                    event.target.value,
                                  )
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
                                    const next = prev.filter(
                                      (_, idx) => idx !== index,
                                    );
                                    const nextAdditional = feeItemsTotal(next);
                                    setForm((formPrev) => {
                                      const total =
                                        toNumber(formPrev.rent_amount) +
                                        toNumber(formPrev.water_bill) +
                                        toNumber(formPrev.electricity_bill) +
                                        toNumber(formPrev.common_fee) +
                                        toNumber(formPrev.discount_amount) *
                                          -1 +
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
                  <p className="text-sm font-semibold text-slate-700">
                    รายละเอียดส่วนลด
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setEditableDiscountItems((prev) => [
                        ...prev,
                        emptyFeeItem(),
                      ])
                    }
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
                                onChange={(event) =>
                                  updateDiscountItem(
                                    index,
                                    "detail",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-2 py-1"
                                placeholder="เช่น ส่วนลดชำระก่อนกำหนด"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(event) =>
                                  updateDiscountItem(
                                    index,
                                    "unit",
                                    event.target.value,
                                  )
                                }
                                className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right"
                              />
                            </td>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(event) =>
                                  updateDiscountItem(
                                    index,
                                    "price_per_unit",
                                    event.target.value,
                                  )
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
                                    const next = prev.filter(
                                      (_, idx) => idx !== index,
                                    );
                                    const nextAdditional =
                                      feeItemsTotal(editableFeeItems);
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

            <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
              <div className="overflow-hidden rounded-[30px] border border-slate-200 bg-gradient-to-b from-slate-50 to-white shadow-sm">
                <div className="border-b border-slate-200 bg-white/80 px-5 py-4 backdrop-blur">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                    Live Preview
                  </p>
                  <h3 className="mt-1 text-lg font-semibold text-slate-900">
                    ตัวอย่างหน้าใบแจ้งหนี้
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    ใช้หน้าตาเดียวกับฝั่ง LIFF และอัปเดตตามค่าที่กำลังแก้
                  </p>
                </div>

                <div className="space-y-4 overflow-x-auto p-5">
                  <div className="rounded-[28px] border border-white/70 bg-white/90 p-5 shadow-lg shadow-slate-200/70">
                    <header className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-slate-500">
                            {form.status === "paid"
                              ? "ใบเสร็จรับเงิน"
                              : "ใบแจ้งหนี้"}
                          </p>
                          <h1 className="text-2xl font-semibold text-slate-900">
                            ห้อง {activeInvoice.room_number}
                          </h1>
                          <div className="mt-2">
                            <Badge
                              variant={
                                form.status === "verifying"
                                  ? "info"
                                  : form.status === "paid"
                                    ? "success"
                                    : "warning"
                              }
                            >
                              สถานะ:{" "}
                              {form.status === "verifying"
                                ? "รอตรวจสอบ"
                                : form.status === "paid"
                                  ? "ชำระแล้ว"
                                  : "รอชำระ"}
                            </Badge>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                            TOTAL
                          </p>
                          <p className="text-3xl font-semibold text-green-600">
                            {formatMoney(toNumber(form.total_amount))}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            ชำระแล้ว: {formatMoney(toNumber(form.paid_amount))}
                          </p>
                          <p className="text-xs text-rose-600">
                            คงเหลือ:{" "}
                            {formatMoney(
                              invoiceDisplayOutstanding({
                                total_amount: form.total_amount,
                                paid_amount: toNumber(form.paid_amount),
                              }),
                            )}
                          </p>
                        </div>
                      </div>

                      {form.status !== "paid" && (
                        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                          ชำระได้ไม่เกินวันที่ 10 ของเดือนถัดไป
                          ถ้าหากเกินกำหนดชำระ มีค่าปรับ 100 บาท/วัน
                        </div>
                      )}
                    </header>

                    <section className="mt-6 rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
                      <h2 className="text-lg font-semibold text-slate-900">
                        รายละเอียดค่าใช้จ่าย
                      </h2>
                      <div className="mt-4 space-y-3 text-sm text-slate-600">
                        {livePreviewRows.length === 0 ? (
                          <p className="text-sm text-slate-400">
                            ยังไม่มีรายการแสดงในใบแจ้งหนี้
                          </p>
                        ) : (
                          livePreviewRows.map((row, index) => (
                            <div
                              key={`${row.detail}-${index}`}
                              className={`flex items-center justify-between ${
                                row.tone === "amber"
                                  ? "rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                                  : row.tone === "sky"
                                    ? "rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"
                                    : ""
                              }`}
                            >
                              <span>
                                <span className="block">{row.detail}</span>
                                <span className="block text-[11px] font-normal text-slate-500">
                                  {row.unitLabel} x{" "}
                                  {formatMoney(Math.abs(row.pricePerUnit))}
                                </span>
                              </span>
                              <span
                                className={`font-semibold ${row.total < 0 ? "text-emerald-700" : "text-slate-900"}`}
                              >
                                {row.total < 0 ? "-" : ""}
                                {formatMoney(Math.abs(row.total))}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </section>

                    <section className="mt-4 rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl">
                      <h2 className="text-lg font-semibold text-slate-900">
                        ข้อมูลประกอบ
                      </h2>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 text-sm text-slate-600">
                        <div className="rounded-2xl bg-slate-50 px-4 py-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            ผู้เช่า
                          </p>
                          <p className="mt-1 font-medium text-slate-800">
                            {activeInvoice.tenant_name}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-50 px-4 py-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            เลขที่บิล
                          </p>
                          <p className="mt-1 font-medium text-slate-800">
                            {shortInvoiceId(activeInvoice.id)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-50 px-4 py-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            รอบบิล
                          </p>
                          <p className="mt-1 font-medium text-slate-800">
                            {form.start_date || "-"} ถึง {form.end_date || "-"}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-50 px-4 py-3">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            ช่องทางชำระ
                          </p>
                          <p className="mt-1 font-medium text-slate-800">
                            {getPaymentMethodLabel(activeInvoice)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-50 px-4 py-3 sm:col-span-2">
                          <p className="text-xs uppercase tracking-wide text-slate-400">
                            หมายเหตุ
                          </p>
                          <p className="mt-1 font-medium text-slate-800">
                            {form.notes || "-"}
                          </p>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </div>

            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}