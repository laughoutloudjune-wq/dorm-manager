"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { createClient } from "@/lib/supabase-client";
import { parseDeepLinkId } from "@/lib/deep-links";

type Payload = {
  tenant: { id: string; full_name: string | null; phone_number: string | null; address: string | null; move_in_date: string | null; move_out_date: string | null } | null;
  roomNumber: string | null;
  buildingName: string | null;
  settlement: { id: string; createdAt: string; moveOutKind: string | null; moveOutNote: string | null };
  plan: Record<string, any>;
  finalInvoice: Record<string, any> | null;
  debtInvoices: Array<{ id: string; start_date: string | null; issue_date: string | null }>;
  payouts: Array<{ id: string; amount: number; paid_at: string | null; method: string | null; recipient: string | null; reference: string | null }>;
  dorm: { dorm_name?: string | null; dorm_address?: string | null; dorm_phone?: string | null } | null;
  unavailable: string[];
  generatedAt: string;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const baht = (v: unknown) =>
  num(v).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (v: string | null | undefined) => {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
};
const month = (v: string | null | undefined) => {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("th-TH", { month: "long", year: "numeric" });
};
const units = (end: unknown, start: unknown) => {
  if (end == null || start == null) return null;
  return Math.max(0, num(end) - num(start));
};

const KIND_LABEL: Record<string, string> = {
  normal: "ย้ายออกตามปกติ",
  abandoned: "ทิ้งห้อง",
  evicted: "ถูกให้ออก",
  other: "อื่น ๆ",
};

// Same look as the monthly receipt print (app/api/receipt/[token]/route.ts): bordered
// header, white cards, a right-aligned charges table. Printing hides the admin shell.
const PRINT_CSS = `
  .ms-doc { font-family: "Noto Sans Thai", "Sarabun", "Tahoma", sans-serif; color: #111827; font-size: 14px; max-width: 800px; margin: 0 auto; }
  .ms-doc h1 { margin: 0; font-size: 28px; color: #0f172a; }
  .ms-sub { color: #334155; margin: 4px 0 14px; font-size: 13px; }
  .ms-header { border: 2px solid #1e40af; border-radius: 12px; background: #eff6ff; padding: 14px; margin-bottom: 14px; }
  .ms-card { border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fff; break-inside: avoid; }
  .ms-card h2 { margin: 0 0 10px; font-size: 15px; color: #1e3a8a; }
  .ms-row { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 6px; }
  .ms-label { color: #4b5563; }
  .ms-value { font-weight: 600; text-align: right; white-space: pre-wrap; }
  .ms-total { margin-top: 10px; padding-top: 8px; border-top: 1px solid #d1d5db; font-size: 16px; font-weight: 700; color: #0f172a; }
  .ms-formula { color: #475569; font-size: 12px; margin-top: 2px; }
  .ms-note { color: #475569; font-size: 12px; margin-top: 6px; }
  .ms-table { width: 100%; border-collapse: collapse; }
  .ms-table th, .ms-table td { border-bottom: 1px solid #e2e8f0; padding: 8px 4px; text-align: left; vertical-align: top; }
  .ms-table th:last-child, .ms-table td:last-child { text-align: right; }
  .ms-result { border: 2px solid #1e40af; border-radius: 12px; padding: 14px; margin-bottom: 12px; break-inside: avoid; }
  .ms-result.refund { background: #f0fdf4; border-color: #15803d; }
  .ms-result.owed { background: #fef2f2; border-color: #b91c1c; }
  .ms-result .big { font-size: 22px; font-weight: 700; }
  @page { size: A4; margin: 12mm; }
  @media print {
    body * { visibility: hidden !important; }
    .ms-doc, .ms-doc * { visibility: visible !important; }
    .ms-doc { position: absolute; left: 0; top: 0; width: 100%; max-width: none; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="ms-row">
    <span className="ms-label">{label}</span>
    <span className="ms-value" style={strong ? { fontSize: 16 } : undefined}>{value}</span>
  </div>
);

export default function MoveOutSummaryPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTenantId(parseDeepLinkId(new URLSearchParams(window.location.search).get("tenant")));
  }, []);

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
      const res = await fetch("/api/admin/move-out-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tenantId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "โหลดสรุปการย้ายออกไม่สำเร็จ");
      setData(json as Payload);
    } catch (e: any) {
      setError(e?.message ?? "โหลดสรุปการย้ายออกไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [supabase, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doc = (() => {
    if (!data) return null;
    const { plan, finalInvoice: inv, tenant } = data;
    const breakdown: any[] = Array.isArray(inv?.additional_fees_breakdown) ? inv!.additional_fees_breakdown : [];
    const lateRows = breakdown.filter((r) => r?.item_type === "late_fee_line");
    const customRows = breakdown.filter((r) => r?.item_type === "custom");
    const proRows = breakdown.filter((r) => r?.item_type === "prorate_rent");
    const elecUnits = units(inv?.electricity_reading_end, inv?.electricity_reading_start);
    const waterUnits = units(inv?.water_reading_end, inv?.water_reading_start);
    const debts: any[] = Array.isArray(plan.debtPayments) ? plan.debtPayments : [];
    const periodOf = (id: string) => data.debtInvoices.find((d) => d.id === id);
    const voidedLate: any[] = Array.isArray(plan?.lateFees?.voided) ? plan.lateFees.voided : [];
    const refundDue = num(plan.refundDue);
    const stillOwed = num(plan.balanceStillOwed);
    const paidOut = data.payouts.reduce((s, p) => s + num(p.amount), 0);
    const issuer = data.dorm?.dorm_name || "Apartment Flow";
    const refNo = `MO-${String(data.settlement.id).slice(0, 8).toUpperCase()}`;
    const hasDeposit = num(plan.depositHeld) > 0;
    const hasAdvance = num(plan.advanceRentHeld) > 0;
    const hasCredit = num(plan.unappliedCreditHeld) > 0;

    return (
      <div className="ms-doc">
        <div className="ms-header">
          <h1>ใบสรุปการย้ายออก</h1>
          <div className="ms-sub">
            เลขที่: {refNo} | วันที่สรุปยอด: {date(data.settlement.createdAt)}
          </div>
          <Row label="ผู้ออกเอกสาร" value={issuer} />
          {data.dorm?.dorm_address ? <Row label="ที่อยู่ผู้ออกเอกสาร" value={data.dorm.dorm_address} /> : null}
          {data.dorm?.dorm_phone ? <Row label="โทรศัพท์" value={data.dorm.dorm_phone} /> : null}
        </div>

        <div className="ms-card">
          <h2>ข้อมูลผู้เช่า</h2>
          <Row label="ชื่อ-นามสกุล" value={tenant?.full_name ?? "-"} />
          <Row label="เลขห้อง" value={`${data.roomNumber ?? "-"}${data.buildingName ? ` (${data.buildingName})` : ""}`} />
          <Row label="วันเข้าพัก" value={date(tenant?.move_in_date)} />
          <Row label="วันย้ายออก" value={date(tenant?.move_out_date)} />
          {data.settlement.moveOutKind ? (
            <Row
              label="ประเภทการย้ายออก"
              value={`${KIND_LABEL[data.settlement.moveOutKind] ?? data.settlement.moveOutKind}${data.settlement.moveOutNote ? ` — ${data.settlement.moveOutNote}` : ""}`}
            />
          ) : null}
        </div>

        <div className="ms-card">
          <h2>1. บิลงวดสุดท้าย</h2>
          {inv ? (
            <table className="ms-table">
              <thead>
                <tr><th>รายการ</th><th>จำนวนเงิน (บาท)</th></tr>
              </thead>
              <tbody>
                {num(inv.rent_amount) > 0 && (
                  <tr>
                    <td>
                      ค่าเช่า
                      {proRows.map((r, i) => <div key={i} className="ms-formula">{String(r.label ?? "")}</div>)}
                    </td>
                    <td>{baht(inv.rent_amount)}</td>
                  </tr>
                )}
                <tr>
                  <td>
                    ค่าน้ำ
                    {waterUnits != null && (
                      <div className="ms-formula">({num(inv.water_reading_start).toFixed(2)} → {num(inv.water_reading_end).toFixed(2)} = {waterUnits.toFixed(2)} หน่วย)</div>
                    )}
                  </td>
                  <td>{baht(inv.water_bill)}</td>
                </tr>
                <tr>
                  <td>
                    ค่าไฟฟ้า
                    {elecUnits != null && (
                      <div className="ms-formula">({num(inv.electricity_reading_start).toFixed(2)} → {num(inv.electricity_reading_end).toFixed(2)} = {elecUnits.toFixed(2)} หน่วย)</div>
                    )}
                  </td>
                  <td>{baht(inv.electricity_bill)}</td>
                </tr>
                {num(inv.common_fee) > 0 && (
                  <tr><td>ค่าส่วนกลาง</td><td>{baht(inv.common_fee)}</td></tr>
                )}
                {lateRows.map((r, i) => (
                  <tr key={`l${i}`}><td>{String(r.label ?? "ค่าปรับล่าช้า")}</td><td>{baht(r.amount)}</td></tr>
                ))}
                {customRows.map((r, i) => (
                  <tr key={`c${i}`}>
                    <td>
                      {String(r.label ?? "ค่าธรรมเนียมเพิ่มเติม")}
                      {r.reason ? <div className="ms-formula">{String(r.reason)}</div> : null}
                    </td>
                    <td>{baht(r.amount)}</td>
                  </tr>
                ))}
                {num(plan.finalBillPaidFromCredit) > 0 && (
                  <tr>
                    <td>หักจากเงินประกัน/ค่าเช่าล่วงหน้าที่ถืออยู่ (ไม่ใช่เงินสด)</td>
                    <td>-{baht(plan.finalBillPaidFromCredit)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <div className="ms-note">ไม่มีบิลงวดสุดท้ายสำหรับการสรุปยอดนี้</div>
          )}
          <div className="ms-total ms-row">
            <span>ยอดบิลงวดสุดท้าย (ก่อนหักเครดิต)</span>
            <span>{baht(plan.finalBillTotal)}</span>
          </div>
          {num(plan.finalBillPaidFromCredit) > 0 && (
            <Row label="ยอดคงเหลือบนบิลหลังหักเครดิต" value={baht(num(plan.finalBillTotal) - num(plan.finalBillPaidFromCredit))} />
          )}
          {voidedLate.length > 0 && (
            <div className="ms-note">
              ค่าปรับที่ยกเว้น: {voidedLate.map((v) => `${baht(v.amount)} (${v.reason ?? "-"})`).join(", ")}
            </div>
          )}
        </div>

        {debts.length > 0 && (
          <div className="ms-card">
            <h2>2. บิลค้างชำระที่ชำระจากเงินที่ถืออยู่</h2>
            <table className="ms-table">
              <thead>
                <tr><th>บิลงวด</th><th>ค้างก่อนหัก</th><th>หักจากเครดิต</th><th>คงเหลือ</th></tr>
              </thead>
              <tbody>
                {debts.map((d, i) => (
                  <tr key={i}>
                    <td>{month(periodOf(String(d.invoiceId))?.start_date ?? d.periodStart)}</td>
                    <td>{baht(d.outstandingBefore)}</td>
                    <td>{baht(d.paidFromCredit)}</td>
                    <td>{baht(d.outstandingAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ms-total ms-row">
              <span>รวมบิลค้างที่ชำระแล้วจากเครดิต</span>
              <span>{baht(plan.debtPaidFromCredit)}</span>
            </div>
          </div>
        )}

        <div className="ms-card">
          <h2>{debts.length > 0 ? "3" : "2"}. เงินประกัน ค่าเช่าล่วงหน้า และเครดิต</h2>
          {hasDeposit && (
            <>
              <Row label="เงินประกันที่ถืออยู่" value={baht(plan.depositHeld)} />
              <Row label="  หักชำระบิล" value={`-${baht(plan.depositApplied)}`} />
              {num(plan.depositForfeited) > 0 && (
                <>
                  <Row label="  หักเป็นค่าเสียหาย/ริบ" value={`-${baht(plan.depositForfeited)}`} />
                  {(plan.forfeitReason || plan.forfeitDetail) && (
                    <div className="ms-note">เหตุผล: {[plan.forfeitReason, plan.forfeitDetail].filter(Boolean).join(" — ")}</div>
                  )}
                </>
              )}
              <Row label="  เงินประกันคงเหลือ" value={baht(plan.depositRemaining)} />
            </>
          )}
          {hasAdvance && (
            <>
              <Row label="ค่าเช่าล่วงหน้าที่ถืออยู่" value={baht(plan.advanceRentHeld)} />
              <Row label="  หักชำระบิล" value={`-${baht(plan.advanceRentApplied)}`} />
              {num(plan.advanceRentAbsorbed) > 0 && (
                <Row label="  ส่วนที่เหลือ (ไม่คืนตามนโยบาย)" value={`-${baht(plan.advanceRentAbsorbed)}`} />
              )}
            </>
          )}
          {hasCredit && (
            <>
              <Row label="เครดิตคงเหลือ (จ่ายเกิน)" value={baht(plan.unappliedCreditHeld)} />
              <Row label="  หักชำระบิล" value={`-${baht(plan.unappliedCreditApplied)}`} />
              <Row label="  เครดิตคงเหลือ" value={baht(plan.unappliedCreditRemaining)} />
            </>
          )}
          {!hasDeposit && !hasAdvance && !hasCredit && <div className="ms-note">ไม่มีเงินประกัน ค่าเช่าล่วงหน้า หรือเครดิตที่ถืออยู่</div>}
          <div className="ms-total ms-row">
            <span>รวมที่นำมาหักชำระ</span>
            <span>{baht(num(plan.advanceRentApplied) + num(plan.depositApplied) + num(plan.unappliedCreditApplied))}</span>
          </div>
        </div>

        {stillOwed > 0 ? (
          <div className="ms-result owed">
            <div className="ms-row"><span className="big">ยอดที่ผู้เช่ายังต้องชำระ</span><span className="big">{baht(stillOwed)} บาท</span></div>
            <div className="ms-note">เงินที่ถืออยู่ไม่พอชำระบิลทั้งหมด</div>
          </div>
        ) : refundDue > 0 ? (
          <div className="ms-result refund">
            <div className="ms-row"><span className="big">ยอดเงินที่ต้องคืนผู้เช่า</span><span className="big">{baht(refundDue)} บาท</span></div>
            {data.payouts.map((p) => (
              <div key={p.id} className="ms-note">
                คืนแล้ว {baht(p.amount)} บาท · {date(p.paid_at)}{p.method ? ` · ${p.method}` : ""}{p.recipient ? ` · ผู้รับ ${p.recipient}` : ""}{p.reference ? ` · อ้างอิง ${p.reference}` : ""}
              </div>
            ))}
            <div className="ms-note">
              {data.payouts.length > 0
                ? `คืนแล้วรวม ${baht(paidOut)} บาท · คงเหลือที่ต้องคืน ${baht(Math.max(0, refundDue - paidOut))} บาท`
                : "ยังไม่มีการบันทึกการคืนเงิน"}
            </div>
          </div>
        ) : (
          <div className="ms-result">
            <div className="ms-row"><span className="big">ยอดสุทธิ</span><span className="big">0.00 บาท</span></div>
            <div className="ms-note">ไม่มียอดค้างชำระและไม่มียอดต้องคืน</div>
          </div>
        )}
      </div>
    );
  })();

  return (
    <div className="space-y-5">
      <style>{PRINT_CSS}</style>
      <PageHeader
        description="สรุปบิลสุดท้าย เงินประกัน ค่าเช่าล่วงหน้า และยอดคืน/ค้างชำระ — กดพิมพ์เพื่อบันทึกเป็น PDF"
        actions={
          <>
            <Link href="/move-outs" className={buttonClasses({ variant: "ghost", size: "sm" })}>
              <ArrowLeft size={14} /> กลับ
            </Link>
            <Button size="sm" onClick={() => window.print()} disabled={!data} icon={<Printer size={14} />}>
              พิมพ์
            </Button>
          </>
        }
      />
      {!tenantId && !loading && <Notice>ไม่พบรหัสผู้เช่า กรุณาเปิดจากหน้าย้ายออก</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {loading && <Skeleton className="h-96 w-full" />}
      {data && data.unavailable.includes("final_invoice") && (
        <Notice>อ่านบิลงวดสุดท้ายไม่ได้ ตัวเลขด้านล่างมาจากแผนสรุปยอดที่บันทึกไว้</Notice>
      )}
      {doc && <Card className="p-6">{doc}</Card>}
    </div>
  );
}
