"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { MoveOutRequestRow, SettingsRates, MoveOutFeeLine } from "@/types";
import { toNumber, formatMoney } from "@/lib/format";
import { getInvoiceOwnOutstanding } from "@/lib/invoice-ledger";
import type { MoveOutSettlementPlan } from "@/lib/money/settlement";
import type { HeldCredit, MoveOutRentPeriod } from "@/lib/money/move-out-settlement-input";
import { controlClasses } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Page";
import {
  ForfeitControls,
  SettlementBreakdown,
  forfeitReasonMissing,
  type ForfeitState,
} from "./MoveOutSettlementBreakdown";
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

/** One unbilled late fee on an older invoice, as returned by get_move_out_late_fees. */
export type MoveOutLateFeeItem = {
  invoiceId: string;
  periodStart: string;
  periodEnd: string | null;
  daysOverdue: number | null;
  dailyRate: number;
  amount: number;
  locked: boolean;
  label: string;
};

export type MoveOutLateFeeVoidState = Record<string, { voided: boolean; reason: string }>;

export type MoveOutLateFeesUi = {
  status: "loading" | "ready" | "error";
  error?: string;
  items: MoveOutLateFeeItem[];
  voids: MoveOutLateFeeVoidState;
  setVoid: (invoiceId: string, patch: Partial<{ voided: boolean; reason: string }>) => void;
};

/** True when a voided late fee has no reason yet. */
export const lateFeeVoidReasonMissing = (lf: MoveOutLateFeesUi) =>
  lf.items.some((i) => lf.voids[i.invoiceId]?.voided && !lf.voids[i.invoiceId]?.reason.trim());

/** Late fees can't be silently skipped: confirm stays blocked until they loaded and voids have reasons. */
export const lateFeesBlockConfirm = (lf: MoveOutLateFeesUi) => lf.status !== "ready" || lateFeeVoidReasonMissing(lf);

function LateFeeRowAmount({ item, voided }: { item: MoveOutLateFeeItem; voided: boolean }) {
  return (
    <span className={`font-mono font-semibold ${voided ? "text-slate-400 line-through" : "text-slate-800"}`}>
      ฿{formatMoney(item.amount)}
    </span>
  );
}

function lateFeeDetail(item: MoveOutLateFeeItem) {
  return item.daysOverdue == null
    ? "ล็อกยอดแล้ว"
    : `${item.daysOverdue} วัน × ${formatMoney(item.dailyRate)} บาท`;
}

