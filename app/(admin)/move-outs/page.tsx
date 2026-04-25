"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Building2, ChevronRight, LogOut, UserCog, RefreshCw } from "lucide-react";

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

  const [tab, setTab] = useState<"tenant" | "admin">("tenant");
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [tenantsWithDate, setTenantsWithDate] = useState<TenantWithMoveOut[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);
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
      setError(reqRes.error.message);
      setRequests([]);
    } else {
      setRequests((reqRes.data ?? []) as unknown as RequestRow[]);
    }
    if (tenRes.error) {
      setError((prev) => prev ?? tenRes.error?.message ?? null);
      setTenantsWithDate([]);
    } else {
      setTenantsWithDate((tenRes.data ?? []) as TenantWithMoveOut[]);
    }
    setLoading(false);
  }, [canView, supabase]);

  useEffect(() => {
    if (!permLoading && canView) void load();
  }, [canView, permLoading, load]);

  const requestedOnly = useMemo(
    () => requests.filter((r) => r.status === "requested"),
    [requests]
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        รวมคำขอย้ายออกจากผู้เช่า และรายการที่ตั้ง <span className="font-medium">วันย้ายออก</span> บนหน้าผู้เช่า
      </p>

      {!permLoading && !canView && (
        <p className="text-sm text-amber-800">ไม่มีสิทธิ์ดูข้อมูลนี้</p>
      )}

      {canView && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-slate-200/90 bg-slate-50/80 p-1">
            <button
              type="button"
              onClick={() => setTab("tenant")}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                tab === "tenant"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <LogOut className="h-4 w-4 opacity-80" />
              คำขอจากผู้เช่า
              {requestedOnly.length > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                  {requestedOnly.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab("admin")}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                tab === "admin"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <UserCog className="h-4 w-4 opacity-80" />
              ตั้งวันย้ายออก (แอดมิน)
            </button>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            รีเฟรช
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {canView && loading && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200/80 py-10 text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />
          กำลังโหลด…
        </div>
      )}

      {canView && !loading && (
        <>
          {tab === "tenant" && (
            <Card>
              <CardContent className="!p-0">
                <div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600">
                  ทุกสถานะ (เรียงตามเวลาล่าสุด) — รอตรวจสอบ:{" "}
                  <span className="font-semibold text-amber-900">{requestedOnly.length} รายการ</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">สถานะ</th>
                        <th className="px-4 py-3">ผู้เช่า</th>
                        <th className="px-4 py-3">ห้อง / อาคาร</th>
                        <th className="px-4 py-3">แจ้ง / วันขอออก</th>
                        <th className="px-4 py-3 w-12" />
                      </tr>
                    </thead>
                    <tbody>
                      {requests.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                            ยังไม่มีคำขอในระบบ
                          </td>
                        </tr>
                      ) : (
                        requests.map((row) => {
                          const { room, building } = roomFromRequest(row);
                          const tname = getTenantFromJoin(row)?.full_name ?? "—";
                          return (
                            <tr
                              key={row.id}
                              className="border-t border-slate-100/90 transition-colors hover:bg-slate-50/60"
                            >
                              <td className="px-4 py-3">
                                <Badge
                                  variant={row.status === "requested" ? "warning" : "default"}
                                >
                                  {requestStatusThai(row.status)}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 font-medium text-slate-900">{tname}</td>
                              <td className="px-4 py-3 text-slate-700">
                                <span className="inline-flex items-center gap-1.5">
                                  <Building2 className="h-3.5 w-3.5 text-slate-400" />
                                  {room} · {building}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-slate-600">
                                {formatThai(row.notice_date)} → {formatThai(row.requested_move_out_date)}
                              </td>
                              <td className="px-4 py-3">
                                <Link
                                  href={`/tenants?focusTenant=${row.tenant_id}&tab=move_out`}
                                  className="inline-flex items-center gap-0.5 text-sm font-medium text-blue-600 hover:underline"
                                >
                                  จัดการ
                                  <ChevronRight className="h-4 w-4" />
                                </Link>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {tab === "admin" && (
            <Card>
              <CardContent className="!p-0">
                <div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600">
                  ผู้เช่า <span className="font-medium text-slate-800">active</span> ที่กำหนด{" "}
                  <span className="font-medium">move_out_date</span> แล้ว (ตั้งบนหน้าผู้เช่า) — {tenantsWithDate.length}{" "}
                  ราย
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">ผู้เช่า</th>
                        <th className="px-4 py-3">ห้อง / อาคาร</th>
                        <th className="px-4 py-3">วันย้ายออก (ปฏิทิน)</th>
                        <th className="px-4 py-3 w-12" />
                      </tr>
                    </thead>
                    <tbody>
                      {tenantsWithDate.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                            ยังไม่มีผู้เช่าที่กำหนดวันย้ายออก
                          </td>
                        </tr>
                      ) : (
                        tenantsWithDate.map((row) => {
                          const { room, building } = roomFromTenant(row);
                          return (
                            <tr
                              key={row.id}
                              className="border-t border-slate-100/90 transition-colors hover:bg-slate-50/60"
                            >
                              <td className="px-4 py-3 font-medium text-slate-900">{row.full_name}</td>
                              <td className="px-4 py-3 text-slate-700">
                                <span className="inline-flex items-center gap-1.5">
                                  <Building2 className="h-3.5 w-3.5 text-slate-400" />
                                  {room} · {building}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-slate-800 tabular-nums">
                                {formatThai(row.move_out_date)}
                              </td>
                              <td className="px-4 py-3">
                                <Link
                                  href={`/tenants?focusTenant=${row.id}&tab=move_out`}
                                  className="inline-flex items-center gap-0.5 text-sm font-medium text-blue-600 hover:underline"
                                >
                                  จัดการ
                                  <ChevronRight className="h-4 w-4" />
                                </Link>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
