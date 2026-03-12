"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { Building2, MessageCircle, Settings2 } from "lucide-react";

type RoomRecord = {
  id: string;
  room_number: string;
  status: string;
  building_name: string;
  tenant_name: string | null;
  tenant_line_user_id: string | null;
};

type InvoiceRow = {
  public_token: string;
  total_amount: number;
  issue_date: string;
};

type TenantMovementRow = {
  id: string;
  tenant_name: string;
  move_in_date: string | null;
  move_out_date: string | null;
};

const statusVariant: Record<string, "success" | "default" | "warning" | "info"> = {
  occupied: "success",
  available: "default",
  vacant: "default",
  maintenance: "warning",
  short_term: "info",
};

const statusLabel = (status: string) => {
  if (status === "occupied") return "มีผู้เช่า";
  if (status === "available" || status === "vacant") return "ว่าง";
  if (status === "maintenance") return "ซ่อมบำรุง";
  if (status === "short_term") return "ระยะสั้น";
  return status;
};

const roomStatusOptions = [
  { value: "available", label: "ว่าง" },
  { value: "occupied", label: "มีผู้เช่า" },
  { value: "maintenance", label: "ซ่อมบำรุง" },
  { value: "short_term", label: "ระยะสั้น" },
] as const;

function normalizeRoom(row: any): RoomRecord {
  const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings;
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;

  return {
    id: row.id,
    room_number: row.room_number,
    status: row.status,
    building_name: building?.name ?? "Unassigned",
    tenant_name: tenant?.full_name ?? null,
    tenant_line_user_id: tenant?.line_user_id ?? null,
  };
}

