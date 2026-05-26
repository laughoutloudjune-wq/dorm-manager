"use client";

import { getInvoiceOutstanding } from "@/lib/invoice-ledger";
import { bangkokYmd, meets30DayMoveOutNotice } from "@/lib/move-out-notice";
import { useEffect, useMemo, useRef, useState } from "react";
import { TenantEditorModal } from "@/components/admin/tenant-editor-modal";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { Loader2, Plus, Printer, Save, Search, Trash2, Upload } from "lucide-react";

type TenantRow = {
  id: string;
  full_name: string;
  address: string | null;
  phone_number: string | null;
  line_user_id: string | null;
  move_in_date: string;
  move_out_date: string | null;
  status: string;
  room_id: string;
  lease_months: number | null;
  initial_electricity_reading: number | null;
  initial_water_reading: number | null;
  advance_rent_amount: number | null;
  security_deposit_amount: number | null;
  deposit_slip_url: string | null;
  final_electricity_reading: number | null;
  final_water_reading: number | null;
  forfeit_security_deposit: boolean | null;
  custom_payment_method: any;
  custom_receipt_profile: any;
  rooms:
    | { room_number: string; price_month: number | null; buildings: { name: string }[] | null }
    | { room_number: string; price_month: number | null; buildings: { name: string }[] | null }[]
    | null;
};

type RoomRow = {
  id: string;
  room_number: string;
  price_month: number | null;
  buildings: { name: string }[] | { name: string } | null;
};

type PaymentMethod = {
  id: string;
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

type ReceiptProfile = {
  id: string;
  label: string;
  company_name: string;
  tax_id: string | null;
  branch: string | null;
  address: string;
};

type MoveOutRequestRow = {
  id: string;
  tenant_id: string;
  notice_date: string | null;
  requested_move_out_date: string;
  approved_move_out_date: string | null;
  actual_move_out_date: string | null;
  status: string;
  request_note: string | null;
  admin_note: string | null;
  created_at: string | null;
};

type SettingsRates = {
  water_rate: number;
  electricity_rate: number;
};

type MoveOutFeeLine = {
  id: string;
  label: string;
  amount: number;
};

type TenantInvoiceHistoryRow = {
  id: string;
  start_date: string;
  end_date: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
  payment_history: any[];
  created_at: string | null;
};

type TransferCalcForm = {
  transfer_date: string;
  old_prev_electricity: number;
  old_curr_electricity: number;
  old_prev_water: number;
  old_curr_water: number;
  new_curr_electricity: number;
  new_curr_water: number;
};

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const roundTo2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const ymdToLocalDate = (ymd: string) => {
  const p = String(ymd).slice(0, 10).split("-");
  if (p.length < 3) return new Date(NaN);
  const y = parseInt(p[0] ?? "0", 10);
  const m = parseInt(p[1] ?? "1", 10);
  const d = parseInt(p[2] ?? "1", 10);
  return new Date(y, m - 1, d);
};

const formatMoney = (value: number) =>
  value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const createMoveOutFeeLine = (): MoveOutFeeLine => ({
  id: crypto.randomUUID(),
  label: "",
  amount: 0,
});

const parseDepositSlipUrls = (value: string | null | undefined): string[] => {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
};

const serializeDepositSlipUrls = (urls: string[]) => {
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  return JSON.stringify(urls);
};

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const roomLabel = (room: RoomRow) => {
  const building = Array.isArray(room.buildings)
    ? room.buildings[0]?.name
    : room.buildings?.name;
  return `${room.room_number}${building ? ` (${building})` : ""}`;
};

const tenantRoomNumber = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  return roomRel?.room_number ?? roomsById.get(tenant.room_id)?.room_number ?? "-";
};

const tenantRoomPrice = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  return toNumber(roomRel?.price_month ?? roomsById.get(tenant.room_id)?.price_month ?? 0);
};

const tenantBuildingName = (tenant: TenantRow, roomsById: Map<string, RoomRow>) => {
  const roomRel = Array.isArray(tenant.rooms) ? tenant.rooms[0] : tenant.rooms;
  if (roomRel?.buildings && Array.isArray(roomRel.buildings) && roomRel.buildings.length > 0) {
    return roomRel.buildings[0]?.name ?? "ไม่ระบุอาคาร";
  }
  const room = roomsById.get(tenant.room_id);
  if (!room?.buildings) return "ไม่ระบุอาคาร";
  if (Array.isArray(room.buildings)) return room.buildings[0]?.name ?? "ไม่ระบุอาคาร";
  return room.buildings.name ?? "ไม่ระบุอาคาร";
};

const leaseEndDateText = (moveInDate: string, leaseMonths: number) => {
  const start = new Date(moveInDate);
  const end = new Date(start);
  end.setMonth(end.getMonth() + leaseMonths);
  return end.toISOString().slice(0, 10);
};

const calculateTransferRentProration = (
  transferDate: string,
  moveInDate: string | null | undefined,
  oldRoomRate: number,
  newRoomRate: number
) => {
  if (!transferDate) {
    return {
      billingStartDay: 1,
      transferDay: 1,
      daysInMonth: 30,
      oldRoomDays: 0,
      newRoomDays: 30,
      oldRentAmount: 0,
      newRentAmount: newRoomRate,
    };
  }

  const transferDateObj = new Date(transferDate);
  const transferYear = transferDateObj.getFullYear();
  const transferMonth = transferDateObj.getMonth();
  const periodStart = new Date(transferYear, transferMonth, 1);
  const periodEnd = new Date(transferYear, transferMonth + 1, 0);
  const daysInMonth = periodEnd.getDate();
  const billingStart = moveInDate ? new Date(moveInDate) : periodStart;
  const effectiveBillingStart = billingStart > periodStart ? billingStart : periodStart;
  const effectiveTransferDate = transferDateObj > effectiveBillingStart ? transferDateObj : effectiveBillingStart;
  const oldRoomDays =
    effectiveTransferDate > effectiveBillingStart
      ? Math.floor(
          (new Date(
            effectiveTransferDate.getFullYear(),
            effectiveTransferDate.getMonth(),
            effectiveTransferDate.getDate() - 1
          ).getTime() -
            effectiveBillingStart.getTime()) /
            86400000
        ) + 1
      : 0;
  const newRoomDays =
    periodEnd >= effectiveTransferDate
      ? Math.floor((periodEnd.getTime() - effectiveTransferDate.getTime()) / 86400000) + 1
      : 0;
  const dailyOldRate = oldRoomRate / 30;
  const dailyNewRate = newRoomRate / 30;

  return {
    billingStartDay: effectiveBillingStart.getDate(),
    transferDay: effectiveTransferDate.getDate(),
    daysInMonth,
    oldRoomDays,
    newRoomDays,
    oldRentAmount: roundTo2(dailyOldRate * oldRoomDays),
    newRentAmount: roundTo2(dailyNewRate * newRoomDays),
  };
};

