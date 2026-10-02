"use client";

import { useState } from "react";

/**
 * Confirmed amount + actual transfer date/time for LIFF slip approval.
 * The slip is evidence; the admin enters what they verified on it. Prefilled
 * with the outstanding balance as a convenience only.
 *
 * Wiring in page.tsx (owned by another agent): replace the date <input> and the
 * approve button with
 *   <ApproveSlipFields outstanding={remaining} disabled={!!savingAction}
 *     working={workingApprove}
 *     onApprove={(p) => void runInvoiceAction("approve_paid", p)} />
 */
export function ApproveSlipFields({
  outstanding,
  disabled,
  working,
  onApprove,
}: {
  outstanding: number;
  disabled?: boolean;
  working?: boolean;
  onApprove: (payload: { amount: number; paidAt: string }) => void;
}) {
  const nowLocal = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const [amount, setAmount] = useState(String(outstanding > 0 ? outstanding : ""));
  const [paidAt, setPaidAt] = useState(nowLocal());
  const parsed = Number(amount.replace(/,/g, ""));
  const valid = Number.isFinite(parsed) && parsed > 0 && Boolean(paidAt);
  const partial = valid && parsed < outstanding;

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">
        ยอดที่โอนจริง (ตามสลิป)
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 box-border w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
      </label>
      <label className="block text-xs font-medium text-slate-600">
        วันที่และเวลาที่โอนจริง
        <input
          type="datetime-local"
          value={paidAt}
          onChange={(e) => setPaidAt(e.target.value)}
          className="mt-1 box-border w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
      </label>
      {partial && (
        <p className="text-xs text-amber-700">ยอดน้อยกว่ายอดค้าง ระบบจะบันทึกเป็นการชำระบางส่วน</p>
      )}
      <button
        type="button"
        disabled={disabled || !valid}
        onClick={() => onApprove({ amount: parsed, paidAt: new Date(paidAt).toISOString() })}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
      >
        {working ? "กำลังอนุมัติ..." : partial ? "ยืนยันรับชำระบางส่วน" : "ยืนยันรับชำระ"}
      </button>
    </div>
  );
}
