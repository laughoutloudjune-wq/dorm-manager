"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Building2, ChevronRight, RefreshCw } from "lucide-react";

type TakeoverRow = {
  id: string;
  room_id: string;
  requester_full_name: string;
  requester_phone: string;
  status: string;
  created_at: string | null;
  rooms?: {
    room_number: string;
    buildings?: { name: string } | { name: string }[];
  } | null;
};

const getBuildingName = (rooms: TakeoverRow["rooms"]) => {
  if (!rooms) return "—";
  const b = rooms.buildings;
  if (!b) return "—";
  return Array.isArray(b) ? b[0]?.name ?? "—" : b?.name ?? "—";
};

const statusLabel = (s: string) => {
  if (s === "requested") return "รอตรวจสอบ";
  if (s === "approved") return "อนุมัติแล้ว";
  if (s === "rejected") return "ไม่อนุมัติ";
  if (s === "cancelled") return "ยกเลิก";
  return s;
};

const statusBadgeVariant = (s: string) => {
  if (s === "requested") return "warning";
  if (s === "approved") return "success";
  if (s === "rejected") return "default";
  if (s === "cancelled") return "default";
  return "default";
};

export default function TakeoversAdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permLoading } = usePermissions();
  const canView = can("tenant.view") || can("tenant.edit");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<TakeoverRow[]>([]);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from("room_takeover_requests")
      .select(
        "id,room_id,requester_full_name,requester_phone,status,created_at,rooms(room_number,buildings(name))"
      )
      .eq("status", "requested")
      .order("created_at", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setRequests([]);
      setLoading(false);
      return;
    }

    setRequests((data ?? []) as unknown as TakeoverRow[]);
    setLoading(false);
  }, [canView, supabase]);

  useEffect(() => {
    if (!permLoading && canView) void load();
  }, [permLoading, canView, load]);

  const approve = async (requestId: string) => {
    if (!can("tenant.edit")) {
      setError("คุณไม่มีสิทธิ์อนุมัติคำขอนี้");
      return;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const response = await fetch("/api/admin/takeovers/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "approve", requestId }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(dataJson?.error ?? "อนุมัติไม่สำเร็จ");
      return;
    }
    await load();
  };

  const reject = async (requestId: string) => {
    if (!can("tenant.edit")) {
      setError("คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้");
      return;
    }
    const note = window.prompt("หมายเหตุสำหรับการปฏิเสธ (ไม่บังคับ):") ?? null;

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const response = await fetch("/api/admin/takeovers/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "reject", requestId, adminNote: note }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(dataJson?.error ?? "ปฏิเสธไม่สำเร็จ");
      return;
    }
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          คำขอย้ายเข้าเมื่อห้องมีผู้เช่าอยู่แล้ว (อนุมัติ/ปฏิเสธโดยแอดมิน)
        </p>
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!permLoading && !canView && <p className="text-sm text-amber-800">ไม่มีสิทธิ์ดูข้อมูลนี้</p>}

      {canView && loading && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200/80 py-10 text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />
          กำลังโหลด…
        </div>
      )}

      {canView && !loading && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">สถานะ</th>
                <th className="px-4 py-3">ผู้ขอ</th>
                <th className="px-4 py-3">ห้อง / อาคาร</th>
                <th className="px-4 py-3">คำขอ</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    ไม่มีคำขอที่รอดำเนินการ
                  </td>
                </tr>
              ) : (
                requests.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100/90 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{row.requester_full_name}</div>
                      <div className="text-xs text-slate-500">{row.requester_phone}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3.5 w-3.5 text-slate-400" />
                        {row.rooms?.room_number ?? "—"} · {getBuildingName(row.rooms ?? null)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void approve(row.id)}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                        >
                          อนุมัติ
                        </button>
                        <button
                          type="button"
                          onClick={() => void reject(row.id)}
                          className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50"
                        >
                          ปฏิเสธ
                        </button>
                      </div>
                      <div className="mt-2 text-xs text-slate-500">
                        <ChevronRight className="inline-block h-3 w-3" />{" "}
                        {row.created_at ? new Date(row.created_at).toLocaleString("th-TH") : ""}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

