"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, Eye } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { buttonClasses } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase-client";
import { formatMoney, toNumber } from "@/lib/format";
import { formatDateThai } from "@/lib/invoice-utils";
import type { MoveOutSettlementPlan } from "@/lib/money/settlement";

type Meter = { prevElec: number; curElec: number; prevWater: number; curWater: number };

type Props = {
  plan: MoveOutSettlementPlan | null;
  meter: Meter;
  prorateDays: number;
  dailyRate: number;
  fullMonths: number;
  periodLabelById?: Map<string, string>;
  tenantName: string;
  tenantPhone?: string | null;
  roomNumber: string;
  moveOutDate: string;
  /** Start of the final invoice period (end of the last billed period). */
  rentStartDate: string;
  /** Unbilled late fees on older invoices, with the admin's void choices. */
  lateFeeItems: LateFeeItem[];
  lateFeeVoids: Record<string, { voided: boolean; reason: string }>;
  /** Older unpaid invoices, to show where each debt comes from. */
  invoiceInfoById: Map<string, { period: string; total: number; paid: number }>;
};

type LateFeeItem = {
  invoiceId: string;
  periodStart: string;
  periodEnd: string | null;
  daysOverdue: number | null;
  dailyRate: number;
  amount: number;
  locked: boolean;
};

const LATE_FEE_PREFIX = "late_fee_line:";

type PrintConfig = {
  settings: { dorm_name?: string | null; dorm_address?: string | null; water_rate?: number | null; electricity_rate?: number | null } | null;
  method: { label?: string | null; bank_name?: string | null; account_name?: string | null; account_number?: string | null } | null;
};

const units = (cur: number, prev: number) => Math.max((cur || 0) - (prev || 0), 0);

