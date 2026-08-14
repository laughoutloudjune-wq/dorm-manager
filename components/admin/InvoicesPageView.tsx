"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { EmptyState, Tabs } from "@/components/ui/Page";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { getCarryForwardCandidatesForTarget } from "@/lib/invoice-ledger";
import { toNumber, roundTo2, formatMoney, toLocalDateString } from "@/lib/format";
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
  type FeeLineItem,
  type CarryForwardItem,
  type LateFeeLineItem,
  type TransferBreakdownItem,
  type AdditionalFee,
  type MeterReadingRow,
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

import { useInvoicesState } from "@/lib/hooks/use-invoices-state";
import { statusVariant } from "@/lib/invoice-utils"; // Need this for the UI

import { InvoiceProvider } from "./invoices/InvoiceContext";
import { SlipViewerModal } from "./invoices/SlipViewerModal";
import { SlipDeclineModal } from "./invoices/SlipDeclineModal";
import { LineSendModal } from "./invoices/LineSendModal";
import { InvoicePreviewModal } from "./invoices/InvoicePreviewModal";
import { InvoiceDetailModal } from "./invoices/InvoiceDetailModal";
import { OverdueRoomsTab } from "./invoices/OverdueRoomsTab";

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const focusRoom = searchParams.get("room") ?? "";
  const [viewMode, setViewMode] = useState<"monthly" | "overdue">(() =>
    searchParams.get("tab") === "overdue" ? "overdue" : "monthly",
  );
  const state = useInvoicesState();
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
    allVisibleSelected,
    modalProrateSummary,

  } = state;

  return (
    <InvoiceProvider state={state}>
    <div className="space-y-6">
      <Tabs
        value={viewMode}
        onChange={setViewMode}
        items={[
          { value: "monthly", label: "รายการบิล (รายเดือน)" },
          { value: "overdue", label: "สรุปห้องค้างชำระ" },
        ]}
      />

      {viewMode === "overdue" ? (
        <OverdueRoomsTab focusRoom={focusRoom} />
      ) : (
        <>
          <div className="rounded-card border border-slate-200 bg-white p-4 shadow-sm">
            {pendingMoveOutCount > 0 && (
          <div className="mb-3">
            <Badge variant="warning" className="text-xs font-semibold sm:text-sm">
              รอดำเนินการย้ายออก {pendingMoveOutCount} รายการ
            </Badge>
            <p className="mt-1 text-xs text-warning-900/80">
              นับรวม: คำขอสถานะรอตรวจ หรือผู้เช่าที่ตั้ง <span className="font-medium">วันย้ายออก</span> แล้ว
            </p>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-1">
          <Input
            label="เดือนใบแจ้งหนี้"
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          />
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              size={18}
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ค้นหาห้อง / ผู้เช่า / อาคาร / สถานะ / เลขบิล"
              className="w-full rounded-control border border-slate-200 bg-white py-3 pl-10 pr-4 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-600/40"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setConfirmGenerateOpen(true)}
            disabled={!canCreateInvoice}
            title={!canCreateInvoice ? "ไม่มีสิทธิ์สร้างใบแจ้งหนี้" : undefined}
            className={buttonClasses({ variant: "primary" })}
          >
            <FileText size={16} />
            สร้างใบแจ้งหนี้รายเดือน
          </button>
        </div>
      </div>

      {moveOutWarnings.length > 0 && (
        <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-900">
          <p className="font-semibold">มีคำขอย้ายออกในงวดนี้ {moveOutWarnings.length} รายการ</p>
          <div className="mt-1 space-y-1 text-xs">
            {moveOutWarnings.slice(0, 5).map((row: any) => {
              const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
              const room = Array.isArray(tenant?.rooms) ? tenant.rooms[0] : tenant?.rooms;
              return (
                <p key={row.id}>
                  {tenant?.full_name ?? "-"} | ห้อง {room?.room_number ?? "-"} | วันที่แจ้ง {row.requested_move_out_date}
                </p>
              );
            })}
          </div>
        </div>
      )}

      {error && <span className="text-sm text-danger-600">{error}</span>}

      {loading ? (
        <div className="space-y-4 animate-pulse">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <div className="h-6 w-32 rounded-lg bg-slate-200"></div>
              <div className="rounded-card border border-slate-100 bg-white">
                <div className="flex h-14 items-center gap-4 border-b border-slate-100 px-4">
                  <div className="h-4 w-24 rounded bg-slate-100"></div>
                  <div className="h-4 w-32 rounded bg-slate-100"></div>
                  <div className="h-4 w-16 rounded bg-slate-100"></div>
                </div>
                <div className="flex h-14 items-center gap-4 px-4">
                  <div className="h-4 w-24 rounded bg-slate-100"></div>
                  <div className="h-4 w-32 rounded bg-slate-100"></div>
                  <div className="h-4 w-16 rounded bg-slate-100"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !error && filteredInvoices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="h-5 w-5" />}
            title="ไม่พบใบแจ้งหนี้ตามคำค้นหา"
            description="ลองเปลี่ยนคำค้นหา หรือเลือกเดือนอื่น"
            action={
              invoices.length > 0 && search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch("")}>
                  ล้างคำค้นหา
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        Object.entries(grouped)
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
          .map(([building, buildingInvoices]) => (
          <div key={building} className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
            <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-sm">
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
                          {(invoice as any)._is_first_regular_invoice && (
                            <span
                              title={`ผู้เช่าเข้าใหม่ (${invoice.tenant_move_in_date})`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-success-200 bg-success-50 text-success-700"
                            >
                              <UserPlus size={12} />
                            </span>
                          )}
                          {(invoice as any)._is_waiting_for_move_out && (
                            <span
                              title={`เตรียมย้ายออก (${invoice.tenant_move_out_date})`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-warning-200 bg-warning-50 text-warning-700"
                            >
                              <LogOut size={12} />
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
                              ? "border-primary-200 bg-primary-50 text-primary-700"
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
                          <p className="mt-1 text-2xs font-medium text-warning-700">
                            มียอดค้างยกมา {formatMoney(invoice.carry_forward_amount)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-semibold text-success-700">
                        {formatMoney(toNumber(invoice.paid_amount))}
                      </td>
                      <td className="px-4 py-3 font-semibold text-danger-700">
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
                              ? "bg-success-100 text-success-700 hover:bg-success-200"
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
                            className={buttonClasses({ variant: "subtle", size: "sm" })}
                          >
                            เมนู
                          </button>
                          {openActionMenuId === invoice.id && (
                          <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-float-lg animate-soft-pop">
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenActionMenuId(null);
                                void openInvoice(invoice);
                              }}
                              disabled={!(canEditInvoice || canRecordInvoicePayment || canUpdateInvoiceStatus)}
                              title={!(canEditInvoice || canRecordInvoicePayment || canUpdateInvoiceStatus) ? "ไม่มีสิทธิ์เปิดแก้ไขใบแจ้งหนี้" : undefined}
                              className={buttonClasses({ variant: "subtle", size: "sm", fullWidth: true })}
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
                              className={buttonClasses({ variant: "subtle", size: "sm", fullWidth: true })}
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
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-success-700 hover:bg-success-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
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
                              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-danger-700 hover:bg-danger-50 disabled:cursor-not-allowed disabled:text-danger-300 disabled:hover:bg-transparent"
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
        <div className="fixed bottom-4 left-1/2 z-40 w-[min(90vw,720px)] -translate-x-1/2 rounded-card border border-slate-200 bg-white px-4 py-3 shadow-float-xl">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-700">เลือกแล้ว {selected.length} ใบแจ้งหนี้</span>
            <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={sendSelectedToLine}
                  className={buttonClasses({ variant: "success" })}
                >
                <Send size={14} />
                Send to LINE
              </button>
              <button
                onClick={() => {
                  const first = invoices.find((invoice) => selected.includes(invoice.id));
                  if (first) void getInvoicePrintDetail(first);
                }}
                className={buttonClasses({ variant: "secondary" })}
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
                className="inline-flex items-center gap-2 rounded-control border border-danger-200 px-3 py-2 text-danger-600 disabled:cursor-not-allowed disabled:text-danger-300"
              >
                <Trash2 size={14} />
                ลบ
              </button>
            </div>
          </div>
        </div>
      )}
      </>
    )}

        <InvoiceDetailModal />

        <SlipViewerModal />

        <SlipDeclineModal />

        <LineSendModal />

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

        <InvoicePreviewModal />
    </div>
    </InvoiceProvider>
  );
}
