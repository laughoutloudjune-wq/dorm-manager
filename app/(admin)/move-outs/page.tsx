"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { AlertTriangle, Building2, CalendarDays, CheckCircle2, ChevronRight, Clock, LogOut, Plus, RefreshCw, Smartphone, XCircle } from "lucide-react";
import { MoveOutProcessingModal } from "@/components/admin/MoveOutProcessingModal";
import { AddManualMoveOutModal } from "@/components/admin/AddManualMoveOutModal";

type RequestRow = {
  id: string;
  tenant_id: string;
  notice_date: string | null;
  requested_move_out_date: string;
  approved_move_out_date: string | null;
  status: string;
  request_note: string | null;
  created_at: string | null;
  tenants: {
    full_name: string | null;
    room_id: string | null;
    rooms:
      | { room_number: string; buildings: { name: string } | { name: string }[] | null }[]
      | { room_number: string; buildings: { name: string } | { name: string }[] | null }
      | null;
  } | null;
};

type TenantWithMoveOut = {
  id: string;
  full_name: string;
  move_out_date: string;
  room_id: string | null;
  rooms:
    | { room_number: string; buildings: { name: string } | { name: string }[] | null }[]
    | { room_number: string; buildings: { name: string } | { name: string }[] | null }
    | null;
};

const roomFromNested = (rooms: TenantWithMoveOut["rooms"]) => {
  if (!rooms) return { room: "-", building: "—" };
  const r = Array.isArray(rooms) ? rooms[0] : rooms;
  if (!r) return { room: "-", building: "—" };
  const b = r.buildings;
  const bname = Array.isArray(b) ? b[0]?.name : b?.name;
  return { room: r.room_number ?? "-", building: bname ?? "—" };
};

const getTenantFromJoin = (row: RequestRow) => {
  const t = row.tenants;
  if (!t) return null;
  return Array.isArray(t) ? t[0] : t;
};

const roomFromRequest = (row: RequestRow) =>
  roomFromNested(getTenantFromJoin(row)?.rooms ?? null);
const roomFromTenant = (row: TenantWithMoveOut) => roomFromNested(row.rooms);

const requestStatusThai = (s: string) => {
  if (s === "requested") return "รอตรวจสอบ";
  if (s === "approved") return "อนุมัติแล้ว";
  if (s === "rejected") return "ไม่อนุมัติ";
  if (s === "completed") return "ย้ายออกแล้ว";
  if (s === "cancelled") return "ยกเลิก";
  if (s === "manual") return "กำหนดแล้ว";
  if (s === "pending_settlement") return "รอสรุปยอด";
  return s;
};

