"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, PageHeader, Tabs } from "@/components/ui/Page";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { createClient } from "@/lib/supabase-client";
import { Building2, DoorOpen, MessageCircle, Send, Settings2 } from "lucide-react";

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
      toast.error(fetchError.message);
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
      toast.error(error?.message ?? "อัปเดตสถานะห้องไม่สำเร็จ");
      return;
    }

    setRooms((prev) =>
      prev.map((item) => (item.id === room.id ? { ...item, status: nextStatus } : item))
    );
    setSelectedRoom((prev) => (prev && prev.id === room.id ? { ...prev, status: nextStatus } : prev));
    toast.success(`เปลี่ยนสถานะห้อง ${room.room_number} เป็น ${statusLabel(nextStatus)} แล้ว`);
  };

  const sendLineReminder = async (room: RoomRecord) => {
    if (!room.tenant_line_user_id) {
      toast.error("ผู้เช่ายังไม่ได้เชื่อม LINE");
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
      toast.error("ไม่พบใบแจ้งหนี้ของห้องนี้");
      return;
    }

    const invoice = latestInvoice as InvoiceRow;

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      toast.error("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
      return;
    }

    const response = await fetch("/api/send-invoice", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
      toast.error(detail || "ส่งแจ้งเตือน LINE ไม่สำเร็จ");
      return;
    }

    toast.success(`ส่งแจ้งเตือน LINE ไปห้อง ${room.room_number} แล้ว`);
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
      toast.error(error.message);
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
      <PageHeader
        description="สถานะห้องทั้งหมดแยกตามอาคาร"
        actions={
          buildings.length > 0 ? (
            <Tabs
              items={buildings.map((building) => ({ value: building, label: building }))}
              value={activeBuilding}
              onChange={setActiveBuilding}
            />
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filteredRooms.map((room) => {
          // A colored top edge, not a left border: the card is rounded on all
          // corners, and a left border fights the radius.
          const accent =
            room.status === "occupied"
              ? "bg-success-500"
              : room.status === "maintenance"
              ? "bg-warning-400"
              : "bg-slate-200";

          return (
            <Card key={room.id} className="overflow-hidden hover-float">
              <div className={`h-1 w-full ${accent}`} />
              <button
                className="w-full p-5 text-left focus:outline-none focus-visible:bg-slate-50"
                onClick={() => setSelectedRoom(room)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-2xl font-semibold tracking-tight text-slate-900">
                    {room.room_number}
                  </div>
                  <Badge variant={statusVariant[room.status] ?? "default"} dot>
                    {statusLabel(room.status)}
                  </Badge>
                </div>
                <p className="mt-2.5 text-sm text-slate-500">{room.tenant_name ?? "ว่าง"}</p>
                <div className="mt-4 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <Building2 size={14} />
                    {room.building_name}
                  </span>
                  {room.tenant_line_user_id && (
                    <Badge variant="success" size="sm">
                      <MessageCircle size={11} />
                      เชื่อม LINE
                    </Badge>
                  )}
                </div>
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-2.5 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Settings2 size={13} />
                  ตั้งค่าสถานะ
                </span>
                <Select
                  value={room.status}
                  onChange={(event) => void updateStatus(room, event.target.value)}
                  className="w-auto py-1 pl-2.5 pr-8 text-xs font-semibold"
                >
                  {roomStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </Card>
          );
        })}
      </div>

      {filteredRooms.length === 0 && (
        <Card>
          <EmptyState
            icon={<DoorOpen className="h-5 w-5" />}
            title="ไม่มีห้องพักในอาคารนี้"
            description="เลือกอาคารอื่น หรือเพิ่มห้องพักในหน้าตั้งค่า"
          />
        </Card>
      )}

      <Modal
        isOpen={!!selectedRoom}
        onClose={() => setSelectedRoom(null)}
        title={`รายละเอียดผู้เช่า - ห้อง ${selectedRoom?.room_number ?? ""}`}
        size="lg"
      >
        {selectedRoom && (
          <div className="space-y-5 text-sm text-slate-600">
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                  การเข้าพัก
                </p>
                <p className="text-lg font-semibold text-slate-900">
                  {selectedRoom.tenant_name ?? "ว่าง"}
                </p>
                <p>อาคาร: {selectedRoom.building_name}</p>
                <p>สถานะ: {statusLabel(selectedRoom.status)}</p>
                <p>LINE: {selectedRoom.tenant_line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}</p>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                  คำสั่งด่วน
                </p>
                <Button
                  fullWidth
                  icon={<Send size={16} />}
                  onClick={() => sendLineReminder(selectedRoom)}
                >
                  ส่งแจ้งเตือน LINE
                </Button>
                <Select
                  label="สถานะห้อง"
                  value={selectedRoom.status}
                  onChange={(event) => void updateStatus(selectedRoom, event.target.value)}
                >
                  {roomStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="overflow-hidden rounded-card border border-slate-200/70 bg-slate-50/60">
              <p className="border-b border-slate-200/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                ประวัติผู้เช่าห้องนี้
              </p>
              {movementLoading ? (
                <p className="px-4 py-5 text-sm text-slate-500">กำลังโหลดประวัติ...</p>
              ) : movementLogs.length === 0 ? (
                <EmptyState title="ยังไม่มีประวัติการเข้า-ออกของห้องนี้" className="py-8" />
              ) : (
                <div className="scrollbar-slim overflow-x-auto bg-white">
                  <Table>
                    <THead>
                      <tr>
                        <TH>ชื่อผู้เช่า</TH>
                        <TH>วันที่เข้าอยู่</TH>
                        <TH>วันที่ย้ายออก</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {movementLogs.map((log) => (
                        <TR key={log.id}>
                          <TD className="font-medium text-slate-900">{log.tenant_name}</TD>
                          <TD>
                            {log.move_in_date
                              ? new Date(log.move_in_date).toLocaleDateString("th-TH")
                              : "-"}
                          </TD>
                          <TD>
                            {log.move_out_date
                              ? new Date(log.move_out_date).toLocaleDateString("th-TH")
                              : "-"}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
