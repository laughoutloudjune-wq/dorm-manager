"use client";

import { Modal } from "@/components/ui/Modal";
import { useInvoiceContext } from "./InvoiceContext";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Loader2, Plus, Printer, Save, Search, Trash2, UploadCloud, Mail, CheckCircle2, FileText, MailOpen, AlertCircle } from "lucide-react";
import { formatMoney, toLocalDateString } from "@/lib/format";
import { 
  isInvoiceDetailEditable,
  formatPeriodLabel, 
  formatDateThai,
  calculateProratedRentByBillingDay,
  resolveWaterUsageForDisplay,
  resolveElectricityUsageForDisplay,
  toTransferBreakdownItems,
  toCarryForwardRows,
  toLateFeeItems,
  toLateFeeRows,
  shortInvoiceId,
  toChargeFeeRows
} from "@/lib/invoice-utils";
import { toNumber } from "@/lib/format";


export function InvoicePreviewModal() {
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
                              {resolveWaterUsageForDisplay(
                                previewReading,
                                toNumber(previewInvoice.water_bill),
                                toNumber(printSettings?.water_rate),
                              ).toLocaleString("th-TH")}{" "}
                              หน่วย
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatMoney(toNumber(printSettings?.water_rate))}
                            </td>
                            <td className="px-3 py-2 text-right">{formatMoney(previewInvoice.water_bill)}</td>
                          </tr>
                          <tr className="border-t border-slate-100">
                            <td className="px-3 py-2">ค่าไฟ</td>
                            <td className="px-3 py-2 text-right">
                              {resolveElectricityUsageForDisplay(
                                previewReading,
                                toNumber(previewInvoice.electricity_bill),
                                toNumber(printSettings?.electricity_rate),
                              ).toLocaleString("th-TH")}{" "}
                              หน่วย
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
                          {toLateFeeItems(toLateFeeRows(previewInvoice.additional_fees_breakdown ?? [])).length > 0 ? (
                            toLateFeeItems(toLateFeeRows(previewInvoice.additional_fees_breakdown ?? [])).map((row, index) => (
                              <tr key={`preview-late-fee-${row.source_invoice_id ?? "manual"}-${index}`} className="border-t border-amber-100 bg-amber-50/40">
                                <td className="px-3 py-2">
                                  {row.detail || `ค่าปรับล่าช้า - บิล ${shortInvoiceId(row.source_invoice_id)}`}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  {toNumber(row.days_overdue ?? row.unit).toLocaleString("th-TH")} วัน
                                </td>
                                <td className="px-3 py-2 text-right">
                                  {formatMoney(toNumber(row.daily_rate ?? row.price_per_unit))}
                                </td>
                                <td className="px-3 py-2 text-right font-semibold text-amber-900">
                                  {formatMoney(row.total_amount)}
                                </td>
                              </tr>
                            ))
                          ) : previewArrearsSnapshots.length > 0 ? (
                            previewArrearsSnapshots.map((row) => (
                              <tr key={`preview-late-fee-snapshot-${row.id}`} className="border-t border-amber-100 bg-amber-50/40">
                                <td className="px-3 py-2">
                                  ค่าปรับล่าช้า - บิล {shortInvoiceId(row.source_invoice_id)} (คำนวณถึง{" "}
                                  {formatDateThai(row.snapshot_as_of)})
                                </td>
                                <td className="px-3 py-2 text-right">
                                  {row.days_overdue.toLocaleString("th-TH")} วัน
                                </td>
                                <td className="px-3 py-2 text-right">{formatMoney(row.daily_rate)}</td>
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
  );
}
