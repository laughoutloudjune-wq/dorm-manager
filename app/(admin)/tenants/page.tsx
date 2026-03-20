"use client";

import { useEffect, useMemo, useState } from "react";
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

type SettingsRates = {
  water_rate: number;
  electricity_rate: number;
};

type MoveOutFeeLine = {
  id: string;
  label: string;
  amount: number;
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
  const { can } = usePermissions();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [receiptProfiles, setReceiptProfiles] = useState<ReceiptProfile[]>([]);
  const [rates, setRates] = useState<SettingsRates>({ water_rate: 0, electricity_rate: 0 });
  const [search, setSearch] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTenant, setActiveTenant] = useState<TenantRow | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "move_in" | "move_out">("info");
  const [useCustomPayment, setUseCustomPayment] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string>("");
  const [useCustomReceipt, setUseCustomReceipt] = useState(false);
  const [selectedReceiptProfileId, setSelectedReceiptProfileId] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [latestPrevElectricity, setLatestPrevElectricity] = useState(0);
  const [latestPrevWater, setLatestPrevWater] = useState(0);
  const [moveOutFeeLines, setMoveOutFeeLines] = useState<MoveOutFeeLine[]>([]);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);
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
    move_out_date: "",
    final_move_out_date: "",
  });

  const loadTenants = async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
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

  useEffect(() => {
    let mounted = true;
    const loadAll = async () => {
      setIsPageLoading(true);
      await Promise.all([loadTenants(), loadRooms(), loadMethods(), loadReceiptProfiles(), loadRates()]);
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

  const openModal = async (tenant?: TenantRow) => {
    setActiveTab("info");
    if (tenant) {
      setActiveTenant(tenant);
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
        move_out_date: tenant.move_out_date ?? new Date().toISOString().slice(0, 10),
        final_move_out_date: tenant.move_out_date ?? new Date().toISOString().slice(0, 10),
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
    } else {
      setActiveTenant(null);
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
        move_out_date: new Date().toISOString().slice(0, 10),
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
    }

    setIsModalOpen(true);
  };

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
      status: form.status,
      lease_months: toNumber(form.lease_months),
      initial_electricity_reading: toNumber(form.initial_electricity_reading),
      initial_water_reading: toNumber(form.initial_water_reading),
      advance_rent_amount: toNumber(form.advance_rent_amount),
      security_deposit_amount: toNumber(form.security_deposit_amount),
      deposit_slip_url: serializeDepositSlipUrls(depositSlipUrls),
      final_electricity_reading: toNumber(form.final_electricity_reading),
      final_water_reading: toNumber(form.final_water_reading),
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
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,custom_payment_method,custom_receipt_profile,rooms(room_number,price_month,buildings(name))"
        )
        .eq("id", activeTenant.id)
        .maybeSingle();
      if (refreshed) {
        setActiveTenant(refreshed as TenantRow);
      }
    }
    setIsSavingTenant(false);
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
    const moveOutDate =
      form.final_move_out_date || form.move_out_date || new Date().toISOString().slice(0, 10);
    try {
      await callTenantsAction("final_move_out", {
        tenantId: activeTenant.id,
        roomId: activeTenant.room_id,
        payload: {
        status: "inactive",
        move_out_date: moveOutDate,
        final_electricity_reading: toNumber(form.final_electricity_reading),
        final_water_reading: toNumber(form.final_water_reading),
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
    const feeRows = moveOutFeeLines
      .filter((line) => line.label.trim() && toNumber(line.amount) > 0)
      .map(
        (line) =>
          `<div class="row"><span class="label">${escapeHtml(line.label.trim())}</span><span class="value">฿${formatMoney(
            toNumber(line.amount)
          )}</span></div>`
      )
      .join("");
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
      <div class="row"><span class="label">ค่าเช่าห้อง</span><span class="value">฿${formatMoney(roomPrice)}</span></div>
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
      <div class="row"><span class="label">ชำระล่วงหน้า (ประกัน + ค่าเช่าล่วงหน้า)</span><span class="value">฿${formatMoney(prepaid)}</span></div>
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

  const transferDateObj = transferCalc.transfer_date ? new Date(transferCalc.transfer_date) : null;
  const transferDay = transferDateObj ? Number(transferCalc.transfer_date.slice(8, 10)) : 1;
  const daysInTransferMonth = transferDateObj
    ? new Date(transferDateObj.getFullYear(), transferDateObj.getMonth() + 1, 0).getDate()
    : 30;
  const oldRoomDays = Math.min(Math.max(transferDay - 1, 0), daysInTransferMonth);
  const newRoomDays = Math.max(daysInTransferMonth - oldRoomDays, 0);
  const transferOldRent = daysInTransferMonth > 0 ? (oldRoomRate * oldRoomDays) / daysInTransferMonth : 0;
  const transferNewRent = daysInTransferMonth > 0 ? (newRoomRate * newRoomDays) / daysInTransferMonth : 0;
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
    return (
      tenant.full_name.toLowerCase().includes(search.toLowerCase()) ||
      room.toLowerCase().includes(search.toLowerCase())
    );
  });
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

  const leaseEnd = form.move_in_date ? leaseEndDateText(form.move_in_date, toNumber(form.lease_months)) : "-";
  const leaseActive = form.move_in_date ? new Date() <= new Date(leaseEnd) : false;

  const electricityUsage = Math.max(toNumber(form.final_electricity_reading) - latestPrevElectricity, 0);
  const waterUsage = Math.max(toNumber(form.final_water_reading) - latestPrevWater, 0);
  const roomPrice = activeTenant ? tenantRoomPrice(activeTenant, roomsById) : 0;
  const utilityTotal = electricityUsage * rates.electricity_rate + waterUsage * rates.water_rate;
  const dailyRent = roomPrice > 0 ? roomPrice / 30 : 0;
  const advanceCoveredDays =
    dailyRent > 0 && toNumber(form.advance_rent_amount) > 0
      ? Math.max(1, Math.round(toNumber(form.advance_rent_amount) / dailyRent))
      : 0;
  const moveOutRequestDate = form.move_out_date ? new Date(form.move_out_date) : null;
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
  const totalCost = roomPrice + utilityTotal + overstayRentCharge + additionalFeesTotal;
  const prepaid = toNumber(form.security_deposit_amount) + toNumber(form.advance_rent_amount);
  const net = prepaid - totalCost;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ค้นหาชื่อผู้เช่าหรือเลขห้อง"
            className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
          />
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
            <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full table-fixed text-left text-base">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[12%]" />
                  <col className="w-[18%]" />
                  <col className="w-[24%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead className="bg-slate-100 text-sm tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-3">ผู้เช่า</th>
                    <th className="px-4 py-3">ห้อง</th>
                    <th className="px-4 py-3">เบอร์โทร</th>
                    <th className="px-4 py-3">วิธีชำระ</th>
                    <th className="px-4 py-3">สถานะ</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {buildingTenants.map((tenant) => (
                    <tr key={tenant.id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{tenant.full_name}</td>
                      <td className="px-4 py-3">{tenantRoomNumber(tenant, roomsById)}</td>
                      <td className="px-4 py-3">{tenant.phone_number ?? "-"}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{tenantPaymentMethodLabel(tenant)}</td>
                      <td className="px-4 py-3">
                        <Badge variant={tenant.status === "active" ? "success" : "warning"}>
                          {tenantStatusLabel(tenant.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          disabled={!canEditTenant}
                          title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 disabled:cursor-not-allowed disabled:border-red-200 disabled:text-red-400"
                          onClick={() => void openModal(tenant)}
                        >
                          แก้ไข
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="รายละเอียดผู้เช่า" size="xl">
        {!canEditTenant && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            บัญชีนี้ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า (ดูได้อย่างเดียว)
          </div>
        )}
        <div className="[&_label]:text-base [&_input]:text-base [&_select]:text-base [&_p]:text-base">
        <div className="mb-4 flex gap-2 text-base">
          <button
            className={`rounded-full px-3 py-2 text-base ${activeTab === "info" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("info")}
          >
            ข้อมูลทั่วไป
          </button>
          <button
            className={`rounded-full px-3 py-2 text-base ${activeTab === "move_in" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("move_in")}
          >
            ย้ายเข้า
          </button>
          <button
            className={`rounded-full px-3 py-2 text-base ${activeTab === "move_out" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("move_out")}
          >
            ย้ายออก
          </button>
        </div>

        {activeTab === "info" && (
          <div
            className={`grid gap-4 md:grid-cols-2 ${
              !canEditTenant ? "cursor-not-allowed opacity-80 [&>*:not(.tenant-line-box)]:pointer-events-none" : ""
            }`}
          >
            <Input className="text-base" label="ชื่อ-นามสกุล" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <Input className="text-base" label="ที่อยู่" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Input className="text-base" label="เบอร์โทร" value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
            <label className="text-base text-slate-700">
              ห้อง
              <select
                value={form.room_id}
                onChange={(event) => setForm({ ...form, room_id: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-base"
              >
                <option value="">เลือกห้อง</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {roomLabel(room)}
                  </option>
                ))}
              </select>
            </label>
            {existingTenantInSelectedRoom && (
              <div className="md:col-span-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                ห้องนี้มีผู้เช่าอยู่แล้ว: {existingTenantInSelectedRoom.full_name}
                {existingTenantInSelectedRoom.phone_number
                  ? ` | เบอร์โทร ${existingTenantInSelectedRoom.phone_number}`
                  : ""}
              </div>
            )}

            {isRoomTransfer && (
              <div className="space-y-3 md:col-span-2 rounded-xl border border-blue-200 bg-blue-50 p-4">
                <p className="text-base font-semibold text-slate-800">คำนวณย้ายห้องกลางเดือน</p>
                <p className="text-sm text-slate-600">
                  ห้องใหม่บันทึกเฉพาะค่าอ่านมิเตอร์ ณ วันย้ายเข้าเป็นค่าเริ่มต้น (baseline) เพื่อใช้คำนวณตอนจบเดือน
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    label="วันที่ย้ายห้อง"
                    type="date"
                    value={transferCalc.transfer_date}
                    onChange={(event) =>
                      setTransferCalc((prev) => ({ ...prev, transfer_date: event.target.value }))
                    }
                    className="text-base"
                  />
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                    ห้องเดิม: {tenantRoomNumber(activeTenant!, roomsById)} ({formatMoney(oldRoomRate)} / เดือน)
                    <br />
                    ห้องใหม่: {newRoom?.room_number ?? "-"} ({formatMoney(newRoomRate)} / เดือน)
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                    <p className="font-medium text-slate-800">ห้องเดิม</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <Input
                        label="ไฟก่อนหน้า"
                        type="number"
                        value={transferCalc.old_prev_electricity}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            old_prev_electricity: toNumber(event.target.value),
                          }))
                        }
                      />
                      <Input
                        label="ไฟล่าสุด"
                        type="number"
                        value={transferCalc.old_curr_electricity}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            old_curr_electricity: toNumber(event.target.value),
                          }))
                        }
                      />
                      <Input
                        label="น้ำก่อนหน้า"
                        type="number"
                        value={transferCalc.old_prev_water}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            old_prev_water: toNumber(event.target.value),
                          }))
                        }
                      />
                      <Input
                        label="น้ำล่าสุด"
                        type="number"
                        value={transferCalc.old_curr_water}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            old_curr_water: toNumber(event.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                    <p className="font-medium text-slate-800">ห้องใหม่</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <Input
                        label="ไฟฟ้า ณ วันย้ายเข้า (Baseline)"
                        type="number"
                        value={transferCalc.new_curr_electricity}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            new_curr_electricity: toNumber(event.target.value),
                          }))
                        }
                      />
                      <Input
                        label="น้ำ ณ วันย้ายเข้า (Baseline)"
                        type="number"
                        value={transferCalc.new_curr_water}
                        onChange={(event) =>
                          setTransferCalc((prev) => ({
                            ...prev,
                            new_curr_water: toNumber(event.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
                  <p>
                    ค่าเช่าห้องเดิม ({oldRoomDays}/{daysInTransferMonth} วัน): ฿{formatMoney(transferOldRent)}
                  </p>
                  <p>
                    ค่าเช่าห้องใหม่ ({newRoomDays}/{daysInTransferMonth} วัน): ฿{formatMoney(transferNewRent)}
                  </p>
                  <p>ค่าน้ำไฟห้องเดิม: ฿{formatMoney(transferOldUtility)}</p>
                  <p className="text-xs text-slate-500">
                    ห้องใหม่จะเริ่มคิดจากเลข baseline นี้เมื่อบันทึกมิเตอร์ปลายเดือน
                  </p>
                  <p className="mt-1 font-semibold text-slate-900">
                    รวมประมาณการย้ายห้องกลางเดือน: ฿{formatMoney(transferGrandTotal)}
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-2 md:col-span-2">
              <p className="text-base font-medium text-slate-700">ช่องทางรับชำระ</p>
              <div className="flex items-center gap-3 text-base text-slate-700">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!useCustomPayment} onChange={() => setUseCustomPayment(false)} />
                  ใช้ช่องทางชำระกลางของหอ
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={useCustomPayment} onChange={() => setUseCustomPayment(true)} />
                  กำหนดบัญชี/QR เฉพาะผู้เช่า
                </label>
              </div>
              {useCustomPayment && (
                <select
                  value={selectedMethodId}
                  onChange={(event) => setSelectedMethodId(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-base"
                >
                  <option value="">เลือกช่องทางชำระเงิน</option>
                  {methods.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.label} - {method.bank_name} ({method.account_number})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-2 md:col-span-2">
              <p className="text-base font-medium text-slate-700">ข้อมูลออกใบเสร็จ (นิติบุคคล)</p>
              <div className="flex items-center gap-3 text-base text-slate-700">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!useCustomReceipt} onChange={() => setUseCustomReceipt(false)} />
                  ใช้ชื่อ/ที่อยู่ผู้เช่าปกติ
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={useCustomReceipt} onChange={() => setUseCustomReceipt(true)} />
                  กำหนดข้อมูลนิติบุคคลเฉพาะห้อง
                </label>
              </div>
              {useCustomReceipt && (
                <select
                  value={selectedReceiptProfileId}
                  onChange={(event) => setSelectedReceiptProfileId(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-base"
                >
                  <option value="">เลือกโปรไฟล์ใบเสร็จ</option>
                  {receiptProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} - {profile.company_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="tenant-line-box space-y-2 md:col-span-2 rounded-xl border border-slate-200 p-4">
              <p className="text-base font-medium text-slate-700">การเชื่อมต่อ LINE</p>
              <div
                className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                  activeTenant?.line_user_id
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                {activeTenant?.line_user_id ? "เชื่อม LINE แล้ว" : "ยังไม่ได้เชื่อม LINE"}
              </div>
              <button
                onClick={() => setConfirmUnlinkOpen(true)}
                disabled={!activeTenant?.line_user_id || !canManageTenantLine}
                title={!canManageTenantLine ? "ไม่มีสิทธิ์จัดการการเชื่อม LINE" : undefined}
                className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ยกเลิกการเชื่อม LINE
              </button>
            </div>
          </div>
        )}

        {activeTab === "move_in" && (
          <fieldset
            disabled={!canEditTenant}
            className="grid gap-4 md:grid-cols-2 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <Input
              label="วันที่ย้ายเข้า"
              type="date"
              value={form.move_in_date}
              onChange={(event) => setForm({ ...form, move_in_date: event.target.value })}
              className="text-base"
            />
            <Input
              label="ระยะสัญญา (เดือน)"
              type="number"
              value={form.lease_months}
              onChange={(event) => setForm({ ...form, lease_months: toNumber(event.target.value) })}
              className="text-base"
            />
            <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              วันสิ้นสุดสัญญา: {form.move_in_date ? leaseEnd : "-"} | สถานะสัญญา:{" "}
              <span className={leaseActive ? "text-green-700" : "text-red-700"}>
                {leaseActive ? "ยังมีผล" : "หมดอายุ"}
              </span>
            </div>
            <Input
              label="เลขมิเตอร์ไฟเริ่มต้น"
              type="number"
              value={form.initial_electricity_reading}
              onChange={(event) =>
                setForm({ ...form, initial_electricity_reading: toNumber(event.target.value) })
              }
              className="text-base"
            />
            <Input
              label="เลขมิเตอร์น้ำเริ่มต้น"
              type="number"
              value={form.initial_water_reading}
              onChange={(event) => setForm({ ...form, initial_water_reading: toNumber(event.target.value) })}
              className="text-base"
            />
            <Input
              label="ค่าเช่าล่วงหน้า"
              type="number"
              value={form.advance_rent_amount}
              onChange={(event) => setForm({ ...form, advance_rent_amount: toNumber(event.target.value) })}
              className="text-base"
            />
            <Input
              label="เงินประกัน"
              type="number"
              value={form.security_deposit_amount}
              onChange={(event) => setForm({ ...form, security_deposit_amount: toNumber(event.target.value) })}
              className="text-base"
            />
            <div className="md:col-span-2 flex items-center gap-3">
              <label
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                  canEditTenant
                    ? "cursor-pointer border-slate-200 text-slate-700"
                    : "cursor-not-allowed border-red-200 text-red-400"
                }`}
              >
                <Upload size={14} />
                อัปโหลดสลิปมัดจำ
                <input
                  type="file"
                  accept="image/*"
                  disabled={!canEditTenant || isUploadingDepositSlip}
                  className="hidden"
                  onChange={(e) => void uploadDepositSlip(e.target.files?.[0])}
                />
              </label>
              {isUploadingDepositSlip && <Loader2 size={16} className="animate-spin text-blue-600" />}
              {depositSlipUrls.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {depositSlipUrls.map((url, index) => (
                    <div key={url} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1">
                      <a href={url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">
                        สลิป {index + 1}
                      </a>
                      <button
                        type="button"
                        onClick={() => removeDepositSlip(url)}
                        className="rounded border border-red-200 px-1.5 py-0.5 text-xs text-red-600"
                      >
                        ลบ
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </fieldset>
        )}

        {activeTab === "move_out" && (
          <fieldset disabled={!canEditTenant} className="space-y-4 disabled:cursor-not-allowed disabled:opacity-70">
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="วันที่แจ้งย้ายออก"
                type="date"
                value={form.move_out_date}
                onChange={(event) => setForm({ ...form, move_out_date: event.target.value })}
                className="text-base"
              />
              <Input
                label="วันที่ย้ายออกจริง"
                type="date"
                value={form.final_move_out_date}
                onChange={(event) => setForm({ ...form, final_move_out_date: event.target.value })}
                className="text-base"
              />
              <Input
                label={`เลขมิเตอร์ไฟสุดท้าย (ก่อนหน้า ${latestPrevElectricity})`}
                type="number"
                value={form.final_electricity_reading}
                onChange={(event) =>
                  setForm({ ...form, final_electricity_reading: toNumber(event.target.value) })
                }
                className="text-base"
              />
              <Input
                label={`เลขมิเตอร์น้ำสุดท้าย (ก่อนหน้า ${latestPrevWater})`}
                type="number"
                value={form.final_water_reading}
                onChange={(event) => setForm({ ...form, final_water_reading: toNumber(event.target.value) })}
                className="text-base"
              />
            </div>

            <label className="inline-flex items-center gap-2 text-base text-slate-700">
              <input
                type="checkbox"
                checked={useProrate}
                onChange={(event) => setUseProrate(event.target.checked)}
              />
              ใช้การคำนวณ Pro-rate สำหรับวันที่เกินจากค่าเช่าล่วงหน้า
            </label>

            <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-800">ค่าใช้จ่ายเพิ่มเติม (ย้ายออก)</p>
                <button
                  type="button"
                  onClick={() => setMoveOutFeeLines((prev) => [...prev, createMoveOutFeeLine()])}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
                >
                  <Plus size={14} />
                  เพิ่มรายการ
                </button>
              </div>
              {moveOutFeeLines.length === 0 && (
                <p className="text-sm text-slate-500">ยังไม่มีค่าใช้จ่ายเพิ่มเติม</p>
              )}
              {moveOutFeeLines.map((line) => (
                <div key={line.id} className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
                  <Input
                    label="รายการ"
                    value={line.label}
                    onChange={(event) =>
                      setMoveOutFeeLines((prev) =>
                        prev.map((item) =>
                          item.id === line.id ? { ...item, label: event.target.value } : item
                        )
                      )
                    }
                  />
                  <Input
                    label="จำนวนเงิน"
                    type="number"
                    value={line.amount}
                    onChange={(event) =>
                      setMoveOutFeeLines((prev) =>
                        prev.map((item) =>
                          item.id === line.id ? { ...item, amount: toNumber(event.target.value) } : item
                        )
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setMoveOutFeeLines((prev) => prev.filter((item) => item.id !== line.id))
                    }
                    className="mt-7 inline-flex h-10 items-center justify-center rounded-lg border border-red-200 px-3 text-red-600"
                    title="ลบรายการ"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-300 bg-white p-5 text-sm text-slate-700">
              <div className="mb-3 border-b border-dashed border-slate-300 pb-3">
                <p className="text-lg font-semibold text-slate-900">สรุปย้ายออก</p>
                <p>ผู้เช่า: {form.full_name || "-"}</p>
                <p>ห้อง: {activeTenant ? tenantRoomNumber(activeTenant, roomsById) : "-"}</p>
                <p>วันที่แจ้งย้ายออก: {form.move_out_date || "-"}</p>
                <p>วันที่ย้ายออกจริง: {form.final_move_out_date || "-"}</p>
              </div>
              <div className="space-y-1">
                <p className="flex justify-between"><span>ค่าเช่าห้อง</span><span>฿{formatMoney(roomPrice)}</span></p>
                {overstayRentCharge > 0 && (
                  <p className="flex justify-between">
                    <span>ค่าเช่า Pro-rate จากวันที่เกิน ({overstayDays} วัน)</span>
                    <span>฿{formatMoney(overstayRentCharge)}</span>
                  </p>
                )}
                <p className="flex justify-between">
                  <span>ค่าไฟฟ้า ({electricityUsage} หน่วย)</span>
                  <span>฿{formatMoney(electricityUsage * rates.electricity_rate)}</span>
                </p>
                <p className="flex justify-between">
                  <span>ค่าน้ำ ({waterUsage} หน่วย)</span>
                  <span>฿{formatMoney(waterUsage * rates.water_rate)}</span>
                </p>
                {moveOutFeeLines
                  .filter((line) => line.label.trim() && toNumber(line.amount) > 0)
                  .map((line) => (
                    <p key={line.id} className="flex justify-between">
                      <span>{line.label.trim()}</span>
                      <span>฿{formatMoney(toNumber(line.amount))}</span>
                    </p>
                  ))}
              </div>
              <div className="my-3 border-t border-dashed border-slate-300" />
              <div className="space-y-1">
                <p className="flex justify-between font-medium"><span>รวมค่าใช้จ่าย</span><span>฿{formatMoney(totalCost)}</span></p>
                <p className="flex justify-between"><span>ชำระล่วงหน้า (ประกัน + ค่าเช่าล่วงหน้า)</span><span>฿{formatMoney(prepaid)}</span></p>
              </div>
              <div className="my-3 border-t border-dashed border-slate-300" />
              <p className="text-base font-semibold text-slate-900">
                {net >= 0
                  ? `คืนเงินผู้เช่า: ฿${formatMoney(net)}`
                  : `ผู้เช่าค้างชำระ: ฿${formatMoney(Math.abs(net))}`}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void saveTenant()}
              disabled={!activeTenant || !canEditTenant || isSavingTenant}
              className="inline-flex items-center gap-2 rounded-xl border border-blue-300 bg-blue-50 px-4 py-2.5 text-base font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSavingTenant ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {isSavingTenant ? "กำลังบันทึก..." : "บันทึกแบบฟอร์มย้ายออก"}
            </button>
            <button
              type="button"
              onClick={printMoveOutReceipt}
              disabled={!activeTenant}
              className="mb-2 inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-base font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={16} />
              พิมพ์ใบสรุปย้ายออก
            </button>
            <button
              onClick={() => setConfirmMoveOutOpen(true)}
              className="rounded-xl bg-red-600 px-4 py-2.5 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={!activeTenant || !canEditTenant || isMovingOut}
              title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
            >
              {isMovingOut ? "กำลังย้ายออก..." : "ยืนยันการย้ายออก"}
            </button>
          </fieldset>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={!activeTenant || !canEditTenant || isDeletingTenant}
            title={!canEditTenant ? "ไม่มีสิทธิ์ลบผู้เช่า" : undefined}
            className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2.5 text-base text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeletingTenant ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            {isDeletingTenant ? "กำลังลบ..." : "ลบผู้เช่า"}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsModalOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-base text-slate-600"
            >
              ยกเลิก
            </button>
            <button
              onClick={() => setConfirmSaveOpen(true)}
              disabled={!canEditTenant || isSavingTenant}
              title={!canEditTenant ? "ไม่มีสิทธิ์แก้ไขข้อมูลผู้เช่า" : undefined}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isSavingTenant ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {isSavingTenant ? "กำลังบันทึก..." : "บันทึกผู้เช่า"}
            </button>
          </div>
        </div>
        </div>
      </Modal>

      <ConfirmActionModal
        isOpen={confirmSaveOpen}
        title="บันทึกผู้เช่า"
        message="ยืนยันการบันทึกการเปลี่ยนแปลงข้อมูลผู้เช่าหรือไม่?"
        confirmLabel="บันทึก"
        loading={isSavingTenant}
        onCancel={() => setConfirmSaveOpen(false)}
        onConfirm={async () => {
          await saveTenant();
          setConfirmSaveOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmDeleteOpen}
        title="ลบผู้เช่า"
        message="การกระทำนี้ไม่สามารถย้อนกลับได้ ต้องการลบผู้เช่าหรือไม่?"
        confirmLabel="ลบ"
        loading={isDeletingTenant}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={async () => {
          await deleteTenant();
          setConfirmDeleteOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmUnlinkOpen}
        title="ยกเลิกการเชื่อม LINE"
        message="ต้องการลบ LINE ID ที่เชื่อมกับผู้เช่ารายนี้หรือไม่?"
        confirmLabel="ยกเลิกการเชื่อม"
        loading={isUnlinkingLine}
        onCancel={() => setConfirmUnlinkOpen(false)}
        onConfirm={async () => {
          await unlinkTenantLine();
          setConfirmUnlinkOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmMoveOutOpen}
        title="ยืนยันการย้ายออก"
        message="ยืนยันการย้ายออกของผู้เช่าและปรับสถานะห้องเป็นว่างหรือไม่?"
        confirmLabel="ยืนยัน"
        loading={isMovingOut}
        onCancel={() => setConfirmMoveOutOpen(false)}
        onConfirm={async () => {
          await confirmMoveOut();
          setConfirmMoveOutOpen(false);
        }}
      />
    </div>
  );
}