const tenantStatusLabel = (status: string) => {
  if (status === "active") return "ใช้งานอยู่";
  if (status === "inactive") return "ย้ายออกแล้ว";
  return status;
};

const sanitizeStorageFileName = (fileName: string) => {
  const extensionIndex = fileName.lastIndexOf(".");
  const rawBase = extensionIndex >= 0 ? fileName.slice(0, extensionIndex) : fileName;
  const rawExtension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
  const safeBase = rawBase
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const safeExtension = rawExtension.replace(/[^.a-z0-9]/g, "");
  return `${safeBase || "upload"}${safeExtension}`;
};

const tenantPaymentMethodLabel = (tenant: TenantRow) => {
  const method = tenant.custom_payment_method;
  if (!method) return "-";
  if (typeof method === "string") return method;
  return method.label ?? method.type ?? "-";
};

const findExistingActiveTenantInRoom = (
  tenants: TenantRow[],
  roomId: string,
  currentTenantId?: string | null
) =>
  tenants.find(
    (tenant) =>
      tenant.room_id === roomId &&
      tenant.status === "active" &&
      tenant.id !== (currentTenantId ?? "")
  ) ?? null;

export default function TenantsPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusTenantId = searchParams.get("focusTenant");
  const focusTabParam = searchParams.get("tab");
  const focusOpenedRef = useRef<string | null>(null);
  const { can } = usePermissions();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [receiptProfiles, setReceiptProfiles] = useState<ReceiptProfile[]>([]);
  const [rates, setRates] = useState<SettingsRates>({ water_rate: 0, electricity_rate: 0 });
  const [search, setSearch] = useState("");
  const [buildingFilter, setBuildingFilter] = useState("all");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTenant, setActiveTenant] = useState<TenantRow | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "move_in" | "move_out" | "payments">("info");
  const [useCustomPayment, setUseCustomPayment] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string>("");
  const [useCustomReceipt, setUseCustomReceipt] = useState(false);
  const [selectedReceiptProfileId, setSelectedReceiptProfileId] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [latestPrevElectricity, setLatestPrevElectricity] = useState(0);
  const [latestPrevWater, setLatestPrevWater] = useState(0);
  const [moveOutFeeLines, setMoveOutFeeLines] = useState<MoveOutFeeLine[]>([]);
  const [moveOutRequests, setMoveOutRequests] = useState<MoveOutRequestRow[]>([]);
  const [activeMoveOutRequest, setActiveMoveOutRequest] = useState<MoveOutRequestRow | null>(null);
  const [forfeitDeposit, setForfeitDeposit] = useState(false);
  const [tenantInvoiceHistory, setTenantInvoiceHistory] = useState<TenantInvoiceHistoryRow[]>([]);
  const [paymentHistoryMonth, setPaymentHistoryMonth] = useState("all");

  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);
  const [confirmCancelMoveOutOpen, setConfirmCancelMoveOutOpen] = useState(false);
  const [isCancellingMoveOut, setIsCancellingMoveOut] = useState(false);
  const [useProrate, setUseProrate] = useState(true);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [isSavingTenant, setIsSavingTenant] = useState(false);
  const [isDeletingTenant, setIsDeletingTenant] = useState(false);
  const [isUnlinkingLine, setIsUnlinkingLine] = useState(false);
  const [isMovingOut, setIsMovingOut] = useState(false);
  const [isUploadingDepositSlip, setIsUploadingDepositSlip] = useState(false);
  const [depositSlipUrls, setDepositSlipUrls] = useState<string[]>([]);
  const [transferCalc, setTransferCalc] = useState<TransferCalcForm>({
    transfer_date: new Date().toISOString().slice(0, 10),
    old_prev_electricity: 0,
    old_curr_electricity: 0,
    old_prev_water: 0,
    old_curr_water: 0,
    new_curr_electricity: 0,
    new_curr_water: 0,
  });
  const canViewTenants = can("tenant.view");
  const canEditTenant = can("tenant.edit");
  const canManageTenantLine = can("tenant.line.manage");

  const callTenantsAction = async (action: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    const response = await fetch("/api/admin/tenants/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(dataJson?.error ?? "ดำเนินการข้อมูลผู้เช่าไม่สำเร็จ");
    return dataJson;
  };

  const [form, setForm] = useState({
    full_name: "",
    address: "",
    phone_number: "",
    room_id: "",
    move_in_date: "",
    status: "active",
    lease_months: 12,
    initial_electricity_reading: 0,
    initial_water_reading: 0,
    advance_rent_amount: 0,
    security_deposit_amount: 0,
    deposit_slip_url: "",
    final_electricity_reading: 0,
    final_water_reading: 0,
    move_out_request_date: "",
    final_move_out_date: "",
  });

  const loadTenants = async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
      )
      .order("move_in_date", { ascending: false });

    if (error) {
      setStatus(error.message);
      return;
    }

    setTenants((data ?? []) as TenantRow[]);
  };

  const loadRooms = async () => {
    const { data } = await supabase
      .from("rooms")
      .select("id,room_number,price_month,buildings(name)")
      .order("room_number");
    const sorted = ((data ?? []) as RoomRow[]).sort((a, b) => {
      const aBuilding = Array.isArray(a.buildings) ? a.buildings[0]?.name ?? "" : a.buildings?.name ?? "";
      const bBuilding = Array.isArray(b.buildings) ? b.buildings[0]?.name ?? "" : b.buildings?.name ?? "";
      const byBuilding = aBuilding.localeCompare(bBuilding, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (byBuilding !== 0) return byBuilding;
      return roomNumberCompare(a.room_number, b.room_number);
    });
    setRooms(sorted);
  };

  const loadMethods = async () => {
    const { data } = await supabase
      .from("payment_methods")
      .select("id,label,bank_name,account_name,account_number,qr_url")
      .order("label", { ascending: true });
    setMethods((data ?? []) as PaymentMethod[]);
  };

  const loadReceiptProfiles = async () => {
    const { data } = await supabase
      .from("receipt_profiles")
      .select("id,label,company_name,tax_id,branch,address")
      .order("label", { ascending: true });
    setReceiptProfiles((data ?? []) as ReceiptProfile[]);
  };

  const loadRates = async () => {
    const { data } = await supabase
      .from("settings")
      .select("water_rate,electricity_rate")
      .eq("id", 1)
      .maybeSingle();
    if (data) {
      setRates({
        water_rate: toNumber((data as any).water_rate),
        electricity_rate: toNumber((data as any).electricity_rate),
      });
    }
  };

  const loadMoveOutRequests = async () => {
    const { data, error } = await supabase
      .from("move_out_requests")
      .select(
        "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at"
      )
      .in("status", ["requested", "approved"])
      .order("created_at", { ascending: false });

    if (error) {
      setStatus(error.message);
      return;
    }

    setMoveOutRequests((data ?? []) as MoveOutRequestRow[]);
  };

  useEffect(() => {
    let mounted = true;
    const loadAll = async () => {
      setIsPageLoading(true);
      await Promise.all([
        loadTenants(),
        loadRooms(),
        loadMethods(),
        loadReceiptProfiles(),
        loadRates(),
        loadMoveOutRequests(),
      ]);
      if (mounted) setIsPageLoading(false);
    };
    void loadAll();
    return () => {
      mounted = false;
    };
  }, []);

  const loadLatestReadings = async (roomId: string, fallbackElectric: number, fallbackWater: number) => {
    if (!roomId) {
      setLatestPrevElectricity(fallbackElectric);
      setLatestPrevWater(fallbackWater);
      return;
    }

    const { data } = await supabase
      .from("meter_readings")
      .select("current_electricity,current_water")
      .eq("room_id", roomId)
      .order("reading_month", { ascending: false })
      .limit(1)
      .maybeSingle();

    setLatestPrevElectricity(toNumber((data as any)?.current_electricity ?? fallbackElectric));
    setLatestPrevWater(toNumber((data as any)?.current_water ?? fallbackWater));
  };

  const loadTenantInvoiceHistory = async (tenantId: string) => {
    const { data, error } = await supabase
      .from("invoices")
      .select("id,start_date,end_date,total_amount,paid_amount,status,slip_url,slip_uploaded_at,payment_history,created_at")
      .eq("tenant_id", tenantId)
      .order("start_date", { ascending: false });

    if (error) {
      setStatus(error.message);
      setTenantInvoiceHistory([]);
      return;
    }

    setTenantInvoiceHistory((data ?? []) as TenantInvoiceHistoryRow[]);
  };

  const loadLatestRoomReadings = async (roomId: string) => {
    if (!roomId) return { electricity: 0, water: 0 };
    const { data } = await supabase
      .from("meter_readings")
      .select("current_electricity,current_water")
      .eq("room_id", roomId)
      .order("reading_month", { ascending: false })
      .limit(1)
      .maybeSingle();
    return {
      electricity: toNumber((data as any)?.current_electricity ?? 0),
      water: toNumber((data as any)?.current_water ?? 0),
    };
  };

  useEffect(() => {
    if (!activeTenant || !form.room_id || form.room_id === activeTenant.room_id) return;
    let mounted = true;
    const fillTransferBaselines = async () => {
      const nextRoomReadings = await loadLatestRoomReadings(form.room_id);
      if (!mounted) return;
      setTransferCalc((prev) => ({
        ...prev,
        old_prev_electricity:
          prev.old_prev_electricity > 0 ? prev.old_prev_electricity : latestPrevElectricity,
        old_prev_water: prev.old_prev_water > 0 ? prev.old_prev_water : latestPrevWater,
        new_curr_electricity:
          prev.new_curr_electricity > 0 ? prev.new_curr_electricity : nextRoomReadings.electricity,
        new_curr_water: prev.new_curr_water > 0 ? prev.new_curr_water : nextRoomReadings.water,
      }));
    };
    void fillTransferBaselines();
    return () => {
      mounted = false;
    };
  }, [activeTenant, form.room_id, latestPrevElectricity, latestPrevWater]);

  const openModal = async (
    tenant?: TenantRow,
    initialTab: "info" | "move_in" | "move_out" | "payments" = "info"
  ) => {
    setActiveTab(initialTab);
    if (tenant) {
      const request = activeMoveOutRequestByTenantId.get(String(tenant.id)) ?? null;
      const moveOutRequestDate = request?.requested_move_out_date ?? null;
      const approvedMoveOutDate = request?.approved_move_out_date ?? null;
      setActiveMoveOutRequest(request);
      setActiveTenant(tenant);
      setForfeitDeposit(Boolean(tenant.forfeit_security_deposit));
      setForm({
        full_name: tenant.full_name,
        address: tenant.address ?? "",
        phone_number: tenant.phone_number ?? "",
        room_id: tenant.room_id,
        move_in_date: tenant.move_in_date,
        status: tenant.status,
        lease_months: toNumber(tenant.lease_months ?? 12),
        initial_electricity_reading: toNumber(tenant.initial_electricity_reading ?? 0),
        initial_water_reading: toNumber(tenant.initial_water_reading ?? 0),
        advance_rent_amount: toNumber(tenant.advance_rent_amount ?? 0),
        security_deposit_amount: toNumber(tenant.security_deposit_amount ?? 0),
        deposit_slip_url: tenant.deposit_slip_url ?? "",
        final_electricity_reading: toNumber(tenant.final_electricity_reading ?? 0),
        final_water_reading: toNumber(tenant.final_water_reading ?? 0),
        move_out_request_date:
          moveOutRequestDate ?? new Date().toISOString().slice(0, 10),
        final_move_out_date:
          tenant.move_out_date ??
          approvedMoveOutDate ??
          moveOutRequestDate ??
          new Date().toISOString().slice(0, 10),
      });
      setDepositSlipUrls(parseDepositSlipUrls(tenant.deposit_slip_url));
      setMoveOutFeeLines([]);
      setUseProrate(true);
      setTransferCalc({
        transfer_date: new Date().toISOString().slice(0, 10),
        old_prev_electricity: 0,
        old_curr_electricity: 0,
        old_prev_water: 0,
        old_curr_water: 0,
        new_curr_electricity: 0,
        new_curr_water: 0,
      });
      const custom = tenant.custom_payment_method;
      if (custom?.methodId) {
        setUseCustomPayment(true);
        setSelectedMethodId(custom.methodId);
      } else {
        setUseCustomPayment(false);
        setSelectedMethodId("");
      }
      const customReceipt = tenant.custom_receipt_profile;
      if (customReceipt?.profileId) {
        setUseCustomReceipt(true);
        setSelectedReceiptProfileId(customReceipt.profileId);
      } else {
        setUseCustomReceipt(false);
        setSelectedReceiptProfileId("");
      }

      await loadLatestReadings(
        tenant.room_id,
        toNumber(tenant.initial_electricity_reading ?? 0),
        toNumber(tenant.initial_water_reading ?? 0)
      );
      await loadTenantInvoiceHistory(tenant.id);
      setPaymentHistoryMonth("all");
    } else {
      setActiveTenant(null);
      setActiveMoveOutRequest(null);
      setForfeitDeposit(false);
      setForm({
        full_name: "",
        address: "",
        phone_number: "",
        room_id: "",
        move_in_date: new Date().toISOString().slice(0, 10),
        status: "active",
        lease_months: 12,
        initial_electricity_reading: 0,
        initial_water_reading: 0,
        advance_rent_amount: 0,
        security_deposit_amount: 0,
        deposit_slip_url: "",
        final_electricity_reading: 0,
        final_water_reading: 0,
        move_out_request_date: new Date().toISOString().slice(0, 10),
        final_move_out_date: new Date().toISOString().slice(0, 10),
      });
      setDepositSlipUrls([]);
      setMoveOutFeeLines([]);
      setUseProrate(true);
      setTransferCalc({
        transfer_date: new Date().toISOString().slice(0, 10),
        old_prev_electricity: 0,
        old_curr_electricity: 0,
        old_prev_water: 0,
        old_curr_water: 0,
        new_curr_electricity: 0,
        new_curr_water: 0,
      });
      setUseCustomPayment(false);
      setSelectedMethodId("");
      setUseCustomReceipt(false);
      setSelectedReceiptProfileId("");
      setLatestPrevElectricity(0);
      setLatestPrevWater(0);
      setTenantInvoiceHistory([]);
      setPaymentHistoryMonth("all");
    }

    setIsModalOpen(true);
  };

  useEffect(() => {
    if (!focusTenantId) {
      focusOpenedRef.current = null;
      return;
    }
    if (isPageLoading || !canViewTenants) return;
    if (focusOpenedRef.current === focusTenantId) return;
    const tenant = tenants.find((t) => String(t.id) === String(focusTenantId));
    if (!tenant) return;
    focusOpenedRef.current = focusTenantId;
    const tab = focusTabParam === "move_out" ? "move_out" : "info";
    void openModal(tenant, tab);
    router.replace("/tenants", { scroll: false });
    // openModal is stable enough for this one-shot deep link; ref prevents duplicate opens.
  }, [focusTenantId, focusTabParam, isPageLoading, canViewTenants, tenants, router]);

  const uploadDepositSlip = async (file?: File | null) => {
    if (!file) return;
    setIsUploadingDepositSlip(true);
    const tenantId = activeTenant?.id ?? crypto.randomUUID();
    const safeFileName = sanitizeStorageFileName(file.name);
    const path = `tenant-docs/${tenantId}/${Date.now()}-${safeFileName}`;

    const { error } = await supabase.storage.from("tenant-docs").upload(path, file, { upsert: true });
    if (error) {
      setStatus(error.message);
      setIsUploadingDepositSlip(false);
      return;
    }

    const { data } = supabase.storage.from("tenant-docs").getPublicUrl(path);
    setDepositSlipUrls((prev) => {
      if (prev.includes(data.publicUrl)) return prev;
      return [...prev, data.publicUrl];
    });
    setStatus("อัปโหลดสลิปมัดจำเรียบร้อย");
    setIsUploadingDepositSlip(false);
  };

  const removeDepositSlip = (url: string) => {
    setDepositSlipUrls((prev) => prev.filter((item) => item !== url));
  };

  const logRoomEvent = async (roomId: string, eventType: "move_in" | "move_out") => {
    const { error } = await supabase.from("room_logs").insert({
      room_id: roomId,
      event_type: eventType,
      created_at: new Date().toISOString(),
    });
    if (error) {
      setStatus(`บันทึกผู้เช่าแล้ว แต่บันทึกประวัติห้องไม่สำเร็จ: ${error.message}`);
    }
  };

  const saveTenant = async () => {
    if (existingTenantInSelectedRoom) {
      setStatus(`ห้องนี้มีผู้เช่าอยู่แล้ว: ${existingTenantInSelectedRoom.full_name}`);
      return;
    }
    setIsSavingTenant(true);
    const selectedMethod = methods.find((method) => method.id === selectedMethodId);
    const customPayment =
      useCustomPayment && selectedMethod
        ? {
            type: selectedMethod.qr_url ? "qr" : "bank",
            methodId: selectedMethod.id,
            label: selectedMethod.label,
            bank_name: selectedMethod.bank_name,
            account_name: selectedMethod.account_name,
            account_number: selectedMethod.account_number,
            qr_url: selectedMethod.qr_url,
          }
        : null;
    const selectedReceiptProfile = receiptProfiles.find(
      (profile) => profile.id === selectedReceiptProfileId
    );
    const customReceipt =
      useCustomReceipt && selectedReceiptProfile
        ? {
            profileId: selectedReceiptProfile.id,
            label: selectedReceiptProfile.label,
            company_name: selectedReceiptProfile.company_name,
            tax_id: selectedReceiptProfile.tax_id,
            branch: selectedReceiptProfile.branch,
            address: selectedReceiptProfile.address,
          }
        : null;

    const payload: any = {
      full_name: form.full_name,
      address: form.address || null,
      phone_number: form.phone_number || null,
      room_id: form.room_id,
      move_in_date: form.move_in_date || new Date().toISOString().slice(0, 10),
      move_out_date: form.final_move_out_date || null,
      status: form.status,
      lease_months: toNumber(form.lease_months),
      initial_electricity_reading: toNumber(form.initial_electricity_reading),
      initial_water_reading: toNumber(form.initial_water_reading),
      advance_rent_amount: toNumber(form.advance_rent_amount),
      security_deposit_amount: toNumber(form.security_deposit_amount),
      deposit_slip_url: serializeDepositSlipUrls(depositSlipUrls),
      final_electricity_reading: toNumber(form.final_electricity_reading),
      final_water_reading: toNumber(form.final_water_reading),
      forfeit_security_deposit: forfeitDeposit,
      custom_payment_method: customPayment,
      custom_receipt_profile: customReceipt,
    };

    const transferPayload =
      isRoomTransfer && activeTenant
        ? {
            tenant_id: activeTenant.id,
            from_room_id: activeTenant.room_id,
            to_room_id: form.room_id,
            transfer_date: transferCalc.transfer_date || new Date().toISOString().slice(0, 10),
            billing_month: `${(transferCalc.transfer_date || new Date().toISOString().slice(0, 10)).slice(0, 7)}-01`,
            old_prev_electricity: toNumber(transferCalc.old_prev_electricity),
            old_curr_electricity: toNumber(transferCalc.old_curr_electricity),
            old_prev_water: toNumber(transferCalc.old_prev_water),
            old_curr_water: toNumber(transferCalc.old_curr_water),
            new_prev_electricity: toNumber(transferCalc.new_curr_electricity),
            new_curr_electricity: toNumber(transferCalc.new_curr_electricity),
            new_prev_water: toNumber(transferCalc.new_curr_water),
            new_curr_water: toNumber(transferCalc.new_curr_water),
            old_electric_usage: transferOldElectricUsage,
            old_water_usage: transferOldWaterUsage,
            old_rent_amount: transferOldRent,
            new_rent_amount: transferNewRent,
          }
        : null;

    if (activeTenant?.id) payload.id = activeTenant.id;

    try {
      await callTenantsAction("save_tenant", {
        payload,
        roomId: form.room_id || null,
        transferPayload,
      });
    } catch (error: any) {
      setStatus(error?.message ?? "บันทึกข้อมูลผู้เช่าไม่สำเร็จ");
      setIsSavingTenant(false);
      return;
    }

    await loadTenants();
    setStatus("บันทึกข้อมูลผู้เช่าเรียบร้อย");
    if (activeTenant?.id) {
      const { data: refreshed } = await supabase
        .from("tenants")
        .select(
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
        )
        .eq("id", activeTenant.id)
        .maybeSingle();
      if (refreshed) {
        setActiveTenant(refreshed as TenantRow);
      }
    }
    setIsSavingTenant(false);
  };

  const cancelMoveOutProcess = async () => {
    if (!activeTenant) return;
    setIsCancellingMoveOut(true);
    try {
      await callTenantsAction("cancel_move_out_process", { tenantId: activeTenant.id });
      await Promise.all([loadTenants(), loadMoveOutRequests()]);
      const { data: refreshed } = await supabase
        .from("tenants")
        .select(
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,forfeit_security_deposit,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
        )
        .eq("id", activeTenant.id)
        .maybeSingle();
      if (refreshed) {
        setActiveTenant(refreshed as TenantRow);
      }
      setActiveMoveOutRequest(null);
      const today = new Date().toISOString().slice(0, 10);
      setForm((prev) => ({
        ...prev,
        move_out_request_date: today,
        final_move_out_date: today,
      }));
      setStatus("ยกเลิกกระบวนการย้ายออกแล้ว — ผู้เช่ายังพักอยู่ตามปกติ");
    } catch (error: any) {
      setStatus(error?.message ?? "ยกเลิกกระบวนการย้ายออกไม่สำเร็จ");
    } finally {
      setIsCancellingMoveOut(false);
    }
  };

  const manageMoveOutRequest = async (requestStatus: "approved" | "rejected") => {
    if (!activeMoveOutRequest) return;
    try {
      await callTenantsAction("manage_move_out_request", {
        requestId: activeMoveOutRequest.id,
        requestStatus,
        approvedMoveOutDate: requestStatus === "approved" ? form.move_out_request_date : null,
        adminNote: activeMoveOutRequest.admin_note ?? null,
      });
      await Promise.all([loadTenants(), loadMoveOutRequests()]);
      setActiveMoveOutRequest((prev) =>
        prev
          ? {
              ...prev,
              status: requestStatus,
              approved_move_out_date:
                requestStatus === "approved" ? form.move_out_request_date : prev.approved_move_out_date,
            }
          : prev
      );
      setStatus(requestStatus === "approved" ? "อนุมัติคำขอย้ายออกเรียบร้อย" : "ปฏิเสธคำขอย้ายออกเรียบร้อย");
    } catch (error: any) {
      setStatus(error?.message ?? "จัดการคำขอย้ายออกไม่สำเร็จ");
    }
  };

  const deleteTenant = async () => {
    if (!activeTenant) return;
    setIsDeletingTenant(true);
    try {
      await callTenantsAction("delete_tenant", { tenantId: activeTenant.id });
    } catch (error: any) {
      setStatus(error?.message ?? "ลบผู้เช่าไม่สำเร็จ");
      setIsDeletingTenant(false);
      return;
    }
    setStatus("ลบผู้เช่าเรียบร้อย");
    setIsModalOpen(false);
    await loadTenants();
    setIsDeletingTenant(false);
  };

  const unlinkTenantLine = async () => {
    if (!activeTenant) return;
    setIsUnlinkingLine(true);
    try {
      await callTenantsAction("unlink_line", { tenantId: activeTenant.id });
    } catch (error: any) {
      setStatus(error?.message ?? "ยกเลิกการเชื่อม LINE ไม่สำเร็จ");
      setIsUnlinkingLine(false);
      return;
    }
    setActiveTenant({ ...activeTenant, line_user_id: null });
    setStatus("ยกเลิกการเชื่อม LINE เรียบร้อย");
    await loadTenants();
    setIsUnlinkingLine(false);
  };

  const confirmMoveOut = async () => {
    if (!activeTenant) return;
    setIsMovingOut(true);
    const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);
    try {
      await callTenantsAction("final_move_out", {
        tenantId: activeTenant.id,
        roomId: activeTenant.room_id,
        payload: {
        status: "inactive",
        move_out_date: moveOutDate,
        final_electricity_reading: toNumber(form.final_electricity_reading),
        final_water_reading: toNumber(form.final_water_reading),
        forfeit_security_deposit: forfeitDeposit,
        },
      });
    } catch (error: any) {
      setStatus(error?.message ?? "ยืนยันการย้ายออกไม่สำเร็จ");
      setIsMovingOut(false);
      return;
    }
    setStatus("ยืนยันการย้ายออกเรียบร้อย");
    setIsModalOpen(false);
    await loadTenants();
    setIsMovingOut(false);
  };

  const printMoveOutReceipt = () => {
    if (!activeTenant) return;
    const roomNo = tenantRoomNumber(activeTenant, roomsById);
    const building = tenantBuildingName(activeTenant, roomsById);
    const todayText = new Date().toLocaleDateString("th-TH");
    const netLabel = net >= 0 ? "คืนเงินผู้เช่า" : "ผู้เช่าค้างชำระ";
    const netAmount = formatMoney(Math.abs(net));
    const receiptRefundableDeposit = forfeitDeposit ? 0 : toNumber(form.security_deposit_amount);
    const receiptForfeitedDeposit = forfeitDeposit ? toNumber(form.security_deposit_amount) : 0;
    const feeRows = moveOutFeeLines
      .filter((line) => line.label.trim() && toNumber(line.amount) > 0)
      .map(
        (line) =>
          `<div class="row"><span class="label">${escapeHtml(line.label.trim())}</span><span class="value">฿${formatMoney(
            toNumber(line.amount)
          )}</span></div>`
      )
      .join("");
    const rentLabel = !useProrate
      ? "ค่าเช่า (ปิดการคำนวณ Pro-rate — ไม่นำมาหัก)"
      : latestBilledEndYmd
        ? `ค่าเช่า (Pro-rate หลังรอบบิล${tailDaysAfterBilledPeriod > 0 ? ` — ${tailDaysAfterBilledPeriod} วัน` : ""})`
        : "ค่าเช่าห้อง (งวด/สรุป)";
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ใบสรุปย้ายออก - ห้อง ${roomNo}</title>
    <style>
      @page { size: A4; margin: 12mm; }
      body { font-family: "Google Sans", "Google Sans Text", "Product Sans", "Noto Sans Thai", "Sarabun", "Tahoma", sans-serif; color: #0f172a; }
      .card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
      .header { border: 2px solid #334155; background: #f8fafc; }
      h1 { margin: 0; font-size: 24px; }
      .sub { color: #475569; margin-top: 6px; }
      .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; }
      .row:last-child { border-bottom: 0; }
      .label { color: #475569; }
      .value { font-weight: 700; }
      .total { margin-top: 10px; padding-top: 10px; border-top: 1px solid #94a3b8; font-size: 18px; font-weight: 700; }
    </style>
  </head>
  <body>
    <div class="card header">
      <h1>ใบสรุปย้ายออก</h1>
      <div class="sub">วันที่พิมพ์: ${todayText}</div>
      <div class="sub">ผู้เช่า: ${form.full_name || "-"}</div>
      <div class="sub">ห้อง: ${roomNo}${building ? ` (${building})` : ""}</div>
    </div>
    <div class="card">
      ${
        unpaidInvoicesSubtotal > 0
          ? `<div class="row"><span class="label">ยอดบิลค้างชำระ (รวม ${outstandingMoveOutInvoices.length} รายการ)</span><span class="value">฿${formatMoney(
              unpaidInvoicesSubtotal
            )}</span></div>`
          : ""
      }
      <div class="row"><span class="label">${rentLabel}</span><span class="value">฿${formatMoney(appliedMoveOutRentBase)}</span></div>
      ${
        overstayRentCharge > 0
          ? `<div class="row"><span class="label">ค่าเช่าคิดตามจำนวนวันค้าง (${overstayDays} วัน)</span><span class="value">฿${formatMoney(
              overstayRentCharge
            )}</span></div>`
          : ""
      }
      <div class="row"><span class="label">ค่าไฟฟ้า (${electricityUsage} หน่วย)</span><span class="value">฿${formatMoney(electricityUsage * rates.electricity_rate)}</span></div>
      <div class="row"><span class="label">ค่าน้ำ (${waterUsage} หน่วย)</span><span class="value">฿${formatMoney(waterUsage * rates.water_rate)}</span></div>
      ${feeRows}
      <div class="row"><span class="label">รวมค่าใช้จ่าย</span><span class="value">฿${formatMoney(totalCost)}</span></div>
      <div class="row"><span class="label">ค่าเช่าล่วงหน้าที่นำมาหักได้</span><span class="value">฿${formatMoney(
        toNumber(form.advance_rent_amount)
      )}</span></div>
      <div class="row"><span class="label">เงินประกันที่นำมาหักได้</span><span class="value">฿${formatMoney(
        receiptRefundableDeposit
      )}</span></div>
      ${
        receiptForfeitedDeposit > 0
          ? `<div class="row"><span class="label">เงินประกันที่ไม่คืน</span><span class="value">฿${formatMoney(
              receiptForfeitedDeposit
            )}</span></div>`
          : ""
      }
      <div class="row"><span class="label">รวมยอดที่หักคืนได้</span><span class="value">฿${formatMoney(prepaid)}</span></div>
      <div class="total">${netLabel}: ฿${netAmount}</div>
    </div>
  </body>
</html>`;

    const win = window.open("about:blank", "_blank", "width=900,height=1100");
    if (!win) {
      setStatus("ไม่สามารถเปิดหน้าพิมพ์ได้ (กรุณาอนุญาต pop-up)");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    const triggerPrint = () => {
      win.focus();
      win.print();
    };
    win.onload = triggerPrint;
    setTimeout(triggerPrint, 250);
  };

  const roomsById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const oldRoom = activeTenant ? roomsById.get(activeTenant.room_id) : null;
  const newRoom = form.room_id ? roomsById.get(form.room_id) : null;
  const existingTenantInSelectedRoom = useMemo(
    () => findExistingActiveTenantInRoom(tenants, form.room_id, activeTenant?.id ?? null),
    [activeTenant?.id, form.room_id, tenants]
  );
  const oldRoomRate = toNumber(
    activeTenant
      ? (Array.isArray(activeTenant.rooms) ? activeTenant.rooms[0]?.price_month : activeTenant.rooms?.price_month) ??
          oldRoom?.price_month
      : 0
  );
  const newRoomRate = toNumber(newRoom?.price_month ?? 0);
  const isRoomTransfer = !!activeTenant?.id && !!form.room_id && form.room_id !== activeTenant.room_id;
  const transferProration = calculateTransferRentProration(
    transferCalc.transfer_date,
    activeTenant?.move_in_date,
    oldRoomRate,
    newRoomRate
  );
  const oldRoomDays = transferProration.oldRoomDays;
  const newRoomDays = transferProration.newRoomDays;
  const daysInTransferMonth = transferProration.daysInMonth;
  const transferOldRent = transferProration.oldRentAmount;
  const transferNewRent = transferProration.newRentAmount;
  const transferOldElectricUsage = Math.max(
    toNumber(transferCalc.old_curr_electricity) - toNumber(transferCalc.old_prev_electricity),
    0
  );
  const transferOldWaterUsage = Math.max(
    toNumber(transferCalc.old_curr_water) - toNumber(transferCalc.old_prev_water),
    0
  );
  const transferOldUtility =
    transferOldElectricUsage * rates.electricity_rate + transferOldWaterUsage * rates.water_rate;
  const transferGrandTotal = transferOldRent + transferNewRent + transferOldUtility;

  const filtered = tenants.filter((tenant) => {
    const room = tenantRoomNumber(tenant, roomsById);
    const building = tenantBuildingName(tenant, roomsById);
    const matchesBuilding = buildingFilter === "all" || building === buildingFilter;
    return (
      matchesBuilding &&
      (tenant.full_name.toLowerCase().includes(search.toLowerCase()) ||
        room.toLowerCase().includes(search.toLowerCase()))
    );
  });
  const buildingOptions = useMemo(
    () =>
      [...new Set(tenants.map((tenant) => tenantBuildingName(tenant, roomsById)))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })),
    [roomsById, tenants]
  );
  const groupedTenants = useMemo(() => {
    const grouped = filtered.reduce<Record<string, TenantRow[]>>((acc, tenant) => {
      const building = tenantBuildingName(tenant, roomsById);
      if (!acc[building]) acc[building] = [];
      acc[building].push(tenant);
      return acc;
    }, {});

    for (const building of Object.keys(grouped)) {
      grouped[building] = grouped[building].sort((a, b) =>
        roomNumberCompare(tenantRoomNumber(a, roomsById), tenantRoomNumber(b, roomsById))
      );
    }
    return grouped;
  }, [filtered, roomsById]);

  const activeMoveOutRequestByTenantId = useMemo(() => {
    const map = new Map<string, MoveOutRequestRow>();
    for (const row of moveOutRequests) {
      const tenantId = String(row.tenant_id ?? "");
      if (!tenantId || map.has(tenantId)) continue;
      map.set(tenantId, row);
    }
    return map;
  }, [moveOutRequests]);

  const leaseEnd = form.move_in_date ? leaseEndDateText(form.move_in_date, toNumber(form.lease_months)) : "-";
  const leaseActive = form.move_in_date ? new Date() <= new Date(leaseEnd) : false;

  const activeMoveOutNoticeYmd = useMemo(() => {
    if (!activeMoveOutRequest) return "";
    if (activeMoveOutRequest.notice_date) {
      return String(activeMoveOutRequest.notice_date).slice(0, 10);
    }
    if (activeMoveOutRequest.created_at) {
      return bangkokYmd(new Date(activeMoveOutRequest.created_at));
    }
    return "";
  }, [activeMoveOutRequest]);

  const moveOutShorterThan30DayNotice =
    Boolean(activeMoveOutRequest && activeMoveOutNoticeYmd && activeMoveOutRequest.requested_move_out_date) &&
    !meets30DayMoveOutNotice(
      activeMoveOutNoticeYmd,
      String(activeMoveOutRequest?.requested_move_out_date ?? "").slice(0, 10)
    );

  const electricityUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const roomPrice = activeTenant ? tenantRoomPrice(activeTenant, roomsById) : 0;
  const utilityTotal = electricityUsage * rates.electricity_rate + waterUsage * rates.water_rate;
  const dailyRent = roomPrice > 0 ? roomPrice / 30 : 0;
  const advanceCoveredDays =
    dailyRent > 0 && toNumber(form.advance_rent_amount) > 0
      ? Math.max(1, Math.round(toNumber(form.advance_rent_amount) / dailyRent))
      : 0;
  const moveOutRequestDate = form.move_out_request_date
    ? new Date(form.move_out_request_date)
    : null;
  const advanceCoveredEndDate = moveOutRequestDate
    ? new Date(moveOutRequestDate.getTime() + advanceCoveredDays * 24 * 60 * 60 * 1000)
    : null;
  const actualMoveOutDate = form.final_move_out_date ? new Date(form.final_move_out_date) : null;
  const overstayDays =
    useProrate && advanceCoveredEndDate && actualMoveOutDate
      ? Math.max(
          0,
          Math.floor(
            (actualMoveOutDate.getTime() - advanceCoveredEndDate.getTime()) / (24 * 60 * 60 * 1000)
          )
        )
      : 0;
  const overstayRentCharge = overstayDays * dailyRent;
  const additionalFeesTotal = moveOutFeeLines.reduce((sum, line) => sum + toNumber(line.amount), 0);

  const latestBilledEndYmd = useMemo(() => {
    let best: string | null = null;
    let bestT = 0;
    for (const inv of tenantInvoiceHistory) {
      const raw = String(inv.end_date || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      const t = ymdToLocalDate(raw).getTime();
      if (Number.isNaN(t) || t < bestT) continue;
      bestT = t;
      best = raw;
    }
    return best;
  }, [tenantInvoiceHistory]);

  const moveOutYmdForTail = (form.final_move_out_date || form.move_out_request_date || "").trim().slice(0, 10);

  const { tailDaysAfterBilledPeriod, moveOutRentBase } = useMemo(() => {
    if (!latestBilledEndYmd) {
      return { tailDaysAfterBilledPeriod: 0, moveOutRentBase: roomPrice };
    }
    if (!moveOutYmdForTail) {
      return { tailDaysAfterBilledPeriod: 0, moveOutRentBase: 0 };
    }
    const dayAfter = ymdToLocalDate(latestBilledEndYmd);
    if (Number.isNaN(dayAfter.getTime())) {
      return { tailDaysAfterBilledPeriod: 0, moveOutRentBase: roomPrice };
    }
    dayAfter.setDate(dayAfter.getDate() + 1);
    const out = ymdToLocalDate(moveOutYmdForTail);
    if (Number.isNaN(out.getTime())) {
      return { tailDaysAfterBilledPeriod: 0, moveOutRentBase: 0 };
    }
    if (out < dayAfter) {
      return { tailDaysAfterBilledPeriod: 0, moveOutRentBase: 0 };
    }
    const days =
      Math.floor((out.getTime() - dayAfter.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    return {
      tailDaysAfterBilledPeriod: days,
      moveOutRentBase: (roomPrice / 30) * days,
    };
  }, [latestBilledEndYmd, moveOutYmdForTail, roomPrice]);

  const appliedMoveOutRentBase = useProrate ? moveOutRentBase : 0;

  const outstandingMoveOutInvoices = useMemo(
    () =>
      tenantInvoiceHistory.filter(
        (inv) => !["draft", "cancelled"].includes(String(inv.status)) && getInvoiceOutstanding(inv) > 0.001
      ),
    [tenantInvoiceHistory]
  );

  const unpaidInvoicesSubtotal = useMemo(
    () => outstandingMoveOutInvoices.reduce((sum, inv) => sum + getInvoiceOutstanding(inv), 0),
    [outstandingMoveOutInvoices]
  );

  const totalCost =
    unpaidInvoicesSubtotal +
    appliedMoveOutRentBase +
    utilityTotal +
    overstayRentCharge +
    additionalFeesTotal;
  const refundableDeposit = forfeitDeposit ? 0 : toNumber(form.security_deposit_amount);
  const forfeitedDepositAmount = forfeitDeposit ? toNumber(form.security_deposit_amount) : 0;
  const prepaid = refundableDeposit + toNumber(form.advance_rent_amount);
  const net = prepaid - totalCost;
  const totalTenants = filtered.length;
  const paymentHistoryMonthOptions = useMemo(
    () =>
      [...new Set(tenantInvoiceHistory.map((invoice) => String(invoice.start_date ?? "").slice(0, 7)).filter(Boolean))]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" })),
    [tenantInvoiceHistory]
  );
  const filteredTenantInvoiceHistory = useMemo(
    () =>
      tenantInvoiceHistory.filter((invoice) =>
        paymentHistoryMonth === "all" ? true : String(invoice.start_date ?? "").slice(0, 7) === paymentHistoryMonth
      ),
    [paymentHistoryMonth, tenantInvoiceHistory]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ค้นหาชื่อผู้เช่าหรือเลขห้อง"
              className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
            />
          </div>
          {buildingOptions.length > 1 && (
            <select
              value={buildingFilter}
              onChange={(event) => setBuildingFilter(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40 md:w-56"
            >
              <option value="all">ทุกอาคาร</option>
              {buildingOptions.map((building) => (
                <option key={building} value={building}>
                  {building}
                </option>
              ))}
            </select>
          )}
        </div>
        <button
          onClick={() => void openModal()}
          disabled={!canEditTenant}
          title={!canEditTenant ? "ไม่มีสิทธิ์เพิ่ม/แก้ไขข้อมูลผู้เช่า" : undefined}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-base font-semibold text-white shadow-lg shadow-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
        >
          <Plus size={16} />
          เพิ่มผู้เช่า
        </button>
      </div>

      {status && <Badge variant="info">{status}</Badge>}
      {isPageLoading && (
        <div className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-base text-blue-700">
          <Loader2 size={16} className="animate-spin" />
          กำลังโหลดข้อมูลผู้เช่า...
        </div>
      )}
      {!canViewTenants && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้เช่า
        </div>
      )}

      {Object.entries(groupedTenants)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .map(([building, buildingTenants]) => (
          <div key={building} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
              <Badge variant="info" className="text-sm">
                {buildingTenants.length} รายการ
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {buildingTenants.map((tenant) => (
                <div
                  key={tenant.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">ห้อง</p>
                      <h2 className="mt-1 text-base font-semibold text-slate-900">{tenantRoomNumber(tenant, roomsById)}</h2>
                      <p className="mt-1 text-sm text-slate-600">{tenant.full_name}</p>
                    </div>
                    <Badge variant={tenant.status === "active" ? "success" : "warning"}>
                      {tenantStatusLabel(tenant.status)}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                      <Badge variant="warning">รอจัดการย้ายออก</Badge>
                    )}
                    {tenant.forfeit_security_deposit ? <Badge variant="danger">ไม่คืนเงินประกัน</Badge> : null}
                  </div>

                  <div className="mt-3 space-y-2 text-sm text-slate-600">
                    <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                      <span>เบอร์โทร</span>
                      <span className="font-medium text-slate-800">{tenant.phone_number ?? "-"}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                      <span>LINE</span>
                      <span className={`font-medium ${tenant.line_user_id ? "text-emerald-700" : "text-slate-500"}`}>
                        {tenant.line_user_id ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {activeMoveOutRequestByTenantId.has(String(tenant.id)) && (
                      <button
                        type="button"
                        disabled={!canEditTenant}
                        onClick={() => void openModal(tenant, "move_out")}
                        className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        ดูคำขอย้ายออก
                      </button>
                    )}
                    <button
                      disabled={!canEditTenant}
                      title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-400"
                      onClick={() => void openModal(tenant)}
                    >
                      แก้ไขข้อมูล
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

      {!isPageLoading && totalTenants === 0 && canViewTenants && (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-slate-500">
          ไม่พบข้อมูลผู้เช่าตามคำค้นหา
        </div>
      )}

            <TenantEditorModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tenantId={activeTenant?.id ?? null}
        initialTab={activeTab}
        onRefresh={loadTenants}
      />
    </div>
  );
}