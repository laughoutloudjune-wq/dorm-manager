"use client";

import { formatMoney } from "@/lib/format";
import type { MoveOutSettlementPlan } from "@/lib/money/settlement";
import { Input, Textarea } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Page";
import { AlertTriangle } from "lucide-react";

export type ForfeitState = {
  enabled: boolean;
  amount: number;
  reason: string;
};

/** Forfeiture is optional, partial allowed, and never accepted without a reason. */
export function forfeitReasonMissing(forfeit: ForfeitState) {
  return forfeit.enabled && forfeit.amount > 0 && !forfeit.reason.trim();
}

export function ForfeitControls({
  forfeit,
  setForfeit,
  depositHeld,
}: {
  forfeit: ForfeitState;
  setForfeit: (next: ForfeitState) => void;
  depositHeld: number;
}) {
  const missing = forfeitReasonMissing(forfeit);
  return (
    <div className="rounded-card border border-danger-200 bg-danger-50/60 px-4 py-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={forfeit.enabled}
          onChange={(e) =>
            setForfeit({
              enabled: e.target.checked,
              amount: e.target.checked ? forfeit.amount || depositHeld : forfeit.amount,
              reason: forfeit.reason,
            })
          }
          className="mt-1 h-4 w-4 accent-danger-600"
        />
        <div>
          <p className="text-base font-semibold text-danger-800">ริบเงินประกัน</p>
          <p className="mt-0.5 text-sm text-danger-600">
            ริบได้บางส่วนหรือทั้งหมด (สูงสุด ฿{formatMoney(depositHeld)}) ต้องระบุเหตุผลทุกครั้ง
          </p>
        </div>
      </label>
      {forfeit.enabled && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Input
            label="จำนวนที่ริบ (บาท)"
            type="number"
            min={0}
            max={depositHeld}
            value={forfeit.amount}
            onChange={(e) => setForfeit({ ...forfeit, amount: Math.max(0, Number(e.target.value) || 0) })}
          />
          <Textarea
            label="เหตุผลการริบ"
            required
            rows={2}
            value={forfeit.reason}
            placeholder="เช่น ผิดสัญญา แจ้งย้ายออกไม่ครบ 30 วัน / ค่าเสียหายประตู"
            error={missing ? "ต้องระบุเหตุผลก่อนริบเงินประกัน" : undefined}
            onChange={(e) => setForfeit({ ...forfeit, reason: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  tone = "default",
  strong = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "credit" | "debit" | "muted" | "warning";
  strong?: boolean;
}) {
  const tones = {
    default: "text-slate-700",
    credit: "text-success-700",
    debit: "text-danger-700",
    muted: "text-slate-400",
    warning: "text-warning-800",
  } as const;
  return (
    <div className={`flex items-start justify-between gap-4 ${tones[tone]} ${strong ? "font-bold" : ""}`}>
      <div className="min-w-0">
        <span className="text-base">{label}</span>
        {sub && <p className="text-sm text-slate-400">{sub}</p>}
      </div>
      <span className="shrink-0 text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

const baht = (n: number) => `฿${formatMoney(n)}`;

/**
 * Line-by-line move-out settlement, straight from planMoveOutSettlement — the
 * same plan the server recomputes and writes. Nothing is summed here.
 */
export function SettlementBreakdown({
  plan,
  prorateDays,
  dailyRate,
  fullMonths,
  meter,
  periodLabelById,
  debtOnly = false,
}: {
  plan: MoveOutSettlementPlan;
  prorateDays: number;
  dailyRate: number;
  fullMonths: number;
  meter?: { prevElec: number; curElec: number; prevWater: number; curWater: number };
  periodLabelById?: Map<string, string>;
  debtOnly?: boolean;
}) {
  return (
    <div className="space-y-4">
      {plan.errors.length > 0 && (
        <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />} title="ยังสรุปยอดไม่ได้">
          <ul className="list-disc pl-4">
            {plan.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}

      {!debtOnly && (
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-wider text-slate-400">บิลสุดท้าย</p>
          {plan.fullMonthRent > 0 && (
            <Row label={`ค่าเช่าเต็มเดือน (${fullMonths} เดือน)`} value={baht(plan.fullMonthRent)} />
          )}
          <Row
            label="ค่าเช่าเฉลี่ยรายวัน (Pro-rate)"
            sub={`${prorateDays} วัน × ฿${formatMoney(dailyRate)}/วัน`}
            value={baht(plan.proratedRent)}
          />
          <Row
            label="ค่าไฟฟ้า"
            sub={meter ? `มิเตอร์ ${meter.prevElec} → ${meter.curElec} = ${Math.max(meter.curElec - meter.prevElec, 0)} หน่วย` : undefined}
            value={baht(plan.electricity)}
          />
          <Row
            label="ค่าน้ำ"
            sub={meter ? `มิเตอร์ ${meter.prevWater} → ${meter.curWater} = ${Math.max(meter.curWater - meter.prevWater, 0)} หน่วย` : undefined}
            value={baht(plan.water)}
          />
          {plan.otherCharges.map((c, i) => (
            <Row key={`${c.label}-${i}`} label={c.label} value={baht(c.amount)} />
          ))}
          <div className="border-t border-dashed border-slate-200 pt-2">
            <Row label="รวมบิลสุดท้าย" value={baht(plan.finalBillTotal)} strong />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-wider text-slate-400">ยอดค้างชำระเดิม</p>
        {plan.debtPayments.length === 0 && <Row label="ไม่มียอดค้าง" value={baht(0)} tone="muted" />}
        {plan.debtPayments.map((d) => (
          <Row
            key={d.invoiceId}
            label={`รอบบิล ${periodLabelById?.get(d.invoiceId) ?? d.periodStart.slice(0, 7)}`}
            sub={`ค้าง ฿${formatMoney(d.outstandingBefore)} · หักเครดิต ฿${formatMoney(d.paidFromCredit)} · คงค้าง ฿${formatMoney(d.outstandingAfter)}`}
            value={baht(d.outstandingBefore)}
            tone="warning"
          />
        ))}
        <div className="border-t border-dashed border-slate-200 pt-2">
          <Row label="รวมที่ต้องชำระทั้งหมด" value={baht(plan.totalOwed)} strong />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-wider text-slate-400">เครดิตที่นำมาหัก (ไม่ใช่เงินสดรับ)</p>
        <Row
          label="ค่าเช่าล่วงหน้าที่ใช้หัก"
          sub={`ถืออยู่ ฿${formatMoney(plan.advanceRentHeld)}`}
          value={`−${baht(plan.advanceRentApplied)}`}
          tone="credit"
        />
        <Row
          label="เงินประกันที่ใช้หัก"
          sub={`ถืออยู่ ฿${formatMoney(plan.depositHeld)}`}
          value={`−${baht(plan.depositApplied)}`}
          tone="credit"
        />
        {plan.unappliedCreditHeld > 0 && (
          <Row
            label="เครดิตชำระเกินที่ใช้หัก"
            sub={`ถืออยู่ ฿${formatMoney(plan.unappliedCreditHeld)}`}
            value={`−${baht(plan.unappliedCreditApplied)}`}
            tone="credit"
          />
        )}
        {plan.depositForfeited > 0 && (
          <Row
            label="เงินประกันที่ริบ (ไม่คืน ไม่ใช่รายรับเงินสด)"
            sub={`เหตุผล: ${plan.forfeitReason ?? "-"}`}
            value={baht(plan.depositForfeited)}
            tone="debit"
          />
        )}
      </div>

      <div className="space-y-2 rounded-card bg-slate-50 px-4 py-3">
        <Row label="เครดิตคงเหลือหลังหัก" value={baht(plan.remainingCredit)} />
        {plan.advanceRentAbsorbed > 0 && (
          <Row
            label="ค่าเช่าล่วงหน้าส่วนที่เหลือ — ไม่คืน (ริบตามนโยบาย)"
            value={`−${baht(plan.advanceRentAbsorbed)}`}
            tone="debit"
          />
        )}
        <Row
          label="ยอดคืนผู้เช่า (ค้างจ่าย — ยังไม่ได้โอน)"
          sub="คิดจากเงินประกันและเครดิตชำระเกินเท่านั้น"
          value={baht(plan.refundDue)}
          tone="credit"
          strong
        />
        <Row
          label="ผู้เช่ายังต้องชำระเพิ่ม"
          sub={plan.balanceStillOwed > 0 ? "ยอดนี้คงค้างในใบแจ้งหนี้ ไม่ถูกตัดเป็นหนี้สูญ" : undefined}
          value={baht(plan.balanceStillOwed)}
          tone={plan.balanceStillOwed > 0 ? "debit" : "muted"}
          strong
        />
      </div>
    </div>
  );
}
