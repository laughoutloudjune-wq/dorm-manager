"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Building2, ChevronRight, RefreshCw, CalendarDays, Smartphone } from "lucide-react";
import { TenantEditorModal } from "@/components/admin/tenant-editor-modal";

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
  if (s === "completed") return "เสร็จสิ้น";
  if (s === "cancelled") return "ยกเลิก";
  if (s === "manual") return "กำหนดแล้ว";
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

export default function MoveOutsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permLoading } = usePermissions();
  const canView = can("tenant.view");

  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [tenantsWithDate, setTenantsWithDate] = useState<TenantWithMoveOut[]>([]);

  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    const [reqRes, tenRes] = await Promise.all([
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
    setLoading(false);
  }, [canView, supabase]);

  useEffect(() => {
    if (!permLoading && canView) void load();
  }, [canView, permLoading, load]);

  const unifiedList = useMemo(() => {
    const map = new Map<string, any>();

    // Process requests
    requests.forEach((req) => {
      if (req.status === "completed") return; // Filter out already moved out

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

    // Process tenantsWithDate
    tenantsWithDate.forEach((t) => {
      // Find if this tenant already has an active request in the list
      const existingReq = Array.from(map.values()).find(
        (u) => u.tenant_id === t.id && (u.status === "approved" || u.status === "requested")
      );

      if (existingReq) {
        // Update the move_out_date to be the actual confirmed one if different
        existingReq.move_out_date = t.move_out_date;
        existingReq.sort_date = new Date(`${t.move_out_date}T00:00:00`).getTime();
      } else {
        // No active request, meaning the admin set the date manually
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

    // Sort: Pending requests first, then by date descending/ascending
    return Array.from(map.values()).sort((a, b) => {
      if (a.status === "requested" && b.status !== "requested") return -1;
      if (b.status === "requested" && a.status !== "requested") return 1;
      return a.sort_date - b.sort_date;
    });
  }, [requests, tenantsWithDate]);

  const requestedCount = unifiedList.filter((r) => r.status === "requested").length;

  const getBadgeVariant = (status: string) => {
    if (status === "requested") return "warning";
    if (status === "approved" || status === "manual") return "success";
    if (status === "rejected" || status === "cancelled") return "danger";
    return "default";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          รวมรายการผู้เช่าที่เตรียมย้ายออกทั้งหมด (เรียงตามวันที่)
        </p>
        {canView && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            รีเฟรช
          </button>
        )}
      </div>

      {!permLoading && !canView && (
        <p className="text-sm text-amber-800">ไม่มีสิทธิ์ดูข้อมูลนี้</p>
      )}



      {canView && loading && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200/80 py-10 text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />
          กำลังโหลด…
        </div>
      )}

      {canView && !loading && (
        <Card>
          <CardContent className="!p-0">
            <div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600 flex gap-4">
              <span>ทั้งหมด: <span className="font-medium text-slate-800">{unifiedList.length}</span> รายการ</span>
              <span>รอตรวจสอบ: <span className="font-semibold text-amber-600">{requestedCount}</span> รายการ</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">สถานะ</th>
                    <th className="px-4 py-3">ผู้เช่า</th>
                    <th className="px-4 py-3">ห้อง / อาคาร</th>
                    <th className="px-4 py-3">วันย้ายออก</th>
                    <th className="px-4 py-3">ที่มา</th>
                    <th className="px-4 py-3 w-12" />
                  </tr>
                </thead>
                <tbody>
                  {unifiedList.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        ไม่มีรายการย้ายออกในระบบ
                      </td>
                    </tr>
                  ) : (
                    unifiedList.map((row) => (
                      <tr
                        key={row.key}
                        className="border-t border-slate-100/90 transition-colors hover:bg-slate-50/60"
                      >
                        <td className="px-4 py-3">
                          <Badge variant={getBadgeVariant(row.status)}>
                            {row.status_label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">{row.tenant_name}</td>
                        <td className="px-4 py-3 text-slate-700">
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-slate-400" />
                            {row.room} · {row.building}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          <div className="flex flex-col gap-0.5">
                            <span className={row.status === "requested" ? "font-medium text-amber-700" : "font-medium text-slate-800"}>
                              {formatThai(row.move_out_date)}
                            </span>
                            {row.notice_date && (
                              <span className="text-[11px] text-slate-400">แจ้งเมื่อ: {formatThai(row.notice_date)}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {row.source === "tenant" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-md">
                              <Smartphone className="h-3 w-3" /> แอปผู้เช่า
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-purple-600 bg-purple-50 px-2 py-1 rounded-md">
                              <CalendarDays className="h-3 w-3" /> แอดมินตั้ง
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => {
                              setSelectedTenantId(row.tenant_id);
                              setIsModalOpen(true);
                            }}
                            className="inline-flex items-center gap-0.5 text-sm font-medium text-blue-600 hover:underline"
                          >
                            จัดการ
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {isModalOpen && (
        <TenantEditorModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          tenantId={selectedTenantId}
          initialTab="move_out"
          onRefresh={load}
        />
      )}
    </div>
  );
}