export default function RoomsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rooms, setRooms] = useState<RoomRecord[]>([]);
  const [buildings, setBuildings] = useState<string[]>([]);
  const [activeBuilding, setActiveBuilding] = useState<string>("");
  const [selectedRoom, setSelectedRoom] = useState<RoomRecord | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [movementLogs, setMovementLogs] = useState<TenantMovementRow[]>([]);
  const [movementLoading, setMovementLoading] = useState(false);

  const callRoomsAction = async (action: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session expired. Please log in again.");
    const response = await fetch("/api/admin/rooms/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(dataJson?.error ?? "Room action failed.");
    return dataJson;
  };

  const loadRooms = async () => {
    const { data, error: fetchError } = await supabase
      .from("rooms")
      .select("id,room_number,status,buildings(name),tenants(full_name,line_user_id)")
      .order("room_number");

    if (fetchError) {
      setStatus(fetchError.message);
      return;
    }

    const normalized = (data ?? []).map(normalizeRoom);
    setRooms(normalized);

    const uniqueBuildings = Array.from(new Set(normalized.map((room) => room.building_name)));
    setBuildings(uniqueBuildings);
    if (!activeBuilding && uniqueBuildings.length > 0) {
      setActiveBuilding(uniqueBuildings[0]);
    }
  };

  useEffect(() => {
    loadRooms();
  }, []);

  const updateStatus = async (room: RoomRecord, nextStatus: string) => {
    if (room.status === nextStatus) return;
    try {
      await callRoomsAction("toggle_status", { roomId: room.id, status: nextStatus });
    } catch (error: any) {
      setStatus(error?.message ?? "อัปเดตสถานะห้องไม่สำเร็จ");
      return;
    }

    setRooms((prev) =>
      prev.map((item) => (item.id === room.id ? { ...item, status: nextStatus } : item))
    );
    setSelectedRoom((prev) => (prev && prev.id === room.id ? { ...prev, status: nextStatus } : prev));
    setStatus(`เปลี่ยนสถานะห้อง ${room.room_number} เป็น ${statusLabel(nextStatus)} แล้ว`);
  };

  const sendLineReminder = async (room: RoomRecord) => {
    if (!room.tenant_line_user_id) {
      setStatus("ผู้เช่ายังไม่ได้เชื่อม LINE");
      return;
    }

    const { data: latestInvoice } = await supabase
      .from("invoices")
      .select("public_token,total_amount,issue_date")
      .eq("room_id", room.id)
      .order("issue_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestInvoice) {
      setStatus("ไม่พบใบแจ้งหนี้ของห้องนี้");
      return;
    }

    const invoice = latestInvoice as InvoiceRow;
    const response = await fetch("/api/send-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: room.tenant_line_user_id,
        roomNumber: room.room_number,
        month: new Date(invoice.issue_date).getMonth() + 1,
        year: new Date(invoice.issue_date).getFullYear(),
        total: invoice.total_amount,
        publicToken: invoice.public_token,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      const detail = [data?.error, data?.lineStatus && `LINE ${data.lineStatus}`, data?.lineMessage]
        .filter(Boolean)
        .join(" | ");
      setStatus(detail || "ส่งแจ้งเตือน LINE ไม่สำเร็จ");
      return;
    }

    setStatus(`ส่งแจ้งเตือน LINE ไปห้อง ${room.room_number} แล้ว`);
  };

  const filteredRooms = rooms.filter((room) => room.building_name === activeBuilding);

  const loadMovementLogs = async (roomId: string) => {
    setMovementLoading(true);
    const { data, error } = await supabase
      .from("room_tenant_logs")
      .select("id,tenant_name,move_in_date,move_out_date")
      .eq("room_id", roomId)
      .order("move_in_date", { ascending: false });

    if (error) {
      setStatus(error.message);
      setMovementLogs([]);
      setMovementLoading(false);
      return;
    }

    setMovementLogs((data ?? []) as TenantMovementRow[]);
    setMovementLoading(false);
  };

  useEffect(() => {
    if (!selectedRoom?.id) {
      setMovementLogs([]);
      return;
    }
    void loadMovementLogs(selectedRoom.id);
  }, [selectedRoom?.id]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {buildings.map((building) => (
          <button
            key={building}
            onClick={() => setActiveBuilding(building)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
              activeBuilding === building
                ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                : "bg-white text-slate-600 border border-slate-200 hover:border-blue-200"
            }`}
          >
            {building}
          </button>
        ))}
      </div>

      {status && <span className="text-sm text-slate-600">{status}</span>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filteredRooms.map((room) => (
          <Card
            key={room.id}
            className={`border-l-4 cursor-pointer hover:shadow-md transition ${
              room.status === "occupied"
                ? "border-green-500"
                : room.status === "maintenance"
                ? "border-yellow-400"
                : "border-slate-200"
            }`}
          >
            <button className="w-full text-left p-5" onClick={() => setSelectedRoom(room)}>
              <div className="flex items-center justify-between">
                <div className="text-3xl font-semibold text-slate-900">{room.room_number}</div>
                <Badge variant={statusVariant[room.status] ?? "default"}>{statusLabel(room.status)}</Badge>
              </div>
              <p className="mt-3 text-sm text-slate-500">{room.tenant_name ?? "ว่าง"}</p>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <Building2 size={14} />
                  {room.building_name}
                </span>
                {room.tenant_line_user_id && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-1 text-[10px] font-semibold text-green-700">
                    <MessageCircle size={12} />
                    เชื่อม LINE
                  </span>
                )}
              </div>
            </button>
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <Settings2 size={12} />
                ตั้งค่าสถานะ
              </span>
              <select
                value={room.status}
                onChange={(event) => void updateStatus(room, event.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
              >
                {roomStatusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        isOpen={!!selectedRoom}
        onClose={() => setSelectedRoom(null)}
        title={`รายละเอียดผู้เช่า - ห้อง ${selectedRoom?.room_number ?? ""}`}
        size="lg"
      >
        {selectedRoom && (
          <div className="space-y-4 text-sm text-slate-600">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">การเข้าพัก</p>
              <p className="text-lg font-semibold text-slate-900">{selectedRoom.tenant_name ?? "ว่าง"}</p>
              <p>อาคาร: {selectedRoom.building_name}</p>
              <p>สถานะ: {statusLabel(selectedRoom.status)}</p>
              <p>LINE: {selectedRoom.tenant_line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}</p>
              </div>
              <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">คำสั่งด่วน</p>
              <button
                className="w-full rounded-xl bg-blue-600 px-4 py-2 text-white font-semibold"
                onClick={() => sendLineReminder(selectedRoom)}
              >
                ส่งแจ้งเตือน LINE
              </button>
              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">สถานะห้อง</span>
                <select
                  value={selectedRoom.status}
                  onChange={(event) => void updateStatus(selectedRoom, event.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-slate-700 font-semibold"
                >
                  {roomStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">ประวัติผู้เช่าห้องนี้</p>
              {movementLoading ? (
                <p className="mt-3 text-sm text-slate-500">กำลังโหลดประวัติ...</p>
              ) : movementLogs.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">ยังไม่มีประวัติการเข้า-ออกของห้องนี้</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-700">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="px-2 py-1">ชื่อผู้เช่า</th>
                        <th className="px-2 py-1">วันที่เข้าอยู่</th>
                        <th className="px-2 py-1">วันที่ย้ายออก</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movementLogs.map((log) => (
                        <tr key={log.id} className="border-t border-slate-200">
                          <td className="px-2 py-1.5 font-medium text-slate-900">{log.tenant_name}</td>
                          <td className="px-2 py-1.5">
                            {log.move_in_date
                              ? new Date(log.move_in_date).toLocaleDateString("th-TH")
                              : "-"}
                          </td>
                          <td className="px-2 py-1.5">
                            {log.move_out_date
                              ? new Date(log.move_out_date).toLocaleDateString("th-TH")
                              : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
