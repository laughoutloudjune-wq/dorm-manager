"use client";
import React from "react";

import { SectionCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Page";
import { formatMoney, toNumber } from "@/lib/format";
import { formatDateThai } from "@/lib/invoice-utils";
import { bangkokYmd } from "@/lib/move-out-notice";

/**
 * Late-fee panel for a `v2` bill (bills made from the 25 Oct 2026 cycle; see
 * docs/audit/2026-09-29-late-fee-and-overdue-design.md A2 / B2).
 *
 * The fee belongs to this bill only. It grows `lateFeePerDay` from the day
 * after the due date until this bill's charges are fully paid, or until the
 * pause date. Nothing here edits a money column: the panel only adds or voids
 * a waiver row, or sets/clears the pause, through the admin actions route, and
 * shows the balance engine's answer back.
 */

type Balance = {
  charges: number;
  chargesPaid: number;
  chargesDue: number;
  feeStopDate: string | null;
  feeDays: number;
  feeAccrued: number;
  feeWaived: number;
  feePaid: number;
  feeDue: number;
  feeRunning: boolean;
  amountDue: number;
  status: string;
};

export type LateFeeV2State = {
  invoiceId: string;
  asOf: string;
  kind: "monthly" | "move_out";
  status: string;
  lateFeePerDay: number;
  lateFeeStartDate: string | null;
  pausedFrom: string | null;
  pausedReason: string | null;
  balance: Balance;
  paidSum: number;
  waivedSum: number;
};

export type LateFeeWaiverRow = {
  id: string;
  amount: number;
  reason: string;
  source: string;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
};

type CallAction = (action: string, payload: Record<string, unknown>) => Promise<any>;

/**
 * Loads the engine's late-fee state + waiver list for one v2 bill. `reloadKey`
 * lets the caller force a refetch (e.g. after a payment was recorded).
 */
export function useLateFeeV2(
  invoiceId: string | null,
  enabled: boolean,
  callAction: CallAction,
  reloadKey: unknown = null,
) {
  const callRef = React.useRef(callAction);
  callRef.current = callAction;
  const [state, setState] = React.useState<LateFeeV2State | null>(null);
  const [waivers, setWaivers] = React.useState<LateFeeWaiverRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [token, setToken] = React.useState(0);

  React.useEffect(() => {
    if (!enabled || !invoiceId) {
      setState(null);
      setWaivers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    callRef
      .current("get_late_fee_state", { invoiceId })
      .then((result) => {
        if (cancelled) return;
        setState((result?.state ?? null) as LateFeeV2State | null);
        setWaivers((result?.waivers ?? []) as LateFeeWaiverRow[]);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.message ?? "โหลดข้อมูลค่าปรับไม่สำเร็จ");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invoiceId, enabled, token, reloadKey]);

  const reload = React.useCallback(() => setToken((n) => n + 1), []);
  return { state, waivers, loading, loadError, reload };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" }) {
  const color =
    tone === "danger" ? "text-danger-700" : tone === "success" ? "text-success-700" : "text-slate-900";
  return (
    <div className="rounded-control border border-slate-200/70 bg-slate-50/60 px-3.5 py-2.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-base font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

const sourceLabel = (source: string) =>
  source === "manual" ? "ยกเว้นโดยผู้ดูแล" : source === "move_out" ? "ย้ายออก" : source === "switch_over" ? "เปลี่ยนระบบ" : source;

export function LateFeeV2Panel({
  state,
  waivers,
  loading,
  loadError,
  canEdit,
  callAction,
  onChanged,
}: {
  state: LateFeeV2State | null;
  waivers: LateFeeWaiverRow[];
  loading: boolean;
  loadError: string | null;
  canEdit: boolean;
  callAction: CallAction;
  /** Called after any successful change, with the refreshed engine state. */
  onChanged: (state: LateFeeV2State | null) => void;
}) {
  const [waiveAmount, setWaiveAmount] = React.useState("");
  const [waiveReason, setWaiveReason] = React.useState("");
  const [pauseDate, setPauseDate] = React.useState(() => bangkokYmd());
  const [pauseReason, setPauseReason] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (key: string, action: string, payload: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await callAction(action, payload);
      onChanged((result?.state ?? null) as LateFeeV2State | null);
      return true;
    } catch (err: any) {
      setError(err?.message ?? "ทำรายการไม่สำเร็จ");
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (loading && !state) {
    return (
      <SectionCard title="ค่าปรับล่าช้า">
        <p className="text-sm text-slate-500">กำลังคำนวณค่าปรับ...</p>
      </SectionCard>
    );
  }
  if (!state) {
    return (
      <SectionCard title="ค่าปรับล่าช้า">
        {loadError ? (
          <Notice tone="danger">{loadError}</Notice>
        ) : (
          <p className="text-sm text-slate-500">ไม่พบข้อมูลค่าปรับของบิลนี้</p>
        )}
      </SectionCard>
    );
  }

  const b = state.balance;
  const isMoveOut = state.kind === "move_out";
  const isPaused = !!state.pausedFrom;
  const editable = canEdit && !isMoveOut && state.status !== "cancelled";

  let runBadge: React.ReactNode;
  if (isMoveOut) {
    runBadge = <Badge variant="neutral">บิลย้ายออก — ไม่มีค่าปรับ</Badge>;
  } else if (b.feeRunning) {
    runBadge = (
      <Badge variant="warning" dot>
        กำลังนับ วันละ {formatMoney(state.lateFeePerDay)} บาท
      </Badge>
    );
  } else if (isPaused && b.feeStopDate === state.pausedFrom) {
    runBadge = (
      <Badge variant="info" dot>
        หยุดนับ (นับถึง {formatDateThai(state.pausedFrom ?? "")})
      </Badge>
    );
  } else if (b.feeStopDate) {
    runBadge = (
      <Badge variant="success" dot>
        หยุดนับแล้ว {formatDateThai(b.feeStopDate)}
      </Badge>
    );
  } else {
    runBadge = <Badge variant="neutral">ยังไม่เริ่มนับ</Badge>;
  }

  const submitWaive = async () => {
    const amount = toNumber(waiveAmount);
    if (!(amount > 0)) {
      setError("กรุณาระบุจำนวนเงินที่ยกเว้น");
      return;
    }
    if (!waiveReason.trim()) {
      setError("กรุณาระบุเหตุผลในการยกเว้นค่าปรับ");
      return;
    }
    const ok = await run("waive", "waive_late_fee", {
      invoiceId: state.invoiceId,
      amount,
      reason: waiveReason.trim(),
    });
    if (ok) {
      setWaiveAmount("");
      setWaiveReason("");
    }
  };

  const submitPause = async () => {
    if (!pauseReason.trim()) {
      setError("กรุณาระบุเหตุผลในการหยุดนับค่าปรับ");
      return;
    }
    const ok = await run("pause", "pause_late_fee", {
      invoiceId: state.invoiceId,
      fromDate: pauseDate,
      reason: pauseReason.trim(),
    });
    if (ok) setPauseReason("");
  };

  const submitResume = async () => {
    if (
      !window.confirm(
        "นับค่าปรับต่อ? ระบบจะคิดค่าปรับย้อนหลังรวมช่วงที่หยุดไว้ด้วย (นับต่อเนื่องจากวันเริ่มปรับ) หากต้องการไม่คิดช่วงที่หยุด ให้ใช้การยกเว้นค่าปรับแทน",
      )
    ) {
      return;
    }
    await run("resume", "resume_late_fee", { invoiceId: state.invoiceId });
  };

  const voidWaiver = async (waiverId: string) => {
    const reasonInput = window.prompt("ยกเลิกการยกเว้นค่าปรับรายการนี้?\n\nกรุณาระบุเหตุผล:");
    if (reasonInput === null) return;
    if (!reasonInput.trim()) {
      setError("กรุณาระบุเหตุผลในการยกเลิกการยกเว้นค่าปรับ");
      return;
    }
    await run(`void:${waiverId}`, "void_late_fee_waiver", { waiverId, reason: reasonInput.trim() });
  };

  return (
    <SectionCard
      title="ค่าปรับล่าช้า"
      description={
        isMoveOut
          ? "บิลย้ายออกไม่คิดค่าปรับล่าช้า"
          : `ค่าปรับอยู่บนบิลนี้เท่านั้น เริ่มนับ ${
              state.lateFeeStartDate ? formatDateThai(state.lateFeeStartDate) : "-"
            } วันละ ${formatMoney(state.lateFeePerDay)} บาท จนกว่าค่าเช่า/ค่าน้ำไฟของบิลนี้จะชำระครบ (นับตามวันที่โอน)`
      }
      action={runBadge}
    >
      <div className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        {isPaused && (
          <Notice tone="info" title={`หยุดนับค่าปรับ — นับถึงวันที่ ${formatDateThai(state.pausedFrom ?? "")}`}>
            เหตุผล: {state.pausedReason || "-"}
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="จำนวนวันที่ปรับ" value={`${b.feeDays.toLocaleString("th-TH")} วัน`} />
          <Stat label="ค่าปรับสะสม" value={formatMoney(b.feeAccrued)} />
          <Stat label="ยกเว้นแล้ว" value={formatMoney(b.feeWaived)} tone="success" />
          <Stat label="ชำระค่าปรับแล้ว" value={formatMoney(b.feePaid)} tone="success" />
          <Stat label="ค่าปรับคงค้าง" value={formatMoney(b.feeDue)} tone="danger" />
          <Stat label="ยอดค้างทั้งบิล (ณ วันนี้)" value={formatMoney(b.amountDue)} tone="danger" />
        </div>

        {editable && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-card border border-slate-200/70 p-4">
              <p className="text-sm font-semibold text-slate-900">ยกเว้นค่าปรับ</p>
              <Input
                label={`จำนวนเงิน (สูงสุด ${formatMoney(b.feeDue)})`}
                type="number"
                min={0}
                max={b.feeDue}
                step="0.01"
                value={waiveAmount}
                onChange={(event) => setWaiveAmount(event.target.value)}
                disabled={b.feeDue <= 0 || busy !== null}
              />
              <Input
                label="เหตุผล"
                required
                value={waiveReason}
                onChange={(event) => setWaiveReason(event.target.value)}
                disabled={b.feeDue <= 0 || busy !== null}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setWaiveAmount(String(b.feeDue))}
                  disabled={b.feeDue <= 0 || busy !== null}
                >
                  ทั้งหมด
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void submitWaive()}
                  loading={busy === "waive"}
                  disabled={b.feeDue <= 0 || (busy !== null && busy !== "waive")}
                >
                  ยกเว้นค่าปรับ
                </Button>
              </div>
            </div>

            <div className="space-y-3 rounded-card border border-slate-200/70 p-4">
              <p className="text-sm font-semibold text-slate-900">หยุดนับค่าปรับ/ทำต่อ</p>
              {isPaused ? (
                <>
                  <p className="text-sm text-slate-600">
                    ค่าปรับหยุดนับอยู่ (นับถึง {formatDateThai(state.pausedFrom ?? "")}) กด "นับค่าปรับต่อ" เพื่อกลับไปนับตามปกติ
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void submitResume()}
                    loading={busy === "resume"}
                    disabled={busy !== null && busy !== "resume"}
                  >
                    นับค่าปรับต่อ
                  </Button>
                </>
              ) : (
                <>
                  <Input
                    label="นับค่าปรับถึงวันที่"
                    type="date"
                    value={pauseDate}
                    onChange={(event) => setPauseDate(event.target.value)}
                    disabled={busy !== null}
                    hint="ค่าปรับของวันนี้ยังนับ หลังจากวันนี้จะไม่เพิ่ม"
                  />
                  <Input
                    label="เหตุผล (เช่น ตกลงผ่อนชำระ)"
                    required
                    value={pauseReason}
                    onChange={(event) => setPauseReason(event.target.value)}
                    disabled={busy !== null}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void submitPause()}
                    loading={busy === "pause"}
                    disabled={busy !== null && busy !== "pause"}
                  >
                    หยุดนับค่าปรับ
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-semibold text-slate-900">ประวัติการยกเว้นค่าปรับ</p>
          {waivers.length === 0 ? (
            <p className="text-sm text-slate-500">ยังไม่มีการยกเว้นค่าปรับ</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-card border border-slate-200/70">
              {waivers.map((waiver) => (
                <li key={waiver.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-semibold tabular-nums ${
                        waiver.voided_at ? "text-slate-400 line-through" : "text-slate-900"
                      }`}
                    >
                      {formatMoney(toNumber(waiver.amount))} บาท
                    </p>
                    <p className="mt-0.5 break-words text-xs text-slate-500">{waiver.reason}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {sourceLabel(waiver.source)} · {formatDateThai(String(waiver.created_at).slice(0, 10))}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {waiver.voided_at ? (
                      <Badge variant="neutral" size="sm">
                        ยกเลิกแล้ว
                      </Badge>
                    ) : (
                      canEdit &&
                      waiver.source === "manual" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void voidWaiver(waiver.id)}
                          loading={busy === `void:${waiver.id}`}
                          disabled={busy !== null && busy !== `void:${waiver.id}`}
                        >
                          ยกเลิก
                        </Button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