const formatThai = (d: string | null) => {
  if (!d) return "—";
  return new Date(`${d}T12:00:00`).toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const daysUntil = (dateStr: string) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

type ActiveTab = "waiting_verify" | "waiting_moveout" | "pending_settlement" | "declined" | "past";

export default function MoveOutsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permLoading } = usePermissions();
  const canView = can("tenant.view");

  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [tenantsWithDate, setTenantsWithDate] = useState<TenantWithMoveOut[]>([]);
  const [pendingSettlementTenants, setPendingSettlementTenants] = useState<TenantWithMoveOut[]>([]);

  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("waiting_verify");

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    const [reqRes, tenRes, settlementRes] = await Promise.all([
      supabase
        .from("move_out_requests")
        .select(
          "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,status,request_note,created_at,tenants(full_name,room_id,rooms(room_number,buildings(name)))"
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("tenants")
        .select("id,full_name,move_out_date,room_id,rooms(room_number,buildings(name))")
        .not("move_out_date", "is", null)
        .eq("status", "active")
        .order("move_out_date", { ascending: true }),
      // Tenants freed via the quick "ปลดล็อกห้องทันที" action: already inactive, but
      // room_id is only cleared by the full settlement (final_move_out/abandon_room),
      // so a non-null room_id here means the settlement invoice hasn't been made yet.
      supabase
        .from("tenants")
        .select("id,full_name,move_out_date,room_id,rooms(room_number,buildings(name))")
        .not("move_out_date", "is", null)
        .not("room_id", "is", null)
        .eq("status", "inactive")
        .order("move_out_date", { ascending: true }),
    ]);
    if (reqRes.error) {
      toast.error(reqRes.error.message);
      setRequests([]);
    } else {
      setRequests((reqRes.data ?? []) as unknown as RequestRow[]);
    }
    if (tenRes.error) {
      toast.error(tenRes.error.message);
      setTenantsWithDate([]);
    } else {
      setTenantsWithDate((tenRes.data ?? []) as TenantWithMoveOut[]);
    }
    if (settlementRes.error) {
      toast.error(settlementRes.error.message);
      setPendingSettlementTenants([]);
    } else {
      setPendingSettlementTenants((settlementRes.data ?? []) as TenantWithMoveOut[]);
    }
    setLoading(false);
  }, [canView, supabase]);

  useEffect(() => {
    if (!permLoading && canView) void load();
  }, [canView, permLoading, load]);

  const unifiedList = useMemo(() => {
    const map = new Map<string, any>();

    requests.forEach((req) => {
      const { room, building } = roomFromRequest(req);
      const tenant_name = getTenantFromJoin(req)?.full_name ?? "—";
      const move_out_date = req.approved_move_out_date ?? req.requested_move_out_date;

      map.set(`req-${req.id}`, {
        key: `req-${req.id}`,
        tenant_id: req.tenant_id,
        tenant_name,
        room,
        building,
        move_out_date,
        sort_date: new Date(`${move_out_date}T00:00:00`).getTime(),
        status: req.status,
        status_label: requestStatusThai(req.status),
        source: "tenant",
        notice_date: req.notice_date,
      });
    });

    tenantsWithDate.forEach((t) => {
      const existingReq = Array.from(map.values()).find(
        (u) => u.tenant_id === t.id && (u.status === "approved" || u.status === "requested")
      );

      if (existingReq) {
        existingReq.move_out_date = t.move_out_date;
        existingReq.sort_date = new Date(`${t.move_out_date}T00:00:00`).getTime();
      } else {
        const { room, building } = roomFromTenant(t);
        map.set(`ten-${t.id}`, {
          key: `ten-${t.id}`,
          tenant_id: t.id,
          tenant_name: t.full_name,
          room,
          building,
          move_out_date: t.move_out_date,
          sort_date: new Date(`${t.move_out_date}T00:00:00`).getTime(),
          status: "manual",
          status_label: requestStatusThai("manual"),
          source: "admin",
          notice_date: null,
        });
      }
    });

    pendingSettlementTenants.forEach((t) => {
      // A tenant vacated via the quick action may still have a stale "approved"/"requested"
      // move-out request row (that flow doesn't touch move_out_requests) — supersede it
      // rather than showing both a stale request AND a pending-settlement row.
      const existing = Array.from(map.values()).find((u) => u.tenant_id === t.id);
      if (existing) {
        existing.status = "pending_settlement";
        existing.status_label = requestStatusThai("pending_settlement");
        existing.move_out_date = t.move_out_date;
        existing.sort_date = new Date(`${t.move_out_date}T00:00:00`).getTime();
        return;
      }
      const { room, building } = roomFromTenant(t);
      map.set(`settle-${t.id}`, {
        key: `settle-${t.id}`,
        tenant_id: t.id,
        tenant_name: t.full_name,
        room,
        building,
        move_out_date: t.move_out_date,
        sort_date: new Date(`${t.move_out_date}T00:00:00`).getTime(),
        status: "pending_settlement",
        status_label: requestStatusThai("pending_settlement"),
        source: "admin",
        notice_date: null,
      });
    });

    return Array.from(map.values()).sort((a, b) => {
      if (a.status === "requested" && b.status !== "requested") return -1;
      if (b.status === "requested" && a.status !== "requested") return 1;
      return a.sort_date - b.sort_date;
    });
  }, [requests, tenantsWithDate, pendingSettlementTenants]);

  const requestedCount = unifiedList.filter((r) => r.status === "requested").length;
  const approvedCount = unifiedList.filter((r) => r.status === "approved" || r.status === "manual").length;
  const pendingSettlementCount = unifiedList.filter((r) => r.status === "pending_settlement").length;
  const thisWeekCount = unifiedList.filter((r) => {
    if (!["approved", "manual"].includes(r.status)) return false;
    const d = daysUntil(r.move_out_date);
    return d >= 0 && d <= 7;
  }).length;

  const filteredList = useMemo(() => {
    return unifiedList.filter((row) => {
      if (activeTab === "waiting_verify") return row.status === "requested";
      if (activeTab === "waiting_moveout") return row.status === "approved" || row.status === "manual";
      if (activeTab === "pending_settlement") return row.status === "pending_settlement";
      if (activeTab === "declined") return row.status === "rejected" || row.status === "cancelled";
      if (activeTab === "past") return row.status === "completed";
      return true;
    });
  }, [unifiedList, activeTab]);

  const getBadgeVariant = (status: string) => {
    if (status === "requested") return "warning" as const;
    if (status === "approved" || status === "manual") return "success" as const;
    if (status === "pending_settlement") return "warning" as const;
    if (status === "rejected" || status === "cancelled") return "danger" as const;
    return "default" as const;
  };

  const openModal = (tenantId: string) => {
    setSelectedTenantId(tenantId);
    setIsModalOpen(true);
  };

  const tabs: { id: ActiveTab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "waiting_verify", label: "รอตรวจสอบ", icon: Clock, count: requestedCount },
    { id: "waiting_moveout", label: "รอย้ายออก", icon: LogOut, count: approvedCount },
    { id: "pending_settlement", label: "รอสรุปยอด", icon: AlertTriangle, count: pendingSettlementCount },
    { id: "declined", label: "ปฏิเสธ / ยกเลิก", icon: XCircle },
    { id: "past", label: "ย้ายออกแล้ว", icon: CheckCircle2 },
  ];

  return (
    <div className="space-y-6">
      {/* ── Stats bar ── */}
      {canView && !loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            {
              label: "รอตรวจสอบ",
              value: requestedCount,
              color: "text-warning-700",
              bg: "bg-warning-50 border-warning-200",
              icon: Clock,
            },
            {
              label: "รอย้ายออก",
              value: approvedCount,
              color: "text-primary-700",
              bg: "bg-primary-50 border-primary-200",
              icon: LogOut,
            },
            {
              label: "ใน 7 วันนี้",
              value: thisWeekCount,
              color: thisWeekCount > 0 ? "text-danger-700" : "text-slate-500",
              bg: thisWeekCount > 0 ? "bg-danger-50 border-danger-200" : "bg-slate-50 border-slate-200",
              icon: AlertTriangle,
            },
            {
              label: "รวมย้ายออกแล้ว",
              value: unifiedList.filter((r) => r.status === "completed").length,
              color: "text-success-700",
              bg: "bg-success-50 border-success-200",
              icon: CheckCircle2,
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className={`flex items-center gap-3 rounded-card border px-4 py-3.5 ${stat.bg}`}
            >
              <stat.icon className={`h-5 w-5 shrink-0 ${stat.color}`} />
              <div>
                <p className={`text-2xl font-black tabular-nums ${stat.color}`}>{stat.value}</p>
                <p className="text-sm text-slate-500 leading-tight">{stat.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">รายการผู้เช่าที่เตรียมย้ายออก</p>
        <div className="flex items-center gap-2">
          {canView && (
            <>
              <button
                type="button"
                onClick={() => setIsManualModalOpen(true)}
                className={buttonClasses({ variant: "primary", size: "sm" })}
              >
                <Plus className="h-4 w-4" />
                เพิ่มย้ายออกแบบกำหนดเอง
              </button>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                รีเฟรช
              </button>
            </>
          )}
        </div>
      </div>

      {!permLoading && !canView && (
        <p className="text-sm text-warning-800">ไม่มีสิทธิ์ดูข้อมูลนี้</p>
      )}

      {canView && loading && (
        <div className="flex items-center justify-center gap-2 rounded-card border border-slate-200/80 py-12 text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />
          กำลังโหลด…
        </div>
      )}

      {canView && !loading && (
        <div className="overflow-hidden rounded-card border border-slate-200/80 bg-white shadow-sm">
          {/* Tabs */}
          <div className="flex border-b border-slate-100 overflow-x-auto">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center gap-2 whitespace-nowrap px-5 py-3.5 text-sm font-semibold transition-colors
                    ${isActive
                      ? "border-b-2 border-primary-600 text-primary-700 bg-primary-50/50"
                      : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                    }
                  `}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {tab.count != null && tab.count > 0 && (
                    <span className={`
                      rounded-full px-2 py-0.5 text-sm font-bold
                      ${isActive ? "bg-primary-100 text-primary-700" : "bg-warning-100 text-warning-700"}
                    `}>
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-slate-50/80 text-sm font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-5 py-3">สถานะ</th>
                  <th className="px-5 py-3">ผู้เช่า</th>
                  <th className="px-5 py-3">ห้อง / อาคาร</th>
                  <th className="px-5 py-3">วันย้ายออก</th>
                  <th className="px-5 py-3">ที่มา</th>
                  <th className="px-5 py-3 w-14" />
                </tr>
              </thead>
              <tbody>
                {filteredList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                      ไม่มีรายการในหมวดนี้
                    </td>
                  </tr>
                ) : (
                  filteredList.map((row) => {
                    const days = daysUntil(row.move_out_date);
                    const isUrgent = days >= 0 && days <= 3 && (row.status === "approved" || row.status === "manual");
                    return (
                      <tr
                        key={row.key}
                        className={`border-t border-slate-100/90 transition-colors hover:bg-slate-50/60 ${isUrgent ? "bg-danger-50/30" : ""}`}
                      >
                        <td className="px-5 py-3.5">
                          <Badge variant={getBadgeVariant(row.status)}>
                            {row.status_label}
                          </Badge>
                        </td>
                        <td className="px-5 py-3.5 font-medium text-slate-900">{row.tenant_name}</td>
                        <td className="px-5 py-3.5 text-slate-600">
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-slate-400" />
                            {row.room} · {row.building}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex flex-col gap-0.5">
                            <span className={`font-semibold ${isUrgent ? "text-danger-700" : row.status === "requested" ? "text-warning-700" : "text-slate-800"}`}>
                              {formatThai(row.move_out_date)}
                            </span>
                            {(row.status === "approved" || row.status === "manual") && days >= 0 && (
                              <span className={`text-2xs font-medium ${days <= 3 ? "text-danger-600" : days <= 7 ? "text-warning-600" : "text-slate-400"}`}>
                                {days === 0 ? "วันนี้" : days === 1 ? "พรุ่งนี้" : `อีก ${days} วัน`}
                              </span>
                            )}
                            {row.notice_date && (
                              <span className="text-2xs text-slate-400">แจ้งเมื่อ: {formatThai(row.notice_date)}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          {row.source === "tenant" ? (
                            <span className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2 py-1 text-sm text-primary-600">
                              <Smartphone className="h-3 w-3" /> แอปผู้เช่า
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2 py-1 text-sm text-primary-600">
                              <CalendarDays className="h-3 w-3" /> แอดมินตั้ง
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          <button
                            onClick={() => openModal(row.tenant_id)}
                            className={buttonClasses({ variant: "subtle", size: "sm" })}
                          >
                            จัดการ <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isModalOpen && (
        <MoveOutProcessingModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          tenantId={selectedTenantId}
          onSuccess={load}
        />
      )}

      {isManualModalOpen && (
        <AddManualMoveOutModal
          isOpen={isManualModalOpen}
          onClose={() => setIsManualModalOpen(false)}
          onSuccess={load}
        />
      )}
    </div>
  );
}
