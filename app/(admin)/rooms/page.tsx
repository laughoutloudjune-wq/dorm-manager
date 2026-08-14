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
import { formatMoney, toNumber } from "@/lib/format";
import { statusLabelThai, statusPillClass } from "@/lib/invoice-utils";
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  DoorOpen,
  MessageCircle,
  Send,
  Settings2,
} from "lucide-react";

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
  tenant_id: string | null;
  tenant_name: string;
  move_in_date: string | null;
  move_out_date: string | null;
};

type TenantDetail = {
  id: string;
  room_id: string | null;
  full_name: string;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  line_user_id: string | null;
  status: string;
  move_in_date: string | null;
  move_out_date: string | null;
  lease_months: number | null;
  security_deposit_amount: number | null;
  advance_rent_amount: number | null;
  forfeit_security_deposit: boolean | null;
  initial_electricity_reading: number | null;
  initial_water_reading: number | null;
  final_electricity_reading: number | null;
  final_water_reading: number | null;
};

type TenantInvoiceRow = {
  id: string;
  issue_date: string;
  start_date: string | null;
  total_amount: number;
  paid_amount: number;
  status: string;
  public_token: string;
  notes: string | null;
};

type MoveOutRequestRow = {
  id: string;
  requested_move_out_date: string | null;
  approved_move_out_date: string | null;
  actual_move_out_date: string | null;
  status: string;
  request_note: string | null;
  admin_note: string | null;
  created_at: string;
};

type MoveOutSummary = {
  label: string;
  variant: "success" | "warning" | "danger" | "default" | "info";
  detail: string;
};

/**
 * How the tenancy ended isn't stored as its own column — it's implied by what
 * each move-out path wrote. `abandon_room` stamps "ทิ้งห้อง" on the invoices it
 * settles/cancels, `final_move_out` issues a "ย้ายออก (…)" closing invoice, and
 * a tenant who was only vacated (step 1 of the move-out flow) is inactive while
 * still holding a room_id. Read in that order.
 */
const summarizeMoveOut = (
  tenant: TenantDetail,
  invoices: TenantInvoiceRow[]
): MoveOutSummary => {
  if (tenant.status === "active") {
    return tenant.move_out_date
      ? {
          label: "แจ้งย้ายออกแล้ว",
          variant: "warning",
          detail: `ยังพักอยู่ กำหนดย้ายออก ${formatDate(tenant.move_out_date)}`,
        }
      : { label: "กำลังพักอาศัย", variant: "success", detail: "ยังไม่มีกำหนดย้ายออก" };
  }

  const notes = invoices.map((invoice) => invoice.notes ?? "");

  if (notes.some((note) => note.includes("ทิ้งห้อง"))) {
    return {
      label: "ทิ้งห้อง",
      variant: "danger",
      detail: tenant.forfeit_security_deposit
        ? "ปิดบัญชีด้วยการทิ้งห้อง และริบเงินประกัน"
        : "ปิดบัญชีด้วยการทิ้งห้อง (หักเครดิตกับบิลค้าง)",
    };
  }

  if (notes.some((note) => note.startsWith("ย้ายออก ("))) {
    return {
      label: "ย้ายออก - ปิดบัญชีแล้ว",
      variant: "default",
      detail: tenant.forfeit_security_deposit
        ? "ออกบิลปิดบัญชีแล้ว และริบเงินประกัน"
        : "ออกบิลปิดบัญชีแล้ว",
    };
  }

  if (tenant.room_id) {
    return {
      label: "ย้ายออกแล้ว - รอปิดบัญชี",
      variant: "warning",
      detail: "ปลดล็อกห้องแล้ว แต่ยังไม่ได้คิดค่าใช้จ่ายปิดบัญชี",
    };
  }

  return { label: "ย้ายออกแล้ว", variant: "default", detail: "ไม่มีบิลปิดบัญชีบันทึกไว้" };
};

