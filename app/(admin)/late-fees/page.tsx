"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { invoiceDeepLink } from "@/lib/deep-links";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import {
  describeRate,
  type ChargeSummary,
  type EstimateRow,
  type LateFeePolicyRow,
  type LateFeeRateKind,
  type PolicyComparisonRow,
} from "@/lib/money/late-fee-flow";

type Row = EstimateRow & { tenantName: string | null; roomNumber: string | null };
type EstimatesResponse = {
  today: string;
  available: boolean;
  mode: "legacy" | "approval";
  policies: LateFeePolicyRow[];
  estimates: Row[];
};
type WaiverPreview = {
  remaining: number;
  amount: number;
  totalBefore: number;
  totalAfter: number;
  balanceBefore: number;
  balanceAfter: number;
  belowPaid: boolean;
};

const baht = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const RATE_KIND_LABELS: Record<LateFeeRateKind, string> = {
  flat_per_day: "บาทต่อวัน",
  percent_per_day: "ร้อยละต่อวัน",
  flat_once: "บาท ครั้งเดียว",
  percent_once: "ร้อยละ ครั้งเดียว",
};

const emptyPolicy = {
  effective_from: "",
  grace_days: "0",
  rate_kind: "flat_per_day" as LateFeeRateKind,
  rate_value: "",
  cap: "",
  rounding: "floor",
  partial_payments_reduce_base: true,
  compounding: false,
  auto_post: false,
  note: "",
};

