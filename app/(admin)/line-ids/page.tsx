"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-client";

type MeterLineUser = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  last_event_type: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export default function LineIdsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<MeterLineUser[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadRows = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setStatus("Session expired. Please log in again.");
        return;
      }
      const response = await fetch("/api/admin/line-meter-users", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(json?.error ?? "โหลดข้อมูลไม่สำเร็จ");
        return;
      }
      setRows((json?.users ?? []) as MeterLineUser[]);
    } catch (error: any) {
      setStatus(error?.message ?? "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  const copyAllIds = async () => {
    const value = rows.map((row) => row.line_user_id).join(",");
    if (!value) {
      setStatus("ยังไม่มี LINE ID ในระบบ");
      return;
    }
    await navigator.clipboard.writeText(value);
    setStatus("คัดลอก LINE ID ทั้งหมดแล้ว");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Meter Employee LINE IDs</h2>
        <p className="mt-1 text-sm text-slate-500">
          เก็บจาก webhook `/api/line/webhook-meter` เมื่อพนักงานทัก OA ที่ใช้สำหรับ meter
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void loadRows()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
        >
          รีเฟรช
        </button>
        <button
          type="button"
          onClick={() => void copyAllIds()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
        >
          คัดลอกทั้งหมด (สำหรับ LINE_METER_USER_IDS)
        </button>
      </div>

      {status && <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">{status}</div>}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
          รายการพนักงาน ({rows.length})
        </div>
        {loading ? (
          <div className="px-4 py-8 text-sm text-slate-500">กำลังโหลด...</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-slate-500">ยังไม่มีข้อมูล LINE ID จาก webhook</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">ชื่อ LINE</th>
                  <th className="px-3 py-2">LINE User ID</th>
                  <th className="px-3 py-2">อีเวนต์ล่าสุด</th>
                  <th className="px-3 py-2">ครั้งแรก</th>
                  <th className="px-3 py-2">ล่าสุด</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {row.picture_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={row.picture_url} alt={row.display_name ?? "LINE"} className="h-7 w-7 rounded-full" />
                        )}
                        <span>{row.display_name ?? "-"}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{row.line_user_id}</td>
                    <td className="px-3 py-2">{row.last_event_type ?? "-"}</td>
                    <td className="px-3 py-2">{row.first_seen_at ? new Date(row.first_seen_at).toLocaleString("th-TH") : "-"}</td>
                    <td className="px-3 py-2">{row.last_seen_at ? new Date(row.last_seen_at).toLocaleString("th-TH") : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