type Props = {
  lateFees: MoveOutLateFeesUi;
  activeTenant: any | null;
  activeMoveOutRequest: MoveOutRequestRow | null;
  rates: SettingsRates;
  form: MoveOutWizardForm;
  setForm: (updater: (prev: MoveOutWizardForm) => MoveOutWizardForm) => void;
  forfeitDeposit: boolean;
  forfeit: ForfeitState;
  setForfeit: (next: ForfeitState) => void;
  heldCredit: HeldCredit;
  settlementPlan: MoveOutSettlementPlan | null;
  abandonPlan: MoveOutSettlementPlan | null;
  rentPeriod: MoveOutRentPeriod;
  existingSettlement: any | null;
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
  forfeitDeposit,
  forfeit,
  setForfeit,
  heldCredit,
  abandonPlan,
  roomNumber,
  canEditTenant,
  isCancellingMoveOut,
  outstandingMoveOutInvoices,
  unpaidInvoicesSubtotal,
  onApprove,
  onDecline,
  onCancelMoveOut,
  onAbandonRoom,
  onNext,
}: {
  activeMoveOutRequest: MoveOutRequestRow | null;
  form: MoveOutWizardForm;
  setForm: Props["setForm"];
  forfeitDeposit: boolean;
  forfeit: ForfeitState;
  setForfeit: (next: ForfeitState) => void;
  heldCredit: HeldCredit;
  abandonPlan: MoveOutSettlementPlan | null;
  roomNumber: string;
  canEditTenant: boolean;
  isCancellingMoveOut: boolean;
  outstandingMoveOutInvoices: InvoiceHistoryRow[];
  unpaidInvoicesSubtotal: number;
  onApprove: () => Promise<void> | void;
  onDecline: () => Promise<void> | void;
  onCancelMoveOut: () => Promise<void> | void;
  onAbandonRoom: (forfeit: boolean, date: string) => Promise<void>;
  onNext: () => void;
}) {
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonMode, setAbandonMode] = useState(false);
  const [isAbandoning, setIsAbandoning] = useState(false);

  const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);
  // Preview of the abandon settlement: the same planner and inputs the API
  // runs (advance rent first, then deposit, oldest debt first), so what the
  // admin approves here is exactly what gets written.
  const abandonPeriodById = useMemo(
    () =>
      new Map(
        outstandingMoveOutInvoices.map((inv: any) => [
          String(inv.id),
          String(inv.start_date ?? "").slice(0, 10),
        ]),
      ),
    [outstandingMoveOutInvoices],
  );

  const handleAbandonment = async () => {
    if (forfeitReasonMissing(forfeit)) {
      toast.error("กรุณาระบุเหตุผลการริบเงินประกัน");
      setAbandonOpen(false);
      return;
    }
    setIsAbandoning(true);
    try {
      await onAbandonRoom(forfeitDeposit, moveOutDate);
    } finally {
      setIsAbandoning(false);
      setAbandonOpen(false);
    }
  };

  const noticeYmd = useMemo(() => {
    if (!activeMoveOutRequest) return "";
    if (activeMoveOutRequest.notice_date) return String(activeMoveOutRequest.notice_date).slice(0, 10);
    if (activeMoveOutRequest.created_at) return bangkokYmd(new Date(activeMoveOutRequest.created_at));
    return "";
  }, [activeMoveOutRequest]);

  const shortNotice =
    Boolean(activeMoveOutRequest?.requested_move_out_date && noticeYmd) &&
    !meets30DayMoveOutNotice(noticeYmd, activeMoveOutRequest!.requested_move_out_date);

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

          {shortNotice && (
            <div className="flex items-start gap-2 rounded-control bg-warning-100 px-3 py-2.5 text-sm text-warning-800 mb-4">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>วันที่นี้ใกล้กว่า 30 วันจากวันที่แจ้ง — ตรวจสอบเงินประกันตามสัญญา</span>
            </div>
          )}

          {/* Approving just confirms the tenant's requested date above — there's
              no separate admin-chosen date to set. If the tenant asked for the
              wrong date, they submit a new request. */}
          {isPending && (
            <div className="flex flex-wrap gap-2 mt-1">
              <button
                type="button"
                onClick={handleApprove}
                disabled={isApproving || isDeclining}
                className={buttonClasses({ variant: "success", size: "lg" })}
              >
                {isApproving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {isApproving ? "กำลังบันทึก..." : "อนุมัติคำขอ"}
              </button>
              <button
                type="button"
                onClick={handleDecline}
                disabled={isApproving || isDeclining}
                className="inline-flex items-center gap-2 rounded-control border border-danger-200 bg-white px-4 py-2 text-base font-semibold text-danger-600 hover:bg-danger-50 transition-colors disabled:opacity-50"
              >
                {isDeclining ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                {isDeclining ? "กำลังปฏิเสธ..." : "ปฏิเสธ"}
              </button>
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
            <Link
              href={`/invoices?tab=overdue&room=${encodeURIComponent(roomNumber)}`}
              className="text-sm font-medium text-warning-700 underline hover:text-warning-600"
            >
              ดูใบแจ้งหนี้
            </Link>
          </div>
          <div className="space-y-2">
            {outstandingMoveOutInvoices.map((inv) => (
              <Link
                key={inv.id}
                href={`/invoices?tab=overdue&room=${encodeURIComponent(roomNumber)}`}
                className="flex justify-between items-center rounded-control bg-white/70 px-3 py-2 border border-warning-100/80 hover:border-warning-300 hover:bg-white transition-colors"
              >
                <span className="text-sm text-slate-600">
                  {String(inv.start_date ?? "").slice(0, 10)} → {String(inv.end_date ?? "").slice(0, 10)}
                  <span className="ml-1.5 rounded-md bg-warning-100 px-1.5 py-0.5 text-warning-700 font-medium">{inv.status}</span>
                </span>
                <span className="text-base font-bold text-warning-900">฿{formatMoney(getInvoiceOwnOutstanding(inv))}</span>
              </Link>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between rounded-control bg-warning-100 px-3 py-2">
            <span className="text-sm font-medium text-warning-800">รวมยอดค้าง</span>
            <span className="text-base font-bold text-warning-900">฿{formatMoney(unpaidInvoicesSubtotal)}</span>
          </div>
        </SectionCard>
      )}

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
            ระบบจะใช้เครดิต (ค่าเช่าล่วงหน้าก่อน แล้วจึงเงินประกัน) หักบิลค้างชำระจากงวดเก่าสุด
            ยอดที่เครดิตไม่พอจะยังคงค้างในใบแจ้งหนี้ (ไม่ตัดหนี้สูญ) และผู้เช่าถูกย้ายออกทันที
            (ไม่สร้างใบแจ้งหนี้สุดท้าย ข้ามขั้นตอนมิเตอร์และสรุปค่าใช้จ่าย)
          </p>
        </div>
      </label>

      {/* Abandon settlement preview */}
      {abandonMode && (
        <ForfeitControls forfeit={forfeit} setForfeit={setForfeit} depositHeld={heldCredit.deposit} />
      )}
      {abandonMode && abandonPlan && (
        <SectionCard>
          <p className="text-base font-semibold text-slate-800">สรุปการตัดเครดิตเมื่อทิ้งห้อง</p>
          <p className="mt-0.5 mb-3 text-sm text-slate-500">
            ยอดค้างของแต่ละงวดคิดเฉพาะค่าใช้จ่ายของงวดนั้น ไม่รวมยอดยกมาที่นับไว้ในงวดก่อนแล้ว
          </p>
          <SettlementBreakdown
            plan={abandonPlan}
            prorateDays={0}
            dailyRate={0}
            fullMonths={0}
            periodLabelById={abandonPeriodById}
            debtOnly
          />
        </SectionCard>
      )}

      {abandonMode && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAbandonOpen(true)}
            disabled={!canEditTenant || isAbandoning || forfeitReasonMissing(forfeit) || (abandonPlan?.errors.length ?? 0) > 0}
            className="inline-flex items-center gap-2 rounded-control bg-warning-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-warning-700 shadow-sm transition-all disabled:opacity-50"
          >
            {isAbandoning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
            {isAbandoning ? "กำลังดำเนินการ…" : "ยืนยันทิ้งห้อง"}
          </button>
        </div>
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
      <ConfirmActionModal
        isOpen={abandonOpen}
        onCancel={() => setAbandonOpen(false)}
        onConfirm={handleAbandonment}
        title="ยืนยันผู้เช่าทิ้งห้อง"
        message={`ยืนยันว่า "${form.full_name || "ผู้เช่า"}" ทิ้งห้อง ${roomNumber}? ระบบจะหักเครดิต ฿${formatMoney(
          abandonPlan?.creditApplied ?? 0
        )} จากยอดค้างจริง ฿${formatMoney(abandonPlan?.totalOwed ?? 0)}${
          (abandonPlan?.balanceStillOwed ?? 0) > 0
            ? `, ยังค้างชำระ ฿${formatMoney(abandonPlan!.balanceStillOwed)} (ไม่ตัดหนี้สูญ)`
            : ""
        }${
          (abandonPlan?.advanceRentAbsorbed ?? 0) > 0
            ? `, ค่าเช่าล่วงหน้าที่เหลือ ฿${formatMoney(abandonPlan!.advanceRentAbsorbed)} ไม่คืน`
            : ""
        }${
          (abandonPlan?.refundDue ?? 0) > 0
            ? `, ยอดคืนผู้เช่า (ค้างจ่าย) ฿${formatMoney(abandonPlan!.refundDue)}`
            : ""
        } และผู้เช่าถูกย้ายออกทันที การดำเนินการนี้ไม่สามารถย้อนกลับได้`}
        confirmLabel="ยืนยันทิ้งห้อง"
        loading={isAbandoning}
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
  forfeit,
  setForfeit,
  heldCredit,
  useProrate,
  setUseProrate,
  moveOutFeeLines,
  setMoveOutFeeLines,
  latestPrevElectricity,
  latestPrevWater,
  outstandingMoveOutInvoices,
  rentPeriod,
  settlementPlan,
  lateFees,
  onBack,
  onNext,
}: {
  lateFees: MoveOutLateFeesUi;
  form: MoveOutWizardForm;
  forfeit: ForfeitState;
  setForfeit: (next: ForfeitState) => void;
  heldCredit: HeldCredit;
  useProrate: boolean;
  setUseProrate: (v: boolean) => void;
  moveOutFeeLines: MoveOutFeeLine[];
  setMoveOutFeeLines: React.Dispatch<React.SetStateAction<MoveOutFeeLine[]>>;
  latestPrevElectricity: number;
  latestPrevWater: number;
  outstandingMoveOutInvoices: InvoiceHistoryRow[];
  rentPeriod: MoveOutRentPeriod;
  settlementPlan: MoveOutSettlementPlan | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const createFeeLine = (): MoveOutFeeLine => ({ id: crypto.randomUUID(), label: "", amount: 0 });
  const periodLabelById = useMemo(
    () => new Map(outstandingMoveOutInvoices.map((inv) => [String(inv.id), String(inv.start_date ?? "").slice(0, 7)])),
    [outstandingMoveOutInvoices]
  );

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">สรุปค่าใช้จ่าย</h2>
        <p className="mt-1 text-base text-slate-500">ตรวจสอบและปรับแต่งรายการค่าใช้จ่ายก่อนยืนยัน</p>
      </div>

      {lateFees.status === "loading" && (
        <Notice tone="info" title="กำลังตรวจสอบค่าปรับล่าช้าจากบิลเก่า">
          กรุณารอสักครู่ ระบบจะยังไม่ให้ยืนยันจนกว่าจะโหลดเสร็จ
        </Notice>
      )}
      {lateFees.status === "error" && (
        <Notice tone="danger" title="โหลดค่าปรับล่าช้าจากบิลเก่าไม่สำเร็จ">
          {lateFees.error || "ไม่ทราบสาเหตุ"} — ยังยืนยันการย้ายออกไม่ได้ กรุณาปิดแล้วเปิดหน้านี้ใหม่
        </Notice>
      )}
      {lateFees.status === "ready" && lateFees.items.length > 0 && (
        <SectionCard>
          <p className="text-base font-semibold text-slate-700 mb-1 flex items-center gap-2">
            <Calculator className="h-4 w-4 text-slate-400" />
            ค่าปรับล่าช้าจากบิลเก่า
          </p>
          <p className="mb-4 text-sm text-slate-500">
            ค่าปรับที่ยังไม่เคยเรียกเก็บ จะถูกเพิ่มเป็นรายการในบิลสุดท้าย หากยกเลิกจะไม่ถูกเรียกเก็บและต้องระบุเหตุผล
          </p>
          <div className="space-y-3">
            {lateFees.items.map((item) => {
              const v = lateFees.voids[item.invoiceId] ?? { voided: false, reason: "" };
              return (
                <div key={item.invoiceId} className="rounded-control border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className={v.voided ? "text-slate-400 line-through" : "text-slate-700"}>
                      <p className="text-base font-medium">งวด {item.periodStart}</p>
                      <p className="text-sm">{lateFeeDetail(item)}</p>
                    </div>
                    <LateFeeRowAmount item={item} voided={v.voided} />
                  </div>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={v.voided}
                      onChange={(e) => lateFees.setVoid(item.invoiceId, { voided: e.target.checked })}
                      className="h-4 w-4 accent-primary-600"
                    />
                    ยกเลิกค่าปรับนี้
                  </label>
                  {v.voided && (
                    <input
                      type="text"
                      placeholder="เหตุผลที่ยกเลิกค่าปรับ (จำเป็น)"
                      value={v.reason}
                      onChange={(e) => lateFees.setVoid(item.invoiceId, { reason: e.target.value })}
                      className={controlClasses({ className: "mt-2", invalid: !v.reason.trim() })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* Additional fees — the label is the documented reason for the charge */}
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
                placeholder="รายการและเหตุผล (เช่น ค่าซ่อมประตูที่ชำรุด)"
                value={line.label}
                onChange={e => setMoveOutFeeLines(prev => prev.map(item => item.id === line.id ? { ...item, label: e.target.value } : item))}
                className={controlClasses({ className: "flex-1", invalid: toNumber(line.amount) > 0 && !line.label.trim() })}
              />
              <input
                type="number"
                placeholder="จำนวน"
                value={line.amount}
                onChange={e => setMoveOutFeeLines(prev => prev.map(item => item.id === line.id ? { ...item, amount: toNumber(e.target.value) } : item))}
                className={controlClasses({ className: "w-28 font-mono" })}
              />
              <button
                type="button"
                onClick={() => setMoveOutFeeLines(prev => prev.filter(item => item.id !== line.id))}
                className={buttonClasses({ variant: "ghost", size: "icon" })}
                aria-label="ลบรายการ"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2">
        <ForfeitControls forfeit={forfeit} setForfeit={setForfeit} depositHeld={heldCredit.deposit} />

        <label className="flex cursor-pointer items-start gap-3 rounded-card border border-slate-200 bg-white px-4 py-4">
          <input
            type="checkbox"
            checked={useProrate}
            onChange={e => setUseProrate(e.target.checked)}
            className="mt-1 h-4 w-4 accent-primary-600"
          />
          <div>
            <p className="text-base font-semibold text-slate-800">คิดค่าเช่าเฉลี่ยตามวัน (Prorate)</p>
            <p className="mt-0.5 text-sm text-slate-500">หากปิดใช้งาน จะไม่เรียกเก็บค่าเช่าในรอบบิลสุดท้าย</p>
          </div>
        </label>
      </div>

      <SectionCard>
        <p className="text-base font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary-500" />
          สรุปยอดย้ายออก (รายบรรทัด)
        </p>
        {settlementPlan && (
          <SettlementBreakdown
            plan={settlementPlan}
            prorateDays={rentPeriod.prorateDays}
            dailyRate={rentPeriod.dailyRate}
            fullMonths={rentPeriod.fullMonths}
            meter={{
              prevElec: latestPrevElectricity,
              curElec: toNumber(form.final_electricity_reading),
              prevWater: latestPrevWater,
              curWater: toNumber(form.final_water_reading),
            }}
            periodLabelById={periodLabelById}
          />
        )}
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
          ถัดไป: ยืนยัน <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Confirmation ──────────────────────────────────────────────────────

function Step4Confirm({
  form,
  forfeit,
  latestPrevElectricity,
  latestPrevWater,
  roomNumber,
  activeMoveOutRequest,
  isMovingOut,
  isCancellingMoveOut,
  canEditTenant,
  activeTenant,
  outstandingMoveOutInvoices,
  rentPeriod,
  settlementPlan,
  existingSettlement,
  lateFees,
  onBack,
  onConfirmMoveOut,
  onCancelMoveOut,
}: {
  lateFees: MoveOutLateFeesUi;
  form: MoveOutWizardForm;
  forfeit: ForfeitState;
  latestPrevElectricity: number;
  latestPrevWater: number;
  roomNumber: string;
  activeMoveOutRequest: MoveOutRequestRow | null;
  isMovingOut: boolean;
  isCancellingMoveOut: boolean;
  canEditTenant: boolean;
  activeTenant: any;
  outstandingMoveOutInvoices: any[];
  rentPeriod: MoveOutRentPeriod;
  settlementPlan: MoveOutSettlementPlan | null;
  existingSettlement: any | null;
  onBack: () => void;
  onConfirmMoveOut: () => Promise<void> | void;
  onCancelMoveOut: () => Promise<void> | void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const periodLabelById = useMemo(
    () => new Map(outstandingMoveOutInvoices.map((inv: any) => [String(inv.id), String(inv.start_date ?? "").slice(0, 7)])),
    [outstandingMoveOutInvoices]
  );

  const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);
  const plan = settlementPlan;
  const owes = (plan?.balanceStillOwed ?? 0) > 0;
  const reasonMissing = forfeitReasonMissing(forfeit);
  const lateFeeBlocked = lateFeesBlockConfirm(lateFees);
  const billedLateFees = lateFees.items.filter((i) => !lateFees.voids[i.invoiceId]?.voided);
  const voidedLateFees = lateFees.items.filter((i) => lateFees.voids[i.invoiceId]?.voided);
  const blocked = !plan || plan.errors.length > 0 || reasonMissing || Boolean(existingSettlement) || lateFeeBlocked;

  return (
    <div className="space-y-5 animate-fade-in-up">
      <div>
        <h2 className="text-xl font-bold text-slate-900">ยืนยันการย้ายออก</h2>
        <p className="mt-1 text-base text-slate-500">ตรวจสอบข้อมูลสุดท้ายก่อนบันทึก</p>
      </div>

      {existingSettlement && (
        <Notice tone="warning" title="ผู้เช่ารายนี้สรุปยอดย้ายออกไปแล้ว">
          สรุปเมื่อ {String(existingSettlement.created_at ?? "").slice(0, 10)} — ไม่สามารถสรุปซ้ำได้
        </Notice>
      )}
      {reasonMissing && (
        <Notice tone="danger" title="ต้องระบุเหตุผลการริบเงินประกัน">
          กลับไปขั้นตอน &quot;สรุปค่าใช้จ่าย&quot; เพื่อกรอกเหตุผล
        </Notice>
      )}

      {lateFees.status === "error" && (
        <Notice tone="danger" title="โหลดค่าปรับล่าช้าจากบิลเก่าไม่สำเร็จ">
          {lateFees.error || "ไม่ทราบสาเหตุ"} — ไม่สามารถยืนยันได้จนกว่าจะโหลดสำเร็จ
        </Notice>
      )}
      {lateFees.status === "loading" && (
        <Notice tone="info" title="กำลังตรวจสอบค่าปรับล่าช้าจากบิลเก่า">
          กรุณารอสักครู่
        </Notice>
      )}
      {lateFees.status === "ready" && lateFeeVoidReasonMissing(lateFees) && (
        <Notice tone="danger" title="ต้องระบุเหตุผลที่ยกเลิกค่าปรับล่าช้า">
          กลับไปขั้นตอน &quot;สรุปค่าใช้จ่าย&quot; เพื่อกรอกเหตุผล
        </Notice>
      )}

      {(billedLateFees.length > 0 || voidedLateFees.length > 0) && (
        <SectionCard>
          <p className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">ค่าปรับล่าช้าจากบิลเก่า</p>
          <div className="space-y-2 text-base">
            {billedLateFees.map((i) => (
              <div key={i.invoiceId} className="flex justify-between gap-3">
                <span className="text-slate-700">งวด {i.periodStart} ({lateFeeDetail(i)}) — เรียกเก็บในบิลสุดท้าย</span>
                <LateFeeRowAmount item={i} voided={false} />
              </div>
            ))}
            {voidedLateFees.map((i) => (
              <div key={i.invoiceId} className="flex justify-between gap-3">
                <span className="text-slate-400">
                  <span className="line-through">งวด {i.periodStart} ({lateFeeDetail(i)})</span> — ยกเลิก: {lateFees.voids[i.invoiceId]?.reason}
                </span>
                <LateFeeRowAmount item={i} voided />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

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
            <p className="text-sm text-slate-400 mb-0.5">เงินประกัน</p>
            <p className={`font-semibold ${(plan?.depositForfeited ?? 0) > 0 ? "text-danger-600" : "text-success-700"}`}>
              {(plan?.depositForfeited ?? 0) > 0
                ? `ริบ ฿${formatMoney(plan!.depositForfeited)} (${plan!.forfeitReason})`
                : "ไม่ริบ"}
            </p>
          </div>
        </div>
      </SectionCard>

      {plan && (
        <div className={`rounded-card px-6 py-6 text-center shadow-float ${owes ? "bg-danger-600" : "bg-success-600"}`}>
          <p className="text-base font-medium text-white/80 mb-1">
            {owes ? "ผู้เช่าต้องชำระเพิ่ม" : "ยอดคืนผู้เช่า (ค้างจ่าย — บันทึกการโอนแยกภายหลัง)"}
          </p>
          <p className="text-4xl font-black text-white tracking-tight">
            ฿{formatMoney(owes ? plan.balanceStillOwed : plan.refundDue)}
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm text-white/80">
            <span>ยอดที่ต้องชำระรวม ฿{formatMoney(plan.totalOwed)}</span>
            <span>เครดิตที่หัก ฿{formatMoney(plan.creditApplied)}</span>
            {plan.advanceRentAbsorbed > 0 && <span>ค่าเช่าล่วงหน้าไม่คืน ฿{formatMoney(plan.advanceRentAbsorbed)}</span>}
          </div>
        </div>
      )}

      <SectionCard>
        <p className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">รายละเอียดทั้งหมด</p>
        {plan && (
          <SettlementBreakdown
            plan={plan}
            prorateDays={rentPeriod.prorateDays}
            dailyRate={rentPeriod.dailyRate}
            fullMonths={rentPeriod.fullMonths}
            meter={{
              prevElec: latestPrevElectricity,
              curElec: toNumber(form.final_electricity_reading),
              prevWater: latestPrevWater,
              curWater: toNumber(form.final_water_reading),
            }}
            periodLabelById={periodLabelById}
          />
        )}
      </SectionCard>

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
              className={buttonClasses({ variant: "secondary", size: "lg" })}
            >
              <Ban className="h-4 w-4" />
              {isCancellingMoveOut ? "กำลังยกเลิก…" : "ยกเลิกการย้ายออก"}
            </button>
          )}

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!canEditTenant || isMovingOut || blocked}
            className={buttonClasses({ variant: "primary", size: "lg" })}
          >
            {isMovingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
            {isMovingOut ? "กำลังบันทึก…" : "ยืนยันการย้ายออก"}
          </button>
        </div>
      </div>

      <ConfirmActionModal
        isOpen={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); onConfirmMoveOut(); }}
        title="ยืนยันการย้ายออก"
        message={`ยืนยันการย้ายออกของ "${form.full_name || "ผู้เช่า"}" จากห้อง ${roomNumber}? ระบบจะสร้างใบแจ้งหนี้สุดท้าย หักเครดิตตามรายละเอียด${
          plan && plan.refundDue > 0 ? ` บันทึกยอดคืนผู้เช่า ฿${formatMoney(plan.refundDue)} เป็นยอดค้างจ่าย (ยังไม่ใช่การโอน)` : ""
        } จากนั้นจึงเปลี่ยนสถานะผู้เช่าเป็น "ย้ายออกแล้ว" และห้องเป็น "ว่าง" — ทั้งหมดสำเร็จพร้อมกันหรือไม่บันทึกเลย`}
        confirmLabel="ยืนยันการย้ายออก"
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
  lateFees,
  activeTenant,
  activeMoveOutRequest,
  rates,
  form,
  setForm,
  forfeitDeposit,
  forfeit,
  setForfeit,
  heldCredit,
  settlementPlan,
  abandonPlan,
  rentPeriod,
  existingSettlement,
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
              forfeitDeposit={forfeitDeposit}
              forfeit={forfeit}
              setForfeit={setForfeit}
              heldCredit={heldCredit}
              abandonPlan={abandonPlan}
              roomNumber={roomNumber}
              canEditTenant={canEditTenant}
              isCancellingMoveOut={isCancellingMoveOut}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              unpaidInvoicesSubtotal={unpaidInvoicesSubtotal}
              onApprove={onApprove}
              onDecline={onDecline}
              onCancelMoveOut={onCancelMoveOut}
              onAbandonRoom={onAbandonRoom}
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
              forfeit={forfeit}
              setForfeit={setForfeit}
              heldCredit={heldCredit}
              useProrate={useProrate}
              setUseProrate={setUseProrate}
              moveOutFeeLines={moveOutFeeLines}
              setMoveOutFeeLines={setMoveOutFeeLines}
              latestPrevElectricity={latestPrevElectricity}
              latestPrevWater={latestPrevWater}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              rentPeriod={rentPeriod}
              settlementPlan={settlementPlan}
              lateFees={lateFees}
              onBack={() => goTo(2)}
              onNext={() => goTo(4)}
            />
          )}
          {step === 4 && (
            <Step4Confirm
              form={form}
              forfeit={forfeit}
              latestPrevElectricity={latestPrevElectricity}
              latestPrevWater={latestPrevWater}
              roomNumber={roomNumber}
              activeMoveOutRequest={activeMoveOutRequest}
              isMovingOut={isMovingOut}
              isCancellingMoveOut={isCancellingMoveOut}
              canEditTenant={canEditTenant}
              activeTenant={activeTenant}
              outstandingMoveOutInvoices={outstandingMoveOutInvoices}
              rentPeriod={rentPeriod}
              settlementPlan={settlementPlan}
              existingSettlement={existingSettlement}
              lateFees={lateFees}
              onBack={() => goTo(3)}
              onConfirmMoveOut={onConfirmMoveOut}
              onCancelMoveOut={onCancelMoveOut}
            />
          )}
        </fieldset>
      </div>
    </div>
  );
}
