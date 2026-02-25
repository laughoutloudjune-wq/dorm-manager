"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
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

const statusVariant: Record<string, "success" | "default" | "warning"> = {
  occupied: "success",
  available: "default",
  maintenance: "warning",
};

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

  const [confirmStatusOpen, setConfirmStatusOpen] = useState(false);
  const [pendingRoom, setPendingRoom] = useState<RoomRecord | null>(null);

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

  const toggleStatus = async (room: RoomRecord) => {
    const order = ["occupied", "maintenance", "available"];
    const currentIndex = order.indexOf(room.status);
    const nextStatus = order[(currentIndex + 1) % order.length];

    try {
      await callRoomsAction("toggle_status", { roomId: room.id, status: nextStatus });
    } catch (error: any) {
      setStatus(error?.message ?? "Failed to update room status.");
      return;
    }

    setRooms((prev) =>
      prev.map((item) => (item.id === room.id ? { ...item, status: nextStatus } : item))
    );
      setStatus(`เปลี่ยนสถานะห้อง ${room.room_number} เป็น ${nextStatus} แล้ว`);
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
                <Badge variant={statusVariant[room.status] ?? "default"}>{room.status}</Badge>
              </div>
              <p className="mt-3 text-sm text-slate-500">{room.tenant_name ?? "Vacant"}</p>
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
              <span>ตั้งค่าห้อง</span>
              <button
                onClick={() => {
                  setPendingRoom(room);
                  setConfirmStatusOpen(true);
                }}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:border-blue-300"
              >
                <Settings2 size={12} />
                เปลี่ยนสถานะ
              </button>
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
          <div className="grid gap-4 md:grid-cols-2 text-sm text-slate-600">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">การเข้าพัก</p>
              <p className="text-lg font-semibold text-slate-900">{selectedRoom.tenant_name ?? "ว่าง"}</p>
              <p>อาคาร: {selectedRoom.building_name}</p>
              <p>สถานะ: {selectedRoom.status}</p>
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
              <button
                className="w-full rounded-xl border border-slate-200 px-4 py-2 text-slate-700 font-semibold"
                onClick={() => {
                  setPendingRoom(selectedRoom);
                  setConfirmStatusOpen(true);
                }}
              >
                เปลี่ยนสถานะห้อง
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmActionModal
        isOpen={confirmStatusOpen}
        title="อัปเดตสถานะห้อง"
        message={`เปลี่ยนสถานะของห้อง ${pendingRoom?.room_number ?? ""}?`}
        confirmLabel="ยืนยัน"
        onCancel={() => {
          setConfirmStatusOpen(false);
          setPendingRoom(null);
        }}
        onConfirm={async () => {
          if (!pendingRoom) return;
          await toggleStatus(pendingRoom);
          setConfirmStatusOpen(false);
          setPendingRoom(null);
        }}
      />
    </div>
  );
}
