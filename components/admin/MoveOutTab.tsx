"use client";

import type { MoveOutRequestRow, SettingsRates, MoveOutFeeLine } from "@/types";
import { toNumber, roundTo2, ymdToLocalDate, formatMoney } from "@/lib/format";

import { getInvoiceOutstanding } from "@/lib/invoice-ledger";
import { bangkokYmd, meets30DayMoveOutNotice } from "@/lib/move-out-notice";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import {
  CheckCircle2,
  XCircle,
  Ban,
  Loader2,
  Plus,
  Printer,
  Save,
  Trash2,
  AlertTriangle,
  ClipboardList,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export 
type TenantSnapshot = {
  id: string;
  full_name: string;
  room_id: string;
  status: string;
  advance_rent_amount: number | null;
  security_deposit_amount: number | null;
  move_out_date: string | null;
  forfeit_security_deposit: boolean | null;
};

type InvoiceHistoryRow = {
  id: string;
  start_date: string;
  end_date: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
  payment_history: any[];
  created_at: string | null;
};

export type MoveOutTabForm = {
  full_name: string;
  advance_rent_amount: number;
  security_deposit_amount: number;
  final_electricity_reading: number;
  final_water_reading: number;
  move_out_request_date: string;
  final_move_out_date: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const requestStatusLabel = (s: string) => {
  if (s === "requested") return "รอตรวจสอบ";
  if (s === "approved") return "อนุมัติแล้ว";
  if (s === "rejected") return "ไม่อนุมัติ";
  if (s === "completed") return "เสร็จสิ้น";
  if (s === "cancelled") return "ยกเลิก";
  return s;
};

const requestBadgeVariant = (s: string): "warning" | "success" | "danger" | "default" => {
  if (s === "requested") return "warning";
  if (s === "approved") return "success";
  if (s === "rejected" || s === "cancelled") return "danger";
  return "default";
};

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  activeTenant: TenantSnapshot | null;
  activeMoveOutRequest: MoveOutRequestRow | null;
  rates: SettingsRates;
  form: MoveOutTabForm;
  setForm: (updater: (prev: MoveOutTabForm) => MoveOutTabForm) => void;
  forfeitDeposit: boolean;
  setForfeitDeposit: (v: boolean) => void;
  moveOutFeeLines: MoveOutFeeLine[];
  setMoveOutFeeLines: React.Dispatch<React.SetStateAction<MoveOutFeeLine[]>>;
  useProrate: boolean;
  setUseProrate: (v: boolean) => void;
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
  isSavingTenant: boolean;
  isMovingOut: boolean;
  isCancellingMoveOut: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onCancelMoveOut: () => void;
  onSave: () => void;
  onPrint: () => void;
  onConfirmMoveOut: () => void;
  /** Triggered when admin confirms the abandon-room flow */
  onAbandonRoom: (forfeitDeposit: boolean, moveOutDate: string) => Promise<void>;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function MoveOutTab({
  activeTenant,
  activeMoveOutRequest,
  rates,
  form,
  setForm,
  forfeitDeposit,
  setForfeitDeposit,
  moveOutFeeLines,
  setMoveOutFeeLines,
  useProrate,
  setUseProrate,
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
  isSavingTenant,
  isMovingOut,
  isCancellingMoveOut,
  onApprove,
  onDecline,
  onCancelMoveOut,
  onSave,
  onPrint,
  onConfirmMoveOut,
  onAbandonRoom,
}: Props) {
  const [abandonRoom, setAbandonRoom] = useState(false);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
  const [isAbandoning, setIsAbandoning] = useState(false);
  const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  // ── Derived values ─────────────────────────────────────────────────────────

  const activeMoveOutNoticeYmd = useMemo(() => {
    if (!activeMoveOutRequest) return "";
    if (activeMoveOutRequest.notice_date) return String(activeMoveOutRequest.notice_date).slice(0, 10);
    if (activeMoveOutRequest.created_at) return bangkokYmd(new Date(activeMoveOutRequest.created_at));
    return "";
  }, [activeMoveOutRequest]);

  const moveOutShorterThan30Days =
    Boolean(activeMoveOutRequest && activeMoveOutNoticeYmd && activeMoveOutRequest.requested_move_out_date) &&
    !meets30DayMoveOutNotice(
      activeMoveOutNoticeYmd,
      String(activeMoveOutRequest?.requested_move_out_date ?? "").slice(0, 10)
    );

  const electricityUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const utilityTotal = electricityUsage * rates.electricity_rate + waterUsage * rates.water_rate;

  const roomPrice = useMemo(() => {
    const rel = activeTenant
      ? (Array.isArray((activeTenant as any).rooms)
          ? (activeTenant as any).rooms[0]
          : (activeTenant as any).rooms)
      : null;
    return toNumber(rel?.price_month ?? 0);
  }, [activeTenant]);

  const dailyRent = roomPrice > 0 ? roomPrice / 30 : 0;
  const overstayDays = tailDaysAfterBilledPeriod;
  const overstayRentCharge = Math.round((overstayDays * dailyRent + Number.EPSILON) * 100) / 100;
  
  const additionalFeesTotal = moveOutFeeLines.reduce((s, l) => s + toNumber(l.amount), 0);
  const totalCost = unpaidInvoicesSubtotal + appliedMoveOutRentBase + utilityTotal + overstayRentCharge + additionalFeesTotal;
  
  const refundableDeposit = forfeitDeposit ? 0 : toNumber(form.security_deposit_amount);
  const forfeitedDepositAmount = forfeitDeposit ? toNumber(form.security_deposit_amount) : 0;
  const prepaid = refundableDeposit + toNumber(form.advance_rent_amount);
  const net = prepaid - totalCost;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleAbandonConfirm = async () => {
    setIsAbandoning(true);
    try {
      await onAbandonRoom(forfeitDeposit, form.final_move_out_date || new Date().toISOString().slice(0, 10));
    } finally {
      setIsAbandoning(false);
      setAbandonConfirmOpen(false);
    }
  };

  const createFeeLine = (): MoveOutFeeLine => ({ id: crypto.randomUUID(), label: "", amount: 0 });

  const setField = <K extends keyof MoveOutTabForm>(key: K, value: MoveOutTabForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const rentLabel = latestBilledEndYmd
    ? `ค่าเช่าห้องแบบเต็มเดือน (ตั้งแต่วันสิ้นสุดบิลล่าสุด: ${latestBilledEndYmd})`
    : "ค่าเช่าห้องแบบเต็มเดือน";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <fieldset disabled={!canEditTenant} className="space-y-4 disabled:cursor-not-allowed disabled:opacity-70">

      {/* ── 1. REQUEST STATUS PANEL ── */}
      {activeMoveOutRequest && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-blue-600" />
              <p className="font-semibold text-slate-900 text-sm">คำขอย้ายออกจากผู้เช่า</p>
            </div>
            <Badge variant={requestBadgeVariant(activeMoveOutRequest.status)}>
              {requestStatusLabel(activeMoveOutRequest.status)}
            </Badge>
          </div>

          {/* Dates grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-700">
            <div>
              <span className="text-slate-500">วันที่แจ้ง (30 วัน):</span>{" "}
              <span className="font-medium">{activeMoveOutNoticeYmd || "—"}</span>
            </div>
            <div>
              <span className="text-slate-500">วันที่ต้องการย้ายออก:</span>{" "}
              <span className="font-medium">{activeMoveOutRequest.requested_move_out_date}</span>
            </div>
            {activeMoveOutRequest.approved_move_out_date && (
              <div className="col-span-2">
                <span className="text-slate-500">วันที่อนุมัติ:</span>{" "}
                <span className="font-medium text-green-700">{activeMoveOutRequest.approved_move_out_date}</span>
              </div>
            )}
          </div>

          {/* 30-day warning */}
          {moveOutShorterThan30Days && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-100 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>วันย้ายออกตามคำขอใกล้กว่า 30 วันจากวันที่แจ้ง — ตรวจสอบเงินประกันตามสัญญา</span>
            </div>
          )}

          {/* Tenant note */}
          {activeMoveOutRequest.request_note && (
            <p className="text-xs text-slate-600">
              <span className="font-medium">หมายเหตุผู้เช่า:</span> {activeMoveOutRequest.request_note}
            </p>
          )}

        </div>
      )}

      {/* ── 3. PENDING BILLS ── */}
      {outstandingMoveOutInvoices.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="font-semibold">บิลค้างชำระ (รวมในสรุปย้ายออก)</p>
            <Link href="/invoices" className="shrink-0 text-sm font-medium text-amber-900 underline hover:text-amber-700">
              ไปหน้าใบแจ้งหนี้
            </Link>
          </div>
          <ul className="mt-2 space-y-1.5 text-xs">
            {outstandingMoveOutInvoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap justify-between gap-2 border-b border-amber-200/60 pb-1 last:border-0">
                <span>
                  งวด {String(inv.start_date ?? "").slice(0, 10)} → {String(inv.end_date ?? "").slice(0, 10)} ·{" "}
                  <span className="font-medium">{inv.status}</span>
                </span>
                <span className="font-semibold">ค้าง ฿{formatMoney(getInvoiceOutstanding(inv))}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-900/80">
            รวมยอดค้าง: ฿{formatMoney(unpaidInvoicesSubtotal)} — นำไปรวมใน &quot;รวมค่าใช้จ่าย&quot; ด้านล่าง
          </p>
        </div>
      )}

      {/* ── 4. PRO-RATE INFO + DATE INPUTS ── */}
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        ค่าเช่า Pro-rate หลังบิลล่าสุด: ใช้วันสิ้นสุดรอบในใบแจ้งหนี้ (
        <span className="font-mono">{latestBilledEndYmd ?? "—"}</span>
        ) เทียบกับวันย้ายออก — ช่วงหลังวันนั้นจนถึงวันย้ายออกจะคิดเพิ่ม
        หากไม่ต้องการให้ระบบนำยอด Pro-rate ไปหักในสรุป ให้ยกเลิกเลือกช่องด้านล่าง
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="วันที่ย้ายออกตามคำขอ (สำหรับคำนวณ/อ้างอิง)"
          type="date"
          value={form.move_out_request_date}
          onChange={(e) => setField("move_out_request_date", e.target.value)}
          className="text-base"
        />
        <Input
          label="วันที่ย้ายออกจริง"
          type="date"
          value={form.final_move_out_date}
          onChange={(e) => setField("final_move_out_date", e.target.value)}
          className="text-base"
        />
      </div>

      {/* ── 5. METER READINGS ── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
        <p className="text-sm font-semibold text-slate-800">มิเตอร์ ณ วันย้ายออก</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label={`เลขมิเตอร์ไฟสุดท้าย (ก่อนหน้า ${latestPrevElectricity})`}
            type="number"
            value={form.final_electricity_reading}
            onChange={(e) => setField("final_electricity_reading", toNumber(e.target.value))}
            className="text-base"
          />
          <Input
            label={`เลขมิเตอร์น้ำสุดท้าย (ก่อนหน้า ${latestPrevWater})`}
            type="number"
            value={form.final_water_reading}
            onChange={(e) => setField("final_water_reading", toNumber(e.target.value))}
            className="text-base"
          />
        </div>
        <div className="grid grid-cols-2 gap-x-6 text-xs text-slate-600">
          <p>ไฟฟ้า: <span className="font-semibold">{electricityUsage} หน่วย × ฿{rates.electricity_rate} = ฿{formatMoney(electricityUsage * rates.electricity_rate)}</span></p>
          <p>น้ำ: <span className="font-semibold">{waterUsage} หน่วย × ฿{rates.water_rate} = ฿{formatMoney(waterUsage * rates.water_rate)}</span></p>
        </div>
      </div>

      {/* ── 6. CHECKBOXES ── */}
      <div className="space-y-3">
        {/* Removed useProrate checkbox as Prorate is now hardcoded correctly by the Master Invoice */}

        {/* Forfeit deposit */}
        <label className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 cursor-pointer">
          <input
            type="checkbox"
            checked={forfeitDeposit}
            onChange={(e) => setForfeitDeposit(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-red-600"
          />
          <span>
            <span className="block font-semibold">ไม่คืนเงินประกัน</span>
            <span className="mt-1 block text-xs text-red-700">
              ใช้กรณีผู้เช่าไม่แจ้งล่วงหน้าหรือย้ายออกก่อนครบสัญญา
              ระบบจะไม่นำเงินประกันมาหักคืนในสรุปย้ายออก
            </span>
          </span>
        </label>

        {/* Abandon room */}
        <label className="flex items-start gap-3 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900 cursor-pointer">
          <input
            type="checkbox"
            checked={abandonRoom}
            onChange={(e) => setAbandonRoom(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-orange-600"
          />
          <span>
            <span className="block font-semibold">ผู้เช่าทิ้งห้อง</span>
            <span className="mt-1 block text-xs text-orange-700">
              ระบบจะใช้ค่าเช่าล่วงหน้า{!forfeitDeposit ? " + เงินประกัน" : ""} เป็นเครดิตหักลบบิลค้างชำระตามลำดับ
              บิลที่เหลือจะถูกยกเลิก และผู้เช่าถูกย้ายออกทันที
              (กดปุ่ม &ldquo;ยืนยันทิ้งห้อง&rdquo; ด้านล่างเพื่อดำเนินการ)
            </span>
          </span>
        </label>
      </div>

      {/* ── 7. ADDITIONAL FEES ── */}
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-800">ค่าใช้จ่ายเพิ่มเติม (ย้ายออก)</p>
          <button
            type="button"
            onClick={() => setMoveOutFeeLines((prev) => [...prev, createFeeLine()])}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            <Plus size={14} />
            เพิ่มรายการ
          </button>
        </div>
        {moveOutFeeLines.length === 0 && (
          <p className="text-sm text-slate-500">ยังไม่มีค่าใช้จ่ายเพิ่มเติม</p>
        )}
        {moveOutFeeLines.map((line) => (
          <div key={line.id} className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
            <Input
              label="รายการ"
              value={line.label}
              onChange={(e) =>
                setMoveOutFeeLines((prev) =>
                  prev.map((item) => (item.id === line.id ? { ...item, label: e.target.value } : item))
                )
              }
            />
            <Input
              label="จำนวนเงิน"
              type="number"
              value={line.amount}
              onChange={(e) =>
                setMoveOutFeeLines((prev) =>
                  prev.map((item) => (item.id === line.id ? { ...item, amount: toNumber(e.target.value) } : item))
                )
              }
            />
            <button
              type="button"
              onClick={() => setMoveOutFeeLines((prev) => prev.filter((item) => item.id !== line.id))}
              className="mt-7 inline-flex h-10 items-center justify-center rounded-lg border border-red-200 px-3 text-red-600"
              title="ลบรายการ"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* ── 8. MOVE-OUT INVOICE SUMMARY ── */}
      <div className="rounded-2xl border border-slate-300 bg-white p-5 text-sm text-slate-700">
        <div className="mb-3 border-b border-dashed border-slate-300 pb-3">
          <p className="text-lg font-semibold text-slate-900">สรุปย้ายออก</p>
          <p>ผู้เช่า: {form.full_name || "—"}</p>
          <p>ห้อง: {roomNumber}</p>
          <p>วันที่แจ้ง (30 วัน): {activeMoveOutNoticeYmd || "—"}</p>
          <p>วันที่ย้ายออกตามคำขอ: {form.move_out_request_date || "—"}</p>
          <p>วันที่ย้ายออกจริง: {form.final_move_out_date || "—"}</p>
        </div>

        <div className="space-y-1">
          {unpaidInvoicesSubtotal > 0 && (
            <p className="flex justify-between text-amber-900">
              <span>ยอดบิลค้างชำระ ({outstandingMoveOutInvoices.length} รายการ)</span>
              <span>฿{formatMoney(unpaidInvoicesSubtotal)}</span>
            </p>
          )}
          <p className="flex justify-between">
            <span>{rentLabel}</span>
            <span>฿{formatMoney(appliedMoveOutRentBase)}</span>
          </p>
          {overstayRentCharge > 0 && (
            <p className="flex justify-between">
              <span>ค่าเช่า Pro-rate ส่วนเกิน ({overstayDays} วัน)</span>
              <span>฿{formatMoney(overstayRentCharge)}</span>
            </p>
          )}
          <p className="flex justify-between">
            <span>ค่าไฟฟ้า ({electricityUsage} หน่วย)</span>
            <span>฿{formatMoney(electricityUsage * rates.electricity_rate)}</span>
          </p>
          <p className="flex justify-between">
            <span>ค่าน้ำ ({waterUsage} หน่วย)</span>
            <span>฿{formatMoney(waterUsage * rates.water_rate)}</span>
          </p>
          {moveOutFeeLines
            .filter((l) => l.label.trim() && toNumber(l.amount) > 0)
            .map((l) => (
              <p key={l.id} className="flex justify-between">
                <span>{l.label.trim()}</span>
                <span>฿{formatMoney(toNumber(l.amount))}</span>
              </p>
            ))}
        </div>

        <div className="my-3 border-t border-dashed border-slate-300" />

        <div className="space-y-1">
          <p className="flex justify-between font-medium">
            <span>รวมค่าใช้จ่าย</span>
            <span>฿{formatMoney(totalCost)}</span>
          </p>
          <p className="flex justify-between">
            <span>ค่าเช่าล่วงหน้าที่นำมาหักได้</span>
            <span>฿{formatMoney(toNumber(form.advance_rent_amount))}</span>
          </p>
          <p className="flex justify-between">
            <span>เงินประกันที่นำมาหักได้</span>
            <span>฿{formatMoney(refundableDeposit)}</span>
          </p>
          {forfeitedDepositAmount > 0 && (
            <p className="flex justify-between text-red-700">
              <span>เงินประกันที่ไม่คืน</span>
              <span>฿{formatMoney(forfeitedDepositAmount)}</span>
            </p>
          )}
          <p className="flex justify-between">
            <span>รวมยอดที่หักคืนได้</span>
            <span>฿{formatMoney(prepaid)}</span>
          </p>
        </div>

        <div className="my-3 border-t border-dashed border-slate-300" />

        <p className={`text-base font-semibold ${net >= 0 ? "text-green-700" : "text-red-700"}`}>
          {net >= 0
            ? `คืนเงินผู้เช่า: ฿${formatMoney(net)}`
            : `ผู้เช่าค้างชำระ: ฿${formatMoney(Math.abs(net))}`}
        </p>
      </div>

      {/* ── 9. ACTION BUTTONS ── */}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 mt-6">
        <button
          type="button"
          onClick={onSave}
          disabled={!activeTenant || !canEditTenant || isSavingTenant}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-300 bg-blue-50 px-4 py-2.5 text-base font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSavingTenant ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {isSavingTenant ? "กำลังบันทึก..." : "บันทึกข้อมูลย้ายออก"}
        </button>

        {activeMoveOutRequest?.status === "requested" ? (
          <>
            <button
              type="button"
              onClick={onApprove}
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-green-700"
            >
              <CheckCircle2 size={16} /> อนุมัติคำขอย้ายออก
            </button>
            <button
              type="button"
              onClick={onDecline}
              className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-white px-4 py-2.5 text-base font-semibold text-red-600 hover:bg-red-50"
            >
              <XCircle size={16} /> ไม่อนุมัติ
            </button>
            <button
              type="button"
              onClick={() => setConfirmCancelOpen(true)}
              disabled={isCancellingMoveOut}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-slate-100 px-4 py-2.5 text-base font-semibold text-slate-800 hover:bg-slate-200 disabled:opacity-50"
            >
              <Ban size={16} />
              {isCancellingMoveOut ? "กำลังดำเนินการ…" : "ยกเลิกกระบวนการย้ายออก"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onPrint}
              disabled={!activeTenant}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-base font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={16} />
              พิมพ์ใบสรุป
            </button>

            {abandonRoom ? (
              <button
                type="button"
                onClick={() => setAbandonConfirmOpen(true)}
                disabled={!activeTenant || !canEditTenant || isAbandoning}
                className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isAbandoning ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />}
                {isAbandoning ? "กำลังดำเนินการ..." : "ยืนยันทิ้งห้อง"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmMoveOutOpen(true)}
                disabled={!activeTenant || !canEditTenant || isMovingOut}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isMovingOut ? <Loader2 size={16} className="animate-spin" /> : null}
                {isMovingOut ? "กำลังย้ายออก..." : "ยืนยันการย้ายออก (เสร็จสิ้น)"}
              </button>
            )}
            
            {(activeTenant?.move_out_date || activeMoveOutRequest) && (
              <button
                type="button"
                onClick={() => setConfirmCancelOpen(true)}
                disabled={isCancellingMoveOut}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-base font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                <Ban size={16} />
                {isCancellingMoveOut ? "กำลังดำเนินการ…" : "ยกเลิกกระบวนการย้ายออก"}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Confirm: normal move-out ── */}
      <ConfirmActionModal
        isOpen={confirmMoveOutOpen}
        onCancel={() => setConfirmMoveOutOpen(false)}
        onConfirm={() => { setConfirmMoveOutOpen(false); onConfirmMoveOut(); }}
        title="ยืนยันการย้ายออก"
        message={`ยืนยันการย้ายออกของ ${form.full_name || "ผู้เช่า"} จากห้อง ${roomNumber}? การดำเนินการนี้จะเปลี่ยนสถานะผู้เช่าเป็น "ย้ายออกแล้ว" และเปลี่ยนสถานะห้องเป็น "ว่าง"`}
        confirmLabel="ยืนยันการย้ายออก"
      />

      {/* ── Confirm: cancel move-out ── */}
      <ConfirmActionModal
        isOpen={confirmCancelOpen}
        onCancel={() => setConfirmCancelOpen(false)}
        onConfirm={() => { setConfirmCancelOpen(false); onCancelMoveOut(); }}
        title="ยืนยันการยกเลิกย้ายออก"
        message="ยืนยันการยกเลิกกระบวนการย้ายออก? ระบบจะล้างวันย้ายออกและยกเลิกคำขอที่รอ/อนุมัติแล้ว ผู้เช่าจะยังพักอยู่ตามปกติ"
        confirmLabel="ยืนยันการยกเลิก"
      />

      {/* ── Confirm: abandon room ── */}
      <ConfirmActionModal
        isOpen={abandonConfirmOpen}
        onCancel={() => setAbandonConfirmOpen(false)}
        onConfirm={handleAbandonConfirm}
        title="ยืนยันผู้เช่าทิ้งห้อง"
        message={`ยืนยันว่า ${form.full_name || "ผู้เช่า"} ทิ้งห้อง ${roomNumber}? ระบบจะใช้ค่าเช่าล่วงหน้า ฿${formatMoney(toNumber(form.advance_rent_amount))}${!forfeitDeposit ? ` + เงินประกัน ฿${formatMoney(toNumber(form.security_deposit_amount))}` : ""} เป็นเครดิตหักบิลค้างชำระ บิลที่เหลือจะถูกยกเลิก และผู้เช่าจะถูกย้ายออกทันที การดำเนินการนี้ไม่สามารถย้อนกลับได้`}
        confirmLabel="ยืนยันทิ้งห้อง"
        loading={isAbandoning}
      />
    </fieldset>
  );
}
