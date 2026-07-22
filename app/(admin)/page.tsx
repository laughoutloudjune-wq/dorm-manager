"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, FileClock, Home, ReceiptText, Users, Zap } from "lucide-react";
import { Card, CardContent, SectionCard } from "@/components/ui/Card";
import { EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/Page";
import { Table, TableCard, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { useDashboardStats } from "@/lib/hooks/use-data";
import { formatMoney } from "@/lib/format";

type KpiTint = "red" | "orange" | "indigo" | "teal" | "green" | "purple";

type Kpi = {
  label: string;
  value: string;
  hint: string;
  tint: KpiTint;
  icon: any;
  href: string;
};

const formatMoneyBaht = (value: number) => `฿${formatMoney(value)}`;

// Each tint carries meaning, not decoration: red = money at risk, orange = needs
// review soon, indigo = action requested, teal = neutral metric, green = positive
// availability, purple = upcoming/scheduled. Written as full literal class names
// (not built via string interpolation) so Tailwind's static scan picks them up.
const KPI_ICON_CLASSES: Record<KpiTint, string> = {
  red: "bg-apple-red/10 text-apple-red",
  orange: "bg-apple-orange/10 text-apple-orange",
  indigo: "bg-apple-indigo/10 text-apple-indigo",
  teal: "bg-apple-teal/10 text-apple-teal",
  green: "bg-apple-green/10 text-apple-green",
  purple: "bg-apple-purple/10 text-apple-purple",
};

export default function DashboardPage() {
  const { data: dashboard, error, isLoading: loading } = useDashboardStats();

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-3 lg:gap-6 2xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[130px]" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="grid gap-6 sm:grid-cols-2">
              <Skeleton className="h-[280px]" />
              <Skeleton className="h-[280px]" />
            </div>
            <Skeleton className="h-[320px]" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-[280px]" />
            <Skeleton className="h-[320px]" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Notice tone="danger" icon={<AlertTriangle className="h-5 w-5" />} title="โหลดข้อมูลไม่สำเร็จ">
        {error.message || String(error)}
      </Notice>
    );
  }

  if (!dashboard) {
    return null;
  }

  const quickActions = [
    { href: "/invoices", label: "ไปตรวจบิล", hint: "บิลค้างและสลิปรอตรวจสอบ", icon: ReceiptText },
    { href: "/meters", label: "ไปบันทึกมิเตอร์", hint: "อัปเดตค่าน้ำและค่าไฟ", icon: Zap },
    { href: "/tenants", label: "ไปจัดการผู้เช่า", hint: "ดูย้ายเข้า ย้ายออก และคำขอ", icon: Users },
    { href: "/reports", label: "ไปหน้ารายงาน", hint: "สรุปข้อมูลสำหรับส่งบัญชี", icon: FileClock },
  ];

  const kpis: Kpi[] = [
    {
      label: "ยอดค้างชำระ",
      value: formatMoneyBaht(dashboard.totalOutstanding),
      hint: `เกินกำหนด ${dashboard.overdueInvoicesCount} | รอชำระ/ชำระบางส่วน ${dashboard.pendingInvoicesCount}`,
      tint: "red",
      icon: AlertTriangle,
      href: "/invoices",
    },
    {
      label: "บิลรอตรวจสอบ",
      value: String(dashboard.verifyingInvoicesCount),
      hint: "มีสลิปอัปโหลดแล้วและรอแอดมินตรวจสอบ",
      tint: "orange",
      icon: FileClock,
      href: "/invoices",
    },
    {
      label: "คำขอย้ายออก",
      value: String(dashboard.requestedMoveOutsCount),
      hint: "คำขอจากผู้เช่าที่รอแอดมินตรวจสอบ",
      tint: "indigo",
      icon: ArrowRight,
      href: "/tenants",
    },
    {
      label: "อัตราเข้าพัก",
      value: `${dashboard.occupancyRate}%`,
      hint: `ห้องใช้งาน ${dashboard.activeTenantsCount} จาก ${dashboard.totalRoomsCount} ห้อง`,
      tint: "teal",
      icon: Home,
      href: "/rooms",
    },
    {
      label: "ห้องว่าง",
      value: String(dashboard.vacantRoomsCount),
      hint: "ห้องที่สามารถปล่อยเช่าได้",
      tint: "green",
      icon: CheckCircle2,
      href: "/rooms",
    },
    {
      label: "รอเข้าพัก",
      value: String(dashboard.upcomingMoveInsCount),
      hint: "ผู้เช่าที่มีกำหนดย้ายเข้าใน 30 วัน",
      tint: "purple",
      icon: Users,
      href: "/tenants",
    },
  ];

  const highAnomalies = dashboard.anomalies.filter((a) => a.severity === "high");
  const mediumAnomalies = dashboard.anomalies.filter((a) => a.severity !== "high");

  return (
    <div className="space-y-6">
      <PageHeader description="ข้อมูลสรุปประจำวันและการแจ้งเตือนสำคัญ" />

      {/* Anomalies — split by severity so real breakage (danger) doesn't get lost
          among softer data-quality notices (warning). The API already tags each
          anomaly with severity; the UI just wasn't using it. */}
      {highAnomalies.length > 0 && (
        <Notice
          tone="danger"
          icon={<AlertTriangle className="h-5 w-5" />}
          title={`ข้อผิดพลาดที่ต้องแก้ไขด่วน (${highAnomalies.length})`}
        >
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {highAnomalies.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-danger-400" />
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {mediumAnomalies.length > 0 && (
        <Notice
          tone="warning"
          icon={<AlertTriangle className="h-5 w-5" />}
          title={`ข้อสังเกตที่ควรตรวจสอบ (${mediumAnomalies.length})`}
        >
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {mediumAnomalies.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-warning-400" />
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {/* 6-across is deferred to 2xl: at lg (a common 1366px laptop width) six
          columns left too little room for a bold currency value and clipped it
          (e.g. "฿165,715.00" cut to "฿165,715.0"). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-3 lg:gap-6 2xl:grid-cols-6">
        {kpis.map((kpi, idx) => (
          <Link
            key={idx}
            href={kpi.href}
            className="group block rounded-card focus-ring"
          >
            <Card interactive className="h-full">
              <CardContent className="p-4 sm:p-5">
                <div
                  className={`inline-flex rounded-control p-2 transition-transform duration-200 ease-float group-hover:scale-105 ${KPI_ICON_CLASSES[kpi.tint]}`}
                >
                  <kpi.icon className="h-5 w-5" />
                </div>
                <div className="mt-3.5">
                  <p className="truncate text-xs font-medium text-slate-500">{kpi.label}</p>
                  <p
                    className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-900"
                    title={kpi.value}
                  >
                    {kpi.value}
                  </p>
                </div>
                <p className="mt-2 line-clamp-2 text-2xs leading-relaxed text-slate-500">
                  {kpi.hint}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-6 sm:grid-cols-2">
            <SectionCard title="กระแสเงินสด 6 เดือนล่าสุด">
              <div className="space-y-3.5">
                {dashboard.monthlyTrend.slice().reverse().map((row) => (
                  <div key={row.month} className="space-y-1.5">
                    <div className="flex justify-between text-xs sm:text-sm">
                      <span className="font-medium text-slate-700">{row.month}</span>
                      <div className="flex gap-3">
                        <span className="text-success-600">฿{row.collected.toLocaleString()}</span>
                        <span className="text-danger-500">
                          {row.outstanding > 0 ? `ค้าง ฿${row.outstanding.toLocaleString()}` : ""}
                        </span>
                      </div>
                    </div>
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      {row.collected + row.outstanding > 0 ? (
                        <>
                          <div
                            className="bg-success-500"
                            style={{ width: `${(row.collected / (row.collected + row.outstanding)) * 100}%` }}
                          />
                          <div
                            className="bg-danger-400"
                            style={{ width: `${(row.outstanding / (row.collected + row.outstanding)) * 100}%` }}
                          />
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="การใช้สาธารณูปโภค">
              <div className="space-y-3.5">
                {dashboard.utilityTrend.slice().reverse().map((row) => (
                  <div key={row.month} className="space-y-1.5">
                    <div className="flex justify-between text-xs sm:text-sm">
                      <span className="font-medium text-slate-700">{row.month}</span>
                      <div className="flex gap-3 text-slate-500">
                        <span>ไฟ {row.electricity.toLocaleString()}</span>
                        <span>น้ำ {row.water.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      {row.electricity + row.water > 0 ? (
                        <>
                          <div
                            className="bg-apple-orange"
                            style={{ width: `${(row.electricity / (row.electricity + row.water)) * 100}%` }}
                          />
                          <div
                            className="bg-apple-cyan"
                            style={{ width: `${(row.water / (row.electricity + row.water)) * 100}%` }}
                          />
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                สถานะห้องพักแยกตามอาคาร
              </h3>
            </div>
            <div className="scrollbar-slim overflow-x-auto">
              <Table>
                <THead>
                  <tr>
                    <TH>อาคาร</TH>
                    <TH className="text-right">จำนวนห้อง</TH>
                    <TH className="text-right">มีผู้เช่า</TH>
                    <TH className="text-right">ว่าง</TH>
                    <TH className="text-right">อัตราการเข้าพัก</TH>
                  </tr>
                </THead>
                <TBody>
                  {dashboard.buildingStats.map((stat) => (
                    <TR key={stat.building}>
                      <TD className="font-medium text-slate-900">{stat.building}</TD>
                      <TD className="text-right">{stat.total}</TD>
                      <TD className="text-right font-medium text-success-600">{stat.occupied}</TD>
                      <TD className="text-right">{stat.vacant}</TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="font-medium text-slate-700">{stat.occupancy}%</span>
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-success-500"
                              style={{ width: `${stat.occupancy}%` }}
                            />
                          </div>
                        </div>
                      </TD>
                    </TR>
                  ))}
                  {dashboard.buildingStats.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState icon={<Home className="h-5 w-5" />} title="ไม่มีข้อมูลห้องพัก" />
                      </td>
                    </tr>
                  )}
                </TBody>
              </Table>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">การเข้าถึงด่วน</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {quickActions.map((action, idx) => (
                <Link
                  key={idx}
                  href={action.href}
                  className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                >
                  <div className="rounded-control bg-slate-100 p-2 text-slate-500 transition-colors group-hover:bg-primary-50 group-hover:text-primary-600 group-focus:bg-primary-50 group-focus:text-primary-600">
                    <action.icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900 group-hover:text-primary-700 group-focus:text-primary-700">
                      {action.label}
                    </p>
                    <p className="text-xs text-slate-500">{action.hint}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300 transition-transform duration-200 ease-float group-hover:translate-x-1 group-hover:text-primary-400 group-focus:translate-x-1 group-focus:text-primary-400" />
                </Link>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">รายการล่าสุด</h3>
            </div>
            {dashboard.recentActivities.length > 0 ? (
              <div className="p-5">
                <div className="relative space-y-5 before:absolute before:inset-y-1 before:left-[7px] before:w-px before:bg-slate-200">
                  {dashboard.recentActivities.map((activity) => (
                    <div key={activity.id} className="relative flex gap-4 pl-6">
                      <div className="absolute left-0 top-1 h-[15px] w-[15px] rounded-full border-[3px] border-white bg-primary-500 shadow-float" />
                      <div>
                        <p className="text-sm leading-relaxed text-slate-700">{activity.text}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {new Date(activity.created_at).toLocaleString("th-TH", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState icon={<FileClock className="h-5 w-5" />} title="ไม่มีรายการล่าสุด" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