// The document uses the exact markup of the monthly "พรีวิวใบแจ้งหนี้" modal
// (components/admin/invoices/InvoicePreviewModal.tsx). It is rendered twice: in the modal for
// screenshots, and in a print-only copy portalled to <body> so the modal chrome never prints.
const PRINT_CSS = `
  .mo-print-only { display: none; }
  @media print {
    @page { size: A4; margin: 12mm; }
    body > *:not(.mo-print-only) { display: none !important; }
    .mo-print-only { display: block !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

function Doc({
  plan,
  meter,
  prorateDays,
  dailyRate,
  fullMonths,
  periodLabelById,
  tenantName,
  tenantPhone,
  roomNumber,
  moveOutDate,
  rentStartDate,
  lateFeeItems,
  lateFeeVoids,
  invoiceInfoById,
  config,
}: Props & { plan: MoveOutSettlementPlan; config: PrintConfig }) {
  const waterUnits = units(meter.curWater, meter.prevWater);
  const elecUnits = units(meter.curElec, meter.prevElec);
  const waterRate = toNumber(config.settings?.water_rate);
  const elecRate = toNumber(config.settings?.electricity_rate);
  const methodLabel = config.method
    ? [config.method.label, config.method.bank_name, config.method.account_name, config.method.account_number].filter(Boolean).join(" | ")
    : "-";
  const docNo = `MO-${roomNumber || "-"}-${String(moveOutDate).replaceAll("-", "").slice(2)}`;
  const monthlyRent = fullMonths > 0 ? plan.fullMonthRent / fullMonths : 0;
  const lateById = new Map(lateFeeItems.map((i) => [i.invoiceId, i]));
  const voidedLate = lateFeeItems.filter((i) => lateFeeVoids[i.invoiceId]?.voided);
  const addMonths = (ymd: string, n: number) => {
    const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1 + n, d || 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  const prorateStart = addMonths(rentStartDate, fullMonths);
  const meterNote = (u: number, rate: number, amount: number) =>
    Math.abs(u * rate - amount) > 0.01 ? " · คิดตามอัตราขั้นต่ำ" : "";

  const cell = "px-3 py-2";
  const rowCls = "border-t border-slate-100";
  const sectionRow = (text: string) => (
    <tr className="border-t border-primary-200 bg-primary-50">
      <td className={`${cell} font-semibold text-primary-900`} colSpan={4}>
        {text}
      </td>
    </tr>
  );

  return (
    <div className="space-y-5 bg-white text-sm text-slate-700">
      <div className="flex flex-wrap justify-between gap-4 rounded-control border border-slate-200 bg-white p-4">
        <div className="space-y-1">
          <p className="text-lg font-bold text-slate-900">{config.settings?.dorm_name || "หอพัก"}</p>
          <p>{config.settings?.dorm_address || "-"}</p>
          <p>ผู้เช่า: {tenantName || "-"}</p>
          <p>ห้อง: {roomNumber || "-"}</p>
          <p>โทร: {tenantPhone || "-"}</p>
        </div>
        <div className="space-y-1 text-right">
          <p>
            <span className="font-semibold">เลขที่ใบสรุปการย้ายออก:</span> {docNo}
          </p>
          <p>
            <span className="font-semibold">เลขห้อง:</span> {roomNumber || "-"}
          </p>
          <p>
            <span className="font-semibold">วันที่ย้ายออก:</span> {formatDateThai(moveOutDate)}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-control border border-slate-200">
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
            {sectionRow("บิลงวดสุดท้าย")}
            {plan.fullMonthRent > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  ค่าเช่าห้องพัก
                  <div className="text-xs text-slate-500">
                    {fullMonths} เดือนเต็ม ({formatDateThai(rentStartDate)} – {formatDateThai(prorateStart)}) × {formatMoney(monthlyRent)} บาท/เดือน
                  </div>
                </td>
                <td className={`${cell} text-right`}>{fullMonths} เดือน</td>
                <td className={`${cell} text-right`}>{formatMoney(monthlyRent)}</td>
                <td className={`${cell} text-right`}>{formatMoney(plan.fullMonthRent)}</td>
              </tr>
            )}
            {(plan.proratedRent > 0 || plan.fullMonthRent === 0) && (
              <tr className={rowCls}>
                <td className={cell}>
                  ค่าเช่าห้องพัก (เฉลี่ยรายวัน)
                  <div className="text-xs text-slate-500">
                    {formatDateThai(prorateStart)} – {formatDateThai(moveOutDate)} = {prorateDays} วัน × {formatMoney(dailyRate)} บาท/วัน
                    (ค่าเช่าต่อเดือน ÷ 30 ปัดลงเป็นบาทเต็ม)
                  </div>
                </td>
                <td className={`${cell} text-right`}>{prorateDays} วัน</td>
                <td className={`${cell} text-right`}>{formatMoney(dailyRate)}</td>
                <td className={`${cell} text-right`}>{formatMoney(plan.proratedRent)}</td>
              </tr>
            )}
            <tr className={rowCls}>
              <td className={cell}>
                ค่าน้ำ
                <div className="text-xs text-slate-500">
                  มิเตอร์ก่อน {meter.prevWater} → ล่าสุด {meter.curWater} = {waterUnits.toLocaleString("th-TH")} หน่วย × {formatMoney(waterRate)}
                  {meterNote(waterUnits, waterRate, plan.water)}
                </div>
              </td>
              <td className={`${cell} text-right`}>{waterUnits.toLocaleString("th-TH")} หน่วย</td>
              <td className={`${cell} text-right`}>{formatMoney(waterRate)}</td>
              <td className={`${cell} text-right`}>{formatMoney(plan.water)}</td>
            </tr>
            <tr className={rowCls}>
              <td className={cell}>
                ค่าไฟ
                <div className="text-xs text-slate-500">
                  มิเตอร์ก่อน {meter.prevElec} → ล่าสุด {meter.curElec} = {elecUnits.toLocaleString("th-TH")} หน่วย × {formatMoney(elecRate)}
                  {meterNote(elecUnits, elecRate, plan.electricity)}
                </div>
              </td>
              <td className={`${cell} text-right`}>{elecUnits.toLocaleString("th-TH")} หน่วย</td>
              <td className={`${cell} text-right`}>{formatMoney(elecRate)}</td>
              <td className={`${cell} text-right`}>{formatMoney(plan.electricity)}</td>
            </tr>
            {plan.otherCharges.map((c, i) => {
              const lateId = String(c.reason ?? "").startsWith(LATE_FEE_PREFIX)
                ? String(c.reason).slice(LATE_FEE_PREFIX.length)
                : null;
              const late = lateId ? lateById.get(lateId) : undefined;
              if (late) {
                return (
                  <tr key={`late-${lateId}`} className="border-t border-warning-100 bg-warning-50/40">
                    <td className={cell}>
                      ค่าปรับล่าช้า — บิลงวด {late.periodStart}
                      <div className="text-xs text-slate-500">
                        {late.daysOverdue == null
                          ? "ยอดค่าปรับที่ล็อกไว้แล้วตอนชำระ/ยกยอด"
                          : `ชำระล่าช้า ${late.daysOverdue} วัน × ${formatMoney(late.dailyRate)} บาท/วัน`}
                        {late.periodEnd ? ` · บิลสิ้นสุด ${formatDateThai(late.periodEnd)}` : ""}
                      </div>
                    </td>
                    <td className={`${cell} text-right`}>{late.daysOverdue == null ? "-" : `${late.daysOverdue} วัน`}</td>
                    <td className={`${cell} text-right`}>{late.daysOverdue == null ? "-" : formatMoney(late.dailyRate)}</td>
                    <td className={`${cell} text-right font-semibold text-warning-900`}>{formatMoney(c.amount)}</td>
                  </tr>
                );
              }
              return (
                <tr key={`${c.label}-${i}`} className={rowCls}>
                  <td className={cell}>
                    {c.label}
                    {c.reason && !String(c.reason).startsWith(LATE_FEE_PREFIX) && (
                      <div className="text-xs text-slate-500">{c.reason}</div>
                    )}
                  </td>
                  <td className={`${cell} text-right`}>1</td>
                  <td className={`${cell} text-right`}>{formatMoney(c.amount)}</td>
                  <td className={`${cell} text-right`}>{formatMoney(c.amount)}</td>
                </tr>
              );
            })}
            {voidedLate.map((v) => (
              <tr key={`void-${v.invoiceId}`} className={rowCls}>
                <td className={`${cell} text-slate-500`} colSpan={3}>
                  ยกเว้นค่าปรับล่าช้า บิลงวด {v.periodStart} ({formatMoney(v.amount)} บาท)
                  <div className="text-xs">เหตุผล: {lateFeeVoids[v.invoiceId]?.reason || "-"}</div>
                </td>
                <td className={`${cell} text-right text-slate-500`}>ยกเว้น</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
              <td className={`${cell} text-right`} colSpan={3}>รวมบิลงวดสุดท้าย</td>
              <td className={`${cell} text-right`}>{formatMoney(plan.finalBillTotal)}</td>
            </tr>

            {plan.debtPayments.length > 0 && sectionRow("บิลค้างชำระเดิม")}
            {plan.debtPayments.map((d) => (
              <tr key={d.invoiceId} className="border-t border-warning-100 bg-warning-50/60">
                <td className={cell}>
                  ยอดค้างรอบบิล {invoiceInfoById.get(d.invoiceId)?.period ?? periodLabelById?.get(d.invoiceId) ?? d.periodStart.slice(0, 7)}
                  {invoiceInfoById.get(d.invoiceId) && (
                    <div className="text-xs text-slate-500">
                      ยอดบิล {formatMoney(invoiceInfoById.get(d.invoiceId)!.total)} − ชำระแล้ว {formatMoney(invoiceInfoById.get(d.invoiceId)!.paid)} = ค้าง {formatMoney(d.outstandingBefore)}
                    </div>
                  )}
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right font-semibold text-warning-900`}>{formatMoney(d.outstandingBefore)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
              <td className={`${cell} text-right`} colSpan={3}>ยอดที่ต้องชำระทั้งหมด</td>
              <td className={`${cell} text-right`}>{formatMoney(plan.totalOwed)}</td>
            </tr>

            {sectionRow("เงินที่นำมาหัก")}
            {plan.advanceRentHeld > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  หักค่าเช่าล่วงหน้า
                  <div className="text-xs text-slate-500">ถืออยู่ {formatMoney(plan.advanceRentHeld)} · ใช้หักชำระบิลก่อน</div>
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-{formatMoney(plan.advanceRentApplied)}</td>
              </tr>
            )}
            {plan.depositHeld > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  หักเงินประกัน
                  <div className="text-xs text-slate-500">ถืออยู่ {formatMoney(plan.depositHeld)} · ใช้หักส่วนที่ยังไม่พอ</div>
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-{formatMoney(plan.depositApplied)}</td>
              </tr>
            )}
            {plan.unappliedCreditHeld > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  หักเครดิตชำระเกิน
                  <div className="text-xs text-slate-500">ถืออยู่ {formatMoney(plan.unappliedCreditHeld)}</div>
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-{formatMoney(plan.unappliedCreditApplied)}</td>
              </tr>
            )}
            {plan.depositForfeited > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  เงินประกันที่ริบ
                  <div className="text-xs text-slate-500">เหตุผล: {plan.forfeitReason || "-"}</div>
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>{formatMoney(plan.depositForfeited)}</td>
              </tr>
            )}
            {plan.advanceRentAbsorbed > 0 && (
              <tr className={rowCls}>
                <td className={cell}>
                  ค่าเช่าล่วงหน้าส่วนที่เหลือ (ไม่คืน)
                  <div className="text-xs text-slate-500">ค่าเช่าล่วงหน้าไม่สามารถขอคืนเป็นเงินได้</div>
                </td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>-</td>
                <td className={`${cell} text-right`}>{formatMoney(plan.advanceRentAbsorbed)}</td>
              </tr>
            )}

            <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
              <td className={`${cell} text-right`} colSpan={3}>
                {plan.balanceStillOwed > 0 ? "ยอดที่ผู้เช่าต้องชำระเพิ่ม" : plan.refundDue > 0 ? "ยอดเงินที่คืนผู้เช่า" : "ยอดรวมสุทธิ"}
              </td>
              <td className={`${cell} text-right`}>
                {formatMoney(plan.balanceStillOwed > 0 ? plan.balanceStillOwed : plan.refundDue)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-1 rounded-control border border-slate-200 bg-white p-4">
        <p>
          <span className="font-semibold">ช่องทางชำระเงิน:</span> {plan.balanceStillOwed > 0 ? methodLabel : "-"}
        </p>
        <div className="text-xs text-slate-500">
          <p className="font-semibold text-slate-600">วิธีคำนวณ</p>
          <p>• ค่าเช่ารายวัน = ค่าเช่าต่อเดือน ÷ 30 (ปัดลงเป็นบาทเต็ม) × จำนวนวันที่อยู่เกินรอบบิลล่าสุด</p>
          <p>• ค่าน้ำ/ค่าไฟ = (เลขมิเตอร์ล่าสุด − เลขมิเตอร์ก่อนหน้า) × อัตราต่อหน่วย</p>
          <p>• ค่าปรับล่าช้า = จำนวนวันที่ชำระล่าช้า × อัตราต่อวัน</p>
          <p>• ยอดที่ต้องชำระ = บิลสุดท้าย + บิลค้างชำระ แล้วหักด้วยค่าเช่าล่วงหน้า เงินประกัน และเครดิต ตามลำดับ</p>
        </div>
        <p>
          <span className="font-semibold">หมายเหตุ:</span>{" "}
          {plan.refundDue > 0 && plan.balanceStillOwed === 0
            ? "ยอดคืนคิดจากเงินประกันและเครดิตชำระเกินที่เหลือเท่านั้น (ค่าเช่าล่วงหน้าไม่คืน)"
            : plan.balanceStillOwed > 0
              ? "เงินประกันและค่าเช่าล่วงหน้าที่ถืออยู่ไม่พอชำระยอดทั้งหมด"
              : "-"}
        </p>
      </div>
    </div>
  );
}

