"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, ListChecks, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionCard } from "@/components/ui/Card";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { createClient } from "@/lib/supabase-client";
import type { LateFeeQueueRow } from "@/lib/money/action-queue";
import { SEVERITY_LABELS, SEVERITY_ORDER } from "@/lib/money/reconciliation-view";
import type { Severity } from "@/lib/money/reconciliation-checks";

type Named = { tenant_id: string; tenantName: string | null; roomNumber: string | null };
type QueueResponse = {
  today: string;
  slips: { invoiceId: string; tenantName: string | null; roomNumber: string | null; amount: number; uploadedAt: string | null }[];
  lateFees: LateFeeQueueRow[];
  refunds: { available: boolean; rows: (Named & { refund_due: number; refund_paid: number; refund_outstanding: number })[] };
  credits: { available: boolean; rows: (Named & { unapplied_credit: number })[] };
  reconciliation: { total: number; bySeverity: Record<Severity, number> };
  generatedAt: string;
};

const severityVariant: Record<Severity, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const formatBaht = (n: number) =>
  n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Section({
  title,
  description,
  count,
  action,
  children,
}: {
  title: string;
  description: string;
  count: number | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          {title}
          {count !== null ? (
            <Badge variant={count > 0 ? "warning" : "neutral"} size="sm">
              {count}
            </Badge>
          ) : null}
        </span>
      }
      description={description}
      action={action}
      bodyClassName="p-0"
    >
      {children}
    </SectionCard>
  );
}

const Empty = ({ title, description }: { title: string; description: string }) => (
  <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={title} description={description} className="py-10" />
);

const NotEnabled = () => (
  <EmptyState title="ยังไม่เปิดใช้งาน" description="ยังไม่ได้สร้างตารางข้อมูลส่วนนี้ในฐานข้อมูล" className="py-10" />
);

const who = (name: string | null, room: string | null) => (
  <>
    <TD className="whitespace-nowrap">{name ?? "-"}</TD>
    <TD className="whitespace-nowrap">{room ?? "-"}</TD>
  </>
);

