"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { tenantDeepLink } from "@/lib/deep-links";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { RecordPayoutModal, VoidPayoutModal } from "@/components/admin/refunds/RefundModals";
import { SettlementsSection } from "@/components/admin/refunds/SettlementsSection";
import { shouldLoadSettlements } from "@/components/admin/refunds/form-logic";
import {
  CREDIT_LABELS,
  PAYOUT_COLUMN_LABELS,
  creditsRefundsToCsv,
  payoutStatusLabel,
  type CreditsRefundsTotals,
  type NamedBalance,
  type NamedPayout,
  type NamedRefund,
} from "@/lib/money/credits-refunds-view";

type Report = {
  creditsAvailable: boolean;
  refundsAvailable: boolean;
  payoutsAvailable: boolean;
  balances: NamedBalance[];
  refunds: NamedRefund[];
  payouts: NamedPayout[];
  totals: CreditsRefundsTotals;
  generatedAt: string;
};

const formatBaht = (n: number) =>
  n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH") : "-");

function TenantCell({ id, name, room }: { id: string; name: string | null; room: string | null }) {
  return (
    <TD className="whitespace-nowrap">
      <Link href={tenantDeepLink(id)} className="text-primary-600 hover:underline">
        {name ?? "-"}
      </Link>
      {room ? <span className="ml-2 text-xs text-slate-400">ห้อง {room}</span> : null}
    </TD>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default function CreditsRefundsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { can, loading: permsLoading, failed: permsFailed } = usePermissions();
  const canRecord = can("refund.record");
  const [refreshKey, setRefreshKey] = useState(0);
  const [payTarget, setPayTarget] = useState<{ tenantId: string; tenantName: string | null; outstanding: number } | null>(null);
  const [voidTarget, setVoidTarget] = useState<NamedPayout | null>(null);
  const refreshAll = () => {
    setRefreshKey((k) => k + 1);
    void load();
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");
      const res = await fetch("/api/admin/credits-refunds", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "โหลดรายงานไม่สำเร็จ");
      setReport(json as Report);
    } catch (e: any) {
      setError(e?.message ?? "โหลดรายงานไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const notEnabled = !!report && !report.creditsAvailable && !report.refundsAvailable && !report.payoutsAvailable;
  const hasAny = !!report && (report.balances.length > 0 || report.refunds.length > 0 || report.payouts.length > 0);

  const exportCsv = () => {
    if (!report) return;
    const csv = creditsRefundsToCsv(report);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `credits-refunds-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("ส่งออกรายงานแล้ว");
  };

  const totals = report?.totals;

  return (
    <div className="space-y-5">
      <PageHeader
        description="เงินประกัน ค่าเช่าล่วงหน้า เครดิต และการคืนเงินให้ผู้เช่า"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> โหลดใหม่
            </Button>
            <Button size="sm" onClick={exportCsv} disabled={loading || !hasAny}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </>
        }
      />

      <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="ค่าเช่าล่วงหน้าไม่สามารถคืนเงินได้">
        ยอดที่ต้องคืนคือเงินประกันที่เหลือหลังสรุปยอดย้ายออกเท่านั้น การบันทึกการจ่ายเงินคืนและการยกเลิกทำได้เฉพาะผู้มีสิทธิ์
      </Notice>

      {error ? (
        <Notice tone="danger" title="โหลดรายงานไม่สำเร็จ">
          {error}
        </Notice>
      ) : null}

      {notEnabled ? (
        <Notice tone="warning" title="ยังไม่เปิดใช้งาน">
          ยังไม่มีตารางเครดิตและการคืนเงินในฐานข้อมูล จึงยังไม่มีข้อมูลให้แสดง
        </Notice>
      ) : null}

      {report && !notEnabled && !report.creditsAvailable ? (
        <Notice tone="warning" title="ยังไม่เปิดใช้งาน: ยอดเครดิตผู้เช่า" />
      ) : null}
      {report && !notEnabled && !report.refundsAvailable ? (
        <Notice tone="warning" title={`ยังไม่เปิดใช้งาน: ${CREDIT_LABELS.refundDue} เทียบ ${CREDIT_LABELS.refundPaid}`} />
      ) : null}
      {report && !notEnabled && !report.payoutsAvailable ? (
        <Notice tone="warning" title="ยังไม่เปิดใช้งาน: รายการคืนเงิน" />
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {loading || !totals
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          : (
              [
                [CREDIT_LABELS.depositHeld, totals.depositHeld],
                [CREDIT_LABELS.advanceHeld, totals.advanceHeld],
                [CREDIT_LABELS.unappliedCredit, totals.unappliedCredit],
                [CREDIT_LABELS.refundDue, totals.refundDue],
                [CREDIT_LABELS.refundPaid, totals.refundPaid],
                [CREDIT_LABELS.refundOutstanding, totals.outstanding],
              ] as const
            ).map(([label, value]) => (
              <Card key={label} className="p-4">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{formatBaht(value)}</p>
              </Card>
            ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : error || notEnabled ? null : !hasAny ? (
        <Card>
          <EmptyState
            icon={<Wallet className="h-6 w-6" />}
            title="ยังไม่มีข้อมูลเครดิตหรือการคืนเงิน"
            description="เมื่อมีเงินประกัน เครดิต หรือการคืนเงิน รายการจะแสดงที่นี่"
          />
        </Card>
      ) : report ? (
        <>
          {report.creditsAvailable ? (
            <section className="space-y-2">
              <SectionTitle
                title="ยอดเครดิตผู้เช่า"
                hint="แยกเป็นเงินประกัน ค่าเช่าล่วงหน้า และเครดิตที่ยังไม่ได้ตัดชำระ"
              />
              {report.balances.length === 0 ? (
                <Card>
                  <EmptyState title="ไม่มียอดเครดิต" />
                </Card>
              ) : (
                <TableCard>
                  <Table>
                    <THead>
                      <TR>
                        <TH>ผู้เช่า</TH>
                        <TH className="text-right">{CREDIT_LABELS.depositHeld}</TH>
                        <TH className="text-right">{CREDIT_LABELS.advanceHeld}</TH>
                        <TH className="text-right">{CREDIT_LABELS.unappliedCredit}</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {report.balances.map((b) => (
                        <TR key={b.tenantId}>
                          <TenantCell id={b.tenantId} name={b.tenantName} room={b.roomNumber} />
                          <TD className="text-right tabular-nums">{formatBaht(b.depositHeld)}</TD>
                          <TD className="text-right tabular-nums">{formatBaht(b.advanceHeld)}</TD>
                          <TD className="text-right tabular-nums">{formatBaht(b.unappliedCredit)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableCard>
              )}
            </section>
          ) : null}

          {report.refundsAvailable ? (
            <section className="space-y-2">
              <SectionTitle
                title={`${CREDIT_LABELS.refundDue} เทียบ ${CREDIT_LABELS.refundPaid}`}
                hint="ยอดค้างคืน = ยอดที่ต้องคืน - คืนเงินแล้ว (ติดลบ = จ่ายออกเกินยอดที่ต้องคืน)"
              />
              {report.refunds.length === 0 ? (
                <Card>
                  <EmptyState title="ไม่มียอดต้องคืน" />
                </Card>
              ) : (
                <TableCard>
                  <Table>
                    <THead>
                      <TR>
                        <TH>ผู้เช่า</TH>
                        <TH className="text-right">{CREDIT_LABELS.refundDue}</TH>
                        <TH className="text-right">{CREDIT_LABELS.refundPaid}</TH>
                        <TH className="text-right">{CREDIT_LABELS.refundOutstanding}</TH>
                        {canRecord ? <TH /> : null}
                      </TR>
                    </THead>
                    <TBody>
                      {report.refunds.map((r) => (
                        <TR key={r.tenantId}>
                          <TenantCell id={r.tenantId} name={r.tenantName} room={r.roomNumber} />
                          <TD className="text-right tabular-nums">{formatBaht(r.refundDue)}</TD>
                          <TD className="text-right tabular-nums">{formatBaht(r.refundPaid)}</TD>
                          <TD className="text-right tabular-nums">
                            {r.outstanding > 0 ? (
                              <Badge variant="warning" size="sm">
                                {formatBaht(r.outstanding)}
                              </Badge>
                            ) : r.outstanding < 0 ? (
                              <Badge variant="danger" size="sm">
                                {formatBaht(r.outstanding)}
                              </Badge>
                            ) : (
                              formatBaht(0)
                            )}
                          </TD>
                          {canRecord ? (
                            <TD className="text-right">
                              {r.outstanding > 0 ? (
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    setPayTarget({ tenantId: r.tenantId, tenantName: r.tenantName, outstanding: r.outstanding })
                                  }
                                >
                                  บันทึกการจ่ายเงินคืน
                                </Button>
                              ) : null}
                            </TD>
                          ) : null}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableCard>
              )}
            </section>
          ) : null}

          {report.payoutsAvailable ? (
            <section className="space-y-2">
              <SectionTitle title="รายการคืนเงิน" hint="รายการที่ยกเลิกแล้วไม่นับรวมในยอดคืนเงินแล้ว" />
              {report.payouts.length === 0 ? (
                <Card>
                  <EmptyState title="ยังไม่มีรายการคืนเงิน" />
                </Card>
              ) : (
                <TableCard>
                  <Table>
                    <THead>
                      <TR>
                        <TH>{PAYOUT_COLUMN_LABELS.paidAt}</TH>
                        <TH>ผู้เช่า</TH>
                        <TH className="text-right">{PAYOUT_COLUMN_LABELS.amount}</TH>
                        <TH>{PAYOUT_COLUMN_LABELS.method}</TH>
                        <TH>{PAYOUT_COLUMN_LABELS.recipient}</TH>
                        <TH>{PAYOUT_COLUMN_LABELS.reference}</TH>
                        <TH>{PAYOUT_COLUMN_LABELS.status}</TH>
                        {canRecord ? <TH /> : null}
                      </TR>
                    </THead>
                    <TBody>
                      {report.payouts.map((p) => (
                        <TR key={p.id} className={p.voided ? "text-slate-400" : undefined}>
                          <TD className="whitespace-nowrap">{formatDate(p.paidAt)}</TD>
                          <TenantCell id={p.tenantId} name={p.tenantName} room={p.roomNumber} />
                          <TD className={`text-right tabular-nums ${p.voided ? "line-through" : ""}`}>
                            {formatBaht(p.amount)}
                          </TD>
                          <TD>{p.method ?? "-"}</TD>
                          <TD>{p.recipient ?? "-"}</TD>
                          <TD>{p.reference ?? "-"}</TD>
                          <TD>
                            <Badge variant={p.voided ? "neutral" : "success"} size="sm" dot>
                              {payoutStatusLabel(p.voided)}
                            </Badge>
                            {p.voided && p.voidReason ? (
                              <p className="mt-1 text-2xs text-slate-400">{p.voidReason}</p>
                            ) : null}
                          </TD>
                          {canRecord ? (
                            <TD className="text-right">
                              {!p.voided ? (
                                <Button variant="danger" size="sm" onClick={() => setVoidTarget(p)}>
                                  ยกเลิกรายการจ่าย
                                </Button>
                              ) : null}
                            </TD>
                          ) : null}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableCard>
              )}
            </section>
          ) : null}
        </>
      ) : null}

      {shouldLoadSettlements({ loading: permsLoading, failed: permsFailed, canViewCredits: can("credits.view") }) ? (
        <SettlementsSection canVoid={can("settlement.void")} refreshKey={refreshKey} onChanged={refreshAll} />
      ) : null}

      <RecordPayoutModal
        target={payTarget}
        onClose={() => setPayTarget(null)}
        onDone={() => {
          setPayTarget(null);
          toast.success("บันทึกการจ่ายเงินคืนแล้ว");
          refreshAll();
        }}
      />
      <VoidPayoutModal
        payout={voidTarget}
        onClose={() => setVoidTarget(null)}
        onDone={() => {
          setVoidTarget(null);
          toast.success("ยกเลิกรายการจ่ายแล้ว");
          refreshAll();
        }}
      />

      {report ? (
        <p className="text-xs text-slate-400">
          สร้างเมื่อ {new Date(report.generatedAt).toLocaleString("th-TH")}
        </p>
      ) : null}
    </div>
  );
}
