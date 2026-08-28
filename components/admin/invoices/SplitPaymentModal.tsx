"use client";
import React from "react";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, controlClasses } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Page";
import { useInvoiceContext } from "./InvoiceContext";
import { formatMoney, toNumber } from "@/lib/format";
import { formatPeriodLabel } from "@/lib/invoice-utils";

export function SplitPaymentModal() {
  const {
    activeInvoice,
    showSplitPaymentModal,
    splitPaymentInvoices,
    splitPaymentAmounts,
    splitPaymentLoading,
    splitPaymentSubmitting,
    closeSplitPaymentModal,
    updateSplitPaymentAmount,
    submitSplitPayment,
    paymentDate,
    setPaymentDate,
    canRecordInvoicePayment,
  } = useInvoiceContext();

  const [slipFile, setSlipFile] = React.useState<File | null>(null);

  const close = () => {
    if (splitPaymentSubmitting) return;
    setSlipFile(null);
    closeSplitPaymentModal();
  };

  const total = splitPaymentInvoices.reduce(
    (sum, invoice) => sum + toNumber(splitPaymentAmounts[invoice.id]),
    0,
  );
  const selectedCount = splitPaymentInvoices.filter(
    (invoice) => toNumber(splitPaymentAmounts[invoice.id]) > 0,
  ).length;

  const toggleInvoice = (invoiceId: string, outstanding: number) => {
    const current = toNumber(splitPaymentAmounts[invoiceId]);
    if (current > 0) {
      updateSplitPaymentAmount(invoiceId, "");
    } else {
      updateSplitPaymentAmount(invoiceId, String(outstanding));
    }
  };

  return (
    <Modal
      isOpen={showSplitPaymentModal}
      onClose={close}
      title="แบ่งชำระหลายงวด"
      description={
        activeInvoice
          ? `ห้อง ${activeInvoice.room_number} · ${activeInvoice.tenant_name}`
          : undefined
      }
      size="lg"
    >
      <div className="space-y-5">
        <Notice tone="info">
          เลือกงวดที่ต้องการนำเงินจำนวนนี้ไปตัดชำระ แล้วระบุจำนวนเงินของแต่ละงวดเอง —
          ไม่จำเป็นต้องตัดจากงวดเก่าสุดก่อน ยอดรวมด้านล่างคือยอดที่จะบันทึกวันนี้
        </Notice>

        {splitPaymentLoading ? (
          <div className="py-10 text-center text-sm font-medium text-slate-500">
            กำลังโหลดรายการค้างชำระ...
          </div>
        ) : splitPaymentInvoices.length === 0 ? (
          <div className="rounded-panel border border-dashed border-slate-300 bg-white py-10 text-center shadow-sm">
            <p className="text-sm font-bold text-slate-500">ผู้เช่ารายนี้ไม่มีใบแจ้งหนี้ค้างชำระ</p>
          </div>
        ) : (
          <div className="space-y-2">
            {splitPaymentInvoices.map((invoice) => {
              const amountValue = splitPaymentAmounts[invoice.id] ?? "";
              const isSelected = toNumber(amountValue) > 0;
              const enteredAmount = toNumber(amountValue);
              const overAmount = enteredAmount > invoice.outstanding + 0.005;
              return (
                <div
                  key={invoice.id}
                  className={`rounded-card border p-4 shadow-sm transition ease-float ${
                    isSelected ? "border-primary-300 bg-primary-50/40" : "border-slate-200 bg-white"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleInvoice(invoice.id, invoice.outstanding)}
                    className="flex w-full items-center justify-between gap-4 text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition ${
                          isSelected
                            ? "border-primary-600 bg-primary-600"
                            : "border-slate-300 bg-white"
                        }`}
                      >
                        {isSelected && (
                          <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
                            <path
                              d="M3.5 8.5l3 3 6-6.5"
                              stroke="white"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <div>
                        <p className="text-sm font-bold text-slate-900">
                          งวด {formatPeriodLabel(invoice.start_date)}
                        </p>
                        <p className="text-xs font-medium text-slate-500">
                          ค้างชำระ {formatMoney(invoice.outstanding)} บาท จากยอด{" "}
                          {formatMoney(invoice.total_amount)} บาท
                        </p>
                      </div>
                    </div>
                  </button>
                  {isSelected && (
                    <div className="mt-3 pl-8">
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={amountValue}
                        onChange={(event) =>
                          updateSplitPaymentAmount(invoice.id, event.target.value)
                        }
                        error={overAmount ? `เกินยอดค้างชำระ (${formatMoney(invoice.outstanding)})` : undefined}
                        className="max-w-[12rem]"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {splitPaymentInvoices.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="block text-sm font-medium text-slate-700">วันที่ชำระ</span>
              <input
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
                className={controlClasses()}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block text-sm font-medium text-slate-700">สลิปโอนเงิน (ถ้ามี)</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => setSlipFile(event.target.files?.[0] ?? null)}
                className={controlClasses({ className: "file:mr-3 file:rounded-control file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-bold" })}
              />
            </label>
          </div>
        )}

        <div className="flex items-center justify-between rounded-card border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="text-sm font-bold text-slate-600">
            {selectedCount > 0 ? `เลือกแล้ว ${selectedCount} งวด` : "ยังไม่ได้เลือกงวด"}
          </span>
          <span className="text-lg font-black text-primary-700">
            รวม {formatMoney(total)} บาท
          </span>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={close} disabled={splitPaymentSubmitting}>
            ยกเลิก
          </Button>
          <Button
            variant="success"
            onClick={() => void submitSplitPayment({ slipFile })}
            loading={splitPaymentSubmitting}
            disabled={!canRecordInvoicePayment || total <= 0}
          >
            บันทึกการชำระเงิน
          </Button>
        </div>
      </div>
    </Modal>
  );
}
