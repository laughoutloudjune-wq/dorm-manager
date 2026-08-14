"use client";
import React from "react";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Page";
import { useInvoiceContext } from "./InvoiceContext";

/**
 * Common reasons, offered as one-tap fills so the usual cases don't need typing.
 * Picking one replaces the box rather than appending — an admin who wants to add
 * detail edits from there.
 */
const PRESET_REASONS = [
  "ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ",
  "สลิปไม่ชัด อ่านรายละเอียดไม่ได้",
  "เป็นสลิปของรอบบิลอื่นที่ชำระไปแล้ว",
  "โอนเข้าบัญชีที่ไม่ถูกต้อง",
  "ไม่พบรายการเงินเข้าตามสลิปนี้",
];

export function SlipDeclineModal() {
  const {
    activeInvoice,
    declineModalOpen,
    setDeclineModalOpen,
    declineReason,
    setDeclineReason,
    declineSubmitting,
    declineSlip,
    canRecordInvoicePayment,
  } = useInvoiceContext();

  const close = () => {
    if (declineSubmitting) return;
    setDeclineModalOpen(false);
    setDeclineReason("");
  };

  return (
    <Modal
      isOpen={declineModalOpen}
      onClose={close}
      title="ปฏิเสธสลิปการชำระเงิน"
      size="md"
    >
      <div className="space-y-5">
        <Notice tone="warning">
          ใบแจ้งหนี้จะกลับไปเป็นสถานะรอชำระ และสลิปเดิมจะถูกนำออกเพื่อให้ผู้เช่าอัปโหลดใหม่
          ระบบจะแจ้งเตือนผู้เช่าทาง LINE พร้อมเหตุผลที่ระบุไว้
        </Notice>

        {activeInvoice && (
          <p className="text-sm text-slate-600">
            ห้อง <b className="text-slate-900">{activeInvoice.room_number}</b> · {activeInvoice.tenant_name}
          </p>
        )}

        <div className="space-y-2">
          <p className="text-sm font-bold text-slate-700">เหตุผลที่พบบ่อย</p>
          <div className="flex flex-wrap gap-2">
            {PRESET_REASONS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDeclineReason(preset)}
                disabled={declineSubmitting}
                className="rounded-control border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition ease-float hover:border-primary-300 hover:text-primary-700 disabled:opacity-50"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        <Textarea
          label="เหตุผล (ผู้เช่าจะเห็นข้อความนี้)"
          rows={3}
          value={declineReason}
          onChange={(event) => setDeclineReason(event.target.value)}
          placeholder="ระบุเหตุผลที่ปฏิเสธสลิปนี้"
          disabled={declineSubmitting}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={close} disabled={declineSubmitting}>
            ยกเลิก
          </Button>
          <Button
            variant="danger"
            onClick={() => void declineSlip()}
            loading={declineSubmitting}
            disabled={!canRecordInvoicePayment || !declineReason.trim()}
          >
            ปฏิเสธสลิป
          </Button>
        </div>
      </div>
    </Modal>
  );
}
