"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { toast } from "sonner";
import type { MoveOutRequestRow } from "@/types";
import { toNumber, formatMoney } from "@/lib/format";
import { getInvoiceOwnOutstanding, planAbandonCredit } from "@/lib/invoice-ledger";
import { bangkokYmd, meets30DayMoveOutNotice } from "@/lib/move-out-notice";
import { moveOutIssueText } from "@/lib/move-out-messages";
import { callTenantsAction, TenantsActionError } from "@/lib/tenants-action-client";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Page";
import {
  CheckCircle2,
  XCircle,
  Ban,
  AlertTriangle,
  ClipboardList,
  Zap,
  Droplets,
  ChevronRight,
  ChevronLeft,
  KeyRound,
  FileText,
  Flag,
  ReceiptText,
  RefreshCw,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** The key-return meter readings the admin types; autosaved by the parent modal. */
export type MoveOutWizardForm = {
  full_name: string;
  final_electricity_reading: number;
  final_water_reading: number;
};

type InvoiceRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  due_date?: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  status: string;
  kind?: string | null;
  fee_model?: string | null;
  notes?: string | null;
  rent_amount?: number | null;
  electricity_bill?: number | null;
  water_bill?: number | null;
  common_fee?: number | null;
  electricity_reading_start?: number | null;
  electricity_reading_end?: number | null;
  water_reading_start?: number | null;
  water_reading_end?: number | null;
  created_at?: string | null;
};

/** `breakdown` from prepare_move_out_bill's result. */
type PrepareBreakdown = {
  rent_start: string;
  rent_end: string;
  rent_days: number;
  full_months: number;
  leftover_days: number;
  use_prorate: boolean;
  daily_rate: number;
  rent: number;
  meter_baseline_source: "meter_readings" | "move_in";
  meter_baseline_month: string | null;
  electricity_previous: number;
  electricity_final: number;
  electricity_units: number;
  electricity_rate: number;
  electricity_bill: number;
  water_previous: number;
  water_final: number;
  water_units: number;
  water_rate: number;
  water_min_units: number;
  water_min_price: number;
  water_bill: number;
  common_fee: number;
  total: number;
  due_date: string;
};

type SettlementIssue = { code: string; message: string };

/** get_settlement_preview's response (also the `preview` of a 409 preview_changed). */
type SettlementPreview = {
  asOf: string;
  forfeitDeposit: boolean;
  canSettle: boolean;
  blockers: SettlementIssue[];
  warnings: SettlementIssue[];
  moveOutBill: {
    id: string;
    status: string;
    total_amount: number;
    paid_sum: number;
    start_date: string | null;
    end_date: string | null;
    due_date: string | null;
    amountDue: number;
    creditApplied: number;
    remainingDue: number;
  } | null;
  olderBills: Array<{
    invoice_id: string;
    status: string;
    start_date: string | null;
    end_date: string | null;
    due_date: string | null;
    charges_due: number;
    fee_due: number;
    fee_to_waive: number;
    credit_applied: number;
    remaining_due: number;
  }>;
  credit: { deposit: number; advanceRent: number; total: number };
  projected: {
    creditToMoveOutBill: number;
    creditToOlderBills: number;
    creditApplied: number;
    feesWaived: number;
    refund: number;
    remainingOwed: number;
  };
};

type Props = {
  activeTenant: any;
  activeMoveOutRequest: MoveOutRequestRow | null;
  form: MoveOutWizardForm;
  setForm: (updater: (prev: MoveOutWizardForm) => MoveOutWizardForm) => void;
  forfeitDeposit: boolean;
  setForfeitDeposit: (v: boolean) => void;
  latestPrevElectricity: number;
  latestPrevWater: number;
  tenantInvoiceHistory: InvoiceRow[];
  outstandingMoveOutInvoices: InvoiceRow[];
  unpaidInvoicesSubtotal: number;
  roomNumber: string;
  canEditTenant: boolean;
  isCancellingMoveOut: boolean;
  onApprove: () => Promise<void> | void;
  onDecline: () => Promise<void> | void;
  onCancelMoveOut: () => Promise<void> | void;
  onAbandonRoom: (forfeitDeposit: boolean, moveOutDate: string) => Promise<void>;
  /** Re-read the tenant/bills after a write (and refresh the page behind). */
  onChanged: () => Promise<unknown> | void;
  /** Close the dialog once the move-out is fully settled. */
  onDone: () => void;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "คำขอย้ายออก", icon: ClipboardList },
  { id: 2, label: "ปลดล็อกห้อง", icon: KeyRound },
  { id: 3, label: "บิลย้ายออก", icon: FileText },
  { id: 4, label: "สรุปยอด", icon: Flag },
] as const;

const baht = (value: unknown) => `฿${formatMoney(toNumber(value as any))}`;

const thaiDate = (ymd: string | null | undefined) => {
  if (!ymd) return "—";
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(ymd);
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
};

const periodLabel = (start: string | null | undefined, end: string | null | undefined) =>
  start || end ? `${thaiDate(start)} – ${thaiDate(end)}` : "—";

/** The tenant's live v2 move-out bill, if prepare_move_out_bill has made one. */
const findMoveOutBill = (rows: InvoiceRow[]) =>
  rows.find((row) => row.kind === "move_out" && row.fee_model === "v2" && row.status !== "cancelled") ?? null;

const isUnlocked = (tenant: any) => tenant?.status === "inactive" && Boolean(tenant?.handover_date);
const isSettled = (tenant: any) => tenant?.status === "inactive" && !tenant?.room_id;

const issueFromError = (error: unknown) => {
  if (error instanceof TenantsActionError) {
    return moveOutIssueText({ code: error.code ?? "", message: error.message });
  }
  return (error as any)?.message ?? "เกิดข้อผิดพลาด";
};

function LineItem({
  label,
  value,
  sub,
  className = "",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div>
        <span className="text-sm text-slate-600">{label}</span>
        {sub && <p className="text-xs text-slate-400">{sub}</p>}
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">{value}</span>
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </div>
  );
}

