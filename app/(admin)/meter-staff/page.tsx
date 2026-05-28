"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Copy, Pencil, RefreshCw, Trash2, UserPlus } from "lucide-react";

type MeterStaffRow = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  staff_note: string | null;
  status: string;
  registered_via: string | null;
  source_channel: string | null;
  last_seen_at: string | null;
  first_seen_at: string | null;
  notify_payment: boolean;
  notify_move_out: boolean;
};

const statusLabel = (status: string) => (status === "active" ? "ใช้งานได้" : "ปิดการใช้งาน");

const formatThaiDateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("th-TH") : "—";

export default function MeterStaffPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can, loading: permLoading } = usePermissions();
  const canEdit = can("meter.edit");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [staff, setStaff] = useState<MeterStaffRow[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<MeterStaffRow | null>(null);
  const [form, setForm] = useState({
    line_user_id: "",
    display_name: "",
    staff_note: "",
    status: "active",
    notify_payment: false,
    notify_move_out: false,
  });

  const registerLiffUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/meter-staff/register`
      : "/meter-staff/register";

  const callAction = async (action: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");

    const response = await fetch("/api/admin/line-meter-users/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(dataJson?.error ?? "Request failed");
    return dataJson;
  };

  const loadStaff = useCallback(async () => {
    if (!canEdit) return;
    setLoading(true);
    setError(null);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      setLoading(false);
      return;
    }

    const response = await fetch("/api/admin/line-meter-users", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(json?.error ?? "โหลดรายชื่อไม่สำเร็จ");
      setStaff([]);
      setLoading(false);
      return;
    }

    setStaff((json?.users ?? []) as MeterStaffRow[]);
    setLoading(false);
  }, [canEdit, supabase]);

  useEffect(() => {
    if (!permLoading && canEdit) void loadStaff();
  }, [permLoading, canEdit, loadStaff]);

  const openCreate = () => {
    setEditing(null);
    setForm({ line_user_id: "", display_name: "", staff_note: "", status: "active", notify_payment: false, notify_move_out: false });
    setEditOpen(true);
  };

  const openEdit = (row: MeterStaffRow) => {
    setEditing(row);
    setForm({
      line_user_id: row.line_user_id,
      display_name: row.display_name ?? "",
      staff_note: row.staff_note ?? "",
      status: row.status,
      notify_payment: row.notify_payment ?? false,
      notify_move_out: row.notify_move_out ?? false,
    });
    setEditOpen(true);
  };

  const saveForm = async () => {
    try {
      await callAction("save", {
        id: editing?.id,
        lineUserId: form.line_user_id.trim(),
        displayName: form.display_name.trim() || null,
        staffNote: form.staff_note.trim() || null,
        status: form.status,
        notifyPayment: form.notify_payment,
        notifyMoveOut: form.notify_move_out,
      });
      setEditOpen(false);
      setMessage(editing ? "บันทึกการแก้ไขแล้ว" : "เพิ่มพนักงานแล้ว");
      await loadStaff();
    } catch (err: any) {
      setError(err?.message ?? "บันทึกไม่สำเร็จ");
    }
  };

  const toggleStatus = async (row: MeterStaffRow) => {
    const next = row.status === "active" ? "inactive" : "active";
    try {
      await callAction("set_status", { id: row.id, status: next });
      setMessage(next === "active" ? "เปิดใช้งานแล้ว" : "ปิดการใช้งานแล้ว");
      await loadStaff();
    } catch (err: any) {
      setError(err?.message ?? "อัปเดตสถานะไม่สำเร็จ");
    }
  };

  const deleteRow = async (row: MeterStaffRow) => {
    if (!window.confirm(`ลบ ${row.display_name ?? row.line_user_id} ออกจากระบบ?`)) return;
    try {
      await callAction("delete", { id: row.id });
      setMessage("ลบรายการแล้ว");
      await loadStaff();
    } catch (err: any) {
      setError(err?.message ?? "ลบไม่สำเร็จ");
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("คัดลอกแล้ว");
    } catch {
      setError("คัดลอกไม่สำเร็จ");
    }
  };

  const activeCount = staff.filter((row) => row.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-blue-100 bg-blue-50/80 p-4 text-sm text-blue-900">
        <p className="font-semibold">ลิงก์ให้พนักงานลงทะเบียน (LIFF)</p>
        <p className="mt-1 break-all">{registerLiffUrl}</p>
        <p className="mt-2 text-xs text-blue-800">
          ส่งลิงก์นี้ให้พนักงานเปิดใน LINE — ระบบจะเก็บ LINE User ID อัตโนมัติ ไม่ต้องอัปเดต
          LINE_METER_USER_IDS ใน Vercel อีก
        </p>
        <button
          type="button"
          onClick={() => void copyText(registerLiffUrl)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white"
        >
          <Copy className="h-3.5 w-3.5" />
          คัดลอกลิงก์
        </button>
      </div>

      {!permLoading && !canEdit && (
        <p className="text-sm text-amber-800">ไม่มีสิทธิ์จัดการพนักงานมิเตอร์ (ต้องมีสิทธิ meter.edit)</p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            พนักงานที่ใช้งานได้ <span className="font-semibold text-slate-900">{activeCount}</span> /{" "}
            {staff.length} คน
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadStaff()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              รีเฟรช
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white"
            >
              <UserPlus className="h-3.5 w-3.5" />
              เพิ่มด้วยมือ
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-emerald-700">{message}</p>}

      {canEdit && loading && (
        <p className="text-sm text-slate-500">กำลังโหลด...</p>
      )}

      {canEdit && !loading && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">สถานะ</th>
                <th className="px-4 py-3">ชื่อ</th>
                <th className="px-4 py-3">LINE User ID</th>
                <th className="px-4 py-3">หมายเหตุ</th>
                <th className="px-4 py-3 text-center">แจ้งชำระเงิน</th>
                <th className="px-4 py-3 text-center">แจ้งย้ายออก</th>
                <th className="px-4 py-3">เห็นล่าสุด</th>
                <th className="px-4 py-3 w-40">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {staff.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    ยังไม่มีพนักงาน — ส่งลิงก์ LIFF ให้พนักงานลงทะเบียน
                  </td>
                </tr>
              ) : (
                staff.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <Badge variant={row.status === "active" ? "success" : "default"}>
                        {statusLabel(row.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {row.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-slate-600">{row.line_user_id}</code>
                        <button
                          type="button"
                          onClick={() => void copyText(row.line_user_id)}
                          className="text-slate-400 hover:text-blue-600"
                          title="คัดลอก LINE ID"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.staff_note ?? "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {row.notify_payment
                        ? <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">✓</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {row.notify_move_out
                        ? <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">✓</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatThaiDateTime(row.last_seen_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-white"
                          title="แก้ไข"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleStatus(row)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-white"
                        >
                          {row.status === "active" ? "ปิด" : "เปิด"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRow(row)}
                          className="rounded-lg border border-red-200 p-1.5 text-red-600 hover:bg-red-50"
                          title="ลบ"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        title={editing ? "แก้ไขพนักงานมิเตอร์" : "เพิ่มพนักงานมิเตอร์"}
        size="md"
      >
        <div className="space-y-4 text-sm">
          <label className="block text-slate-600">
            LINE User ID
            <input
              value={form.line_user_id}
              onChange={(event) => setForm((prev) => ({ ...prev, line_user_id: event.target.value }))}
              disabled={Boolean(editing)}
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs disabled:bg-slate-100"
              placeholder="Uxxxxxxxx..."
            />
          </label>
          <label className="block text-slate-600">
            ชื่อที่แสดง
            <input
              value={form.display_name}
              onChange={(event) => setForm((prev) => ({ ...prev, display_name: event.target.value }))}
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-slate-600">
            หมายเหตุ
            <input
              value={form.staff_note}
              onChange={(event) => setForm((prev) => ({ ...prev, staff_note: event.target.value }))}
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-slate-600">
            สถานะ
            <select
              value={form.status}
              onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))}
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="active">ใช้งานได้</option>
              <option value="inactive">ปิดการใช้งาน</option>
            </select>
          </label>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">การแจ้งเตือน LINE</p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.notify_payment}
                onChange={(e) => setForm((prev) => ({ ...prev, notify_payment: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              <span className="text-sm text-slate-700">รับแจ้งเมื่อผู้เช่าอัปโหลดสลิปชำระเงิน</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.notify_move_out}
                onChange={(e) => setForm((prev) => ({ ...prev, notify_move_out: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              <span className="text-sm text-slate-700">รับแจ้งเมื่อผู้เช่าส่งคำขอย้ายออก</span>
            </label>
          </div>
          <button
            type="button"
            onClick={() => void saveForm()}
            className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white"
          >
            บันทึก
          </button>
        </div>
      </Modal>
    </div>
  );
}
