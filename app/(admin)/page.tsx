"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, FileClock, Home, ReceiptText, Users, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";

type Kpi = {
  label: string;
  value: string;
  hint: string;
  tone: string;
  icon: any;
  href: string;
};
type ActivityItem = {
  id: string;
  text: string;
  created_at: string;
};

const toNumber = (value: any) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  `฿${value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("th-TH") : "-";

const monthKey = (value: string) => String(value).slice(0, 7);
const relationItem = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
const roomCompare = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
const translateInvoiceStatus = (status: string) => {
  switch (status) {
    case "paid":
      return "ชำระแล้ว";
    case "verifying":
      return "รอตรวจสอบ";
    case "overdue":
      return "เกินกำหนด";
    case "partial":
      return "ชำระบางส่วน";
    case "pending":
      return "รอชำระ";
    case "draft":
      return "ฉบับร่าง";
    default:
      return status;
  }
};

export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [meters, setMeters] = useState<any[]>([]);
  const [moveOutRequests, setMoveOutRequests] = useState<any[]>([]);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [selectedMoveOutRequest, setSelectedMoveOutRequest] = useState<any | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      const [roomsRes, tenantsRes, invoicesRes, metersRes, moveOutRequestsRes] = await Promise.all([
        supabase.from("rooms").select("id,room_number,status,buildings(name)").order("room_number"),
        supabase
          .from("tenants")
          .select("id,full_name,room_id,status,move_in_date,move_out_date,created_at,rooms(room_number,buildings(name))")
          .order("created_at", { ascending: false }),
        supabase
          .from("invoices")
          .select("id,status,total_amount,paid_amount,created_at,start_date,due_date,slip_url,room_id,tenant_id,rooms(room_number,buildings(name)),tenants(full_name)")
          .order("created_at", { ascending: false }),
        supabase
          .from("meter_readings")
          .select("id,room_id,reading_month,electricity_usage,water_usage,rooms(room_number,buildings(name))")
          .order("reading_month", { ascending: false }),
        supabase
          .from("move_out_requests")
          .select("id,tenant_id,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,created_at,tenants(full_name,rooms(room_number,buildings(name)))")
          .order("created_at", { ascending: false }),
      ]);

      if (!mounted) return;
      const firstError =
        roomsRes.error ||
        tenantsRes.error ||
        invoicesRes.error ||
        metersRes.error ||
        moveOutRequestsRes.error;
      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }

      setRooms(roomsRes.data ?? []);
      setTenants(tenantsRes.data ?? []);
      setInvoices((invoicesRes.data ?? []).filter((row: any) => String(row.status) !== "draft"));
      setMeters(metersRes.data ?? []);
      setMoveOutRequests(moveOutRequestsRes.data ?? []);
      setLoading(false);
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const dashboard = useMemo(() => {
    const todayText = today.toISOString().slice(0, 10);
    const in30Days = new Date(today);
    in30Days.setDate(in30Days.getDate() + 30);
    const in30DaysText = in30Days.toISOString().slice(0, 10);

    const activeTenants = tenants.filter((tenant) => tenant.status === "active");
    const requestedMoveOuts = moveOutRequests.filter((row) => String(row.status) === "requested");
    const activeTenantRoomIds = new Set(activeTenants.map((tenant) => String(tenant.room_id)));

    const pendingInvoices = invoices.filter((invoice) => ["pending", "partial", "overdue"].includes(String(invoice.status)));
    const verifyingInvoices = invoices.filter((invoice) => String(invoice.status) === "verifying" || (!!invoice.slip_url && String(invoice.status) !== "paid"));
    const overdueInvoices = invoices.filter((invoice) => String(invoice.status) === "overdue");

    const totalOutstanding = pendingInvoices.reduce(
      (sum, invoice) => sum + Math.max(toNumber(invoice.total_amount) - toNumber(invoice.paid_amount), 0),
      0
    );
    const overdueAmount = overdueInvoices.reduce(
      (sum, invoice) => sum + Math.max(toNumber(invoice.total_amount) - toNumber(invoice.paid_amount), 0),
      0
    );

    const upcomingMoveIns = tenants.filter((tenant) => {
      const date = String(tenant.move_in_date ?? "");
      return date >= todayText && date <= in30DaysText;
    });
    const upcomingMoveOuts = tenants.filter((tenant) => {
      const date = String(tenant.move_out_date ?? "");
      return date >= todayText && date <= in30DaysText;
    });

    const vacantRooms = rooms.filter((room) => ["available", "vacant"].includes(String(room.status)));
    const occupancyRate = rooms.length > 0 ? Math.round((activeTenants.length / rooms.length) * 100) : 0;

    const byBuilding = new Map<string, { total: number; occupied: number; vacant: number }>();
    for (const room of rooms) {
      const building = relationItem(room.buildings)?.name ?? "ไม่ระบุอาคาร";
      const current = byBuilding.get(building) ?? { total: 0, occupied: 0, vacant: 0 };
      current.total += 1;
      if (["available", "vacant"].includes(String(room.status))) current.vacant += 1;
      if (String(room.status) === "occupied") current.occupied += 1;
      byBuilding.set(building, current);
    }
    const buildingStats = [...byBuilding.entries()]
      .map(([building, value]) => ({
        building,
        ...value,
        occupancy: value.total > 0 ? Math.round((value.occupied / value.total) * 100) : 0,
      }))
      .sort((a, b) => a.building.localeCompare(b.building, undefined, { numeric: true, sensitivity: "base" }));

    const latestMeterMonth = meters.length > 0 ? monthKey(String(meters[0].reading_month)) : null;
    const meterKeySet = new Set(
      meters
        .filter((row) => !latestMeterMonth || monthKey(String(row.reading_month)) === latestMeterMonth)
        .map((row) => `${row.room_id}:${monthKey(String(row.reading_month))}`)
    );
    const invoiceKeySet = new Set(
      invoices
        .filter((row) => !latestMeterMonth || monthKey(String(row.start_date)) === latestMeterMonth)
        .map((row) => `${row.room_id}:${monthKey(String(row.start_date))}`)
    );

    const anomalies: { id: string; text: string; severity: "high" | "medium" }[] = [];
    for (const room of rooms) {
      const roomId = String(room.id);
      const roomNo = String(room.room_number ?? "-");
      const status = String(room.status ?? "");
      if (status === "occupied" && !activeTenantRoomIds.has(roomId)) {
        anomalies.push({ id: `occupied-no-tenant-${roomId}`, text: `ห้อง ${roomNo} สถานะเป็นมีผู้เช่า แต่ไม่พบผู้เช่า active`, severity: "high" });
      }
      if (status !== "occupied" && activeTenantRoomIds.has(roomId)) {
        anomalies.push({ id: `tenant-room-mismatch-${roomId}`, text: `ห้อง ${roomNo} มีผู้เช่า active แต่สถานะห้องไม่ใช่ occupied`, severity: "high" });
      }
      if (latestMeterMonth && meterKeySet.has(`${roomId}:${latestMeterMonth}`) && !invoiceKeySet.has(`${roomId}:${latestMeterMonth}`)) {
        anomalies.push({ id: `meter-no-invoice-${roomId}`, text: `ห้อง ${roomNo} มีมิเตอร์เดือน ${latestMeterMonth} แต่ไม่มีบิล`, severity: "medium" });
      }
      if (latestMeterMonth && invoiceKeySet.has(`${roomId}:${latestMeterMonth}`) && !meterKeySet.has(`${roomId}:${latestMeterMonth}`)) {
        anomalies.push({ id: `invoice-no-meter-${roomId}`, text: `ห้อง ${roomNo} มีบิลเดือน ${latestMeterMonth} แต่ไม่มีมิเตอร์`, severity: "medium" });
      }
    }

    const recentActivities: ActivityItem[] = [
      ...invoices.slice(0, 5).map((invoice: any) => {
        const room = relationItem(invoice.rooms);
        return {
          id: `invoice-${invoice.id}`,
          text: `บิลห้อง ${room?.room_number ?? "-"} สถานะ ${translateInvoiceStatus(String(invoice.status ?? ""))} ยอด ${formatMoney(toNumber(invoice.total_amount))}`,
          created_at: invoice.created_at,
        };
      }),
      ...tenants.slice(0, 5).map((tenant: any) => {
        const room = relationItem(tenant.rooms);
        return {
          id: `tenant-${tenant.id}`,
          text: `ผู้เช่า ${tenant.full_name} ห้อง ${room?.room_number ?? "-"}`,
          created_at: tenant.created_at,
        };
      }),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8);

    const monthBuckets = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth() - (5 - index), 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    });

    const monthlyTrend = monthBuckets.map((month) => {
      const monthInvoices = invoices.filter((invoice) => monthKey(String(invoice.start_date)) === month);
      return {
        month,
        collected: monthInvoices.filter((invoice) => String(invoice.status) === "paid").reduce((sum, invoice) => sum + toNumber(invoice.paid_amount || invoice.total_amount), 0),
        outstanding: monthInvoices
          .filter((invoice) => ["pending", "partial", "overdue", "verifying"].includes(String(invoice.status)))
          .reduce((sum, invoice) => sum + Math.max(toNumber(invoice.total_amount) - toNumber(invoice.paid_amount), 0), 0),
      };
    });

    const utilityTrend = monthBuckets.map((month) => {
      const monthMeters = meters.filter((meter) => monthKey(String(meter.reading_month)) === month);
      return {
        month,
        electricity: monthMeters.reduce((sum, meter) => sum + toNumber(meter.electricity_usage), 0),
        water: monthMeters.reduce((sum, meter) => sum + toNumber(meter.water_usage), 0),
      };
    });

    const quickActions = [
      { href: "/invoices", label: "ไปตรวจบิล", hint: "บิลค้างและสลิปรอตรวจสอบ", icon: ReceiptText },
      { href: "/meters", label: "ไปบันทึกมิเตอร์", hint: "อัปเดตค่าน้ำและค่าไฟ", icon: Zap },
      { href: "/tenants", label: "ไปจัดการผู้เช่า", hint: "ดูย้ายเข้า ย้ายออก และคำขอ", icon: Users },
      { href: "/reports", label: "ไปหน้ารายงาน", hint: "สรุปข้อมูลสำหรับส่งบัญชี", icon: FileClock },
    ];

    const kpis: Kpi[] = [
      {
        label: "ยอดค้างชำระ",
        value: formatMoney(totalOutstanding),
        hint: `เกินกำหนด ${overdueInvoices.length} | รอชำระ/ชำระบางส่วน ${pendingInvoices.length}`,
        tone: "from-rose-50 to-white",
        icon: AlertTriangle,
        href: "/invoices",
      },
      {
        label: "บิลรอตรวจสอบ",
        value: String(verifyingInvoices.length),
        hint: "มีสลิปอัปโหลดแล้วและรอแอดมินตรวจสอบ",
        tone: "from-amber-50 to-white",
        icon: FileClock,
        href: "/invoices",
      },
      {
        label: "คำขอย้ายออก",
        value: String(requestedMoveOuts.length),
        hint: "คำขอจากผู้เช่าที่รอแอดมินตรวจสอบ",
        tone: "from-orange-50 to-white",
        icon: ArrowRight,
        href: "/tenants",
      },
      {
        label: "อัตราเข้าพัก",
        value: `${occupancyRate}%`,
        hint: `ห้องใช้งาน ${activeTenants.length} จาก ${rooms.length} ห้อง`,
        tone: "from-sky-50 to-white",
        icon: Home,
        href: "/rooms",
      },
      {
        label: "ห้องว่าง",
        value: String(vacantRooms.length),
        hint: "จำนวนห้องที่พร้อมปล่อยเช่า",
        tone: "from-emerald-50 to-white",
        icon: Users,
        href: "/rooms",
      },
    ];

    return {
      kpis,
      quickActions,
      buildingStats,
      recentActivities,
      anomalies,
      monthlyTrend,
      utilityTrend,
      upcomingMoveIns,
      upcomingMoveOuts,
      requestedMoveOuts,
      overdueAmount,
      latestMeterMonth,
    };
  }, [invoices, meters, moveOutRequests, rooms, tenants, today]);

  const maxTrendValue = Math.max(
    1,
    ...dashboard.monthlyTrend.flatMap((row) => [row.collected, row.outstanding])
  );
  const maxUtilityValue = Math.max(
    1,
    ...dashboard.utilityTrend.flatMap((row) => [row.electricity, row.water])
  );

  const openMoveOutRequestModal = (request: any) => {
    setSelectedMoveOutRequest(request);
    setRequestModalOpen(true);
  };

  const manageMoveOutRequest = async (requestStatus: "approved" | "rejected") => {
    if (!selectedMoveOutRequest) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const approvedMoveOutDate =
      requestStatus === "approved"
        ? String(selectedMoveOutRequest.requested_move_out_date ?? "")
        : null;

    const response = await fetch("/api/admin/tenants/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: "manage_move_out_request",
        requestId: selectedMoveOutRequest.id,
        requestStatus,
        approvedMoveOutDate,
      }),
    });

    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(dataJson?.error ?? "จัดการคำขอย้ายออกไม่สำเร็จ");
      return;
    }

    setMoveOutRequests((prev) =>
      prev.map((row) =>
        String(row.id) === String(selectedMoveOutRequest.id)
          ? {
              ...row,
              status: requestStatus,
              approved_move_out_date: approvedMoveOutDate,
            }
          : row
      )
    );
    if (requestStatus === "approved" && approvedMoveOutDate) {
      setTenants((prev) =>
        prev.map((tenant) =>
          String(tenant.id) === String(selectedMoveOutRequest.tenant_id)
            ? { ...tenant, move_out_date: approvedMoveOutDate }
            : tenant
        )
      );
    }
    setSelectedMoveOutRequest((prev: any) =>
      prev
        ? {
            ...prev,
            status: requestStatus,
            approved_move_out_date: approvedMoveOutDate,
          }
        : prev
    );
    setRequestModalOpen(false);
  };

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {dashboard.kpis.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.label} href={item.href} className="block">
              <Card className={`bg-gradient-to-br ${item.tone} shadow-md transition hover:-translate-y-0.5 hover:shadow-lg`}>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-600">{item.label}</p>
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-700 shadow-sm">
                      <Icon size={18} />
                    </span>
                  </div>
                  <p className="text-3xl font-semibold text-slate-900">{loading ? "-" : item.value}</p>
                  <p className="text-xs text-slate-500">{item.hint}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">สิ่งที่ต้องทำวันนี้</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {dashboard.quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <Link key={action.href} href={action.href} className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                        <Icon size={18} />
                      </span>
                      <ArrowRight size={16} className="text-slate-400" />
                    </div>
                    <p className="mt-4 font-semibold text-slate-900">{action.label}</p>
                    <p className="mt-1 text-xs text-slate-500">{action.hint}</p>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">การเคลื่อนไหวเร็ว ๆ นี้</h2>
              <span className="text-xs text-slate-400">30 วัน</span>
            </div>
            <div className="space-y-3">
              <MiniListAction
                title="คำขอย้ายออกรอตรวจสอบ"
                emptyText="ยังไม่มีคำขอย้ายออกใหม่จากผู้เช่า"
                items={dashboard.requestedMoveOuts.map((request: any) => {
                  const tenant = relationItem(request.tenants);
                  const room = relationItem(tenant?.rooms);
                  return {
                    id: String(request.id),
                    text: `${tenant?.full_name ?? "-"} | ห้อง ${room?.room_number ?? "-"} | ${formatDate(
                      request.requested_move_out_date
                    )}`,
                    onClick: () => openMoveOutRequestModal(request),
                  };
                })}
              />
              <MiniList
                title="กำลังจะย้ายเข้า"
                emptyText="ไม่มีรายการย้ายเข้าใน 30 วัน"
                items={dashboard.upcomingMoveIns.map((tenant: any) => {
                  const room = relationItem(tenant.rooms);
                  return `${tenant.full_name} | ห้อง ${room?.room_number ?? "-"} | ${formatDate(tenant.move_in_date)}`;
                })}
              />
              <MiniList
                title="กำลังจะย้ายออก"
                emptyText="ไม่มีรายการย้ายออกใน 30 วัน"
                items={dashboard.upcomingMoveOuts.map((tenant: any) => {
                  const room = relationItem(tenant.rooms);
                  return `${tenant.full_name} | ห้อง ${room?.room_number ?? "-"} | ${formatDate(tenant.move_out_date)}`;
                })}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">แนวโน้มรายรับ 6 เดือนล่าสุด</h2>
              <span className="text-xs text-slate-400">เก็บเงินจริง เทียบกับยอดค้าง</span>
            </div>
            <div className="grid h-72 grid-cols-6 items-end gap-4">
              {dashboard.monthlyTrend.map((row) => (
                <div key={row.month} className="flex h-full flex-col justify-end gap-2">
                  <div className="flex h-56 items-end justify-center gap-2">
                    <div
                      className="w-5 rounded-t-full bg-emerald-500"
                      style={{ height: `${Math.max((row.collected / maxTrendValue) * 100, row.collected > 0 ? 6 : 0)}%` }}
                      title={`เก็บเงินจริง ${formatMoney(row.collected)}`}
                    />
                    <div
                      className="w-5 rounded-t-full bg-amber-400"
                      style={{ height: `${Math.max((row.outstanding / maxTrendValue) * 100, row.outstanding > 0 ? 6 : 0)}%` }}
                      title={`ยอดค้าง ${formatMoney(row.outstanding)}`}
                    />
                  </div>
                  <div className="text-center">
                    <p className="text-xs font-medium text-slate-700">{row.month.slice(5)}</p>
                    <p className="text-[11px] text-slate-500">{formatMoney(row.collected)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-emerald-500" />เก็บเงินจริง</span>
              <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-amber-400" />ยอดค้าง</span>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">อัตราเข้าพักแยกตามอาคาร</h2>
              <span className="text-xs text-slate-400">ปัจจุบัน</span>
            </div>
            <div className="space-y-4">
              {dashboard.buildingStats.map((row) => (
                <div key={row.building} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-800">{row.building}</span>
                    <span className="text-slate-500">
                      {row.occupied}/{row.total} ห้อง | ว่าง {row.vacant}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-gradient-to-r from-blue-600 to-cyan-500" style={{ width: `${row.occupancy}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">ค่าน้ำค่าไฟ 6 เดือนล่าสุด</h2>
              <span className="text-xs text-slate-400">หน่วยการใช้งาน</span>
            </div>
            <div className="grid h-72 grid-cols-6 items-end gap-4">
              {dashboard.utilityTrend.map((row) => (
                <div key={row.month} className="flex h-full flex-col justify-end gap-2">
                  <div className="flex h-56 items-end justify-center gap-2">
                    <div
                      className="w-5 rounded-t-full bg-yellow-500"
                      style={{ height: `${Math.max((row.electricity / maxUtilityValue) * 100, row.electricity > 0 ? 6 : 0)}%` }}
                      title={`ไฟ ${row.electricity.toLocaleString("th-TH")} หน่วย`}
                    />
                    <div
                      className="w-5 rounded-t-full bg-sky-500"
                      style={{ height: `${Math.max((row.water / maxUtilityValue) * 100, row.water > 0 ? 6 : 0)}%` }}
                      title={`น้ำ ${row.water.toLocaleString("th-TH")} หน่วย`}
                    />
                  </div>
                  <div className="text-center">
                    <p className="text-xs font-medium text-slate-700">{row.month.slice(5)}</p>
                    <p className="text-[11px] text-slate-500">ไฟ {row.electricity.toLocaleString("th-TH")}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-yellow-500" />ไฟฟ้า</span>
              <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-sky-500" />น้ำ</span>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">รายการผิดปกติที่ควรแก้</h2>
              <span className="text-xs text-slate-400">{dashboard.latestMeterMonth ? `เช็กเดือน ${dashboard.latestMeterMonth}` : "เช็กภาพรวม"}</span>
            </div>
            <div className="space-y-3">
              {dashboard.anomalies.length > 0 ? (
                dashboard.anomalies.slice(0, 10).map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-xl border px-4 py-3 text-sm ${
                      item.severity === "high"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {item.text}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  ไม่พบความผิดปกติหลักของข้อมูลในตอนนี้
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">กิจกรรมล่าสุด</h2>
            <ul className="space-y-3 text-sm text-slate-600">
              {dashboard.recentActivities.length > 0 ? (
                dashboard.recentActivities.map((activity) => (
                  <li key={activity.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    {activity.text}
                  </li>
                ))
              ) : (
                <li className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-slate-400">
                  ยังไม่มีกิจกรรมล่าสุด
                </li>
              )}
            </ul>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">ห้องว่างล่าสุด</h2>
            <div className="space-y-3">
              {rooms
                .filter((room) => ["available", "vacant"].includes(String(room.status)))
                .sort((a, b) => {
                  const aBuilding = relationItem(a.buildings)?.name ?? "";
                  const bBuilding = relationItem(b.buildings)?.name ?? "";
                  const buildingOrder = aBuilding.localeCompare(bBuilding, undefined, { numeric: true, sensitivity: "base" });
                  if (buildingOrder !== 0) return buildingOrder;
                  return roomCompare(String(a.room_number ?? ""), String(b.room_number ?? ""));
                })
                .slice(0, 10)
                .map((room) => (
                  <div key={room.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium text-slate-900">ห้อง {room.room_number}</p>
                      <p className="text-slate-500">{relationItem(room.buildings)?.name ?? "ไม่ระบุอาคาร"}</p>
                    </div>
                    <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700">ว่าง</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <Modal
        isOpen={requestModalOpen}
        onClose={() => setRequestModalOpen(false)}
        title="จัดการคำขอย้ายออก"
        size="lg"
      >
        {selectedMoveOutRequest && (
          <div className="space-y-4">
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
              <p className="font-semibold">
                {(relationItem(selectedMoveOutRequest.tenants) as any)?.full_name ?? "-"}
              </p>
              <p className="mt-1">
                ห้อง {(relationItem((relationItem(selectedMoveOutRequest.tenants) as any)?.rooms) as any)?.room_number ?? "-"}
              </p>
              <p className="mt-1">วันที่แจ้งย้ายออก: {formatDate(selectedMoveOutRequest.requested_move_out_date)}</p>
              <p className="mt-1">สถานะ: {selectedMoveOutRequest.status}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void manageMoveOutRequest("rejected")}
                className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600"
              >
                ปฏิเสธ
              </button>
              <button
                type="button"
                onClick={() => void manageMoveOutRequest("approved")}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white"
              >
                อนุมัติ
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function MiniList({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: string[];
  emptyText: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <div className="mt-3 space-y-2 text-sm text-slate-600">
        {items.length > 0 ? (
          items.map((item, index) => (
            <div key={`${title}-${index}`} className="rounded-xl bg-white px-3 py-2">
              {item}
            </div>
          ))
        ) : (
          <div className="rounded-xl bg-white px-3 py-2 text-slate-400">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

function MiniListAction({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: { id: string; text: string; onClick: () => void }[];
  emptyText: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <div className="mt-3 space-y-2 text-sm text-slate-600">
        {items.length > 0 ? (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              className="block w-full rounded-xl bg-white px-3 py-2 text-left transition hover:border-blue-200 hover:bg-blue-50"
            >
              {item.text}
            </button>
          ))
        ) : (
          <div className="rounded-xl bg-white px-3 py-2 text-slate-400">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