function StepRail({
  currentStep,
  doneSteps,
  onStepClick,
}: {
  currentStep: number;
  doneSteps: Set<number>;
  onStepClick: (s: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 py-2">
      {STEPS.map((step) => {
        const Icon = step.icon;
        const isActive = currentStep === step.id;
        const isDone = !isActive && doneSteps.has(step.id);
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onStepClick(step.id)}
            className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-all duration-200 ease-float ${
              isActive
                ? "bg-primary-600 text-white shadow-float-md"
                : isDone
                  ? "bg-success-50 text-success-700 hover:bg-success-100"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
            }`}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control ${
                isActive ? "bg-white/20" : isDone ? "bg-success-100" : "bg-slate-100"
              }`}
            >
              {isDone ? <CheckCircle2 className="h-4 w-4 text-success-600" /> : <Icon className="h-3.5 w-3.5" />}
            </span>
            <span className="text-sm font-semibold leading-tight">{step.label}</span>
            {isActive && <ChevronRight className="ml-auto h-4 w-4 opacity-60" />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Step 1: Request review (approve/decline, abandon, cancel) ────────────────

function Step1RequestReview({
  activeTenant,
  activeMoveOutRequest,
  form,
  forfeitDeposit,
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
  activeTenant: any;
  activeMoveOutRequest: MoveOutRequestRow | null;
  form: MoveOutWizardForm;
  forfeitDeposit: boolean;
  roomNumber: string;
  canEditTenant: boolean;
  isCancellingMoveOut: boolean;
  outstandingMoveOutInvoices: InvoiceRow[];
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
  const [abandonDate, setAbandonDate] = useState(() => bangkokYmd());

  const isActive = activeTenant?.status === "active";
  const prepaid =
    (forfeitDeposit ? 0 : toNumber(activeTenant?.security_deposit_amount)) +
    toNumber(activeTenant?.advance_rent_amount);

  // Preview of the abandon settlement, computed with the same planner the API
  // runs, so what the admin approves here is exactly what gets written.
  const abandonPlan = useMemo(
    () =>
      planAbandonCredit(
        [...outstandingMoveOutInvoices].sort((a: any, b: any) =>
          String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")),
        ) as any,
        prepaid,
      ),
    [outstandingMoveOutInvoices, prepaid],
  );
  const abandonPeriodById = useMemo(
    () =>
      new Map(
        outstandingMoveOutInvoices.map((inv) => [String(inv.id), String(inv.start_date ?? "").slice(0, 10)]),
      ),
    [outstandingMoveOutInvoices],
  );

  const handleAbandonment = async () => {
    setIsAbandoning(true);
    try {
      await onAbandonRoom(forfeitDeposit, abandonDate);
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
      <StepHeading title="คำขอย้ายออก" description="ตรวจสอบคำขอและวันย้ายออกตามที่ผู้เช่าแจ้ง" />

      {!activeMoveOutRequest && (
        <Notice tone="info" icon={<ClipboardList className="h-4 w-4" />} title="ไม่มีคำขอย้ายออกจากผู้เช่า">
          แอดมินกำหนดวันย้ายออกเอง หรือยังไม่มีคำขอ
        </Notice>
      )}

      {activeMoveOutRequest && (
        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ClipboardList className="h-4 w-4 text-slate-500" />
              คำขอย้ายออกจากผู้เช่า
            </p>
            <Badge variant={isPending ? "warning" : isApproved ? "success" : "neutral"} dot>
              {isPending ? "รอตรวจสอบ" : isApproved ? "อนุมัติแล้ว" : activeMoveOutRequest.status}
            </Badge>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <LineItem label="วันที่แจ้ง" value={thaiDate(noticeYmd)} />
            <LineItem label="ผู้เช่าต้องการย้ายออก" value={thaiDate(activeMoveOutRequest.requested_move_out_date)} />
          </div>

          {activeMoveOutRequest.request_note && (
            <p className="mb-4 rounded-control bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
              <span className="mb-1 block text-xs text-slate-400">หมายเหตุจากผู้เช่า</span>
              {activeMoveOutRequest.request_note}
            </p>
          )}

          {shortNotice && (
            <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />} className="mb-4">
              วันที่นี้ใกล้กว่า 30 วันจากวันที่แจ้ง — ตรวจสอบเงินประกันตามสัญญา
            </Notice>
          )}

          {/* Approving confirms the tenant's own requested date; there is no
              separate admin-chosen date. A wrong date means a new request. */}
          {isPending && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="success"
                onClick={handleApprove}
                loading={isApproving}
                disabled={isDeclining}
                icon={<CheckCircle2 className="h-4 w-4" />}
              >
                {isApproving ? "กำลังบันทึก..." : "อนุมัติคำขอ"}
              </Button>
              <Button
                variant="secondary"
                onClick={handleDecline}
                loading={isDeclining}
                disabled={isApproving}
                icon={<XCircle className="h-4 w-4" />}
              >
                {isDeclining ? "กำลังปฏิเสธ..." : "ปฏิเสธ"}
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card className="p-5">
        <LineItem
          label="วันย้ายออกตามที่แจ้ง (ค่าเช่าคิดถึงวันนี้)"
          value={thaiDate(activeTenant?.tenancy_end_date ?? activeTenant?.move_out_date)}
          sub="ถ้าผู้เช่าคืนกุญแจก่อน ค่าเช่ายังคิดถึงวันที่แจ้งไว้ — ระบุวันที่คืนกุญแจได้ในขั้นตอนถัดไป"
        />
      </Card>

      {outstandingMoveOutInvoices.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ReceiptText className="h-4 w-4 text-warning-600" />
              บิลค้างชำระ ({outstandingMoveOutInvoices.length} รายการ)
            </p>
            <Link
              href={`/invoices?tab=overdue&room=${encodeURIComponent(roomNumber)}`}
              className="text-sm font-medium text-primary-600 hover:underline"
            >
              ดูใบแจ้งหนี้
            </Link>
          </div>
          <div className="space-y-1.5">
            {outstandingMoveOutInvoices.map((inv) => (
              <LineItem
                key={inv.id}
                label={
                  <>
                    {periodLabel(inv.start_date, inv.end_date)}{" "}
                    <Badge size="sm" variant="warning">
                      {inv.kind === "move_out" ? "บิลย้ายออก" : inv.status}
                    </Badge>
                  </>
                }
                value={baht(getInvoiceOwnOutstanding(inv as any))}
              />
            ))}
          </div>
          <div className="mt-3 border-t border-slate-100 pt-3">
            <LineItem label="รวมยอดค้าง" value={baht(unpaidInvoicesSubtotal)} />
          </div>
        </Card>
      )}

      {/* Abandon room — only for a tenant still active (abandon_room refuses otherwise). */}
      {isActive && (
        <Card className="p-5">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={abandonMode}
              onChange={(e) => setAbandonMode(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300"
            />
            <span>
              <span className="block text-sm font-semibold text-slate-800">ผู้เช่าทิ้งห้อง</span>
              <span className="mt-0.5 block text-sm text-slate-500">
                ระบบจะใช้เครดิต (ค่าเช่าล่วงหน้า{!forfeitDeposit ? " + เงินประกัน" : ""}) หักบิลค้างชำระตามลำดับ
                และผู้เช่าถูกย้ายออกทันที (ไม่สร้างบิลย้ายออก ข้ามขั้นตอนที่เหลือ)
              </span>
            </span>
          </label>

          {abandonMode && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              <Input
                label="วันที่ทิ้งห้อง"
                type="date"
                value={abandonDate}
                onChange={(e) => setAbandonDate(e.target.value)}
                className="max-w-xs"
              />
              <p className="text-xs text-slate-500">
                ยอดค้างของแต่ละงวดคิดเฉพาะค่าใช้จ่ายของงวดนั้น ไม่รวมยอดยกมาที่นับไว้ในงวดก่อนแล้ว
              </p>
              <LineItem
                label={`เครดิตที่ใช้ได้ (ค่าเช่าล่วงหน้า${forfeitDeposit ? "" : " + เงินประกัน"})`}
                value={baht(abandonPlan.creditPool)}
              />
              <LineItem label="ยอดค้างจริงทั้งหมด" value={baht(abandonPlan.totalOwed)} />
              {abandonPlan.lines.map((line) => (
                <LineItem
                  key={line.invoiceId}
                  className="pl-3"
                  label={`งวด ${abandonPeriodById.get(line.invoiceId) ?? "-"} · ค้าง ${baht(line.owed)}`}
                  value={
                    line.outcome === "already_clear"
                      ? "ไม่มียอดค้างของงวดนี้"
                      : `หักเครดิต ${baht(line.applied)}${line.writtenOff > 0 ? ` · ตัดหนี้สูญ ${baht(line.writtenOff)}` : ""}`
                  }
                />
              ))}
              <LineItem label="รวมเครดิตที่ใช้" value={baht(abandonPlan.creditApplied)} />
              <LineItem label="รวมตัดเป็นหนี้สูญ" value={baht(abandonPlan.writtenOff)} />
              {abandonPlan.refundableCredit > 0 && (
                <LineItem label="เครดิตคงเหลือ (ต้องคืนผู้เช่า)" value={baht(abandonPlan.refundableCredit)} />
              )}
              <div className="flex justify-end">
                <Button
                  variant="danger"
                  onClick={() => setAbandonOpen(true)}
                  disabled={!canEditTenant || !abandonDate}
                  loading={isAbandoning}
                  icon={<Ban className="h-4 w-4" />}
                >
                  ยืนยันทิ้งห้อง
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        {isActive && (activeMoveOutRequest || activeTenant?.move_out_date) ? (
          <Button
            variant="secondary"
            onClick={() => setConfirmCancelOpen(true)}
            loading={isCancellingMoveOut}
            icon={<Ban className="h-4 w-4" />}
          >
            ยกเลิกกระบวนการย้ายออก
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onNext} iconRight={<ChevronRight className="h-4 w-4" />}>
          ถัดไป: ปลดล็อกห้อง
        </Button>
      </div>

      <ConfirmActionModal
        isOpen={confirmCancelOpen}
        onCancel={() => setConfirmCancelOpen(false)}
        onConfirm={() => {
          setConfirmCancelOpen(false);
          onCancelMoveOut();
        }}
        title="ยืนยันการยกเลิกย้ายออก"
        message="ระบบจะล้างวันย้ายออกและยกเลิกคำขอที่รอ/อนุมัติแล้ว ผู้เช่าจะยังพักอยู่ตามปกติ"
        confirmLabel="ยืนยันการยกเลิก"
      />
      <ConfirmActionModal
        isOpen={abandonOpen}
        onCancel={() => setAbandonOpen(false)}
        onConfirm={handleAbandonment}
        title="ยืนยันผู้เช่าทิ้งห้อง"
        message={`ยืนยันว่า "${form.full_name || "ผู้เช่า"}" ทิ้งห้อง ${roomNumber}? ระบบจะใช้เครดิต ${baht(
          abandonPlan.creditPool,
        )} หักยอดค้างจริง ${baht(abandonPlan.totalOwed)} → ตัดชำระ ${baht(
          abandonPlan.creditApplied,
        )}, ตัดเป็นหนี้สูญ ${baht(abandonPlan.writtenOff)}${
          abandonPlan.refundableCredit > 0 ? `, เหลือเครดิตคืนผู้เช่า ${baht(abandonPlan.refundableCredit)}` : ""
        } และผู้เช่าถูกย้ายออกทันที การดำเนินการนี้ไม่สามารถย้อนกลับได้`}
        confirmLabel="ยืนยันทิ้งห้อง"
        destructive
        loading={isAbandoning}
      />
    </div>
  );
}

// ─── Step 2: Unlock the room (key returned) ───────────────────────────────────

function Step2Unlock({
  activeTenant,
  roomNumber,
  canEditTenant,
  onChanged,
  onBack,
  onNext,
}: {
  activeTenant: any;
  roomNumber: string;
  canEditTenant: boolean;
  onChanged: Props["onChanged"];
  onBack: () => void;
  onNext: () => void;
}) {
  const today = bangkokYmd();
  const unlocked = isUnlocked(activeTenant);
  // A tenant vacated by the old "ปลดล็อกห้องทันที" (status inactive, no
  // handover date) still needs a handover date recorded before billing.
  const vacatedByOldFlow = activeTenant?.status === "inactive" && !activeTenant?.handover_date;
  const [handoverDate, setHandoverDate] = useState(() => {
    const fromTenant = vacatedByOldFlow ? String(activeTenant?.move_out_date ?? "").slice(0, 10) : "";
    return fromTenant && fromTenant <= today ? fromTenant : today;
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // unlock_room: tenancy_end_date = existing tenancy_end_date ?? move_out_date ?? handover date.
  const rentEnd: string | null = activeTenant?.tenancy_end_date ?? activeTenant?.move_out_date ?? null;
  const effectiveRentEnd = rentEnd ?? handoverDate;
  const dateError =
    !handoverDate
      ? "กรุณาระบุวันที่คืนกุญแจ"
      : handoverDate > today
        ? "วันที่คืนกุญแจต้องไม่เป็นวันในอนาคต"
        : activeTenant?.move_in_date && handoverDate < String(activeTenant.move_in_date).slice(0, 10)
          ? "วันที่คืนกุญแจต้องไม่ก่อนวันย้ายเข้า"
          : null;

  const unlock = async () => {
    setBusy(true);
    try {
      const res = await callTenantsAction("unlock_room", { tenantId: activeTenant.id, handoverDate });
      if (res?.result === "already_unlocked") {
        toast.info("ห้องนี้ถูกปลดล็อกไปแล้วก่อนหน้านี้");
      } else if (res?.rpc?.room_freed === false) {
        toast.success("บันทึกวันคืนกุญแจแล้ว — ห้องมีผู้เช่าใหม่อยู่แล้ว จึงไม่เปลี่ยนสถานะห้อง");
      } else {
        toast.success("ปลดล็อกห้องเรียบร้อย — ผู้เช่าใหม่สามารถลงทะเบียนได้ทันที");
      }
      await onChanged();
      onNext();
    } catch (error) {
      toast.error(issueFromError(error));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      <StepHeading
        title="ปลดล็อกห้อง"
        description="ผู้เช่าคืนกุญแจแล้ว — ปลดล็อกห้องเพื่อให้ผู้เช่าใหม่ลงทะเบียนได้ สรุปยอดทำภายหลังได้"
      />

      {unlocked ? (
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />} title="ปลดล็อกห้องแล้ว">
          คืนกุญแจเมื่อ {thaiDate(activeTenant?.handover_date)} · ค่าเช่าคิดถึง{" "}
          {thaiDate(activeTenant?.tenancy_end_date)} · ไม่มีบิลรายเดือนใหม่ของผู้เช่ารายนี้อีก
        </Notice>
      ) : (
        <>
          {vacatedByOldFlow && (
            <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />} title="ห้องถูกปลดล็อกด้วยระบบเดิม">
              ผู้เช่ารายนี้ถูกปลดล็อกห้องก่อนมีระบบใหม่ จึงยังไม่มีวันที่คืนกุญแจ — ระบุวันที่คืนกุญแจแล้วกดบันทึก
              เพื่อสร้างบิลย้ายออกได้
            </Notice>
          )}
          <Card className="space-y-4 p-5">
            <Input
              label="วันที่คืนกุญแจ"
              type="date"
              value={handoverDate}
              max={today}
              onChange={(e) => setHandoverDate(e.target.value)}
              error={dateError ?? undefined}
              className="max-w-xs"
            />
            <LineItem
              label="ค่าเช่าคิดถึงวันที่ (วันย้ายออกตามที่แจ้ง)"
              value={thaiDate(effectiveRentEnd)}
              sub="ถึงจะคืนกุญแจก่อน ค่าเช่าในบิลย้ายออกยังคิดถึงวันที่แจ้งไว้"
            />
            {!rentEnd && (
              <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
                ยังไม่มีวันย้ายออกตามที่แจ้ง ระบบจะใช้วันที่คืนกุญแจเป็นวันสิ้นสุดค่าเช่า — ถ้าต้องการคิดค่าเช่าถึงวันอื่น
                ให้อนุมัติคำขอย้ายออกหรือกำหนดวันย้ายออกก่อนปลดล็อก
              </Notice>
            )}
          </Card>
        </>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="secondary" onClick={onBack} icon={<ChevronLeft className="h-4 w-4" />}>
          ย้อนกลับ
        </Button>
        {unlocked ? (
          <Button onClick={onNext} iconRight={<ChevronRight className="h-4 w-4" />}>
            ถัดไป: บิลย้ายออก
          </Button>
        ) : (
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!canEditTenant || Boolean(dateError)}
            loading={busy}
            icon={<KeyRound className="h-4 w-4" />}
          >
            {vacatedByOldFlow ? "บันทึกวันคืนกุญแจ" : "ปลดล็อกห้อง"}
          </Button>
        )}
      </div>

      <ConfirmActionModal
        isOpen={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={unlock}
        title="ยืนยันปลดล็อกห้อง"
        message={`ยืนยันว่า ${activeTenant?.full_name ?? "ผู้เช่า"} คืนกุญแจห้อง ${roomNumber} แล้วเมื่อ ${thaiDate(
          handoverDate,
        )}? สถานะผู้เช่าจะเปลี่ยนเป็น "ย้ายออกแล้ว" ห้องจะว่างทันทีให้ผู้เช่าใหม่ลงทะเบียนได้ และจะไม่มีบิลรายเดือนใหม่ของผู้เช่ารายนี้อีก ค่าเช่าช่วงสุดท้ายจะคิดถึงวันที่ ${thaiDate(
          effectiveRentEnd,
        )} ในบิลย้ายออก`}
        confirmLabel="ยืนยันปลดล็อกห้อง"
        loading={busy}
      />
    </div>
  );
}

// ─── Step 3: Prepare the move-out bill ────────────────────────────────────────

function BreakdownView({ b }: { b: PrepareBreakdown }) {
  const waterMinApplied = b.water_units <= b.water_min_units && b.water_bill > b.water_units * b.water_rate;
  return (
    <div className="space-y-2">
      <LineItem
        label={`ค่าเช่า ${thaiDate(b.rent_start)} – ${thaiDate(b.rent_end)} (${b.rent_days} วัน)`}
        sub={
          b.use_prorate
            ? `${b.full_months} เดือนเต็ม + ${b.leftover_days} วัน × ${baht(b.daily_rate)} (คิดส่วนเกินแบบ pro-rate)`
            : `${b.full_months} เดือนเต็ม · ไม่คิดส่วนเกิน ${b.leftover_days} วัน`
        }
        value={baht(b.rent)}
      />
      <LineItem
        label="ค่าไฟฟ้า"
        sub={`มิเตอร์ ${b.electricity_previous} → ${b.electricity_final} = ${b.electricity_units} หน่วย × ${baht(b.electricity_rate)}`}
        value={baht(b.electricity_bill)}
      />
      <LineItem
        label="ค่าน้ำ"
        sub={`มิเตอร์ ${b.water_previous} → ${b.water_final} = ${b.water_units} หน่วย × ${baht(b.water_rate)}${
          waterMinApplied ? ` (คิดขั้นต่ำ ${baht(Math.max(b.water_min_price, b.water_min_units * b.water_rate))})` : ""
        }`}
        value={baht(b.water_bill)}
      />
      <LineItem label="ค่าส่วนกลาง" value={baht(b.common_fee)} />
      <div className="border-t border-dashed border-slate-200 pt-2">
        <LineItem label="รวมบิลย้ายออก" value={baht(b.total)} sub={`ครบกำหนด ${thaiDate(b.due_date)} · ไม่มีค่าปรับ`} />
      </div>
      <p className="text-xs text-slate-400">
        เลขมิเตอร์ครั้งก่อนมาจาก
        {b.meter_baseline_source === "meter_readings"
          ? ` มิเตอร์ของรอบบิลล่าสุด${b.meter_baseline_month ? ` (${String(b.meter_baseline_month).slice(0, 7)})` : ""}`
          : " เลขมิเตอร์ตอนย้ายเข้า (ยังไม่เคยมีบิลรายเดือน)"}
      </p>
    </div>
  );
}

function StoredBillView({ bill }: { bill: InvoiceRow }) {
  return (
    <div className="space-y-2">
      <LineItem
        label={`ค่าเช่า ${periodLabel(bill.start_date, bill.end_date)}`}
        sub={bill.notes ?? undefined}
        value={baht(bill.rent_amount)}
      />
      <LineItem
        label="ค่าไฟฟ้า"
        sub={`มิเตอร์ ${bill.electricity_reading_start ?? "-"} → ${bill.electricity_reading_end ?? "-"}`}
        value={baht(bill.electricity_bill)}
      />
      <LineItem
        label="ค่าน้ำ"
        sub={`มิเตอร์ ${bill.water_reading_start ?? "-"} → ${bill.water_reading_end ?? "-"}`}
        value={baht(bill.water_bill)}
      />
      <LineItem label="ค่าส่วนกลาง" value={baht(bill.common_fee)} />
      <div className="border-t border-dashed border-slate-200 pt-2">
        <LineItem
          label="รวมบิลย้ายออก"
          value={baht(bill.total_amount)}
          sub={bill.due_date ? `ครบกำหนด ${thaiDate(bill.due_date)} · ไม่มีค่าปรับ` : undefined}
        />
      </div>
    </div>
  );
}

function Step3PrepareBill({
  activeTenant,
  form,
  setForm,
  latestPrevElectricity,
  latestPrevWater,
  moveOutBill,
  canEditTenant,
  onChanged,
  onBack,
  onNext,
}: {
  activeTenant: any;
  form: MoveOutWizardForm;
  setForm: Props["setForm"];
  latestPrevElectricity: number;
  latestPrevWater: number;
  moveOutBill: InvoiceRow | null;
  canEditTenant: boolean;
  onChanged: Props["onChanged"];
  onBack: () => void;
  onNext: () => void;
}) {
  const unlocked = isUnlocked(activeTenant);
  const settled = isSettled(activeTenant);
  // An existing bill prepared with the toggle off says so in its notes.
  const [useProrate, setUseProrate] = useState(() => !String(moveOutBill?.notes ?? "").includes("ไม่คิดส่วนเกิน"));
  const [breakdown, setBreakdown] = useState<PrepareBreakdown | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // prepare_move_out_bill only rewrites a bill that is still an untouched draft.
  const billLocked =
    Boolean(moveOutBill) && (moveOutBill!.status !== "draft" || toNumber(moveOutBill!.paid_amount) > 0);

  const elec = toNumber(form.final_electricity_reading);
  const water = toNumber(form.final_water_reading);
  const readingsInvalid =
    !Number.isFinite(elec) || !Number.isFinite(water) || elec < 0 || water < 0;

  const setReading = (key: "final_electricity_reading" | "final_water_reading", raw: string) =>
    setForm((prev) => ({ ...prev, [key]: raw === "" ? 0 : toNumber(raw) }));

  const prepare = async () => {
    setBusy(true);
    setErrorText(null);
    try {
      const res = await callTenantsAction("prepare_move_out_bill", {
        tenantId: activeTenant.id,
        finalElectricity: elec,
        finalWater: water,
        useProrate,
      });
      setBreakdown((res?.rpc?.breakdown ?? null) as PrepareBreakdown | null);
      toast.success(res?.result === "replaced" ? "สร้างบิลย้ายออกใหม่แล้ว (ฉบับร่าง)" : "สร้างบิลย้ายออกแล้ว (ฉบับร่าง)");
      await onChanged();
    } catch (error) {
      const text = issueFromError(error);
      setErrorText(text);
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  // The fresh breakdown describes the bill only until the toggle or readings move.
  const breakdownStale =
    breakdown != null &&
    (breakdown.use_prorate !== useProrate ||
      toNumber(breakdown.electricity_final) !== elec ||
      toNumber(breakdown.water_final) !== water);

  return (
    <div className="space-y-5 animate-fade-in-up">
      <StepHeading
        title="บิลย้ายออก"
        description="กรอกเลขมิเตอร์วันคืนกุญแจ เลือกวิธีคิดค่าเช่าส่วนเกิน แล้วสร้างบิลย้ายออก (ฉบับร่าง)"
      />

      {settled && (
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
          สรุปยอดย้ายออกเรียบร้อยแล้ว — บิลย้ายออกแก้ไขที่นี่ไม่ได้อีก
        </Notice>
      )}
      {!unlocked && !settled && (
        <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
          {moveOutIssueText({ code: "not_unlocked" })}
        </Notice>
      )}

      <fieldset disabled={!unlocked || settled || billLocked || busy} className="space-y-5 disabled:opacity-70">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Zap className="h-4 w-4 text-warning-600" /> ไฟฟ้า
            </p>
            <Input
              label="เลขมิเตอร์วันคืนกุญแจ"
              type="number"
              min={0}
              value={form.final_electricity_reading}
              onChange={(e) => setReading("final_electricity_reading", e.target.value)}
              hint={`มิเตอร์ล่าสุดของห้อง: ${latestPrevElectricity}`}
              error={elec < latestPrevElectricity ? "น้อยกว่าเลขมิเตอร์ล่าสุด — ตรวจสอบอีกครั้ง" : undefined}
            />
          </Card>
          <Card className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Droplets className="h-4 w-4 text-primary-600" /> น้ำประปา
            </p>
            <Input
              label="เลขมิเตอร์วันคืนกุญแจ"
              type="number"
              min={0}
              value={form.final_water_reading}
              onChange={(e) => setReading("final_water_reading", e.target.value)}
              hint={`มิเตอร์ล่าสุดของห้อง: ${latestPrevWater}`}
              error={water < latestPrevWater ? "น้อยกว่าเลขมิเตอร์ล่าสุด — ตรวจสอบอีกครั้ง" : undefined}
            />
          </Card>
        </div>

        <Card className="p-5">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={useProrate}
              onChange={(e) => setUseProrate(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300"
            />
            <span>
              <span className="block text-sm font-semibold text-slate-800">
                คิดค่าเช่าส่วนเกินแบบ pro-rate / Prorate leftover days
              </span>
              <span className="mt-0.5 block text-sm text-slate-500">
                ค่าเช่าเดือนเต็มคิดเสมอ ส่วนวันที่เหลือไม่ครบเดือน: เปิด = คิดตามวัน (ค่าเช่า ÷ 30 ปัดลง × จำนวนวัน),
                ปิด = ไม่คิดวันที่เหลือ — ระบบไม่ตัดสินใจแทน
              </span>
            </span>
          </label>
        </Card>
      </fieldset>

      {errorText && (
        <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {errorText}
        </Notice>
      )}

      {billLocked && !settled && (
        <Notice tone="info" icon={<FileText className="h-4 w-4" />}>
          {moveOutIssueText({ code: "move_out_bill_exists" })}
        </Notice>
      )}

      {(breakdown || moveOutBill) && (
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <FileText className="h-4 w-4 text-slate-500" /> บิลย้ายออกที่สร้างแล้ว
            </p>
            <Badge variant={moveOutBill?.status === "draft" || !moveOutBill ? "neutral" : "primary"}>
              {moveOutBill?.status === "draft" || !moveOutBill ? "ฉบับร่าง" : moveOutBill.status}
            </Badge>
          </div>
          {breakdown ? <BreakdownView b={breakdown} /> : moveOutBill ? <StoredBillView bill={moveOutBill} /> : null}
          {breakdownStale && (
            <Notice tone="warning" icon={<RefreshCw className="h-4 w-4" />}>
              คุณเปลี่ยนเลขมิเตอร์หรือวิธีคิดค่าเช่าหลังสร้างบิล — กด “สร้างบิลใหม่” เพื่อให้บิลตรงกับค่าที่เลือก
            </Notice>
          )}
        </Card>
      )}

      <div className="flex flex-wrap justify-between gap-2 pt-2">
        <Button variant="secondary" onClick={onBack} icon={<ChevronLeft className="h-4 w-4" />}>
          ย้อนกลับ
        </Button>
        <div className="flex flex-wrap gap-2">
          {unlocked && !settled && !billLocked && (
            <Button
              variant={moveOutBill ? "secondary" : "primary"}
              onClick={prepare}
              loading={busy}
              disabled={!canEditTenant || readingsInvalid}
              icon={<FileText className="h-4 w-4" />}
            >
              {moveOutBill ? "สร้างบิลใหม่ด้วยค่าที่เลือก" : "สร้างบิลย้ายออก"}
            </Button>
          )}
          <Button
            onClick={onNext}
            disabled={!moveOutBill && !settled}
            iconRight={<ChevronRight className="h-4 w-4" />}
          >
            ถัดไป: สรุปยอด
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 4: Settlement preview + confirm ─────────────────────────────────────

function Step4Settle({
  activeTenant,
  roomNumber,
  forfeitDeposit,
  setForfeitDeposit,
  canEditTenant,
  onChanged,
  onDone,
  onBack,
}: {
  activeTenant: any;
  roomNumber: string;
  forfeitDeposit: boolean;
  setForfeitDeposit: (v: boolean) => void;
  canEditTenant: boolean;
  onChanged: Props["onChanged"];
  onDone: () => void;
  onBack: () => void;
}) {
  const tenantId = String(activeTenant?.id ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changedNotice, setChangedNotice] = useState(false);

  const {
    data: preview,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<SettlementPreview>(
    tenantId ? ["settlement-preview", tenantId, forfeitDeposit] : null,
    () => callTenantsAction<SettlementPreview>("get_settlement_preview", { tenantId, forfeitDeposit }),
    { revalidateOnFocus: false },
  );

  // A changed forfeit choice is a new preview, not a changed one.
  useEffect(() => setChangedNotice(false), [forfeitDeposit]);

  const settle = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await callTenantsAction("settle_move_out", {
        tenantId,
        forfeitDeposit,
        expectedRefund: preview.projected.refund,
      });
      const refundAmount = toNumber(res?.rpc?.refund?.amount ?? res?.rpc?.credit?.refund ?? 0);
      toast.success(
        res?.result === "already_settled"
          ? "สรุปยอดย้ายออกนี้ทำไปแล้วก่อนหน้านี้"
          : refundAmount > 0
            ? `สรุปยอดย้ายออกเรียบร้อย — ต้องคืนเงินผู้เช่า ${baht(refundAmount)} (ดูได้ที่ส่วนเงินคืน)`
            : "สรุปยอดย้ายออกเรียบร้อย",
        { duration: 8000 },
      );
      setConfirmOpen(false);
      await onChanged();
      onDone();
    } catch (err) {
      setConfirmOpen(false);
      if (err instanceof TenantsActionError && err.status === 409 && err.code === "preview_changed" && err.body?.preview) {
        // The money moved since the admin looked: show the new figures and
        // make them confirm again rather than settling on different numbers.
        await mutate(err.body.preview as SettlementPreview, { revalidate: false });
        setChangedNotice(true);
        toast.warning(moveOutIssueText({ code: "preview_changed" }));
      } else {
        toast.error(issueFromError(err));
        void mutate();
      }
    } finally {
      setBusy(false);
    }
  };

  const p = preview;
  const confirmMessage = p
    ? [
        `ยืนยันสรุปยอดย้ายออกของ ${activeTenant?.full_name ?? "ผู้เช่า"} ห้อง ${roomNumber}?`,
        `ใช้เครดิต ${baht(p.credit.total)} (เงินประกัน ${baht(p.credit.deposit)}${
          forfeitDeposit ? " — ริบ" : ""
        } + ค่าเช่าล่วงหน้า ${baht(p.credit.advanceRent)})`,
        `หักบิลย้ายออก ${baht(p.projected.creditToMoveOutBill)}` +
          (p.projected.creditToOlderBills > 0 ? ` และบิลเก่า ${baht(p.projected.creditToOlderBills)}` : ""),
        p.projected.feesWaived > 0 ? `ยกเว้นค่าปรับค้างของบิลเก่า ${baht(p.projected.feesWaived)}` : "",
        p.projected.refund > 0 ? `คืนเงินผู้เช่า ${baht(p.projected.refund)} (บันทึกเป็น "รอคืนเงิน")` : "ไม่มีเงินคืน",
        p.projected.remainingOwed > 0 ? `ผู้เช่ายังค้างชำระ ${baht(p.projected.remainingOwed)} (ไม่มีค่าปรับ)` : "",
        "บิลย้ายออกจะเปลี่ยนจากฉบับร่างเป็นบิลจริง และผู้เช่าจะออกจากห้องในระบบ — ทำย้อนกลับไม่ได้",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="space-y-5 animate-fade-in-up">
      <StepHeading
        title="สรุปยอดย้ายออก"
        description="เงินประกันและค่าเช่าล่วงหน้าจ่ายบิลย้ายออกก่อน แล้วจ่ายบิลเก่าจากเก่าสุด ค่าปรับค้างของบิลเก่าถูกยกเว้น ที่เหลือคืนผู้เช่า"
      />

      <Card className="p-5">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={forfeitDeposit}
            onChange={(e) => setForfeitDeposit(e.target.checked)}
            disabled={busy || isSettled(activeTenant)}
            className="mt-1 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-800">ริบเงินประกัน (ไม่คืนเงินประกัน)</span>
            <span className="mt-0.5 block text-sm text-slate-500">
              ใช้กรณีผิดสัญญา — เงินประกันจะไม่ถูกนำมาหักบิลหรือคืน ใช้เฉพาะค่าเช่าล่วงหน้า
            </span>
          </span>
        </label>
      </Card>

      {isLoading && !p && <div className="h-40 animate-pulse rounded-card bg-slate-100" />}
      {error && !p && (
        <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          โหลดตัวอย่างการสรุปยอดไม่สำเร็จ: {issueFromError(error)}
        </Notice>
      )}

      {p && (
        <>
          {changedNotice && (
            <Notice tone="warning" icon={<RefreshCw className="h-4 w-4" />} title="ตัวเลขมีการเปลี่ยนแปลง">
              มีการชำระเงิน ยกเลิกการชำระ หรือแก้บิลหลังจากที่แสดงตัวอย่างครั้งก่อน — ตัวเลขด้านล่างเป็นยอดล่าสุด
              ตรวจสอบแล้วกดยืนยันอีกครั้ง
            </Notice>
          )}

          {p.blockers.length > 0 && (
            <Notice tone="danger" icon={<Ban className="h-4 w-4" />} title="ยังสรุปยอดไม่ได้">
              <ul className="list-disc space-y-1 pl-4">
                {p.blockers.map((b, i) => (
                  <li key={`${b.code}-${i}`}>{moveOutIssueText(b)}</li>
                ))}
              </ul>
            </Notice>
          )}
          {p.warnings.length > 0 && (
            <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" />} title="ข้อควรทราบ">
              <ul className="list-disc space-y-1 pl-4">
                {[...new Set(p.warnings.map((w) => moveOutIssueText(w)))].map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </Notice>
          )}

          <Card className="space-y-2 p-5">
            <p className="text-sm font-semibold text-slate-800">เครดิตของผู้เช่า</p>
            <LineItem
              label={forfeitDeposit ? "เงินประกัน (ริบ — ไม่นำมาใช้)" : "เงินประกัน"}
              value={baht(p.credit.deposit)}
            />
            <LineItem label="ค่าเช่าล่วงหน้า" value={baht(p.credit.advanceRent)} />
            <div className="border-t border-dashed border-slate-200 pt-2">
              <LineItem label="รวมเครดิต" value={baht(p.credit.total)} />
            </div>
          </Card>

          <Card className="space-y-3 p-5">
            <p className="text-sm font-semibold text-slate-800">เครดิตจะจ่ายบิลตามลำดับนี้</p>
            {p.moveOutBill ? (
              <div className="rounded-control bg-slate-50 px-3 py-2.5">
                <LineItem
                  label={
                    <>
                      1. บิลย้ายออก {periodLabel(p.moveOutBill.start_date, p.moveOutBill.end_date)}{" "}
                      {p.moveOutBill.status === "draft" && (
                        <Badge size="sm" variant="neutral">
                          ฉบับร่าง
                        </Badge>
                      )}
                    </>
                  }
                  sub={`ยอดบิล ${baht(p.moveOutBill.amountDue)}${
                    p.moveOutBill.remainingDue > 0 ? ` · ยังค้าง ${baht(p.moveOutBill.remainingDue)}` : " · ชำระครบ"
                  }`}
                  value={`หัก ${baht(p.moveOutBill.creditApplied)}`}
                />
              </div>
            ) : (
              <p className="text-sm text-slate-500">ยังไม่มีบิลย้ายออก</p>
            )}
            {p.olderBills.map((bill, index) => (
              <div key={bill.invoice_id} className="rounded-control bg-slate-50 px-3 py-2.5">
                <LineItem
                  label={`${index + 2}. บิลเก่า ${periodLabel(bill.start_date, bill.end_date)}`}
                  sub={[
                    `ค่าเช่า/ค่าน้ำไฟค้าง ${baht(bill.charges_due)}`,
                    bill.fee_to_waive > 0 ? `ยกเว้นค่าปรับ ${baht(bill.fee_to_waive)}` : "",
                    bill.remaining_due > 0 ? `ยังค้าง ${baht(bill.remaining_due)}` : "ชำระครบ",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  value={`หัก ${baht(bill.credit_applied)}`}
                />
              </div>
            ))}
            {p.olderBills.length === 0 && <p className="text-xs text-slate-400">ไม่มีบิลเก่าค้างชำระ</p>}
          </Card>

          <Card className="space-y-2 p-5">
            <p className="text-sm font-semibold text-slate-800">ผลการสรุปยอด</p>
            <LineItem label="ใช้เครดิตหักบิลรวม" value={baht(p.projected.creditApplied)} />
            <LineItem label="ค่าปรับค้างที่ยกเว้น (บิลเก่า)" value={baht(p.projected.feesWaived)} />
            <LineItem
              label="ยังค้างชำระหลังสรุปยอด"
              value={baht(p.projected.remainingOwed)}
              sub={p.projected.remainingOwed > 0 ? "คงอยู่บนบิลเดิม ไม่มีค่าปรับ" : undefined}
            />
            <div className="border-t border-dashed border-slate-200 pt-2">
              <LineItem
                label="เงินคืนผู้เช่า"
                value={<span className="text-base text-success-700">{baht(p.projected.refund)}</span>}
                sub={p.projected.refund > 0 ? "บันทึกเป็น “รอคืนเงิน” — กดบันทึกจ่ายคืนเมื่อโอนแล้วที่หน้าย้ายออก" : undefined}
              />
            </div>
            <p className="pt-1 text-xs text-slate-400">คำนวณ ณ วันที่ {thaiDate(p.asOf)}</p>
          </Card>
        </>
      )}

      <div className="flex flex-wrap justify-between gap-2 border-t border-slate-100 pt-4">
        <Button variant="secondary" onClick={onBack} icon={<ChevronLeft className="h-4 w-4" />}>
          ย้อนกลับ
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setChangedNotice(false);
              void mutate();
            }}
            loading={isValidating && !busy}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            คำนวณใหม่
          </Button>
          <Button
            variant="success"
            onClick={() => setConfirmOpen(true)}
            disabled={!canEditTenant || !p?.canSettle || isValidating}
            loading={busy}
            icon={<Flag className="h-4 w-4" />}
          >
            ยืนยันสรุปยอดย้ายออก
          </Button>
        </div>
      </div>

      <ConfirmActionModal
        isOpen={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={settle}
        title="ยืนยันสรุปยอดย้ายออก"
        message={confirmMessage}
        confirmLabel="ยืนยันสรุปยอด"
        loading={busy}
      />
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

/** Where to open the wizard: the first step that still needs doing. */
const initialStepFor = (tenant: any, moveOutBill: InvoiceRow | null) => {
  if (tenant?.status === "active") return 1;
  if (!isUnlocked(tenant)) return isSettled(tenant) ? 4 : 2;
  return moveOutBill ? 4 : 3;
};

export function MoveOutWizard(props: Props) {
  const {
    activeTenant,
    activeMoveOutRequest,
    form,
    setForm,
    forfeitDeposit,
    setForfeitDeposit,
    latestPrevElectricity,
    latestPrevWater,
    tenantInvoiceHistory,
    outstandingMoveOutInvoices,
    unpaidInvoicesSubtotal,
    roomNumber,
    canEditTenant,
    isCancellingMoveOut,
    onApprove,
    onDecline,
    onCancelMoveOut,
    onAbandonRoom,
    onChanged,
    onDone,
  } = props;

  const moveOutBill = useMemo(() => findMoveOutBill(tenantInvoiceHistory ?? []), [tenantInvoiceHistory]);
  const [step, setStep] = useState(() => initialStepFor(activeTenant, moveOutBill));

  const doneSteps = useMemo(() => {
    const done = new Set<number>();
    if (activeTenant?.status !== "active") done.add(1);
    if (isUnlocked(activeTenant) || isSettled(activeTenant)) done.add(2);
    if (moveOutBill) done.add(3);
    if (isSettled(activeTenant)) done.add(4);
    return done;
  }, [activeTenant, moveOutBill]);

  const goTo = (s: number) => {
    if (s >= 1 && s <= STEPS.length) setStep(s);
  };

  return (
    <div className="flex min-h-[480px] flex-col gap-4 md:flex-row md:gap-0">
      <div className="shrink-0 md:w-44 md:border-r md:border-slate-100 md:pr-4 md:pt-1">
        <p className="mb-3 px-3 text-2xs font-bold uppercase tracking-widest text-slate-400">ขั้นตอน</p>
        <StepRail currentStep={step} doneSteps={doneSteps} onStepClick={goTo} />
      </div>

      <div className="min-w-0 flex-1 md:pl-6 md:pt-1">
        {isSettled(activeTenant) && step !== 4 && (
          <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />} className="mb-4">
            สรุปยอดย้ายออกของผู้เช่ารายนี้เรียบร้อยแล้ว
          </Notice>
        )}
        {step === 1 && (
          <Step1RequestReview
            activeTenant={activeTenant}
            activeMoveOutRequest={activeMoveOutRequest}
            form={form}
            forfeitDeposit={forfeitDeposit}
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
          <Step2Unlock
            key={`unlock-${activeTenant?.id}`}
            activeTenant={activeTenant}
            roomNumber={roomNumber}
            canEditTenant={canEditTenant}
            onChanged={onChanged}
            onBack={() => goTo(1)}
            onNext={() => goTo(3)}
          />
        )}
        {step === 3 && (
          <Step3PrepareBill
            key={`prepare-${activeTenant?.id}`}
            activeTenant={activeTenant}
            form={form}
            setForm={setForm}
            latestPrevElectricity={latestPrevElectricity}
            latestPrevWater={latestPrevWater}
            moveOutBill={moveOutBill}
            canEditTenant={canEditTenant}
            onChanged={onChanged}
            onBack={() => goTo(2)}
            onNext={() => goTo(4)}
          />
        )}
        {step === 4 && (
          <Step4Settle
            activeTenant={activeTenant}
            roomNumber={roomNumber}
            forfeitDeposit={forfeitDeposit}
            setForfeitDeposit={setForfeitDeposit}
            canEditTenant={canEditTenant}
            onChanged={onChanged}
            onDone={onDone}
            onBack={() => goTo(3)}
          />
        )}
      </div>
    </div>
  );
}