export default function ActionQueuePage() {
  const supabase = useMemo(() => createClient(), []);
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");
      const res = await fetch("/api/admin/action-queue", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "โหลดคิวงานไม่สำเร็จ");
      setData(json as QueueResponse);
    } catch (e: any) {
      setError(e?.message ?? "โหลดคิวงานไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        description="รวมงานที่รอผู้ดูแลตรวจหรือตัดสินใจ แยกตามประเภท"
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> โหลดใหม่
          </Button>
        }
      />

      <Notice tone="info" icon={<ShieldCheck className="h-5 w-5" />} title="หน้านี้แสดงรายการเท่านั้น ไม่แก้ไขข้อมูล">
        ค่าปรับเป็นยอดประมาณการจากการตั้งค่าปัจจุบัน ยังไม่ได้บันทึกเป็นรายการเรียกเก็บ
      </Notice>

      {error ? (
        <Notice tone="danger" title="โหลดคิวงานไม่สำเร็จ">
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !data ? null : (
        <>
          <Section
            title="สลิปรอตรวจสอบ"
            description="บิลสถานะ “รอตรวจสอบ” ที่มีสลิปแนบ รอแอดมินยืนยัน"
            count={data.slips.length}
            action={
              <Link href="/invoices" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                ไปหน้าบิล
              </Link>
            }
          >
            {data.slips.length === 0 ? (
              <Empty title="ไม่มีสลิปรอตรวจสอบ" description="ทุกสลิปที่อัปโหลดถูกตรวจแล้ว" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า</TH>
                    <TH>ห้อง</TH>
                    <TH className="text-right">ยอดค้าง</TH>
                    <TH>อัปโหลดเมื่อ</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.slips.map((s) => (
                    <TR key={s.invoiceId}>
                      {who(s.tenantName, s.roomNumber)}
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(s.amount)}</TD>
                      <TD className="whitespace-nowrap text-slate-500">
                        {s.uploadedAt ? new Date(s.uploadedAt).toLocaleString("th-TH") : "-"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>

          <Section
            title="ค่าปรับรออนุมัติ"
            description={`บิลเกินกำหนด ณ ${data.today}: ประมาณการเทียบกับยอดที่ล็อกไว้แล้ว (อ่านอย่างเดียว)`}
            count={data.lateFees.length}
          >
            {data.lateFees.length === 0 ? (
              <Empty title="ไม่มีบิลเกินกำหนด" description="ไม่มีบิลค้างชำระที่เลยกำหนดชำระ" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า</TH>
                    <TH>ห้อง</TH>
                    <TH>ครบกำหนด</TH>
                    <TH className="text-right">ยอดค้าง</TH>
                    <TH className="text-right">ค่าปรับประมาณการ</TH>
                    <TH className="text-right">ล็อกไว้แล้ว</TH>
                    <TH>วิธีคิด</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.lateFees.map((r) => (
                    <TR key={r.invoiceId}>
                      {who(r.tenantName, r.roomNumber)}
                      <TD className="whitespace-nowrap">{r.dueDate}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(r.outstanding)}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(r.estimate.amount)}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">
                        {r.locked === null ? "ยังไม่ล็อก" : formatBaht(r.locked)}
                      </TD>
                      <TD className="min-w-[16rem] text-slate-500">{r.estimate.formula}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>

          <Section title="เงินคืนที่ต้องจ่าย" description="ยอดเงินคืนที่ยังไม่ได้โอนให้ผู้เช่า" count={data.refunds.available ? data.refunds.rows.length : null}>
            {!data.refunds.available ? (
              <NotEnabled />
            ) : data.refunds.rows.length === 0 ? (
              <Empty title="ไม่มีเงินคืนค้างจ่าย" description="ไม่มียอดเงินคืนคงเหลือ" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า</TH>
                    <TH>ห้อง</TH>
                    <TH className="text-right">ต้องคืน</TH>
                    <TH className="text-right">คืนแล้ว</TH>
                    <TH className="text-right">คงเหลือ</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.refunds.rows.map((r) => (
                    <TR key={r.tenant_id}>
                      {who(r.tenantName, r.roomNumber)}
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(Number(r.refund_due))}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(Number(r.refund_paid))}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(Number(r.refund_outstanding))}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>

          <Section title="เครดิตผู้เช่าที่ยังไม่ได้ตัดบิล" description="เงินจ่ายเกินที่ถือไว้ ยังไม่ได้นำไปหักบิลใด" count={data.credits.available ? data.credits.rows.length : null}>
            {!data.credits.available ? (
              <NotEnabled />
            ) : data.credits.rows.length === 0 ? (
              <Empty title="ไม่มีเครดิตค้าง" description="ไม่มียอดจ่ายเกินที่รอตัดบิล" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>ผู้เช่า</TH>
                    <TH>ห้อง</TH>
                    <TH className="text-right">เครดิตคงเหลือ</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.credits.rows.map((r) => (
                    <TR key={r.tenant_id}>
                      {who(r.tenantName, r.roomNumber)}
                      <TD className="whitespace-nowrap text-right tabular-nums">{formatBaht(Number(r.unapplied_credit))}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>

          <Section
            title="ผลตรวจสอบยอดเงิน"
            description="จำนวนรายการผิดปกติตามระดับความรุนแรง"
            count={data.reconciliation.total}
            action={
              <Link href="/reconciliation" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                ดูรายละเอียด
              </Link>
            }
          >
            {data.reconciliation.total === 0 ? (
              <Empty title="ไม่พบความผิดปกติ" description="ข้อมูลใบแจ้งหนี้ ใบรับเงิน และการจัดสรรสอดคล้องกัน" />
            ) : (
              <div className="grid grid-cols-3 gap-3 p-4">
                {SEVERITY_ORDER.map((s) => (
                  <Card key={s} className="p-4">
                    <p className="text-xs text-slate-500">ระดับ{SEVERITY_LABELS[s]}</p>
                    <p className="mt-1 flex items-center gap-2 text-2xl font-semibold text-slate-900">
                      {data.reconciliation.bySeverity[s]}
                      <Badge variant={severityVariant[s]} size="sm" dot>
                        {SEVERITY_LABELS[s]}
                      </Badge>
                    </p>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <ListChecks className="h-3.5 w-3.5" />
            สร้างเมื่อ {new Date(data.generatedAt).toLocaleString("th-TH")}
          </p>
        </>
      )}
    </div>
  );
}
