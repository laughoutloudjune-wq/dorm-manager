"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { invoiceDeepLink, tenantDeepLink } from "@/lib/deep-links";
import { createClient } from "@/lib/supabase-client";
import type { CheckName, Severity } from "@/lib/money/reconciliation-checks";
import {
  CHECK_LABELS,
  CHECK_ORDER,
  COLUMN_LABELS,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  filterFindings,
  findingsToLabelledCsv,
  summarizeFindings,
  type FindingSummary,
  type ViewFinding,
} from "@/lib/money/reconciliation-view";

type ReportResponse = {
  findings: ViewFinding[];
  summary: FindingSummary;
  moneyEventsAvailable: boolean;
  generatedAt: string;
};

const severityVariant: Record<Severity, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const formatBaht = (n: number) =>
  n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ReconciliationPage() {
  const supabase = useMemo(() => createClient(), []);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [check, setCheck] = useState<CheckName | "all">("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");
      const res = await fetch("/api/admin/reconciliation", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "โหลดรายงานไม่สำเร็จ");
      setReport(json as ReportResponse);
    } catch (e: any) {
      setError(e?.message ?? "โหลดรายงานไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (report ? filterFindings(report.findings, { severity, check }) : []),
    [report, severity, check]
  );
  // Check counts respect the severity filter so the dropdown shows what you would get.
  const checkCounts = useMemo(
    () => summarizeFindings(report ? filterFindings(report.findings, { severity }) : []).byCheck,
    [report, severity]
  );

  const exportCsv = () => {
    // Exports what is on screen (current filters), with the same column labels.
    const csv = findingsToLabelledCsv(visible);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`ส่งออก ${visible.length} รายการ`);
  };

  const summary = report?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        description="ตรวจความสอดคล้องของใบแจ้งหนี้ ใบรับเงิน และการจัดสรรการชำระเงิน"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> โหลดใหม่
            </Button>
            <Button size="sm" onClick={exportCsv} disabled={loading || visible.length === 0}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </>
        }
      />

      <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="หน้านี้รายงานเท่านั้น ไม่แก้ไขข้อมูล">
        ระบบเพียงอ่านข้อมูลและแสดงรายการที่ตัวเลขไม่ตรงกัน ไม่มีการปรับยอด ลบ หรือยกเลิกรายการใด ๆ
        ให้ตรวจกับสลิปและใบแจ้งยอดธนาคารก่อน แล้วผู้ดูแลจึงตัดสินใจแก้ไขเอง
      </Notice>

      {report && !report.moneyEventsAvailable ? (
        <Notice tone="warning" title="ยังไม่มีตารางบันทึกตรวจสอบย้อนหลัง (money_events)">
          ข้ามการตรวจ &quot;{CHECK_LABELS.missing_money_event}&quot; เพราะไม่สามารถตัดสินได้หากไม่มีบันทึก
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title="โหลดรายงานไม่สำเร็จ">
          {error}
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {loading || !summary ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Card className="p-4">
              <p className="text-xs text-slate-500">ทั้งหมด</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</p>
            </Card>
            {SEVERITY_ORDER.map((s) => (
              <Card key={s} className="p-4">
                <p className="text-xs text-slate-500">ระดับ{SEVERITY_LABELS[s]}</p>
                <p className="mt-1 flex items-center gap-2 text-2xl font-semibold text-slate-900">
                  {summary.bySeverity[s]}
                  <Badge variant={severityVariant[s]} size="sm" dot>
                    {SEVERITY_LABELS[s]}
                  </Badge>
                </p>
              </Card>
            ))}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Select
          label="ระดับความรุนแรง"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity | "all")}
        >
          <option value="all">ทุกระดับ</option>
          {SEVERITY_ORDER.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]} ({report?.summary.bySeverity[s] ?? 0})
            </option>
          ))}
        </Select>
        <Select
          label="การตรวจสอบ"
          value={check}
          onChange={(e) => setCheck(e.target.value as CheckName | "all")}
        >
          <option value="all">ทุกการตรวจสอบ</option>
          {CHECK_ORDER.map((c) => (
            <option key={c} value={c}>
              {CHECK_LABELS[c]} ({checkCounts[c] ?? 0})
            </option>
          ))}
        </Select>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : error ? null : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" />}
            title={report && report.findings.length > 0 ? "ไม่พบรายการตามตัวกรอง" : "ไม่พบความผิดปกติ"}
            description={
              report && report.findings.length > 0
                ? "ลองเปลี่ยนตัวกรองระดับหรือการตรวจสอบ"
                : "ข้อมูลใบแจ้งหนี้ ใบรับเงิน และการจัดสรรสอดคล้องกันทุกการตรวจสอบ"
            }
          />
        </Card>
      ) : (
        <TableCard>
          <Table>
            <THead>
              <TR>
                <TH>{COLUMN_LABELS.severity}</TH>
                <TH>{COLUMN_LABELS.check}</TH>
                <TH>ผู้เช่า</TH>
                <TH>ห้อง</TH>
                <TH className="text-right">{COLUMN_LABELS.amount}</TH>
                <TH>{COLUMN_LABELS.explanation}</TH>
                <TH>{COLUMN_LABELS.suggestedNextStep}</TH>
                <TH>ลิงก์</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((f) => (
                <TR key={f.id}>
                  <TD>
                    <Badge variant={severityVariant[f.severity]} size="sm" dot>
                      {SEVERITY_LABELS[f.severity]}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{CHECK_LABELS[f.check]}</TD>
                  <TD className="whitespace-nowrap">{f.tenantName ?? "-"}</TD>
                  <TD className="whitespace-nowrap">{f.roomNumber ?? "-"}</TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(f.amount)}</TD>
                  <TD className="min-w-[18rem] text-slate-700">{f.explanation}</TD>
                  <TD className="min-w-[16rem] text-slate-500">{f.suggestedNextStep}</TD>
                  <TD className="whitespace-nowrap">
                    <div className="flex flex-wrap gap-1">
                      {f.invoiceId ? (
                        <Link href={invoiceDeepLink(f.invoiceId)} className={buttonClasses({ variant: "subtle", size: "sm" })}>
                          เปิดบิล
                        </Link>
                      ) : null}
                      {f.tenantId ? (
                        <Link href={tenantDeepLink(f.tenantId)} className={buttonClasses({ variant: "subtle", size: "sm" })}>
                          เปิดผู้เช่า
                        </Link>
                      ) : null}
                      {!f.invoiceId && !f.tenantId ? "-" : null}
                    </div>
                    {f.invoiceId || f.batchId ? (
                      <p className="mt-1 font-mono text-2xs text-slate-400">
                        {f.invoiceId ? `บิล ${f.invoiceId.slice(0, 8)}` : ""}
                        {f.invoiceId && f.batchId ? " · " : ""}
                        {f.batchId ? `ใบรับเงิน ${f.batchId.slice(0, 8)}` : ""}
                      </p>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableCard>
      )}

      {report ? (
        <p className="text-xs text-slate-400">
          แสดง {visible.length} จาก {report.findings.length} รายการ · สร้างเมื่อ{" "}
          {new Date(report.generatedAt).toLocaleString("th-TH")}
        </p>
      ) : null}
    </div>
  );
}