const moveOutRequestStatusLabel = (status: string) => {
  if (status === "requested") return "รออนุมัติ";
  if (status === "approved") return "อนุมัติแล้ว";
  if (status === "rejected") return "ปฏิเสธ";
  if (status === "completed") return "ดำเนินการเสร็จสิ้น";
  if (status === "cancelled") return "ยกเลิก";
  return status;
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

const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("th-TH") : "-";

const tenantStatusLabel = (status: string) => {
  if (status === "active") return "กำลังพักอาศัย";
  if (status === "inactive") return "ย้ายออกแล้ว";
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
  // Drill-in: the room modal swaps to a past-tenant detail view rather than
  // stacking a second dialog (two <Modal>s share a z-index and an Esc handler).
  const [selectedLog, setSelectedLog] = useState<TenantMovementRow | null>(null);
  const [tenantDetail, setTenantDetail] = useState<TenantDetail | null>(null);
  const [tenantInvoices, setTenantInvoices] = useState<TenantInvoiceRow[]>([]);
  const [moveOutRequest, setMoveOutRequest] = useState<MoveOutRequestRow | null>(null);
  const [tenantLoading, setTenantLoading] = useState(false);

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
      .select("id,tenant_id,tenant_name,move_in_date,move_out_date")
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

  const openTenantDetail = async (log: TenantMovementRow) => {
    setSelectedLog(log);
    setTenantDetail(null);
    setTenantInvoices([]);
    setMoveOutRequest(null);
    // Legacy log rows carry only a name — there is no tenant record to load.
    if (!log.tenant_id) return;

    setTenantLoading(true);
    const [
      { data: tenant, error: tenantError },
      { data: invoices, error: invoiceError },
      { data: requests, error: requestError },
    ] = await Promise.all([
      supabase
        .from("tenants")
        .select(
          "id,room_id,full_name,phone_number,email,address,line_user_id,status,move_in_date,move_out_date,lease_months,security_deposit_amount,advance_rent_amount,forfeit_security_deposit,initial_electricity_reading,initial_water_reading,final_electricity_reading,final_water_reading"
        )
        .eq("id", log.tenant_id)
        .maybeSingle(),
      supabase
        .from("invoices")
        .select("id,issue_date,start_date,total_amount,paid_amount,status,public_token,notes")
        .eq("tenant_id", log.tenant_id)
        .order("issue_date", { ascending: false }),
      supabase
        .from("move_out_requests")
        .select(
          "id,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at"
        )
        .eq("tenant_id", log.tenant_id)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    if (tenantError || invoiceError || requestError) {
      toast.error(
        tenantError?.message ??
          invoiceError?.message ??
          requestError?.message ??
          "โหลดข้อมูลผู้เช่าไม่สำเร็จ"
      );
    }

    setTenantDetail((tenant as TenantDetail | null) ?? null);
    setTenantInvoices((invoices ?? []) as TenantInvoiceRow[]);
    setMoveOutRequest(((requests ?? [])[0] as MoveOutRequestRow | undefined) ?? null);
    setTenantLoading(false);
  };

  const closeRoomModal = () => {
    setSelectedRoom(null);
    setSelectedLog(null);
    setTenantDetail(null);
    setTenantInvoices([]);
    setMoveOutRequest(null);
  };

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
        onClose={closeRoomModal}
        title={
          selectedLog
            ? `ผู้เช่า ${selectedLog.tenant_name} - ห้อง ${selectedRoom?.room_number ?? ""}`
            : `รายละเอียดผู้เช่า - ห้อง ${selectedRoom?.room_number ?? ""}`
        }
        size="lg"
      >
        {selectedRoom && selectedLog && (
          <div className="space-y-5 text-sm text-slate-600">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft size={16} />}
              onClick={() => setSelectedLog(null)}
            >
              กลับไปรายละเอียดห้อง
            </Button>

            {tenantLoading ? (
              <p className="px-1 py-5 text-sm text-slate-500">กำลังโหลดข้อมูลผู้เช่า...</p>
            ) : (
              <>
                <div className="rounded-card border border-slate-200/70 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-lg font-semibold text-slate-900">
                      {tenantDetail?.full_name ?? selectedLog.tenant_name}
                    </p>
                    {tenantDetail && (
                      <Badge
                        variant={tenantDetail.status === "active" ? "success" : "default"}
                        dot
                      >
                        {tenantStatusLabel(tenantDetail.status)}
                      </Badge>
                    )}
                  </div>
                  <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    <DetailItem
                      label="วันที่เข้าอยู่"
                      value={formatDate(tenantDetail?.move_in_date ?? selectedLog.move_in_date)}
                    />
                    <DetailItem
                      label="วันที่ย้ายออก"
                      value={formatDate(tenantDetail?.move_out_date ?? selectedLog.move_out_date)}
                    />
                    {tenantDetail && (
                      <>
                        <DetailItem label="เบอร์โทร" value={tenantDetail.phone_number || "-"} />
                        <DetailItem label="อีเมล" value={tenantDetail.email || "-"} />
                        <DetailItem
                          label="ที่อยู่"
                          value={tenantDetail.address || "-"}
                          className="sm:col-span-2"
                        />
                        <DetailItem
                          label="LINE"
                          value={tenantDetail.line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}
                        />
                        <DetailItem
                          label="ระยะสัญญา"
                          value={
                            tenantDetail.lease_months ? `${tenantDetail.lease_months} เดือน` : "-"
                          }
                        />
                        <DetailItem
                          label="เงินประกัน"
                          value={`฿${formatMoney(toNumber(tenantDetail.security_deposit_amount))}${
                            tenantDetail.forfeit_security_deposit ? " (ยึดเงินประกัน)" : ""
                          }`}
                        />
                        <DetailItem
                          label="ค่าเช่าล่วงหน้า"
                          value={`฿${formatMoney(toNumber(tenantDetail.advance_rent_amount))}`}
                        />
                        <DetailItem
                          label="มิเตอร์ไฟ (เริ่ม → สิ้นสุด)"
                          value={`${toNumber(tenantDetail.initial_electricity_reading)} → ${
                            tenantDetail.final_electricity_reading === null
                              ? "-"
                              : toNumber(tenantDetail.final_electricity_reading)
                          }`}
                        />
                        <DetailItem
                          label="มิเตอร์น้ำ (เริ่ม → สิ้นสุด)"
                          value={`${toNumber(tenantDetail.initial_water_reading)} → ${
                            tenantDetail.final_water_reading === null
                              ? "-"
                              : toNumber(tenantDetail.final_water_reading)
                          }`}
                        />
                      </>
                    )}
                  </dl>
                  {!tenantDetail && (
                    <p className="mt-4 text-sm text-slate-500">
                      ประวัติรายการนี้ไม่ได้ผูกกับข้อมูลผู้เช่าในระบบแล้ว จึงแสดงได้เฉพาะชื่อและช่วงเวลาที่พัก
                    </p>
                  )}
                </div>

                {tenantDetail &&
                  (() => {
                    const summary = summarizeMoveOut(tenantDetail, tenantInvoices);
                    return (
                      <div className="rounded-card border border-slate-200/70 bg-white p-4 shadow-float">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                          การสิ้นสุดการเช่า
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge variant={summary.variant} dot>
                            {summary.label}
                          </Badge>
                          <span className="text-sm text-slate-600">{summary.detail}</span>
                        </div>
                        {moveOutRequest && (
                          <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
                            <DetailItem
                              label="คำขอย้ายออกจากผู้เช่า"
                              value={moveOutRequestStatusLabel(moveOutRequest.status)}
                            />
                            <DetailItem
                              label="วันที่ผู้เช่าแจ้ง"
                              value={formatDate(moveOutRequest.requested_move_out_date)}
                            />
                            <DetailItem
                              label="วันที่อนุมัติ"
                              value={formatDate(moveOutRequest.approved_move_out_date)}
                            />
                            <DetailItem
                              label="วันที่ย้ายออกจริง"
                              value={formatDate(moveOutRequest.actual_move_out_date)}
                            />
                            {moveOutRequest.request_note && (
                              <DetailItem
                                label="เหตุผลจากผู้เช่า"
                                value={moveOutRequest.request_note}
                                className="sm:col-span-2"
                              />
                            )}
                            {moveOutRequest.admin_note && (
                              <DetailItem
                                label="บันทึกของแอดมิน"
                                value={moveOutRequest.admin_note}
                                className="sm:col-span-2"
                              />
                            )}
                          </dl>
                        )}
                      </div>
                    );
                  })()}

                <div className="overflow-hidden rounded-card border border-slate-200/70 bg-slate-50/60">
                  <p className="border-b border-slate-200/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    บิลของผู้เช่ารายนี้
                  </p>
                  {tenantInvoices.length === 0 ? (
                    <EmptyState title="ไม่มีบิลของผู้เช่ารายนี้" className="py-8" />
                  ) : (
                    <div className="scrollbar-slim overflow-x-auto bg-white">
                      <Table>
                        <THead>
                          <tr>
                            <TH>รอบบิล</TH>
                            <TH>ยอดรวม</TH>
                            <TH>ชำระแล้ว</TH>
                            <TH>สถานะ</TH>
                            <TH> </TH>
                          </tr>
                        </THead>
                        <TBody>
                          {tenantInvoices.map((invoice) => (
                            <TR key={invoice.id}>
                              <TD className="font-medium text-slate-900">
                                {formatDate(invoice.start_date ?? invoice.issue_date)}
                                {invoice.notes ? (
                                  <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                    {invoice.notes}
                                  </span>
                                ) : null}
                              </TD>
                              <TD>฿{formatMoney(toNumber(invoice.total_amount))}</TD>
                              <TD>฿{formatMoney(toNumber(invoice.paid_amount))}</TD>
                              <TD>
                                <span
                                  className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusPillClass(
                                    invoice.status
                                  )}`}
                                >
                                  {statusLabelThai(invoice.status)}
                                </span>
                              </TD>
                              <TD className="text-right">
                                {/* The receipt endpoint 400s on anything unpaid. */}
                                {invoice.status === "paid" ? (
                                  <a
                                    className="text-xs font-semibold text-primary-600 hover:underline"
                                    href={`/api/receipt/${invoice.public_token}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    ดูใบเสร็จ
                                  </a>
                                ) : null}
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {selectedRoom && !selectedLog && (
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
                        <TH> </TH>
                      </tr>
                    </THead>
                    <TBody>
                      {movementLogs.map((log) => (
                        <TR
                          key={log.id}
                          className="cursor-pointer"
                          onClick={() => void openTenantDetail(log)}
                        >
                          <TD className="font-medium text-slate-900">{log.tenant_name}</TD>
                          <TD>{formatDate(log.move_in_date)}</TD>
                          <TD>{formatDate(log.move_out_date)}</TD>
                          <TD className="text-right text-slate-400">
                            <ChevronRight size={16} className="inline" />
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

function DetailItem({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
    </div>
  );
}
