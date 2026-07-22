"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { MoveOutRequestRow, SettingsRates, MoveOutFeeLine } from "@/types";
import { toNumber, formatMoney } from "@/lib/format";
import { getInvoiceOutstanding } from "@/lib/invoice-ledger";
import { bangkokYmd, meets30DayMoveOutNotice } from "@/lib/move-out-notice";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { buttonClasses } from "@/components/ui/Button";
import {
  CheckCircle2,
  XCircle,
  Ban,
  Loader2,
  Plus,
  Trash2,
  AlertTriangle,
  ClipboardList,
  Zap,
  Droplets,
  ChevronRight,
  ChevronLeft,
  Home,
  FileText,
  Calculator,
  Flag,
  TrendingDown,
  TrendingUp,
  ReceiptText,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type MoveOutWizardForm = {
  full_name: string;
  advance_rent_amount: number;
  security_deposit_amount: number;
  final_electricity_reading: number;
  final_water_reading: number;
  move_out_request_date: string;
  final_move_out_date: string;
};

type InvoiceHistoryRow = {
  id: string;
  start_date: string;
  end_date: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string;
  electricity_reading_end?: number | null;
  water_reading_end?: number | null;
};

type Props = {
  activeTenant: any | null;
  activeMoveOutRequest: MoveOutRequestRow | null;
  rates: SettingsRates;
  form: MoveOutWizardForm;
  setForm: (updater: (prev: MoveOutWizardForm) => MoveOutWizardForm) => void;
  forfeitDeposit: boolean;
  setForfeitDeposit: (v: boolean) => void;
  useProrate: boolean;
  setUseProrate: (v: boolean) => void;
  moveOutFeeLines: MoveOutFeeLine[];
  setMoveOutFeeLines: React.Dispatch<React.SetStateAction<MoveOutFeeLine[]>>;
  latestPrevElectricity: number;
  latestPrevWater: number;
  tenantInvoiceHistory: InvoiceHistoryRow[];
  outstandingMoveOutInvoices: InvoiceHistoryRow[];
  unpaidInvoicesSubtotal: number;
  latestBilledEndYmd: string | null;
  tailDaysAfterBilledPeriod: number;
  appliedMoveOutRentBase: number;
  roomNumber: string;
  canEditTenant: boolean;
  isMovingOut: boolean;
  isCancellingMoveOut: boolean;
  onApprove: () => Promise<void> | void;
  onDecline: () => Promise<void> | void;
  onCancelMoveOut: () => Promise<void> | void;
  onConfirmMoveOut: () => Promise<void> | void;
  onAbandonRoom: (forfeitDeposit: boolean, moveOutDate: string) => Promise<void>;
};

// ─── Step Definitions ──────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "คำขอย้ายออก", icon: ClipboardList },
  { id: 2, label: "มิเตอร์", icon: Zap },
  { id: 3, label: "สรุปค่าใช้จ่าย", icon: Calculator },
  { id: 4, label: "ยืนยัน", icon: Flag },
] as const;

// ─── Sub-components ────────────────────────────────────────────────────────────