export default function LateFeesPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can } = usePermissions();
  const [data, setData] = useState<EstimatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [approveRow, setApproveRow] = useState<Row | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<{ row: Row; charge: ChargeSummary } | null>(null);
  const [waiveAmount, setWaiveAmount] = useState("");
  const [waiveReason, setWaiveReason] = useState("");
  const [waiveKey, setWaiveKey] = useState("");
  const [waivePreview, setWaivePreview] = useState<WaiverPreview | null>(null);
  const [reverseTarget, setReverseTarget] = useState<{ id: string; amount: number; reason: string } | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState(emptyPolicy);
  const [comparison, setComparison] = useState<{
    since: string;
    rows: PolicyComparisonRow[];
    totals: { current: number; candidate: number; difference: number };
  } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const call = useCallback(
    async (payload: Record<string, unknown>) => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");
      const res = await fetch("/api/admin/late-fees/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "ทำรายการไม่สำเร็จ");
      return json;
    },
    [supabase],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await call({ action: "get_estimates" })) as EstimatesResponse);
    } catch (e: any) {
      setError(e?.message ?? "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, success: string, close: () => void) => {
    setBusy(true);
    setModalError(null);
    try {
      await fn();
      close();
      setNotice(success);
      await load();
    } catch (e: any) {
      setModalError(e?.message ?? "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  // Live before/after for the waiver dialog.
  useEffect(() => {
    if (!waiveTarget) return;
    const amount = Number(waiveAmount);
    if (!(amount > 0)) {
      setWaivePreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      call({ action: "preview_waiver", chargeId: waiveTarget.charge.charge.id, amount })
        .then((p) => !cancelled && setWaivePreview(p as WaiverPreview))
        .catch(() => !cancelled && setWaivePreview(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiveTarget, waiveAmount, call]);

  const canApprove = can("late_fee.approve");
  const canPolicy = can("late_fee.policy");
  const toApprove = (data?.estimates ?? []).filter((r) => r.estimate && r.estimate.amount > 0);
  const posted = (data?.estimates ?? []).flatMap((r) => r.charges.map((c) => ({ row: r, charge: c })));

  const policyPayload = () => ({
    effective_from: policyForm.effective_from,
    grace_days: Number(policyForm.grace_days || 0),
    rate_kind: policyForm.rate_kind,
    rate_value: Number(policyForm.rate_value),
    cap: policyForm.cap === "" ? null : Number(policyForm.cap),
    rounding: policyForm.rounding,
    partial_payments_reduce_base: policyForm.partial_payments_reduce_base,
    compounding: policyForm.compounding,
    auto_post: policyForm.auto_post,
    note: policyForm.note,
  });

  const openWaive = (row: Row, charge: ChargeSummary) => {
    setWaiveTarget({ row, charge });
    setWaiveAmount(String(charge.remaining));
    setWaiveReason("");
    setWaiveKey(newKey());
    setWaivePreview(null);
    setModalError(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        description="ค่าปรับที่ยังเป็นยอดประมาณการจะไม่ถูกเรียกเก็บจนกว่าผู้ดูแลจะอนุมัติ เมื่ออนุมัติจะลงเป็นรายการแยกในบิลถัดไป"
        actions={
          <>
            {canPolicy ? (
              <Button variant="secondary" size="sm" onClick={() => { setPolicyOpen(true); setComparison(null); setModalError(null); }}>
                ตั้งนโยบายเวอร์ชันใหม่
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> โหลดใหม่
            </Button>
          </>
        }
      />

      {error ? <Notice tone="danger" title="โหลดข้อมูลไม่สำเร็จ">{error}</Notice> : null}
      {notice ? <Notice tone="success" icon={<CheckCircle2 className="h-5 w-5" />}>{notice}</Notice> : null}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !data ? null : (
        <>
          {!data.available ? (
            <Notice tone="warning" title="ยังไม่เปิดใช้งาน">
              ยังไม่ได้สร้างตารางค่าปรับในฐานข้อมูล ระบบยังคิดค่าปรับแบบเดิมทั้งหมด
            </Notice>
          ) : data.mode === "legacy" ? (
            <Notice tone="warning" icon={<ShieldCheck className="h-5 w-5" />} title="ยังใช้ระบบค่าปรับแบบเดิม">
              ยังไม่มีนโยบายค่าปรับ ระบบจึงยังลงค่าปรับในบิลถัดไปอัตโนมัติแบบเดิม เมื่อสร้างนโยบายแรก
              ค่าปรับใหม่ทั้งหมดจะรอการอนุมัติที่หน้านี้ (ยกเว้นนโยบายที่เปิด “ลงอัตโนมัติ”)
            </Notice>
          ) : (
            <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="ค่าปรับต้องได้รับอนุมัติ">
              ระบบไม่ลงค่าปรับเองโดยไม่แจ้ง ยอดในคอลัมน์ “ประมาณการ” ยังไม่ใช่ยอดที่ผู้เช่าต้องจ่าย
            </Notice>
          )}

          <SectionCard
            title={
              <span className="flex items-center gap-2">
                ค่าปรับรออนุมัติ
                <Badge variant={toApprove.length > 0 ? "warning" : "neutral"} size="sm">{toApprove.length}</Badge>
              </span>
            }
            description={`คำนวณ ณ ${data.today} (บิลที่ชำระแล้ว คิดถึงวันที่ชำระครบ)`}
            bodyClassName="p-0"
          >
            {data.estimates.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title="ไม่มีบิลเกินกำหนด" description="ไม่มีค่าปรับที่ต้องพิจารณา" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า / ห้อง</TH>
                    <TH>ครบกำหนด</TH>
                    <TH className="text-right">ยอดค้าง (ต้น)</TH>
                    <TH className="text-right">ประมาณการ</TH>
                    <TH className="text-right">เรียกเก็บแล้ว</TH>
                    <TH className="text-right">ยกเว้นแล้ว</TH>
                    <TH className="text-right">รวมต้องชำระ</TH>
                    <TH>ช่วงวันที่ / วิธีคิด</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {data.estimates.map((r) => (
                    <TR key={r.invoiceId}>
                      <TD className="whitespace-nowrap">
                        <Link href={invoiceDeepLink(r.invoiceId)} className="text-primary-600 hover:underline">
                          {r.tenantName ?? "-"}
                        </Link>
                        <span className="block text-xs text-slate-500">ห้อง {r.roomNumber ?? "-"}</span>
                      </TD>
                      <TD className="whitespace-nowrap">
                        {r.dueDate}
                        {r.status === "paid" ? <Badge variant="neutral" size="sm" className="ml-1.5">ชำระแล้ว {r.asOf}</Badge> : null}
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{baht(r.principalOverdue)}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">
                        {r.estimate && r.estimate.amount > 0 ? (
                          <Badge variant="warning" size="sm">ประมาณการ {baht(r.estimate.amount)}</Badge>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{baht(r.posted)}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{baht(r.waived)}</TD>
                      <TD className="whitespace-nowrap text-right font-semibold tabular-nums">{baht(r.totalDue)}</TD>
                      <TD className="min-w-[16rem] text-xs text-slate-500">
                        {r.estimate && r.estimate.amount > 0 ? (
                          <>
                            <span className="block">{r.estimate.coveredFrom} ถึง {r.estimate.coveredTo}</span>
                            <span className="block">{r.estimate.formula}</span>
                          </>
                        ) : null}
                        {r.legacyLocked !== null ? <span className="block">ยอดล็อกแบบเดิม: {baht(r.legacyLocked)}</span> : null}
                        {r.blockedReason ? <span className="block text-warning-700">{r.blockedReason}</span> : null}
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        {canApprove && r.estimate && r.estimate.amount > 0 && !r.blockedReason ? (
                          <Button size="sm" variant="primary" onClick={() => { setApproveRow(r); setModalError(null); }}>
                            อนุมัติ
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </SectionCard>

          <SectionCard title="ค่าปรับที่เรียกเก็บแล้ว" description="แต่ละรายการลงเป็นบรรทัดแยกในบิลถัดไป การยกเว้นบันทึกเป็นรายการปรับยอดพร้อมเหตุผล ยกเลิกได้ ไม่ลบทิ้ง" bodyClassName="p-0">
            {posted.length === 0 ? (
              <EmptyState title="ยังไม่มีค่าปรับที่เรียกเก็บผ่านการอนุมัติ" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า</TH>
                    <TH>ช่วงวันที่</TH>
                    <TH className="text-right">เรียกเก็บ</TH>
                    <TH className="text-right">ยกเว้น</TH>
                    <TH className="text-right">คงเหลือ</TH>
                    <TH>ลงในบิล / โดย</TH>
                    <TH>การยกเว้น</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {posted.map(({ row, charge }) => (
                    <TR key={charge.charge.id}>
                      <TD className="whitespace-nowrap">{row.tenantName ?? "-"} <span className="text-xs text-slate-500">ห้อง {row.roomNumber ?? "-"}</span></TD>
                      <TD className="whitespace-nowrap text-xs">
                        {charge.charge.covered_from} ถึง {charge.charge.covered_to}
                        <span className="block text-slate-500">{charge.charge.formula}</span>
                      </TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{baht(charge.charge.amount)}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{baht(charge.waived)}</TD>
                      <TD className="whitespace-nowrap text-right font-semibold tabular-nums">{baht(charge.remaining)}</TD>
                      <TD className="whitespace-nowrap text-xs">
                        {charge.charge.target_invoice_id ? (
                          <Link href={invoiceDeepLink(charge.charge.target_invoice_id)} className="text-primary-600 hover:underline">
                            เปิดบิล
                          </Link>
                        ) : "-"}
                        <span className="ml-1.5">
                          {charge.automated ? <Badge variant="info" size="sm">อัตโนมัติ</Badge> : <Badge variant="neutral" size="sm">อนุมัติโดยผู้ดูแล</Badge>}
                        </span>
                      </TD>
                      <TD className="min-w-[14rem] text-xs">
                        {charge.waivers.length === 0 ? <span className="text-slate-400">-</span> : null}
                        {charge.waivers.map((w) => (
                          <div key={w.id} className="flex items-center gap-2 py-0.5">
                            <span className={w.reversed ? "text-slate-400 line-through" : ""}>
                              {baht(w.amount)} · {w.reason}
                            </span>
                            {w.reversed ? (
                              <Badge variant="neutral" size="sm">ยกเลิกแล้ว</Badge>
                            ) : canApprove ? (
                              <Button size="sm" variant="ghost" onClick={() => { setReverseTarget({ id: w.id, amount: w.amount, reason: w.reason }); setReverseReason(""); setModalError(null); }}>
                                ยกเลิกการยกเว้น
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        {canApprove && charge.remaining > 0 ? (
                          <Button size="sm" variant="secondary" onClick={() => openWaive(row, charge)}>
                            ยกเว้น
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </SectionCard>

          <SectionCard title="นโยบายค่าปรับ" description="แต่ละเวอร์ชันแก้ไขไม่ได้ การเปลี่ยนนโยบายคือการสร้างเวอร์ชันใหม่ และไม่ย้อนไปคิดกับบิลเก่าโดยอัตโนมัติ" bodyClassName="p-0">
            {data.policies.length === 0 ? (
              <EmptyState title="ยังไม่มีนโยบาย" description="ระบบยังใช้การคิดค่าปรับแบบเดิม" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>เวอร์ชัน</TH>
                    <TH>เริ่มใช้กับบิลที่ครบกำหนดตั้งแต่</TH>
                    <TH>อัตรา</TH>
                    <TH className="text-right">ผ่อนผัน (วัน)</TH>
                    <TH className="text-right">เพดาน</TH>
                    <TH>ลงอัตโนมัติ</TH>
                    <TH>หมายเหตุ</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.policies.map((p) => (
                    <TR key={p.version}>
                      <TD>v{p.version}</TD>
                      <TD className="whitespace-nowrap">{p.effective_from}</TD>
                      <TD className="whitespace-nowrap">{describeRate(p)}</TD>
                      <TD className="text-right tabular-nums">{p.grace_days}</TD>
                      <TD className="text-right tabular-nums">{p.cap === null ? "-" : baht(p.cap)}</TD>
                      <TD>{p.auto_post ? <Badge variant="warning" size="sm">เปิด</Badge> : <Badge variant="neutral" size="sm">ปิด (ต้องอนุมัติ)</Badge>}</TD>
                      <TD className="text-xs text-slate-500">{p.note ?? ""}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </SectionCard>
        </>
      )}

      {/* Approve */}
      <Modal
        isOpen={!!approveRow}
        onClose={() => setApproveRow(null)}
        title="อนุมัติค่าปรับล่าช้า"
        description="ค่าปรับจะลงเป็นบรรทัดแยกในบิลถัดไปของผู้เช่า พร้อมอ้างอิงบิลต้นทาง"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setApproveRow(null)} disabled={busy}>ยกเลิก</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                approveRow &&
                run(
                  () => call({ action: "post_fee", invoiceId: approveRow.invoiceId, expectedAmount: approveRow.estimate?.amount }),
                  `ลงค่าปรับ ${baht(approveRow.estimate?.amount)} บาทแล้ว`,
                  () => setApproveRow(null),
                )
              }
            >
              ยืนยันเรียกเก็บ
            </Button>
          </div>
        }
      >
        {approveRow?.estimate ? (
          <div className="space-y-3 text-sm">
            {modalError ? <Notice tone="danger">{modalError}</Notice> : null}
            <p>ผู้เช่า: <strong>{approveRow.tenantName ?? "-"}</strong> ห้อง {approveRow.roomNumber ?? "-"}</p>
            <p>บิลครบกำหนด {approveRow.dueDate} · ยอดค้าง (ต้น) {baht(approveRow.principalOverdue)} บาท</p>
            <p>ช่วงวันที่: {approveRow.estimate.coveredFrom} ถึง {approveRow.estimate.coveredTo} ({approveRow.estimate.days} วัน)</p>
            <p className="text-slate-600">{approveRow.estimate.formula}</p>
            <p className="text-base font-semibold">เรียกเก็บ {baht(approveRow.estimate.amount)} บาท</p>
          </div>
        ) : null}
      </Modal>

      {/* Waive */}
      <Modal
        isOpen={!!waiveTarget}
        onClose={() => setWaiveTarget(null)}
        title="ยกเว้นค่าปรับ"
        description="บันทึกเป็นรายการปรับยอด (ไม่ลบค่าปรับเดิม) ต้องระบุเหตุผล ยกเลิกภายหลังได้"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setWaiveTarget(null)} disabled={busy}>ยกเลิก</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!waiveReason.trim() || !(Number(waiveAmount) > 0) || (waiveTarget ? Number(waiveAmount) > waiveTarget.charge.remaining : true)}
              onClick={() =>
                waiveTarget &&
                run(
                  () =>
                    call({
                      action: "waive_fee",
                      chargeId: waiveTarget.charge.charge.id,
                      amount: Number(waiveAmount),
                      reason: waiveReason,
                      idempotencyKey: waiveKey,
                    }),
                  `ยกเว้นค่าปรับ ${baht(Number(waiveAmount))} บาทแล้ว`,
                  () => setWaiveTarget(null),
                )
              }
            >
              ยืนยันยกเว้น
            </Button>
          </div>
        }
      >
        {waiveTarget ? (
          <div className="space-y-4 text-sm">
            {modalError ? <Notice tone="danger">{modalError}</Notice> : null}
            <p>
              ค่าปรับ {baht(waiveTarget.charge.charge.amount)} บาท · ยกเว้นไปแล้ว {baht(waiveTarget.charge.waived)} · ยกเว้นได้อีกไม่เกิน{" "}
              <strong>{baht(waiveTarget.charge.remaining)}</strong> บาท
            </p>
            <Input
              label="จำนวนที่ยกเว้น (บาท)"
              type="number"
              min={0}
              max={waiveTarget.charge.remaining}
              step="0.01"
              value={waiveAmount}
              onChange={(e) => setWaiveAmount(e.target.value)}
              error={Number(waiveAmount) > waiveTarget.charge.remaining ? "เกินยอดค่าปรับคงเหลือ" : undefined}
            />
            <Textarea
              label="เหตุผล"
              required
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="เช่น ผู้เช่าแจ้งล่วงหน้า / ระบบธนาคารขัดข้อง"
            />
            {waivePreview ? (
              <div className="grid grid-cols-2 gap-2 rounded-control border border-slate-200 p-3 text-xs">
                <span className="text-slate-500">ยอดบิลก่อน</span>
                <span className="text-right tabular-nums">{baht(waivePreview.totalBefore)}</span>
                <span className="text-slate-500">ยอดบิลหลัง</span>
                <span className="text-right font-semibold tabular-nums">{baht(waivePreview.totalAfter)}</span>
                <span className="text-slate-500">ค้างชำระก่อน</span>
                <span className="text-right tabular-nums">{baht(waivePreview.balanceBefore)}</span>
                <span className="text-slate-500">ค้างชำระหลัง</span>
                <span className="text-right font-semibold tabular-nums">{baht(waivePreview.balanceAfter)}</span>
                {waivePreview.belowPaid ? (
                  <span className="col-span-2 text-danger-700">ยอดบิลจะต่ำกว่ายอดที่ชำระแล้ว ระบบจะไม่อนุญาต</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Reverse waiver */}
      <Modal
        isOpen={!!reverseTarget}
        onClose={() => setReverseTarget(null)}
        title="ยกเลิกการยกเว้นค่าปรับ"
        description="บันทึกรายการกลับรายการคู่กัน รายการยกเว้นเดิมยังคงอยู่ในประวัติ"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReverseTarget(null)} disabled={busy}>ยกเลิก</Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!reverseReason.trim()}
              onClick={() =>
                reverseTarget &&
                run(
                  () => call({ action: "reverse_waiver", adjustmentId: reverseTarget.id, reason: reverseReason }),
                  "ยกเลิกการยกเว้นแล้ว ค่าปรับกลับมาเรียกเก็บ",
                  () => setReverseTarget(null),
                )
              }
            >
              ยืนยันยกเลิกการยกเว้น
            </Button>
          </div>
        }
      >
        {reverseTarget ? (
          <div className="space-y-4 text-sm">
            {modalError ? <Notice tone="danger">{modalError}</Notice> : null}
            <p>
              การยกเว้น {baht(reverseTarget.amount)} บาท ({reverseTarget.reason}) จะถูกยกเลิก และยอดนี้จะกลับไปอยู่ในบิล
            </p>
            <Textarea label="เหตุผล" required value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
          </div>
        ) : null}
      </Modal>

      {/* New policy version */}
      <Modal
        isOpen={policyOpen}
        onClose={() => setPolicyOpen(false)}
        title="ตั้งนโยบายค่าปรับเวอร์ชันใหม่"
        description="สร้างเวอร์ชันใหม่ ไม่แก้ของเดิม ใช้กับบิลที่ครบกำหนดตั้งแต่วันที่เริ่มใช้ และไม่คิดย้อนหลังกับบิลเก่าโดยอัตโนมัติ"
        size="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setPolicyOpen(false)} disabled={busy}>ปิด</Button>
            <Button
              variant="secondary"
              loading={busy && !comparison}
              onClick={async () => {
                setBusy(true);
                setModalError(null);
                try {
                  setComparison(await call({ action: "preview_policy_comparison", policy: policyPayload() }));
                } catch (e: any) {
                  setModalError(e?.message ?? "เปรียบเทียบไม่สำเร็จ");
                } finally {
                  setBusy(false);
                }
              }}
            >
              เปรียบเทียบกับบิลย้อนหลัง (ดูอย่างเดียว)
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!policyForm.effective_from || policyForm.rate_value === ""}
              onClick={() => run(() => call({ action: "set_policy", policy: policyPayload() }), "สร้างนโยบายเวอร์ชันใหม่แล้ว", () => setPolicyOpen(false))}
            >
              บันทึกเวอร์ชันใหม่
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-sm">
          {modalError ? <Notice tone="danger">{modalError}</Notice> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="ใช้กับบิลที่ครบกำหนดตั้งแต่" type="date" required value={policyForm.effective_from} onChange={(e) => setPolicyForm({ ...policyForm, effective_from: e.target.value })} />
            <Input label="ผ่อนผัน (วันหลังครบกำหนด)" type="number" min={0} value={policyForm.grace_days} onChange={(e) => setPolicyForm({ ...policyForm, grace_days: e.target.value })} />
            <Select label="ประเภทอัตรา" value={policyForm.rate_kind} onChange={(e) => setPolicyForm({ ...policyForm, rate_kind: e.target.value as LateFeeRateKind })}>
              {(Object.keys(RATE_KIND_LABELS) as LateFeeRateKind[]).map((k) => (
                <option key={k} value={k}>{RATE_KIND_LABELS[k]}</option>
              ))}
            </Select>
            <Input label="อัตรา" type="number" min={0} step="0.01" required value={policyForm.rate_value} onChange={(e) => setPolicyForm({ ...policyForm, rate_value: e.target.value })} />
            <Input label="เพดานค่าปรับต่อบิล (เว้นว่าง = ไม่มี)" type="number" min={0} value={policyForm.cap} onChange={(e) => setPolicyForm({ ...policyForm, cap: e.target.value })} />
            <Select label="การปัดเศษ" value={policyForm.rounding} onChange={(e) => setPolicyForm({ ...policyForm, rounding: e.target.value })}>
              <option value="floor">ปัดลง</option>
              <option value="round">ปัดตามปกติ</option>
              <option value="ceil">ปัดขึ้น</option>
            </Select>
          </div>
          <div className="space-y-2">
            {(
              [
                ["partial_payments_reduce_base", "จ่ายบางส่วนแล้วคิดค่าปรับจากยอดที่เหลือ"],
                ["compounding", "คิดทบต้น (เฉพาะแบบร้อยละต่อวัน)"],
                ["auto_post", "ให้ระบบลงค่าปรับอัตโนมัติ (บิลที่ครบกำหนดหลังสร้างนโยบายเท่านั้น)"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key}>
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={policyForm[key]}
                    onChange={(e) => setPolicyForm({ ...policyForm, [key]: e.target.checked })}
                  />
                  {label}
                </span>
              </Field>
            ))}
          </div>
          <Textarea label="หมายเหตุ" value={policyForm.note} onChange={(e) => setPolicyForm({ ...policyForm, note: e.target.value })} />
          {comparison ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                บิลที่ครบกำหนดตั้งแต่ {comparison.since}: ปัจจุบัน {baht(comparison.totals.current)} · ตามนโยบายใหม่ {baht(comparison.totals.candidate)} · ส่วนต่าง {baht(comparison.totals.difference)} (ไม่มีการแก้ไขข้อมูลใด ๆ)
              </p>
              {comparison.rows.length === 0 ? (
                <p className="text-xs text-slate-500">ไม่มีบิลที่ได้รับผล</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>ครบกำหนด</TH>
                      <TH className="text-right">ปัจจุบัน</TH>
                      <TH className="text-right">นโยบายใหม่</TH>
                      <TH className="text-right">ส่วนต่าง</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {comparison.rows.slice(0, 50).map((r) => (
                      <TR key={r.invoiceId}>
                        <TD>
                          <Link href={invoiceDeepLink(r.invoiceId)} className="text-primary-600 hover:underline">{r.dueDate}</Link>
                        </TD>
                        <TD className="text-right tabular-nums">
                          {baht(r.current)}
                          <span className="block text-2xs text-slate-400">
                            {r.currentSource === "posted" ? "เรียกเก็บแล้ว" : r.currentSource === "legacy_locked" ? "ล็อกแบบเดิม" : "ไม่มี"}
                          </span>
                        </TD>
                        <TD className="text-right tabular-nums">{baht(r.candidate)}</TD>
                        <TD className="text-right tabular-nums">{baht(r.difference)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
