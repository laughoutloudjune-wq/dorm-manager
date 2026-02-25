"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { ArrowDownRight, ArrowUpRight, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase-client";

type DashboardStats = {
  totalRooms: number;
  occupiedRooms: number;
  vacantRooms: number;
  maintenanceRooms: number;
  pendingIncome: number;
  roomGap: number;
};

type ActivityItem = {
  id: string;
  text: string;
  created_at: string;
};

const formatMoney = (value: number) =>
  value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats>({
    totalRooms: 0,
    occupiedRooms: 0,
    vacantRooms: 0,
    maintenanceRooms: 0,
    pendingIncome: 0,
    roomGap: 0,
  });
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [ghostRooms, setGhostRooms] = useState<
    { id: string; room_number: string; status: string | null; reason: string }[]
  >([]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      const [roomsRes, invoicesRes, recentInvoicesRes, recentTenantsRes, activeTenantsRes] = await Promise.all([
        supabase.from("rooms").select("id,room_number,status"),
        supabase
          .from("invoices")
          .select("total_amount")
          .in("status", ["pending", "overdue", "verifying", "partial"]),
        supabase
          .from("invoices")
          .select("id,total_amount,created_at,rooms(room_number)")
          .order("created_at", { ascending: false })
          .limit(4),
        supabase
          .from("tenants")
          .select("id,full_name,created_at,rooms(room_number)")
          .order("created_at", { ascending: false })
          .limit(4),
        supabase.from("tenants").select("room_id").eq("status", "active"),
      ]);

      if (
        roomsRes.error ||
        invoicesRes.error ||
        recentInvoicesRes.error ||
        recentTenantsRes.error ||
        activeTenantsRes.error
      ) {
        setError(
          roomsRes.error?.message ||
            invoicesRes.error?.message ||
            recentInvoicesRes.error?.message ||
            recentTenantsRes.error?.message ||
            activeTenantsRes.error?.message ||
            "โหลดข้อมูลแดชบอร์ดไม่สำเร็จ"
        );
        setLoading(false);
        return;
      }

      const rooms = ((roomsRes.data ?? []) as any[]).map((room) => ({
        id: room.id as string,
        room_number: (room.room_number as string) ?? "-",
        status: (room.status as string | null) ?? null,
      }));
      const pendingInvoices = invoicesRes.data ?? [];
      const activeTenantRoomIds = new Set(
        ((activeTenantsRes.data ?? []) as any[])
          .map((tenant) => tenant.room_id as string | null)
          .filter(Boolean) as string[]
      );

      const totalRooms = rooms.length;
      const occupiedRooms = rooms.filter((room) => room.status === "occupied").length;
      const maintenanceRooms = rooms.filter((room) => room.status === "maintenance").length;
      const vacantRooms = rooms.filter(
        (room) => room.status === "vacant" || room.status === "available"
      ).length;
      const roomGap = totalRooms - (occupiedRooms + vacantRooms + maintenanceRooms);
      const pendingIncome = pendingInvoices.reduce(
        (sum: number, item: any) => sum + Number(item.total_amount ?? 0),
        0
      );

      const nextGhostRooms = rooms
        .map((room) => {
          const status = room.status;
          const statusKnown =
            status === "occupied" ||
            status === "maintenance" ||
            status === "vacant" ||
            status === "available";
          if (!statusKnown) {
            return {
              id: room.id,
              room_number: room.room_number,
              status,
              reason: "สถานะห้องไม่ถูกต้อง/ไม่รู้จัก",
            };
          }
          if (status === "occupied" && !activeTenantRoomIds.has(room.id)) {
            return {
              id: room.id,
              room_number: room.room_number,
              status,
              reason: "ห้องมีสถานะไม่ว่าง แต่ไม่พบผู้เช่า active",
            };
          }
          return null;
        })
        .filter(Boolean) as { id: string; room_number: string; status: string | null; reason: string }[];

      setStats({ totalRooms, occupiedRooms, vacantRooms, maintenanceRooms, pendingIncome, roomGap });
      setGhostRooms(nextGhostRooms);

      const invoiceActivities = (recentInvoicesRes.data ?? []).map((item: any) => {
        const room = Array.isArray(item.rooms) ? item.rooms[0] : item.rooms;
        return {
          id: `invoice-${item.id}`,
          text: `สร้างใบแจ้งหนี้ห้อง ${room?.room_number ?? "-"} ยอด ฿${formatMoney(Number(item.total_amount ?? 0))}`,
          created_at: item.created_at,
        };
      });

      const tenantActivities = (recentTenantsRes.data ?? []).map((item: any) => {
        const room = Array.isArray(item.rooms) ? item.rooms[0] : item.rooms;
        return {
          id: `tenant-${item.id}`,
          text: `เพิ่มผู้เช่า ${item.full_name} (${room?.room_number ?? "-"})`,
          created_at: item.created_at,
        };
      });

      const merged = [...invoiceActivities, ...tenantActivities]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6);

      setActivities(merged);
      setLoading(false);
    };

    void load();
  }, [supabase]);

  const occupancyRate = stats.totalRooms ? Math.round((stats.occupiedRooms / stats.totalRooms) * 100) : 0;

  const cards = [
    {
      label: "ห้องทั้งหมด",
      value: String(stats.totalRooms),
      trend: `มีผู้เช่าอยู่ ${stats.occupiedRooms} ห้อง`,
      icon: ArrowUpRight,
      iconWrap: "bg-blue-100 text-blue-700",
      cardTone: "from-blue-50 to-white",
    },
    {
      label: "อัตราการเข้าพัก",
      value: `${occupancyRate}%`,
      trend: `ห้องว่าง ${Math.max(stats.totalRooms - stats.occupiedRooms, 0)} ห้อง`,
      icon: ArrowUpRight,
      iconWrap: "bg-emerald-100 text-emerald-700",
      cardTone: "from-emerald-50 to-white",
    },
    {
      label: "รายได้รอรับ",
      value: `฿${formatMoney(stats.pendingIncome)}`,
      trend: "รวมสถานะรอชำระ / ชำระบางส่วน / เกินกำหนด / รอตรวจสอบ",
      icon: ArrowDownRight,
      iconWrap: "bg-amber-100 text-amber-700",
      cardTone: "from-amber-50 to-white",
    },
    {
      label: "ซ่อมบำรุง / ปัญหา",
      value: String(stats.maintenanceRooms),
      trend: "ห้องที่อยู่ระหว่างซ่อมบำรุง",
      icon: Wrench,
      iconWrap: "bg-rose-100 text-rose-700",
      cardTone: "from-rose-50 to-white",
    },
  ];

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className={`shadow-md bg-gradient-to-br ${stat.cardTone} animate-fade-in-up hover-lift`}>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-600">{stat.label}</p>
                  <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${stat.iconWrap}`}>
                    <Icon size={18} />
                  </span>
                </div>
                <div className="text-2xl font-semibold text-slate-900">{loading ? "-" : stat.value}</div>
                <p className="text-xs text-slate-500">{stat.trend}</p>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card className="animate-fade-in-up stagger-1 hover-lift">
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">ภาพรวมการเข้าพัก</h2>
              <span className="text-xs text-slate-400">เรียลไทม์</span>
            </div>
            <div className="rounded-xl bg-gradient-to-r from-blue-50 to-cyan-50 p-4">
              <div className="flex items-center justify-between text-sm text-slate-600">
                <span>มีผู้เช่าอยู่</span>
                <span className="font-semibold text-slate-900">
                  {stats.occupiedRooms} / {stats.totalRooms}
                </span>
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-white">
                <div
                  className="h-2 rounded-full bg-gradient-to-r from-blue-600 to-cyan-500"
                  style={{ width: `${occupancyRate}%` }}
                />
              </div>
              <div className="mt-3 flex justify-between text-xs text-slate-500">
                <span>ห้องว่าง: {Math.max(stats.totalRooms - stats.occupiedRooms, 0)} ห้อง</span>
                <span>ซ่อมบำรุง: {stats.maintenanceRooms} ห้อง</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="animate-fade-in-up stagger-2 hover-lift">
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">ตรวจสอบความถูกต้องของสถานะห้อง</h2>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <p>
                ส่วนต่างห้อง = ทั้งหมด ({stats.totalRooms}) - มีผู้เช่า ({stats.occupiedRooms}) - ห้องว่าง ({stats.vacantRooms}) -
                ซ่อมบำรุง ({stats.maintenanceRooms}) ={" "}
                <span className={stats.roomGap === 0 ? "font-semibold text-green-700" : "font-semibold text-red-700"}>
                  {stats.roomGap}
                </span>
              </p>
            </div>
            {stats.roomGap !== 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-800">ห้องที่สถานะผิดปกติ</p>
                {ghostRooms.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                    ไม่พบห้องผิดปกติตามเงื่อนไขปัจจุบัน
                  </p>
                ) : (
                  <ul className="space-y-2 text-xs text-slate-600">
                    {ghostRooms.map((room) => (
                      <li key={room.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                        ห้อง {room.room_number} ({room.status ?? "null"}): {room.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="animate-fade-in-up stagger-3 hover-lift">
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">กิจกรรมล่าสุด</h2>
            <ul className="space-y-3 text-sm text-slate-600">
              {activities.length > 0 ? (
                activities.map((activity) => (
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
      </section>
    </div>
  );
}
