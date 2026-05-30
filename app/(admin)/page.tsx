"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, FileClock, Home, ReceiptText, Users, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { useDashboardStats } from "@/lib/hooks/use-data";
import { formatMoney } from "@/lib/format";

type Kpi = {
  label: string;
  value: string;
  hint: string;
  tone: string;
  icon: any;
  href: string;
};

const formatMoneyBaht = (value: number) => `฿${formatMoney(value)}`;

export default function DashboardPage() {
  const { data: dashboard, error, isLoading: loading } = useDashboardStats();

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 p-4 pb-20 sm:space-y-8 sm:p-6 lg:p-8 animate-pulse">
        {/* Header Skeleton */}
        <div className="space-y-2">
          <div className="h-8 w-48 rounded-lg bg-slate-200"></div>
          <div className="h-4 w-72 rounded-lg bg-slate-100"></div>
        </div>

        {/* KPIs Grid Skeleton */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6 lg:gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[120px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
          ))}
        </div>

        {/* Main Content Skeleton */}
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="h-[280px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
              <div className="h-[280px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
            </div>
            <div className="h-[320px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
          </div>
          <div className="space-y-6">
            <div className="h-[280px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
            <div className="h-[320px] rounded-2xl bg-slate-100 ring-1 ring-slate-200/50"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center text-red-500">
        เกิดข้อผิดพลาดในการโหลดข้อมูล: {error.message || String(error)}
      </div>
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
      tone: "from-rose-50 to-white",
      icon: AlertTriangle,
      href: "/invoices",
    },
    {
      label: "บิลรอตรวจสอบ",
      value: String(dashboard.verifyingInvoicesCount),
      hint: "มีสลิปอัปโหลดแล้วและรอแอดมินตรวจสอบ",
      tone: "from-amber-50 to-white",
      icon: FileClock,
      href: "/invoices",
    },
    {
      label: "คำขอย้ายออก",
      value: String(dashboard.requestedMoveOutsCount),
      hint: "คำขอจากผู้เช่าที่รอแอดมินตรวจสอบ",
      tone: "from-orange-50 to-white",
      icon: ArrowRight,
      href: "/tenants",
    },
    {
      label: "อัตราเข้าพัก",
      value: `${dashboard.occupancyRate}%`,
      hint: `ห้องใช้งาน ${dashboard.activeTenantsCount} จาก ${dashboard.totalRoomsCount} ห้อง`,
      tone: "from-sky-50 to-white",
      icon: Home,
      href: "/rooms",
    },
    {
      label: "ห้องว่าง",
      value: String(dashboard.vacantRoomsCount),
      hint: "ห้องที่สามารถปล่อยเช่าได้",
      tone: "from-emerald-50 to-white",
      icon: CheckCircle2,
      href: "/rooms",
    },
    {
      label: "รอเข้าพัก",
      value: String(dashboard.upcomingMoveInsCount),
      hint: "ผู้เช่าที่มีกำหนดย้ายเข้าใน 30 วัน",
      tone: "from-indigo-50 to-white",
      icon: Users,
      href: "/tenants",
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 pb-20 sm:space-y-8 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">ภาพรวมระบบ</h1>
          <p className="mt-1 text-sm text-slate-500">ข้อมูลสรุปประจำวันและการแจ้งเตือนสำคัญ</p>
        </div>
      </div>

      {/* Anomalies */}
      {dashboard.anomalies.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-rose-700">
            <AlertTriangle className="h-5 w-5" />
            <h2 className="font-semibold">ข้อสังเกตที่ควรตรวจสอบ ({dashboard.anomalies.length})</h2>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {dashboard.anomalies.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm text-rose-600">
                <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400"></span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* KPIs Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6 lg:gap-6">
        {kpis.map((kpi, idx) => (
          <Link key={idx} href={kpi.href} className="group block focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 rounded-2xl">
            <Card className={`h-full overflow-hidden border-none bg-gradient-to-b ${kpi.tone} shadow-sm ring-1 ring-slate-200/50 transition-all hover:-translate-y-0.5 hover:shadow-md`}>
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center justify-between">
                  <div className="rounded-xl bg-white/60 p-2 text-slate-600 shadow-sm backdrop-blur-sm group-hover:scale-110 group-hover:text-slate-900 transition-all">
                    <kpi.icon className="h-5 w-5 sm:h-6 sm:w-6" />
                  </div>
                </div>
                <div className="mt-3 sm:mt-4">
                  <p className="truncate text-xs font-medium text-slate-500 sm:text-sm">{kpi.label}</p>
                  <p className="mt-1 text-lg font-bold tracking-tight text-slate-900 sm:text-2xl">{kpi.value}</p>
                </div>
                <p className="mt-2 text-[10px] text-slate-500 line-clamp-2 sm:text-xs">{kpi.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content Area */}
        <div className="space-y-6 lg:col-span-2">
          {/* Charts Row */}
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Monthly Trend */}
            <Card className="overflow-hidden border-slate-200 shadow-sm">
              <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
                <h3 className="font-semibold text-slate-900">กระแสเงินสด 6 เดือนล่าสุด</h3>
              </div>
              <CardContent className="p-5">
                <div className="space-y-3">
                  {dashboard.monthlyTrend.slice().reverse().map((row) => (
                    <div key={row.month} className="space-y-1.5">
                      <div className="flex justify-between text-xs sm:text-sm">
                        <span className="font-medium text-slate-700">{row.month}</span>
                        <div className="flex gap-3">
                          <span className="text-emerald-600">฿{row.collected.toLocaleString()}</span>
                          <span className="text-rose-500">{row.outstanding > 0 ? `ค้าง ฿${row.outstanding.toLocaleString()}` : ''}</span>
                        </div>
                      </div>
                      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        {row.collected + row.outstanding > 0 ? (
                          <>
                            <div className="bg-emerald-400" style={{ width: `${(row.collected / (row.collected + row.outstanding)) * 100}%` }}></div>
                            <div className="bg-rose-400" style={{ width: `${(row.outstanding / (row.collected + row.outstanding)) * 100}%` }}></div>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Utility Trend */}
            <Card className="overflow-hidden border-slate-200 shadow-sm">
              <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
                <h3 className="font-semibold text-slate-900">การใช้สาธารณูปโภค</h3>
              </div>
              <CardContent className="p-5">
                <div className="space-y-3">
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
                            <div className="bg-amber-400" style={{ width: `${(row.electricity / (row.electricity + row.water)) * 100}%` }}></div>
                            <div className="bg-sky-400" style={{ width: `${(row.water / (row.electricity + row.water)) * 100}%` }}></div>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Building Stats */}
          <Card className="overflow-hidden border-slate-200 shadow-sm">
            <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
              <h3 className="font-semibold text-slate-900">สถานะห้องพักแยกตามอาคาร</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="px-5 py-3 font-medium">อาคาร</th>
                    <th className="px-5 py-3 font-medium text-right">จำนวนห้อง</th>
                    <th className="px-5 py-3 font-medium text-right">มีผู้เช่า</th>
                    <th className="px-5 py-3 font-medium text-right">ว่าง</th>
                    <th className="px-5 py-3 font-medium text-right">อัตราการเข้าพัก</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dashboard.buildingStats.map((stat) => (
                    <tr key={stat.building} className="hover:bg-slate-50/50">
                      <td className="px-5 py-3 font-medium text-slate-900">{stat.building}</td>
                      <td className="px-5 py-3 text-right text-slate-600">{stat.total}</td>
                      <td className="px-5 py-3 text-right text-emerald-600">{stat.occupied}</td>
                      <td className="px-5 py-3 text-right text-slate-600">{stat.vacant}</td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="font-medium text-slate-700">{stat.occupancy}%</span>
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full bg-emerald-500" style={{ width: `${stat.occupancy}%` }}></div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {dashboard.buildingStats.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                        ไม่มีข้อมูลห้องพัก
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Sidebar Area */}
        <div className="space-y-6">
          {/* Quick Actions */}
          <Card className="overflow-hidden border-slate-200 shadow-sm">
            <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
              <h3 className="font-semibold text-slate-900">การเข้าถึงด่วน</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {quickActions.map((action, idx) => (
                <Link
                  key={idx}
                  href={action.href}
                  className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                >
                  <div className="rounded-lg bg-slate-100 p-2 text-slate-500 transition-colors group-hover:bg-indigo-50 group-hover:text-indigo-600 group-focus:bg-indigo-50 group-focus:text-indigo-600">
                    <action.icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900 group-hover:text-indigo-600 group-focus:text-indigo-600">
                      {action.label}
                    </p>
                    <p className="text-xs text-slate-500">{action.hint}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-indigo-400 group-focus:translate-x-1 group-focus:text-indigo-400" />
                </Link>
              ))}
            </div>
          </Card>

          {/* Recent Activity */}
          <Card className="overflow-hidden border-slate-200 shadow-sm">
            <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4">
              <h3 className="font-semibold text-slate-900">รายการล่าสุด</h3>
            </div>
            <div className="p-5">
              {dashboard.recentActivities.length > 0 ? (
                <div className="relative space-y-6 before:absolute before:inset-y-0 before:left-2 before:w-px before:bg-slate-200">
                  {dashboard.recentActivities.map((activity) => (
                    <div key={activity.id} className="relative flex gap-4 pl-6">
                      <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full border-4 border-white bg-indigo-500 shadow-sm"></div>
                      <div>
                        <p className="text-sm text-slate-700">{activity.text}</p>
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
              ) : (
                <p className="text-center text-sm text-slate-500">ไม่มีรายการล่าสุด</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
