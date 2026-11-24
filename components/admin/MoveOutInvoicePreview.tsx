"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, Eye, EyeOff } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { MoveOutSettlementPlan } from "@/lib/money/settlement";
import { buttonClasses } from "@/components/ui/Button";

type Meter = { prevElec: number; curElec: number; prevWater: number; curWater: number };

type Props = {
  plan: MoveOutSettlementPlan | null;
  meter: Meter;
  prorateDays: number;
  dailyRate: number;
  fullMonths: number;
  periodLabelById?: Map<string, string>;
  tenantName: string;
  roomNumber: string;
  moveInDate?: string | null;
  moveOutDate: string;
  dormName?: string | null;
};

const baht = (n: number) => formatMoney(Number.isFinite(n) ? n : 0);
const thDate = (v: string | null | undefined) => {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
};
const units = (cur: number, prev: number) => Math.max((cur || 0) - (prev || 0), 0);

// Same look as the monthly receipt print: blue header box, white cards, right-aligned amounts.
// On screen the document is shown inline (for a screenshot); for printing a copy is portalled to
// <body> so nothing in the wizard modal (overflow, transforms) can clip it.
const CSS = `
  .mi-doc { font-family: "Noto Sans Thai", "Sarabun", "Tahoma", sans-serif; color: #111827; font-size: 14px; background: #fff; padding: 16px; }
  .mi-doc h1 { margin: 0; font-size: 26px; color: #0f172a; }
  .mi-sub { color: #334155; margin: 4px 0 12px; font-size: 13px; }
  .mi-header { border: 2px solid #1e40af; border-radius: 12px; background: #eff6ff; padding: 14px; margin-bottom: 12px; }
  .mi-card { border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fff; break-inside: avoid; }
  .mi-card h2 { margin: 0 0 10px; font-size: 15px; color: #1e3a8a; }
  .mi-row { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 6px; }
  .mi-label { color: #4b5563; }
  .mi-value { font-weight: 600; text-align: right; white-space: pre-wrap; }
  .mi-total { margin-top: 10px; padding-top: 8px; border-top: 1px solid #d1d5db; font-size: 16px; font-weight: 700; color: #0f172a; }
  .mi-formula { color: #475569; font-size: 12px; margin-top: 2px; }
  .mi-note { color: #64748b; font-size: 12px; margin-top: 6px; }
  .mi-table { width: 100%; border-collapse: collapse; }
  .mi-table th, .mi-table td { border-bottom: 1px solid #e2e8f0; padding: 8px 4px; text-align: left; vertical-align: top; }
  .mi-table th:last-child, .mi-table td:last-child { text-align: right; }
  .mi-result { border: 2px solid #1e40af; border-radius: 12px; padding: 14px; margin-bottom: 12px; break-inside: avoid; }
  .mi-result.refund { background: #f0fdf4; border-color: #15803d; }
  .mi-result.owed { background: #fef2f2; border-color: #b91c1c; }
  .mi-big { font-size: 20px; font-weight: 700; }
  .mi-print-only { display: none; }
  @media print {
    @page { size: A4; margin: 12mm; }
    body > *:not(.mi-print-only) { display: none !important; }
    .mi-print-only { display: block !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

const R = ({ label, value }: { label: string; value: string }) => (
  <div className="mi-row">
    <span className="mi-label">{label}</span>
    <span className="mi-value">{value}</span>
  </div>
);

function Doc({ plan, meter, prorateDays, dailyRate, fullMonths, periodLabelById, tenantName, roomNumber, moveInDate, moveOutDate, dormName }: Props & { plan: MoveOutSettlementPlan }) {
  const advanceTotal = plan.advanceRentApplied + plan.depositApplied + plan.unappliedCreditApplied;
  return (
    <div className="mi-doc">
      <div className="mi-header">
        <h1>ใบสรุปการย้ายออก</h1>
        <div className="mi-sub">วันที่ย้ายออก: {thDate(moveOutDate)}</div>
        <R label="ผู้ออกเอกสาร" value={dormName || "Apartment Flow"} />
        <R label="ผู้เช่า" value={tenantName || "-"} />
        <R label="เลขห้อง" value={roomNumber || "-"} />
        <R label="วันเข้าพัก" value={thDate(moveInDate)} />
      </div>

      <div className="mi-card">
        <h2>1. บิลงวดสุดท้าย</h2>
        <table className="mi-table">
          <thead>
            <tr><th>รายการ</th><th>จำนวนเงิน (บาท)</th></tr>
          </thead>
          <tbody>
            {plan.fullMonthRent > 0 && (
              <tr><td>ค่าเช่าเต็มเดือน ({fullMonths} เดือน)</td><td>{baht(plan.fullMonthRent)}</td></tr>
            )}
            {(plan.proratedRent > 0 || plan.fullMonthRent === 0) && (
              <tr>
                <td>
                  ค่าเช่าเฉลี่ยรายวัน
                  <div className="mi-formula">{prorateDays} วัน × {baht(dailyRate)} บาท/วัน</div>
                </td>
                <td>{baht(plan.proratedRent)}</td>
              </tr>
            )}
            <tr>
              <td>
                ค่าไฟฟ้า
                <div className="mi-formula">({meter.prevElec} → {meter.curElec} = {units(meter.curElec, meter.prevElec)} หน่วย)</div>
              </td>
              <td>{baht(plan.electricity)}</td>
            </tr>
            <tr>
              <td>
                ค่าน้ำ
                <div className="mi-formula">({meter.prevWater} → {meter.curWater} = {units(meter.curWater, meter.prevWater)} หน่วย)</div>
              </td>
              <td>{baht(plan.water)}</td>
            </tr>
            {plan.otherCharges.map((c, i) => (
              <tr key={`${c.label}-${i}`}><td>{c.label}</td><td>{baht(c.amount)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="mi-total mi-row"><span>รวมบิลงวดสุดท้าย</span><span>{baht(plan.finalBillTotal)}</span></div>
      </div>

      {plan.debtPayments.length > 0 && (
        <div className="mi-card">
          <h2>2. บิลค้างชำระเดิม</h2>
          <table className="mi-table">
            <thead>
              <tr><th>รอบบิล</th><th>ค้าง</th></tr>
            </thead>
            <tbody>
              {plan.debtPayments.map((d) => (
                <tr key={d.invoiceId}>
                  <td>{periodLabelById?.get(d.invoiceId) ?? d.periodStart.slice(0, 7)}</td>
                  <td>{baht(d.outstandingBefore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mi-total mi-row"><span>รวมบิลค้างชำระ</span><span>{baht(plan.outstandingDebt)}</span></div>
        </div>
      )}

      <div className="mi-card">
        <h2>{plan.debtPayments.length > 0 ? "3" : "2"}. ยอดที่ต้องชำระทั้งหมดและเงินที่นำมาหัก</h2>
        <R label="ยอดที่ต้องชำระทั้งหมด (บิลสุดท้าย + บิลค้าง)" value={baht(plan.totalOwed)} />
        {plan.advanceRentHeld > 0 && (
          <R label={`หักค่าเช่าล่วงหน้า (ถืออยู่ ${baht(plan.advanceRentHeld)})`} value={`-${baht(plan.advanceRentApplied)}`} />
        )}
        {plan.depositHeld > 0 && (
          <R label={`หักเงินประกัน (ถืออยู่ ${baht(plan.depositHeld)})`} value={`-${baht(plan.depositApplied)}`} />
        )}
        {plan.unappliedCreditHeld > 0 && (
          <R label={`หักเครดิตชำระเกิน (ถืออยู่ ${baht(plan.unappliedCreditHeld)})`} value={`-${baht(plan.unappliedCreditApplied)}`} />
        )}
        {plan.depositForfeited > 0 && (
          <>
            <R label="เงินประกันที่ริบ" value={baht(plan.depositForfeited)} />
            <div className="mi-note">เหตุผล: {plan.forfeitReason || "-"}</div>
          </>
        )}
        {plan.advanceRentAbsorbed > 0 && (
          <>
            <R label="ค่าเช่าล่วงหน้าส่วนที่เหลือ (ไม่คืน)" value={baht(plan.advanceRentAbsorbed)} />
          </>
        )}
        <div className="mi-total mi-row"><span>รวมเงินที่นำมาหัก</span><span>-{baht(advanceTotal)}</span></div>
      </div>

      {plan.balanceStillOwed > 0 ? (
        <div className="mi-result owed">
          <div className="mi-row"><span className="mi-big">ยอดที่ผู้เช่าต้องชำระเพิ่ม</span><span className="mi-big">{baht(plan.balanceStillOwed)} บาท</span></div>
          <div className="mi-note">เงินประกันและค่าเช่าล่วงหน้าที่ถืออยู่ไม่พอชำระยอดทั้งหมด</div>
        </div>
      ) : plan.refundDue > 0 ? (
        <div className="mi-result refund">
          <div className="mi-row"><span className="mi-big">ยอดเงินที่คืนผู้เช่า</span><span className="mi-big">{baht(plan.refundDue)} บาท</span></div>
          <div className="mi-note">คิดจากเงินประกันและเครดิตชำระเกินที่เหลือเท่านั้น (ค่าเช่าล่วงหน้าไม่คืน)</div>
        </div>
      ) : (
        <div className="mi-result">
          <div className="mi-row"><span className="mi-big">ยอดสุทธิ</span><span className="mi-big">0.00 บาท</span></div>
          <div className="mi-note">ไม่มียอดค้างชำระและไม่มียอดคืน</div>
        </div>
      )}
    </div>
  );
}

/**
 * Preview of the move-out summary invoice, built from the live settlement plan while the admin is still
 * settling — before anything is saved. Screenshot it or print/save as PDF to send to the tenant.
 */
export function MoveOutInvoicePreview(props: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { plan } = props;
  if (!plan) return null;
  const blocked = plan.errors.length > 0;

  return (
    <div className="rounded-card border border-primary-200 bg-primary-50/50 p-4">
      <style>{CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-slate-800">ใบสรุปการย้ายออก (ตัวอย่างก่อนยืนยัน)</p>
          <p className="mt-0.5 text-sm text-slate-500">ดูหน้าตาใบสรุปเหมือนใบแจ้งหนี้รายเดือน เพื่อแคปหน้าจอหรือพิมพ์ส่งให้ผู้เช่าได้ทันที</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} className={buttonClasses({ variant: "secondary" })}>
            {open ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {open ? "ซ่อนตัวอย่าง" : "ดูใบสรุป"}
          </button>
          <button type="button" onClick={() => window.print()} disabled={blocked} className={buttonClasses({ variant: "primary" })}>
            <Printer className="h-4 w-4" /> พิมพ์ / PDF
          </button>
        </div>
      </div>
      {blocked && <p className="mt-2 text-sm text-danger-600">ยังสรุปยอดไม่ได้ — แก้ข้อผิดพลาดด้านบนก่อนพิมพ์</p>}
      {open && !blocked && (
        <div className="mt-4 overflow-x-auto rounded-card border border-slate-200 bg-white">
          <Doc {...props} plan={plan} />
        </div>
      )}
      {mounted && !blocked && createPortal(<div className="mi-print-only"><Doc {...props} plan={plan} /></div>, document.body)}
    </div>
  );
}