function StepRail({ currentStep, onStepClick }: { currentStep: number; onStepClick: (s: number) => void }) {
  return (
    <div className="flex flex-col gap-1 py-2">
      {STEPS.map((step, idx) => {
        const Icon = step.icon;
        const isActive = currentStep === step.id;
        const isDone = currentStep > step.id;
        return (
          <div key={step.id} className="relative">
            <button
              type="button"
              onClick={() => onStepClick(step.id)}
              className={`
                group flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-all duration-200
                ${isActive
                  ? "bg-primary-600 text-white shadow-float-md"
                  : isDone
                    ? "bg-success-50 text-success-700 hover:bg-success-100"
                    : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
                }
              `}
            >
              <span className={`
                flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-bold transition-all
                ${isActive ? "bg-white/20" : isDone ? "bg-success-100" : "bg-slate-100"}
              `}>
                {isDone ? <CheckCircle2 className="h-4 w-4 text-success-600" /> : <Icon className="h-3.5 w-3.5" />}
              </span>
              <span className="text-base font-semibold leading-tight">{step.label}</span>
              {isActive && <ChevronRight className="ml-auto h-4 w-4 opacity-60" />}
            </button>
            {idx < STEPS.length - 1 && (
              <div className={`ml-[22px] mt-0.5 mb-0.5 h-4 w-0.5 ${isDone ? "bg-success-200" : "bg-slate-100"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-slate-200/80 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function LineItem({ label, value, sub, className = "" }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div>
        <span className="text-base text-slate-600">{label}</span>
        {sub && <p className="text-sm text-slate-400">{sub}</p>}
      </div>
      <span className="shrink-0 text-base font-semibold text-slate-800 tabular-nums">{value}</span>
    </div>
  );
}

// ─── Step 1: Request Review ─────────────────────────────────────────────────────

function Step1RequestReview({
  activeMoveOutRequest,
  form,
  setForm,
  isCancellingMoveOut,
  outstandingMoveOutInvoices,
  unpaidInvoicesSubtotal,
  onApprove,
  onDecline,
  onCancelMoveOut,
  onNext,
}: {
  activeMoveOutRequest: MoveOutRequestRow | null;
  form: MoveOutWizardForm;
  setForm: Props["setForm"];
  isCancellingMoveOut: boolean;
  outstandingMoveOutInvoices: InvoiceHistoryRow[];
  unpaidInvoicesSubtotal: number;
  onApprove: () => Promise<void> | void;
  onDecline: () => Promise<void> | void;
  onCancelMoveOut: () => Promise<void> | void;
  onNext: () => void;
}) {
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);

  const noticeYmd = useMemo(() => {
    if (!activeMoveOutRequest) return "";
    if (activeMoveOutRequest.notice_date) return String(activeMoveOutRequest.notice_date).slice(0, 10);
    if (activeMoveOutRequest.created_at) return bangkokYmd(new Date(activeMoveOutRequest.created_at));
    return "";
  }, [activeMoveOutRequest]);

  // Tracks the date the admin is *about* to approve (form.move_out_request_date),
  // not the tenant's original ask — so if the admin corrects a wrong date, the
  // 30-day warning updates to reflect what's actually about to be saved.
  const shortNotice =
    Boolean(activeMoveOutRequest && noticeYmd && form.move_out_request_date) &&
    !meets30DayMoveOutNotice(noticeYmd, form.move_out_request_date);

  const isPending = activeMoveOutRequest?.status === "requested";
  const isApproved = activeMoveOutRequest?.status === "approved";

  const setField = <K extends keyof MoveOutWizardForm>(key: K, value: MoveOutWizardForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await onApprove();
    } finally {
      setIsApproving(false);
    }
  };

  const handleDecline = async () => {
    setIsDeclining(true);
    try {
      await onDecline();
    } finally {
      setIsDeclining(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">คำขอย้ายออก</h2>
        <p className="mt-1 text-base text-slate-500">ตรวจสอบรายละเอียดคำขอและกำหนดวันย้ายออก</p>
      </div>

      {/* No request — admin-set date or fresh */}
      {!activeMoveOutRequest && (
        <SectionCard className="border-dashed border-slate-200">
          <div className="flex items-center gap-3 text-slate-400">
            <ClipboardList className="h-5 w-5 shrink-0" />
            <div>
              <p className="text-base font-medium text-slate-600">ไม่มีคำขอย้ายออกจากผู้เช่า</p>
              <p className="text-sm text-slate-400 mt-0.5">แอดมินตั้งวันย้ายออกโดยตรง หรือยังไม่มีคำขอ</p>
            </div>
          </div>
        </SectionCard>
      )}

      {/* Pending Request */}
      {activeMoveOutRequest && (
        <SectionCard className={isPending ? "border-warning-200 bg-warning-50/60" : isApproved ? "border-success-200 bg-success-50/60" : "border-slate-200"}>
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <ClipboardList className={`h-4 w-4 ${isPending ? "text-warning-600" : isApproved ? "text-success-600" : "text-slate-500"}`} />
              <p className="font-semibold text-slate-900 text-base">คำขอย้ายออกจากผู้เช่า</p>
            </div>
            <span className={`
              inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold
              ${isPending ? "bg-warning-100 text-warning-800" : isApproved ? "bg-success-100 text-success-800" : "bg-slate-100 text-slate-600"}
            `}>
              {isPending ? "รอตรวจสอบ" : isApproved ? "อนุมัติแล้ว" : activeMoveOutRequest.status}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-base mb-4">
            <div className="rounded-control bg-white/70 px-3 py-2.5 border border-white">
              <p className="text-sm text-slate-400 mb-1">วันที่แจ้ง</p>
              <p className="font-semibold text-slate-800">{noticeYmd || "—"}</p>
            </div>
            <div className="rounded-control bg-white/70 px-3 py-2.5 border border-white">
              <p className="text-sm text-slate-400 mb-1">ผู้เช่าต้องการย้ายออก</p>
              <p className="font-semibold text-slate-800">{String(activeMoveOutRequest.requested_move_out_date || "—")}</p>
            </div>
          </div>

          {activeMoveOutRequest.request_note && (
            <div className="rounded-control bg-white/70 border border-slate-100 px-3 py-2.5 mb-4">
              <p className="text-sm text-slate-400 mb-1">หมายเหตุจากผู้เช่า</p>
              <p className="text-base text-slate-700">{activeMoveOutRequest.request_note}</p>
            </div>
          )}

          {/* The date this admin is about to approve — defaults to what the tenant
              asked for (see MoveOutProcessingModal's fetcher), but stays editable
              here so a wrong date from the tenant can be corrected before saving,
              and can be corrected again later even after approval. */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-500 mb-1.5">
              {isPending ? "วันที่จะอนุมัติให้ย้ายออก" : "วันที่อนุมัติ (แก้ไขได้หากผิดพลาด)"}
            </label>
            <input
              type="date"
              value={form.move_out_request_date}
              onChange={(e) => setField("move_out_request_date", e.target.value)}
              className={`w-full rounded-control border px-3 py-2.5 text-base focus:outline-none focus:ring-2 ${
                isApproved
                  ? "border-success-200 bg-success-50/70 text-success-900 focus:border-success-400 focus:ring-success-200"
                  : "border-slate-200 bg-white text-slate-800 focus:border-primary-400 focus:ring-primary-200"
              }`}
            />
          </div>

          {shortNotice && (
            <div className="flex items-start gap-2 rounded-control bg-warning-100 px-3 py-2.5 text-sm text-warning-800 mb-4">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>วันที่นี้ใกล้กว่า 30 วันจากวันที่แจ้ง — ตรวจสอบเงินประกันตามสัญญา</span>
            </div>
          )}

          {/* Approve (pending) / re-save the corrected date (already approved) */}
          {(isPending || isApproved) && (
            <div className="flex flex-wrap gap-2 mt-1">
              <button
                type="button"
                onClick={handleApprove}
                disabled={isApproving || isDeclining}
                className={buttonClasses({ variant: "success", size: "lg" })}
              >
                {isApproving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {isApproving ? "กำลังบันทึก..." : isPending ? "อนุมัติคำขอ" : "บันทึกวันที่แก้ไข"}
              </button>
              {isPending && (
                <button
                  type="button"
                  onClick={handleDecline}
                  disabled={isApproving || isDeclining}
                  className="inline-flex items-center gap-2 rounded-control border border-danger-200 bg-white px-4 py-2 text-base font-semibold text-danger-600 hover:bg-danger-50 transition-colors disabled:opacity-50"
                >
                  {isDeclining ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                  {isDeclining ? "กำลังปฏิเสธ..." : "ปฏิเสธ"}
                </button>
              )}
            </div>
          )}
        </SectionCard>
      )}

      {/* Actual settlement date — separate from the approved move-out date above:
          this is what the meter-reading and proration math in later steps uses,
          and only needs to change from the approved date if the tenant's actual
          departure slipped. */}
      <SectionCard>
        <p className="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <Home className="h-4 w-4 text-primary-500" />
          วันที่ย้ายออกจริง
        </p>
        <input
          type="date"
          value={form.final_move_out_date}
          onChange={(e) => setField("final_move_out_date", e.target.value)}
          className="w-full max-w-xs rounded-control border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200"
        />
        <p className="mt-2 text-sm text-slate-500">ใช้คำนวณค่าเช่า ค่าน้ำไฟ และเงินประกันในขั้นตอนถัดไป</p>
      </SectionCard>

      {/* Outstanding invoices */}
      {outstandingMoveOutInvoices.length > 0 && (
        <SectionCard className="border-warning-200 bg-warning-50/50">
          <div className="flex items-center justify-between mb-3">
            <p className="text-base font-semibold text-warning-900 flex items-center gap-2">
              <ReceiptText className="h-4 w-4" />
              บิลค้างชำระ ({outstandingMoveOutInvoices.length} รายการ)
            </p>
            <Link href="/invoices" className="text-sm font-medium text-warning-700 underline hover:text-warning-600">
              ดูใบแจ้งหนี้
            </Link>
          </div>
          <div className="space-y-2">
            {outstandingMoveOutInvoices.map((inv) => (
              <div key={inv.id} className="flex justify-between items-center rounded-control bg-white/70 px-3 py-2 border border-warning-100/80">
                <span className="text-sm text-slate-600">
                  {String(inv.start_date ?? "").slice(0, 10)} → {String(inv.end_date ?? "").slice(0, 10)}
                  <span className="ml-1.5 rounded-md bg-warning-100 px-1.5 py-0.5 text-warning-700 font-medium">{inv.status}</span>
                </span>
                <span className="text-base font-bold text-warning-900">฿{formatMoney(getInvoiceOutstanding(inv))}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between rounded-control bg-warning-100 px-3 py-2">
            <span className="text-sm font-medium text-warning-800">รวมยอดค้าง</span>
            <span className="text-base font-bold text-warning-900">฿{formatMoney(unpaidInvoicesSubtotal)}</span>
          </div>
        </SectionCard>
      )}

      {/* Cancel move-out */}
      {activeMoveOutRequest && (
        <button
          type="button"
          onClick={() => setConfirmCancelOpen(true)}
          disabled={isCancellingMoveOut}
          className={buttonClasses({ variant: "secondary", size: "lg" })}
        >
          <Ban className="h-4 w-4" />
          {isCancellingMoveOut ? "กำลังดำเนินการ…" : "ยกเลิกกระบวนการย้ายออก"}
        </button>
      )}

      {/* Next */}
      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={onNext}
          className={buttonClasses({ variant: "primary", size: "lg" })}
        >
          ถัดไป: มิเตอร์ <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <ConfirmActionModal
        isOpen={confirmCancelOpen}
        onCancel={() => setConfirmCancelOpen(false)}
        onConfirm={() => { setConfirmCancelOpen(false); onCancelMoveOut(); }}
        title="ยืนยันการยกเลิกย้ายออก"
        message="ระบบจะล้างวันย้ายออกและยกเลิกคำขอที่รอ/อนุมัติแล้ว ผู้เช่าจะยังพักอยู่ตามปกติ"
        confirmLabel="ยืนยันการยกเลิก"
      />
    </div>
  );
}

// ─── Step 2: Meter Readings ─────────────────────────────────────────────────────

function Step2MeterReadings({
  form,
  setForm,
  latestPrevElectricity,
  latestPrevWater,
  rates,
  onBack,
  onNext,
}: {
  form: MoveOutWizardForm;
  setForm: Props["setForm"];
  latestPrevElectricity: number;
  latestPrevWater: number;
  rates: SettingsRates;
  onBack: () => void;
  onNext: () => void;
}) {
  const setField = <K extends keyof MoveOutWizardForm>(key: K, value: MoveOutWizardForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const elecUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const elecCost = elecUsage * rates.electricity_rate;
  const waterCost = waterUsage * rates.water_rate;

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">มิเตอร์ ณ วันย้ายออก</h2>
        <p className="mt-1 text-base text-slate-500">กรอกเลขมิเตอร์ที่อ่านได้วันย้ายออก เพื่อคำนวณค่าสาธารณูปโภค</p>
      </div>

      {/* Electricity */}
      <SectionCard className="border-warning-200 bg-gradient-to-br from-warning-50/60 to-warning-50/40">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-control bg-warning-100">
            <Zap className="h-4 w-4 text-warning-600" />
          </div>
          <p className="font-semibold text-slate-800">ไฟฟ้า</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 mb-4">
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1.5">เลขมิเตอร์ครั้งก่อน</label>
            <div className="flex h-11 items-center rounded-control border border-slate-200 bg-white/80 px-3 text-base text-slate-700 select-none">
              <span className="text-slate-400 mr-2">อ่านล่าสุด:</span>
              <span className="font-mono font-semibold">{latestPrevElectricity}</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1.5">เลขมิเตอร์ปัจจุบัน (ย้ายออก)</label>
            <input
              type="number"
              min={latestPrevElectricity}
              value={form.final_electricity_reading}
              onChange={(e) => setField("final_electricity_reading", toNumber(e.target.value))}
              className="w-full rounded-control border border-warning-200 bg-white px-3 py-2.5 text-base font-mono text-slate-800 focus:border-warning-400 focus:outline-none focus:ring-2 focus:ring-warning-100"
              placeholder={String(latestPrevElectricity)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-control bg-warning-100/80 px-4 py-3">
          <span className="text-base text-warning-800">
            การใช้: <span className="font-bold font-mono">{elecUsage}</span> หน่วย × ฿{rates.electricity_rate}
          </span>
          <span className="text-base font-bold text-warning-900">฿{formatMoney(elecCost)}</span>
        </div>
      </SectionCard>

      {/* Water */}
      <SectionCard className="border-primary-200 bg-gradient-to-br from-primary-50/60 to-cyan-50/40">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-control bg-primary-100">
            <Droplets className="h-4 w-4 text-primary-600" />
          </div>
          <p className="font-semibold text-slate-800">น้ำประปา</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 mb-4">
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1.5">เลขมิเตอร์ครั้งก่อน</label>
            <div className="flex h-11 items-center rounded-control border border-slate-200 bg-white/80 px-3 text-base text-slate-700 select-none">
              <span className="text-slate-400 mr-2">อ่านล่าสุด:</span>
              <span className="font-mono font-semibold">{latestPrevWater}</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1.5">เลขมิเตอร์ปัจจุบัน (ย้ายออก)</label>
            <input
              type="number"
              min={latestPrevWater}
              value={form.final_water_reading}
              onChange={(e) => setField("final_water_reading", toNumber(e.target.value))}
              className="w-full rounded-control border border-primary-200 bg-white px-3 py-2.5 text-base font-mono text-slate-800 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
              placeholder={String(latestPrevWater)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between rounded-control bg-primary-100/80 px-4 py-3">
          <span className="text-base text-primary-800">
            การใช้: <span className="font-bold font-mono">{waterUsage}</span> หน่วย × ฿{rates.water_rate}
          </span>
          <span className="text-base font-bold text-primary-900">฿{formatMoney(waterCost)}</span>
        </div>
      </SectionCard>

      {/* Mini summary */}
      <SectionCard>
        <p className="text-base font-semibold text-slate-700 mb-3">รวมค่าสาธารณูปโภค</p>
        <div className="space-y-2">
          <LineItem label="ค่าไฟฟ้า" value={`฿${formatMoney(elecCost)}`} sub={`${elecUsage} หน่วย`} />
          <LineItem label="ค่าน้ำประปา" value={`฿${formatMoney(waterCost)}`} sub={`${waterUsage} หน่วย`} />
          <div className="pt-2 border-t border-dashed border-slate-200">
            <LineItem label="รวม" value={`฿${formatMoney(elecCost + waterCost)}`} className="font-semibold" />
          </div>
        </div>
      </SectionCard>

      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          className={buttonClasses({ variant: "secondary", size: "lg" })}
        >
          <ChevronLeft className="h-4 w-4" /> ย้อนกลับ
        </button>
        <button
          type="button"
          onClick={onNext}
          className={buttonClasses({ variant: "primary", size: "lg" })}
        >
          ถัดไป: สรุปค่าใช้จ่าย <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Financial Summary ─────────────────────────────────────────────────

function Step3FinancialSummary({
  form,
  setForm,
  forfeitDeposit,
  setForfeitDeposit,
  useProrate,
  setUseProrate,
  moveOutFeeLines,
  setMoveOutFeeLines,
  rates,
  latestPrevElectricity,
  latestPrevWater,
  unpaidInvoicesSubtotal,
  outstandingMoveOutInvoices,
  appliedMoveOutRentBase,
  tailDaysAfterBilledPeriod,
  latestBilledEndYmd,
  roomNumber,
  activeMoveOutRequest,
  onBack,
  onNext,
}: {
  form: MoveOutWizardForm;
  setForm: Props["setForm"];
  forfeitDeposit: boolean;
  setForfeitDeposit: (v: boolean) => void;
  useProrate: boolean;
  setUseProrate: (v: boolean) => void;
  moveOutFeeLines: MoveOutFeeLine[];
  setMoveOutFeeLines: React.Dispatch<React.SetStateAction<MoveOutFeeLine[]>>;
  rates: SettingsRates;
  latestPrevElectricity: number;
  latestPrevWater: number;
  unpaidInvoicesSubtotal: number;
  outstandingMoveOutInvoices: InvoiceHistoryRow[];
  appliedMoveOutRentBase: number;
  tailDaysAfterBilledPeriod: number;
  latestBilledEndYmd: string | null;
  roomNumber: string;
  activeMoveOutRequest: MoveOutRequestRow | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const elecUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const elecCost = elecUsage * rates.electricity_rate;
  const waterCost = waterUsage * rates.water_rate;
  const additionalFeesTotal = moveOutFeeLines.reduce((s, l) => s + toNumber(l.amount), 0);

  const overstayDays = tailDaysAfterBilledPeriod;
  const roomPrice = useMemo(() => {
    if (!form) return 0;
    return 0; // price is baked into appliedMoveOutRentBase
  }, [form]);
  const overstayRentCharge = 0; // included in appliedMoveOutRentBase from parent

  const totalCost = unpaidInvoicesSubtotal + appliedMoveOutRentBase + elecCost + waterCost + additionalFeesTotal;
  const refundableDeposit = forfeitDeposit ? 0 : toNumber(form.security_deposit_amount);
  const forfeitedDepositAmount = forfeitDeposit ? toNumber(form.security_deposit_amount) : 0;
  const prepaid = refundableDeposit + toNumber(form.advance_rent_amount);
  const net = prepaid - totalCost;

  const createFeeLine = (): MoveOutFeeLine => ({ id: crypto.randomUUID(), label: "", amount: 0 });

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">สรุปค่าใช้จ่าย</h2>
        <p className="mt-1 text-base text-slate-500">ตรวจสอบและปรับแต่งรายการค่าใช้จ่ายก่อนยืนยัน</p>
      </div>

      {/* Charges breakdown */}
      <SectionCard>
        <p className="text-base font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-danger-400" />
          รายการค่าใช้จ่าย
        </p>
        <div className="space-y-2.5">
          {unpaidInvoicesSubtotal > 0 && (
            <LineItem
              label={`บิลค้างชำระ (${outstandingMoveOutInvoices.length} รายการ)`}
              value={`฿${formatMoney(unpaidInvoicesSubtotal)}`}
              className="text-warning-700"
            />
          )}
          <LineItem
            label={latestBilledEndYmd
              ? `ค่าเช่า (หลังบิล ${latestBilledEndYmd})`
              : "ค่าเช่าห้อง"}
            value={`฿${formatMoney(appliedMoveOutRentBase)}`}
          />
          <LineItem
            label="ค่าไฟฟ้า"
            sub={`มิเตอร์ ${toNumber(form.final_electricity_reading)} - ${latestPrevElectricity} = ${elecUsage} หน่วย`}
            value={`฿${formatMoney(elecCost)}`}
          />
          <LineItem
            label="ค่าน้ำ"
            sub={`มิเตอร์ ${toNumber(form.final_water_reading)} - ${latestPrevWater} = ${waterUsage} หน่วย`}
            value={`฿${formatMoney(waterCost)}`}
          />
          {moveOutFeeLines.filter(l => l.label.trim() && toNumber(l.amount) > 0).map(l => (
            <LineItem key={l.id} label={l.label.trim()} value={`฿${formatMoney(toNumber(l.amount))}`} />
          ))}
          <div className="pt-2 mt-1 border-t border-dashed border-slate-200">
            <LineItem
              label="รวมค่าใช้จ่ายทั้งหมด"
              value={`฿${formatMoney(totalCost)}`}
              className="font-bold text-slate-900 text-base"
            />
          </div>
        </div>
      </SectionCard>

      {/* Additional fees */}
      <SectionCard>
        <div className="flex items-center justify-between mb-4">
          <p className="text-base font-semibold text-slate-700 flex items-center gap-2">
            <Plus className="h-4 w-4 text-slate-400" />
            ค่าใช้จ่ายเพิ่มเติม
          </p>
          <button
            type="button"
            onClick={() => setMoveOutFeeLines(prev => [...prev, createFeeLine()])}
            className={buttonClasses({ variant: "subtle", size: "sm" })}
          >
            <Plus className="h-3.5 w-3.5" /> เพิ่มรายการ
          </button>
        </div>
        {moveOutFeeLines.length === 0 && (
          <p className="text-base text-slate-400 text-center py-3">ยังไม่มีค่าใช้จ่ายเพิ่มเติม</p>
        )}
        <div className="space-y-2">
          {moveOutFeeLines.map(line => (
            <div key={line.id} className="flex gap-2 items-start">
              <input
                type="text"
                placeholder="รายการ (เช่น ค่าซ่อมแซม)"
                value={line.label}
                onChange={e => setMoveOutFeeLines(prev => prev.map(item => item.id === line.id ? { ...item, label: e.target.value } : item))}
                className="flex-1 rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-base focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
              <input
                type="number"
                placeholder="จำนวน"
                value={line.amount}
                onChange={e => setMoveOutFeeLines(prev => prev.map(item => item.id === line.id ? { ...item, amount: toNumber(e.target.value) } : item))}
                className="w-28 rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-base font-mono focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
              <button
                type="button"
                onClick={() => setMoveOutFeeLines(prev => prev.filter(item => item.id !== line.id))}
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-danger-100 text-danger-400 hover:border-danger-200 hover:bg-danger-50 hover:text-danger-600 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Credits & Deposit */}
      <SectionCard>
        <p className="text-base font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-success-500" />
          เครดิต / การหักคืน
        </p>
        <div className="space-y-2.5">
          <LineItem
            label="ค่าเช่าล่วงหน้า"
            value={`฿${formatMoney(toNumber(form.advance_rent_amount))}`}
            className="text-success-700"
          />
          <LineItem
            label={forfeitDeposit ? "เงินประกัน (ริบ — ไม่คืน)" : "เงินประกัน"}
            value={forfeitDeposit ? `−฿${formatMoney(toNumber(form.security_deposit_amount))}` : `฿${formatMoney(toNumber(form.security_deposit_amount))}`}
            className={forfeitDeposit ? "text-danger-500 line-through" : "text-success-700"}
          />
          <div className="pt-2 mt-1 border-t border-dashed border-slate-200">
            <LineItem
              label="รวมเครดิต"
              value={`฿${formatMoney(prepaid)}`}
              className="font-bold text-success-700 text-base"
            />
          </div>
        </div>
      </SectionCard>

      {/* Forfeit deposit toggle */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-card border border-danger-200 bg-danger-50/60 px-4 py-4">
          <div className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={forfeitDeposit}
              onChange={e => setForfeitDeposit(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-5 w-5 rounded-md border-2 border-danger-300 bg-white peer-checked:border-danger-600 peer-checked:bg-danger-600 transition-all" />
            {forfeitDeposit && (
              <CheckCircle2 className="absolute h-3.5 w-3.5 text-white pointer-events-none" />
            )}
          </div>
          <div>
            <p className="text-base font-semibold text-danger-800">ริบเงินประกัน (ไม่คืนเงินประกัน)</p>
            <p className="mt-0.5 text-sm text-danger-600">ใช้กรณีผิดสัญญา ระบบจะไม่คืนเงินประกัน</p>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-card border border-slate-200 bg-white px-4 py-4">
          <div className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={useProrate}
              onChange={e => setUseProrate(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-5 w-5 rounded-md border-2 border-slate-300 bg-white peer-checked:border-primary-600 peer-checked:bg-primary-600 transition-all" />
            {useProrate && (
              <CheckCircle2 className="absolute h-3.5 w-3.5 text-white pointer-events-none" />
            )}
          </div>
          <div>
            <p className="text-base font-semibold text-slate-800">คิดค่าเช่าเฉลี่ยตามวัน (Prorate)</p>
            <p className="mt-0.5 text-sm text-slate-500">หากปิดใช้งาน จะไม่เรียกเก็บค่าเช่าในรอบบิลสุดท้าย</p>
          </div>
        </label>
      </div>

      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          className={buttonClasses({ variant: "secondary", size: "lg" })}
        >
          <ChevronLeft className="h-4 w-4" /> ย้อนกลับ
        </button>
        <button
          type="button"
          onClick={onNext}
          className={buttonClasses({ variant: "primary", size: "lg" })}
        >
          ถัดไป: ยืนยัน <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Confirmation ──────────────────────────────────────────────────────

function Step4Confirm({
  form,
  forfeitDeposit,
  moveOutFeeLines,
  rates,
  latestPrevElectricity,
  latestPrevWater,
  unpaidInvoicesSubtotal,
  appliedMoveOutRentBase,
  roomNumber,
  activeMoveOutRequest,
  isMovingOut,
  isCancellingMoveOut,
  canEditTenant,
  activeTenant,
  outstandingMoveOutInvoices,
  onBack,
  onConfirmMoveOut,
  onAbandonRoom,
  onCancelMoveOut,
}: {
  form: MoveOutWizardForm;
  forfeitDeposit: boolean;
  moveOutFeeLines: MoveOutFeeLine[];
  rates: SettingsRates;
  latestPrevElectricity: number;
  latestPrevWater: number;
  unpaidInvoicesSubtotal: number;
  appliedMoveOutRentBase: number;
  roomNumber: string;
  activeMoveOutRequest: MoveOutRequestRow | null;
  isMovingOut: boolean;
  isCancellingMoveOut: boolean;
  canEditTenant: boolean;
  activeTenant: any;
  outstandingMoveOutInvoices: any[];
  onBack: () => void;
  onConfirmMoveOut: () => Promise<void> | void;
  onAbandonRoom: (forfeit: boolean, date: string) => Promise<void>;
  onCancelMoveOut: () => Promise<void> | void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonMode, setAbandonMode] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [isAbandoning, setIsAbandoning] = useState(false);

  const elecUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const elecCost = elecUsage * rates.electricity_rate;
  const waterCost = waterUsage * rates.water_rate;
  const additionalFeesTotal = moveOutFeeLines.reduce((s, l) => s + toNumber(l.amount), 0);
  const totalCost = unpaidInvoicesSubtotal + appliedMoveOutRentBase + elecCost + waterCost + additionalFeesTotal;
  const refundableDeposit = forfeitDeposit ? 0 : toNumber(form.security_deposit_amount);
  const prepaid = refundableDeposit + toNumber(form.advance_rent_amount);
  const net = prepaid - totalCost;
  const isRefund = net >= 0;

  const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);

  const handleAbandonment = async () => {
    setIsAbandoning(true);
    try {
      await onAbandonRoom(forfeitDeposit, moveOutDate);
    } finally {
      setIsAbandoning(false);
      setAbandonOpen(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">ยืนยันการย้ายออก</h2>
        <p className="mt-1 text-base text-slate-500">ตรวจสอบข้อมูลสุดท้ายก่อนบันทึก</p>
      </div>

      {/* Tenant info card */}
      <SectionCard>
        <div className="grid grid-cols-2 gap-3 text-base">
          <div>
            <p className="text-sm text-slate-400 mb-0.5">ผู้เช่า</p>
            <p className="font-semibold text-slate-800">{form.full_name || "—"}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400 mb-0.5">ห้อง</p>
            <p className="font-semibold text-slate-800">{roomNumber || "—"}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400 mb-0.5">วันที่ย้ายออกจริง</p>
            <p className="font-semibold text-slate-800">{moveOutDate}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400 mb-0.5">สถานะเงินประกัน</p>
            <p className={`font-semibold ${forfeitDeposit ? "text-danger-600" : "text-success-700"}`}>
              {forfeitDeposit ? "ริบ (ไม่คืน)" : "คืนเต็มจำนวน"}
            </p>
          </div>
        </div>
      </SectionCard>

      {/* Net amount — hero display */}
      <div className={`
        relative overflow-hidden rounded-card px-6 py-6 text-center
        ${isRefund
          ? "bg-gradient-to-br from-success-500 to-success-600"
          : "bg-gradient-to-br from-danger-500 to-danger-600"
        }
      `}>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -top-4 -right-4 h-24 w-24 rounded-full bg-white" />
          <div className="absolute -bottom-6 -left-6 h-32 w-32 rounded-full bg-white" />
        </div>
        <p className="relative text-base font-medium text-white/80 mb-1">
          {isRefund ? "คืนเงินให้ผู้เช่า" : "ผู้เช่าต้องชำระเพิ่ม"}
        </p>
        <p className="relative text-4xl font-black text-white tracking-tight">
          ฿{formatMoney(Math.abs(net))}
        </p>
        <div className="relative mt-3 flex justify-center gap-6 text-sm text-white/70">
          <span>ค่าใช้จ่ายรวม ฿{formatMoney(totalCost)}</span>
          <span>เครดิต ฿{formatMoney(prepaid)}</span>
        </div>
      </div>

      {/* Cost summary table */}
      <SectionCard>
        <p className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">รายละเอียดทั้งหมด</p>
        <div className="space-y-2 text-base">
          {unpaidInvoicesSubtotal > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-warning-700">
                <span>บิลค้างชำระ ({outstandingMoveOutInvoices?.length || 0} รายการ)</span>
                <span className="font-semibold tabular-nums">฿{formatMoney(unpaidInvoicesSubtotal)}</span>
              </div>
              <div className="pl-4 space-y-1 text-sm text-slate-500">
                {outstandingMoveOutInvoices?.map((inv: any) => {
                  const remaining = Math.max(0, inv.total_amount - (inv.paid_amount || 0));
                  if (remaining <= 0) return null;
                  return (
                    <div key={inv.id} className="flex justify-between">
                      <span>รอบบิล {inv.start_date ? String(inv.start_date).slice(0, 7) : "ไม่ระบุ"}</span>
                      <span className="tabular-nums">฿{formatMoney(remaining)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex justify-between text-slate-600">
            <span>ค่าเช่า</span>
            <span className="font-semibold tabular-nums">฿{formatMoney(appliedMoveOutRentBase)}</span>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-slate-600">
              <span>ค่าไฟ + น้ำ</span>
              <span className="font-semibold tabular-nums">฿{formatMoney(elecCost + waterCost)}</span>
            </div>
            <div className="pl-4 space-y-1 text-sm text-slate-500">
              {elecUsage > 0 && (
                <div className="flex justify-between">
                  <span>
                    ค่าไฟ ({latestPrevElectricity} → {toNumber(form.final_electricity_reading)}) = {elecUsage} หน่วย
                  </span>
                  <span className="tabular-nums">฿{formatMoney(elecCost)}</span>
                </div>
              )}
              {waterUsage > 0 && (
                <div className="flex justify-between">
                  <span>
                    ค่าน้ำ ({latestPrevWater} → {toNumber(form.final_water_reading)}) = {waterUsage} หน่วย
                  </span>
                  <span className="tabular-nums">฿{formatMoney(waterCost)}</span>
                </div>
              )}
            </div>
          </div>
          {additionalFeesTotal > 0 && (
            <div className="flex justify-between text-slate-600">
              <span>ค่าใช้จ่ายอื่น</span>
              <span className="font-semibold tabular-nums">฿{formatMoney(additionalFeesTotal)}</span>
            </div>
          )}
          <div className="pt-2 border-t border-dashed border-slate-200 flex justify-between font-bold text-slate-900">
            <span>รวมค่าใช้จ่าย</span>
            <span className="tabular-nums">฿{formatMoney(totalCost)}</span>
          </div>
          <div className="flex justify-between text-success-700">
            <span>ค่าเช่าล่วงหน้า</span>
            <span className="font-semibold tabular-nums">−฿{formatMoney(toNumber(form.advance_rent_amount))}</span>
          </div>
          <div className={`flex justify-between ${forfeitDeposit ? "text-danger-400 line-through" : "text-success-700"}`}>
            <span>เงินประกัน</span>
            <span className="font-semibold tabular-nums">−฿{formatMoney(toNumber(form.security_deposit_amount))}</span>
          </div>
        </div>
      </SectionCard>

      {/* Abandon room toggle */}
      <label className="flex cursor-pointer items-start gap-3 rounded-card border border-warning-200 bg-warning-50/60 px-4 py-4">
        <div className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={abandonMode}
            onChange={e => setAbandonMode(e.target.checked)}
            className="peer sr-only"
          />
          <div className="h-5 w-5 rounded-md border-2 border-warning-300 bg-white peer-checked:border-warning-600 peer-checked:bg-warning-600 transition-all" />
          {abandonMode && (
            <CheckCircle2 className="absolute h-3.5 w-3.5 text-white pointer-events-none" />
          )}
        </div>
        <div>
          <p className="text-base font-semibold text-warning-900">ผู้เช่าทิ้งห้อง</p>
          <p className="mt-0.5 text-sm text-warning-700">
            ระบบจะใช้เครดิต (ค่าเช่าล่วงหน้า{!forfeitDeposit ? " + เงินประกัน" : ""}) หักบิลค้างชำระตามลำดับ
            บิลที่เหลือจะถูกยกเลิก และผู้เช่าถูกย้ายออกทันที (ไม่สร้างใบแจ้งหนี้สุดท้าย)
          </p>
        </div>
      </label>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onBack}
          className={buttonClasses({ variant: "secondary", size: "lg" })}
        >
          <ChevronLeft className="h-4 w-4" /> ย้อนกลับ
        </button>

        <div className="flex flex-wrap gap-2">
          {(activeTenant?.move_out_date || activeMoveOutRequest) && (
            <button
              type="button"
              onClick={() => setConfirmCancelOpen(true)}
              disabled={isCancellingMoveOut}
              className="inline-flex items-center gap-2 rounded-control border border-warning-200 bg-warning-50 px-4 py-2.5 text-base font-semibold text-warning-800 hover:bg-warning-100 transition-colors disabled:opacity-50"
            >
              <Ban className="h-4 w-4" />
              {isCancellingMoveOut ? "กำลังยกเลิก…" : "ยกเลิกการย้ายออก"}
            </button>
          )}

          {abandonMode ? (
            <button
              type="button"
              onClick={() => setAbandonOpen(true)}
              disabled={!canEditTenant || isAbandoning}
              className="inline-flex items-center gap-2 rounded-control bg-warning-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-warning-700 shadow-sm transition-all disabled:opacity-50"
            >
              {isAbandoning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              {isAbandoning ? "กำลังดำเนินการ…" : "ยืนยันทิ้งห้อง"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={!canEditTenant || isMovingOut}
              className={buttonClasses({ variant: "primary", size: "lg" })}
            >
              {isMovingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
              {isMovingOut ? "กำลังบันทึก…" : "ยืนยันการย้ายออก"}
            </button>
          )}
        </div>
      </div>

      {/* Confirm modals */}
      <ConfirmActionModal
        isOpen={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); onConfirmMoveOut(); }}
        title="ยืนยันการย้ายออก"
        message={`ยืนยันการย้ายออกของ "${form.full_name || "ผู้เช่า"}" จากห้อง ${roomNumber}? ระบบจะสร้างใบแจ้งหนี้สุดท้าย เปลี่ยนสถานะผู้เช่าเป็น "ย้ายออกแล้ว" และเปลี่ยนสถานะห้องเป็น "ว่าง"`}
        confirmLabel="ยืนยันการย้ายออก"
      />
      <ConfirmActionModal
        isOpen={abandonOpen}
        onCancel={() => setAbandonOpen(false)}
        onConfirm={handleAbandonment}
        title="ยืนยันผู้เช่าทิ้งห้อง"
        message={`ยืนยันว่า "${form.full_name || "ผู้เช่า"}" ทิ้งห้อง ${roomNumber}? ระบบจะใช้เครดิต ฿${formatMoney(prepaid)} หักบิลค้างชำระตามลำดับ บิลที่เหลือถูกยกเลิก และผู้เช่าถูกย้ายออกทันที การดำเนินการนี้ไม่สามารถย้อนกลับได้`}
        confirmLabel="ยืนยันทิ้งห้อง"
        loading={isAbandoning}
      />
      <ConfirmActionModal
        isOpen={confirmCancelOpen}
        onCancel={() => setConfirmCancelOpen(false)}
        onConfirm={() => { setConfirmCancelOpen(false); onCancelMoveOut(); }}
        title="ยืนยันการยกเลิกย้ายออก"
        message="ระบบจะล้างวันย้ายออกและยกเลิกคำขอที่รอ/อนุมัติแล้ว ผู้เช่าจะยังพักอยู่ตามปกติ"
        confirmLabel="ยืนยันการยกเลิก"
      />
    </div>
  );
}

// ─── Main Wizard Component ─────────────────────────────────────────────────────

export function MoveOutWizard({
  activeTenant,
  activeMoveOutRequest,
  rates,
  form,
  setForm,
  forfeitDeposit,
  setForfeitDeposit,
  useProrate,
  setUseProrate,
  moveOutFeeLines,
  setMoveOutFeeLines,
  latestPrevElectricity,
  latestPrevWater,
  tenantInvoiceHistory,
  outstandingMoveOutInvoices,
  unpaidInvoicesSubtotal,
  latestBilledEndYmd,
  tailDaysAfterBilledPeriod,
  appliedMoveOutRentBase,
  roomNumber,
  canEditTenant,
  isMovingOut,
  isCancellingMoveOut,
  onApprove,
  onDecline,
  onCancelMoveOut,
  onConfirmMoveOut,
  onAbandonRoom,
}: Props) {
  const [step, setStep] = useState(1);

  const goTo = (s: number) => {
    if (s >= 1 && s <= STEPS.length) {
      setStep(s);
      try {
        if (typeof window !== "undefined" && window.scrollTo) {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } catch (e) {
        // Ignore scrollTo errors on older browsers
      }
    }
  };

  return (
    <div className="flex gap-0 min-h-[480px]">
      {/* Left rail */}
      <div className="w-44 shrink-0 border-r border-slate-100 pr-4 pt-1">
        <p className="text-2xs font-bold uppercase tracking-widest text-slate-400 mb-3 px-3">ขั้นตอน</p>
        <StepRail currentStep={step} onStepClick={goTo} />
      </div>

      {/* Right content */}
      <div className="flex-1 min-w-0 pl-6 pt-1">
        <fieldset disabled={!canEditTenant} className="disabled:cursor-not-allowed disabled:opacity-70">
          {step === 1 && (
            <Step1RequestReview
              activeMoveOutRequest={activeMoveOutRequest}
              form={form}
              setForm={setForm}
              isCancellingMoveOut={isCancellingMoveOut}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              unpaidInvoicesSubtotal={unpaidInvoicesSubtotal}
              onApprove={onApprove}
              onDecline={onDecline}
              onCancelMoveOut={onCancelMoveOut}
              onNext={() => goTo(2)}
            />
          )}
          {step === 2 && (
            <Step2MeterReadings
              form={form}
              setForm={setForm}
              latestPrevElectricity={latestPrevElectricity}
              latestPrevWater={latestPrevWater}
              rates={rates}
              onBack={() => goTo(1)}
              onNext={() => goTo(3)}
            />
          )}
          {step === 3 && (
            <Step3FinancialSummary
              form={form}
              setForm={setForm}
              forfeitDeposit={forfeitDeposit}
              setForfeitDeposit={setForfeitDeposit}
              useProrate={useProrate}
              setUseProrate={setUseProrate}
              moveOutFeeLines={moveOutFeeLines}
              setMoveOutFeeLines={setMoveOutFeeLines}
              rates={rates}
              latestPrevElectricity={latestPrevElectricity}
              latestPrevWater={latestPrevWater}
              unpaidInvoicesSubtotal={unpaidInvoicesSubtotal}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              appliedMoveOutRentBase={appliedMoveOutRentBase}
              tailDaysAfterBilledPeriod={tailDaysAfterBilledPeriod}
              latestBilledEndYmd={latestBilledEndYmd}
              roomNumber={roomNumber}
              activeMoveOutRequest={activeMoveOutRequest}
              onBack={() => goTo(2)}
              onNext={() => goTo(4)}
            />
          )}
          {step === 4 && (
            <Step4Confirm
              form={form}
              forfeitDeposit={forfeitDeposit}
              moveOutFeeLines={moveOutFeeLines}
              rates={rates}
              latestPrevElectricity={latestPrevElectricity}
              latestPrevWater={latestPrevWater}
              unpaidInvoicesSubtotal={unpaidInvoicesSubtotal}
              appliedMoveOutRentBase={appliedMoveOutRentBase}
              roomNumber={roomNumber}
              activeMoveOutRequest={activeMoveOutRequest}
              isMovingOut={isMovingOut}
              isCancellingMoveOut={isCancellingMoveOut}
              canEditTenant={canEditTenant}
              activeTenant={activeTenant}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              onBack={() => goTo(3)}
              onConfirmMoveOut={onConfirmMoveOut}
              onAbandonRoom={onAbandonRoom}
              onCancelMoveOut={onCancelMoveOut}
            />
          )}
        </fieldset>
      </div>
    </div>
  );
}