/**
 * The move-out summary invoice, shown while the admin is still settling (before anything is saved).
 * Built from the live settlement plan, so it follows every change on the screen.
 */
export function MoveOutInvoicePreview(props: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [config, setConfig] = useState<PrintConfig>({ settings: null, method: null });
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data: session } = await supabase.auth.getSession();
        const token = session.session?.access_token;
        if (!token) return;
        const res = await fetch("/api/admin/invoices/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "get_print_config" }),
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setConfig({ settings: json?.settings ?? null, method: json?.defaultPaymentMethod ?? null });
      } catch {
        // Non-blocking: the preview still renders without dorm details.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { plan } = props;
  if (!plan) return null;
  const blocked = plan.errors.length > 0;

  return (
    <div className="rounded-card border border-primary-200 bg-primary-50/50 p-4">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-slate-800">ใบสรุปการย้ายออก (ตัวอย่างก่อนยืนยัน)</p>
          <p className="mt-0.5 text-sm text-slate-500">หน้าตาเหมือนใบแจ้งหนี้รายเดือน แคปหน้าจอหรือพิมพ์ส่งให้ผู้เช่าได้ทันที</p>
        </div>
        <button type="button" onClick={() => setOpen(true)} disabled={blocked} className={buttonClasses({ variant: "primary" })}>
          <Eye className="h-4 w-4" /> พรีวิวใบสรุป
        </button>
      </div>
      {blocked && <p className="mt-2 text-sm text-danger-600">ยังสรุปยอดไม่ได้ — แก้ข้อผิดพลาดด้านบนก่อน</p>}

      <Modal isOpen={open} onClose={() => setOpen(false)} title="พรีวิวใบสรุปการย้ายออก" size="xl">
        {open && !blocked && (
          <div className="space-y-5">
            <Doc {...props} plan={plan} config={config} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className={buttonClasses({ variant: "secondary" })}>
                ปิด
              </button>
              <button onClick={() => window.print()} className={buttonClasses({ variant: "primary" })}>
                <Printer size={16} /> พิมพ์ใบสรุปการย้ายออก
              </button>
            </div>
          </div>
        )}
      </Modal>
      {mounted && open && !blocked &&
        createPortal(
          <div className="mo-print-only p-2">
            <Doc {...props} plan={plan} config={config} />
          </div>,
          document.body
        )}
    </div>
  );
}
