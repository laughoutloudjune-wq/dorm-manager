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

  const [activeTab, setActiveTab] = React.useState('preview');

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
        <div className="flex flex-col lg:flex-row h-full max-h-[85vh] bg-white overflow-hidden rounded-xl">
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
                  className={`w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold capitalize transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-70 ${statusPillClass(form.status)}`}
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
                    className={`w-full flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-all ${
                      isActive
                        ? "bg-blue-600 text-white shadow-md shadow-blue-200"
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
                <div className="flex justify-between text-sm text-emerald-600 mt-1.5">
                  <span>ชำระแล้ว</span>
                  <span className="font-semibold">{formatMoney(toNumber(form.paid_amount))}</span>
                </div>
                <div className="flex justify-between text-base text-rose-600 mt-3 font-bold border-t border-slate-100 pt-3">
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
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
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
                        setPreviewDocType(
                          activeInvoice.status === "paid" ? "receipt" : "invoice",
                        );
                        setPreviewInvoice(activeInvoice);
                        setPreviewOpen(true);
                      }}
                      className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                    >
                      <Printer size={16} /> พิมพ์
                    </button>
                    <button
                      onClick={() => sendToLine(activeInvoice)}
                      className="flex items-center gap-2 rounded-xl bg-[#06C755] px-4 py-2 text-sm font-semibold text-white hover:bg-[#05b34c] transition-colors shadow-sm"
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
                      className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 size={16} /> ลบ
                    </button>
                  </div>
                </div>

                {(!canEditInvoice || !canUpdateInvoiceStatus || !canRecordInvoicePayment) && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex gap-3">
                    <AlertCircle className="shrink-0" size={20} />
                    <span>บางส่วนถูกล็อกตามสิทธิ์ของผู้ใช้ (ปุ่มที่ล็อกจะแสดงเคอร์เซอร์ห้ามใช้งาน)</span>
                  </div>
                )}
                {!isInvoiceDetailEditable(activeInvoice.status) && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex gap-3">
                    <AlertCircle className="shrink-0" size={20} />
                    <span>ปิดการแก้ไขรายละเอียดสำหรับสถานะ <b>{statusLabelThai(activeInvoice.status)}</b> หากต้องการแก้ไข ให้เปลี่ยนสถานะเป็น <b>ฉบับร่าง</b></span>
                  </div>
                )}

                {/* THE LIVE PREVIEW CARD */}
                <div className="overflow-hidden rounded-3xl border border-slate-200 shadow-xl bg-white mt-8">
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
                        <p className="text-sm font-bold text-blue-600 uppercase tracking-widest">
                          {form.status === "paid" ? "RECEIPT" : "INVOICE"}
                        </p>
                        <h1 className="text-5xl font-black text-slate-900 mt-2">Room {activeInvoice.room_number}</h1>
                        <p className="text-sm font-semibold text-slate-500 mt-3">
                          รอบบิล: {form.start_date || "-"} ถึง {form.end_date || "-"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs uppercase tracking-widest text-slate-400 font-bold">ยอดรวมทั้งสิ้น</p>
                        <p className="text-5xl font-black text-emerald-600 mt-2 tracking-tighter">{formatMoney(toNumber(form.total_amount))}</p>
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
                            className={`flex items-center justify-between p-4 rounded-2xl transition-all hover:scale-[1.01] \${
                              row.tone === "amber"
                                ? "border border-amber-200 bg-amber-50 text-amber-900"
                                : row.tone === "sky"
                                  ? "border border-blue-200 bg-blue-50 text-blue-900"
                                  : "border border-slate-100 bg-slate-50 text-slate-800"
                            }`}
                          >
                            <span>
                              <span className="block font-bold text-base">{row.detail}</span>
                              <span className="block text-xs font-semibold mt-1 opacity-60">
                                {row.unitLabel} x {formatMoney(Math.abs(row.pricePerUnit))}
                              </span>
                            </span>
                            <span className={`font-black text-xl \${row.total < 0 ? "text-emerald-600" : ""}`}>
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
                  className={`space-y-8 \${!(canEditDetails && canEditInvoice) ? "opacity-70" : ""}`}
                >
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-slate-700">วันที่ออกบิล</label>
                      <input
                        type="date"
                        value={form.issue_date}
                        onChange={(event) => updateForm("issue_date", event.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm font-medium transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-slate-700">ครบกำหนดชำระ</label>
                      <input
                        type="date"
                        value={form.due_date}
                        onChange={(event) => updateForm("due_date", event.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm font-medium transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
                    <div className="flex items-center justify-between">
                      <h4 className="text-lg font-bold text-slate-800">ค่าเช่าห้องพัก</h4>
                      <p className="text-3xl font-black tracking-tight text-blue-600">{formatMoney(form.rent_amount)}</p>
                    </div>

                    {modalProrateSummary && (
                      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
                        <label className="flex items-center gap-3 font-semibold text-indigo-900 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useProrateInModal}
                            onChange={(e) => toggleProrateInModal(e.target.checked)}
                            className="w-5 h-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-600"
                          />
                          คิดค่าเช่าเฉลี่ยตามวัน (Prorate)
                        </label>
                        {useProrateInModal && (
                          <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-indigo-800">
                            <div className="bg-white/50 p-4 rounded-2xl">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">วันที่เข้าพัก</span>
                              <span className="block mt-1 font-black text-lg">{formatDateThai(activeInvoice.tenant_move_in_date)}</span>
                            </div>
                            <div className="bg-white/50 p-4 rounded-2xl">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">วันตัดรอบบิล</span>
                              <span className="block mt-1 font-black text-lg">{printSettings.billing_day || 1}</span>
                            </div>
                            <div className="bg-white/50 p-4 rounded-2xl">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-60">จำนวนวัน</span>
                              <span className="block mt-1 font-black text-lg">{modalProrateSummary.proratedDays} / {modalProrateSummary.daysInMonth} วัน</span>
                            </div>
                            <div className="bg-indigo-100 p-4 rounded-2xl shadow-sm">
                              <span className="block text-xs font-bold uppercase tracking-widest opacity-70">ค่าเช่าเฉลี่ย</span>
                              <span className="block mt-1 font-black text-2xl tracking-tighter">{formatMoney(modalProrateSummary.proratedAmount)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid lg:grid-cols-2 gap-6">
                    {/* Electricity */}
                    <div className="rounded-3xl border border-amber-200 bg-amber-50/50 p-6 space-y-5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-amber-900 flex items-center gap-2">
                          <AlertCircle size={20} className="text-amber-500" /> มิเตอร์ไฟฟ้า
                        </h4>
                        <p className="text-2xl font-black text-amber-700 tracking-tight">{formatMoney(form.electricity_bill)}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-amber-800 uppercase tracking-widest">เลขครั้งก่อน</label>
                          <input
                            type="number"
                            value={form.electricity_meter_prev}
                            onChange={(e) => updateUtilityUnits("electricity", "prev", e.target.value)}
                            className="w-full rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm text-right font-bold shadow-sm transition focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-amber-800 uppercase tracking-widest">เลขครั้งนี้</label>
                          <input
                            type="number"
                            value={form.electricity_meter_curr}
                            onChange={(e) => updateUtilityUnits("electricity", "curr", e.target.value)}
                            className="w-full rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm text-right font-black shadow-sm transition focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-amber-800 pt-3 border-t border-amber-200/50">
                        <span>ใช้ไป: {form.electricity_units} หน่วย</span>
                        <span>เรท: {form.electricity_rate}/หน่วย</span>
                      </div>
                    </div>

                    {/* Water */}
                    <div className="rounded-3xl border border-sky-200 bg-sky-50/50 p-6 space-y-5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sky-900 flex items-center gap-2">
                          <AlertCircle size={20} className="text-sky-500" /> มิเตอร์น้ำประปา
                        </h4>
                        <p className="text-2xl font-black text-sky-700 tracking-tight">{formatMoney(form.water_bill)}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-sky-800 uppercase tracking-widest">เลขครั้งก่อน</label>
                          <input
                            type="number"
                            value={form.water_meter_prev}
                            onChange={(e) => updateUtilityUnits("water", "prev", e.target.value)}
                            className="w-full rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm text-right font-bold shadow-sm transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-sky-800 uppercase tracking-widest">เลขครั้งนี้</label>
                          <input
                            type="number"
                            value={form.water_meter_curr}
                            onChange={(e) => updateUtilityUnits("water", "curr", e.target.value)}
                            className="w-full rounded-xl border border-sky-300 bg-white px-4 py-3 text-sm text-right font-black shadow-sm transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-sky-800 pt-3 border-t border-sky-200/50">
                        <span>ใช้ไป: {form.water_units} หน่วย</span>
                        <span>เรท: {form.water_rate}/หน่วย</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">หมายเหตุใบแจ้งหนี้</label>
                    <textarea
                      value={form.notes}
                      onChange={(event) => updateForm("notes", event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm font-medium shadow-sm transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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
                <h3 className="text-2xl font-bold text-slate-900">ค่าปรับและรายการอื่นๆ</h3>
                
                <fieldset disabled={!(canEditDetails && canEditInvoice)} className={!(canEditDetails && canEditInvoice) ? "opacity-70" : ""}>
                  
                  {/* Carry Forwards */}
                  <div className="rounded-3xl border border-amber-200 bg-white shadow-sm overflow-hidden">
                    <div className="bg-amber-50 px-6 py-5 border-b border-amber-200 flex justify-between items-center">
                      <h4 className="font-bold text-amber-900">ยอดยกมา (ค้างชำระ)</h4>
                      <button
                        type="button"
                        onClick={() => setEditableCarryForwardItems((prev) => [...prev, emptyCarryForwardItem()])}
                        className="text-xs font-bold text-amber-700 bg-amber-100 px-4 py-2 rounded-xl transition hover:bg-amber-200"
                      >
                        + เพิ่มยอดยกมา
                      </button>
                    </div>
                    <div className="p-6 bg-amber-50/10">
                      {editableCarryForwardItems.length === 0 ? (
                        <p className="text-sm text-amber-700/50 text-center py-6 font-bold">ไม่มียอดยกมา</p>
                      ) : (
                        <div className="space-y-4">
                          {editableCarryForwardItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateCarryForwardItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดยอดค้าง"
                                className="flex-1 rounded-xl border border-amber-200 px-4 py-3 text-sm font-semibold transition focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateCarryForwardItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-xl border border-amber-200 px-4 py-3 text-sm text-right font-bold transition focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
                              />
                              <span className="text-amber-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateCarryForwardItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-xl border border-amber-300 px-4 py-3 text-sm text-right font-black text-amber-700 transition focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableCarryForwardItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-red-400 p-3 hover:bg-red-50 hover:text-red-600 rounded-xl transition opacity-50 group-hover:opacity-100"
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
                  <div className="rounded-3xl border border-rose-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-rose-50 px-6 py-5 border-b border-rose-200 flex justify-between items-center">
                      <h4 className="font-bold text-rose-900">ค่าปรับล่าช้า</h4>
                      <button
                        type="button"
                        onClick={() => setEditableLateFeeItems((prev) => [...prev, emptyLateFeeItem()])}
                        className="text-xs font-bold text-rose-700 bg-rose-100 px-4 py-2 rounded-xl transition hover:bg-rose-200"
                      >
                        + เพิ่มค่าปรับ
                      </button>
                    </div>
                    <div className="p-6 bg-rose-50/10">
                      {editableLateFeeItems.length === 0 ? (
                        <p className="text-sm text-rose-700/50 text-center py-6 font-bold">ไม่มีค่าปรับ</p>
                      ) : (
                        <div className="space-y-4">
                          {editableLateFeeItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateLateFeeItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดค่าปรับ"
                                className="flex-1 rounded-xl border border-rose-200 px-4 py-3 text-sm font-semibold transition focus:border-rose-400 focus:ring-1 focus:ring-rose-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateLateFeeItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-xl border border-rose-200 px-4 py-3 text-sm text-right font-bold transition focus:border-rose-400 focus:ring-1 focus:ring-rose-400"
                              />
                              <span className="text-rose-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateLateFeeItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-xl border border-rose-300 px-4 py-3 text-sm text-right font-black text-rose-700 transition focus:border-rose-400 focus:ring-1 focus:ring-rose-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableLateFeeItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-red-400 p-3 hover:bg-red-50 hover:text-red-600 rounded-xl transition opacity-50 group-hover:opacity-100"
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
                  <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-slate-50 px-6 py-5 border-b border-slate-200 flex justify-between items-center">
                      <h4 className="font-bold text-slate-800">รายการค่าธรรมเนียมเพิ่มเติม</h4>
                      <button
                        type="button"
                        onClick={() => setEditableFeeItems((prev) => [...prev, emptyFeeItem()])}
                        className="text-xs font-bold text-slate-700 bg-slate-200 px-4 py-2 rounded-xl transition hover:bg-slate-300"
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
                                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold transition focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateFeeItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-xl border border-slate-200 px-4 py-3 text-sm text-right font-bold transition focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                              />
                              <span className="text-slate-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateFeeItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-xl border border-slate-300 px-4 py-3 text-sm text-right font-black transition focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableFeeItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-red-400 p-3 hover:bg-red-50 hover:text-red-600 rounded-xl transition opacity-50 group-hover:opacity-100"
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
                  <div className="rounded-3xl border border-emerald-200 bg-white shadow-sm overflow-hidden mt-8">
                    <div className="bg-emerald-50 px-6 py-5 border-b border-emerald-200 flex justify-between items-center">
                      <h4 className="font-bold text-emerald-800">รายการส่วนลด</h4>
                      <button
                        type="button"
                        onClick={() => setEditableDiscountItems((prev) => [...prev, emptyFeeItem()])}
                        className="text-xs font-bold text-emerald-700 bg-emerald-100 px-4 py-2 rounded-xl transition hover:bg-emerald-200"
                      >
                        + เพิ่มส่วนลด
                      </button>
                    </div>
                    <div className="p-6 bg-emerald-50/20">
                      {editableDiscountItems.length === 0 ? (
                        <p className="text-sm text-emerald-700/50 text-center py-6 font-bold">ไม่มีรายการส่วนลด</p>
                      ) : (
                        <div className="space-y-4">
                          {editableDiscountItems.map((item, index) => (
                            <div key={index} className="flex gap-3 items-center group">
                              <input
                                type="text"
                                value={item.detail}
                                onChange={(e) => updateDiscountItem(index, "detail", e.target.value)}
                                placeholder="รายละเอียดส่วนลด"
                                className="flex-1 rounded-xl border border-emerald-200 px-4 py-3 text-sm font-semibold transition focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                              />
                              <input
                                type="number"
                                value={item.unit}
                                onChange={(e) => updateDiscountItem(index, "unit", e.target.value)}
                                placeholder="หน่วย"
                                className="w-24 rounded-xl border border-emerald-200 px-4 py-3 text-sm text-right font-bold transition focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                              />
                              <span className="text-emerald-300 font-bold">x</span>
                              <input
                                type="number"
                                value={item.price_per_unit}
                                onChange={(e) => updateDiscountItem(index, "price_per_unit", e.target.value)}
                                placeholder="ราคา"
                                className="w-32 rounded-xl border border-emerald-300 px-4 py-3 text-sm text-right font-black text-emerald-700 transition focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                              />
                              <button
                                type="button"
                                onClick={() => setEditableDiscountItems((prev) => prev.filter((_, idx) => idx !== index))}
                                className="text-red-400 p-3 hover:bg-red-50 hover:text-red-600 rounded-xl transition opacity-50 group-hover:opacity-100"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                </fieldset>
              </div>
            )}

            {/* TAB: PAYMENTS */}
            {activeTab === 'payments' && (
              <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <h3 className="text-2xl font-bold text-slate-900">ประวัติการชำระเงิน</h3>
                
                {(!Array.isArray(activeInvoice.payment_history) || activeInvoice.payment_history.length === 0) ? (
                  <div className="rounded-3xl border border-dashed border-slate-300 py-16 text-center bg-white shadow-sm">
                    <p className="text-slate-500 font-bold">ยังไม่มีประวัติการชำระเงินสำหรับใบแจ้งหนี้นี้</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activeInvoice.payment_history.map((payment, idx) => (
                      <div key={idx} className="flex justify-between items-center p-6 rounded-3xl border border-slate-200 shadow-sm bg-white transition hover:shadow-md">
                        <div className="flex items-center gap-5">
                          <div className="h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 shadow-inner">
                            <CheckCircle2 size={28} />
                          </div>
                          <div>
                            <p className="font-black text-slate-900 text-lg">
                              {payment.amount === toNumber(activeInvoice.total_amount) ? "ชำระเต็มจำนวน" : "ชำระบางส่วน"}
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
                                  className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-bold text-blue-600 hover:bg-blue-50 transition"
                                >
                                  ดูสลิป
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-3xl font-black text-emerald-600 tracking-tighter">{formatMoney(payment.amount)}</p>
                          <button
                            onClick={() => cancelPaymentEntry(idx)}
                            disabled={!canRecordInvoicePayment || paymentSubmitting}
                            className="text-xs font-bold text-rose-500 hover:text-rose-700 mt-2 disabled:opacity-50 transition"
                          >
                            ยกเลิกรายการ
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* NEW PAYMENT FORM */}
                <div className="mt-10 pt-8 border-t border-slate-200">
                  <h4 className="text-xl font-bold text-slate-900 mb-6">เพิ่มการชำระเงินใหม่</h4>
                  
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
                    <div className="grid sm:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-slate-700">วันที่ชำระ</label>
                        <input
                          type="date"
                          value={paymentDate}
                          onChange={(e) => setPaymentDate(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm shadow-sm font-medium transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-slate-700">จำนวนเงิน</label>
                        <input
                          type="number"
                          value={paymentAmountInput}
                          onChange={(e) => setPaymentAmountInput(e.target.value)}
                          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm shadow-sm font-black text-emerald-700 transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                          placeholder="กรอกจำนวนเงิน"
                        />
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <label className="text-sm font-bold text-slate-700">สลิปโอนเงิน (ถ้ามี)</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => setPaymentSlipFile(e.target.files?.[0] ?? null)}
                          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm bg-slate-50 file:border-0 file:bg-white file:px-4 file:py-2 file:rounded-xl file:mr-4 file:text-sm file:font-bold shadow-inner"
                        />
                        {slipPreview && (
                          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
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
                                  className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-blue-50 transition shadow-sm"
                                >
                                  เปิดภาพเต็ม
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deletePaymentSlip()}
                                  disabled={!canRecordInvoicePayment || paymentSubmitting}
                                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 transition shadow-sm"
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
                              className="block w-full overflow-hidden rounded-xl border border-slate-200 bg-white hover:border-blue-300 transition"
                            >
                              <img
                                src={slipPreview}
                                alt="สลิป"
                                className="max-h-64 w-full object-contain p-2"
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
                        className="rounded-xl bg-emerald-600 px-8 py-3 text-base font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 shadow-sm"
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

