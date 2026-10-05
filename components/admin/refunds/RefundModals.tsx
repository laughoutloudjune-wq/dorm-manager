"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Page";
import { postRefundAction } from "./api";
import {
  buildRecordPayoutBody,
  buildVoidPayoutBody,
  buildVoidSettlementBody,
  defaultPayoutForm,
  isReasonValid,
  validatePayoutForm,
  type PayoutForm,
} from "./form-logic";

const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RecordPayoutModal({
  target,
  onClose,
  onDone,
}: {
  target: { tenantId: string; tenantName: string | null; outstanding: number } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<PayoutForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string>("");

  // One idempotency key per modal open; reused on retry.
  useEffect(() => {
    if (target) {
      keyRef.current = crypto.randomUUID();
      setForm(defaultPayoutForm(target.outstanding, target.tenantName));
      setError(null);
      setBusy(false);
    }
  }, [target]);

  if (!target || !form) return null;
  const errors = validatePayoutForm(form, target.outstanding);
  const valid = Object.keys(errors).length === 0;
  const set = (k: keyof PayoutForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postRefundAction(buildRecordPayoutBody(target.tenantId, form, keyRef.current));
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={busy ? () => {} : onClose}
      title="บันทึกการจ่ายเงินคืน"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? "กำลังบันทึก..." : "บันทึกการจ่าย"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">
          ค่าเช่าล่วงหน้าไม่สามารถคืนเงินได้ แสดงเฉพาะเงินประกันที่เหลือหลังสรุปยอดย้ายออกเป็นยอดที่ต้องคืน
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <p className="text-sm text-slate-600">
          {target.tenantName ?? "-"} · ยอดค้างคืน {baht(target.outstanding)}
        </p>
        <Field label="จำนวนเงิน" required error={errors.amount}>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            max={target.outstanding}
            value={form.amount}
            onChange={set("amount")}
          />
        </Field>
        <Field label="วันเวลาที่จ่าย" required error={errors.paidAt}>
          <Input type="datetime-local" value={form.paidAt} onChange={set("paidAt")} />
        </Field>
        <Field label="ช่องทาง" required error={errors.method}>
          <Input value={form.method} onChange={set("method")} placeholder="เช่น โอนเงิน, เงินสด" />
        </Field>
        <Field label="ผู้รับ" required error={errors.recipient}>
          <Input value={form.recipient} onChange={set("recipient")} />
        </Field>
        <Field label="เลขอ้างอิง" hint="ต้องระบุเลขอ้างอิงหรือลิงก์หลักฐานอย่างน้อยหนึ่งอย่าง" error={errors.reference}>
          <Input value={form.reference} onChange={set("reference")} />
        </Field>
        <Field label="ลิงก์หลักฐาน (URL)">
          <Input type="url" value={form.evidenceUrl} onChange={set("evidenceUrl")} placeholder="https://" />
        </Field>
      </div>
    </Modal>
  );
}

function ReasonModal({
  open,
  title,
  confirmLabel,
  warning,
  summary,
  build,
  onClose,
  onDone,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  warning?: ReactNode;
  summary?: ReactNode;
  build: (reason: string) => Record<string, unknown>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postRefundAction(build(reason));
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={busy ? () => {} : onClose}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            ปิด
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!isReasonValid(reason) || busy}>
            {busy ? "กำลังดำเนินการ..." : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {warning}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {summary}
        <Field label="เหตุผล" required hint="จำเป็นต้องระบุ และจะถูกบันทึกในประวัติ">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function VoidPayoutModal({
  payout,
  onClose,
  onDone,
}: {
  payout: { id: string; amount: number; tenantName: string | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <ReasonModal
      open={!!payout}
      title="ยกเลิกรายการจ่ายเงินคืน"
      confirmLabel="ยกเลิกรายการจ่าย"
      summary={
        payout ? (
          <p className="text-sm text-slate-600">
            {payout.tenantName ?? "-"} · {baht(payout.amount)} ยอดนี้จะกลับมาเป็นยอดค้างคืน
          </p>
        ) : null
      }
      build={(reason) => buildVoidPayoutBody(payout?.id ?? "", reason)}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function VoidSettlementModal({
  settlement,
  onClose,
  onDone,
}: {
  settlement: { id: string; tenantName: string | null; roomNumber: string | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <ReasonModal
      open={!!settlement}
      title="ยกเลิกการสรุปยอดย้ายออก"
      confirmLabel="ยืนยันยกเลิกการสรุปยอด"
      warning={
        <Notice tone="warning" title="สิ่งที่จะถูกย้อนกลับ">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>การชำระแบบหักเครดิตในใบแจ้งหนี้เก่า</li>
            <li>รายการเงินประกันและค่าเช่าล่วงหน้า</li>
            <li>ใบแจ้งหนี้ปิดยอดจะถูกยกเลิก</li>
            <li>ผู้เช่าและห้องจะกลับสู่สถานะก่อนสรุปยอด</li>
          </ul>
          <p className="mt-2 text-sm">จะไม่สามารถยกเลิกได้หากมีรายการจ่ายเงินคืนที่ยังไม่ถูกยกเลิก</p>
        </Notice>
      }
      summary={
        settlement ? (
          <p className="text-sm text-slate-600">
            {settlement.tenantName ?? "-"}
            {settlement.roomNumber ? ` · ห้อง ${settlement.roomNumber}` : ""}
          </p>
        ) : null
      }
      build={(reason) => buildVoidSettlementBody(settlement?.id ?? "", reason)}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
