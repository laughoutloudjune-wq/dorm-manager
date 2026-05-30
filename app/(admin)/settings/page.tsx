"use client";

import { toast } from "sonner";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { AppLocale, t } from "@/lib/i18n";
import { usePermissions } from "@/lib/use-permissions";
import {
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  RoleKey,
  RolePermissionMap,
  defaultRolePermissions,
  normalizeRolePermissions,
} from "@/lib/permissions";
import { Loader2, Lock, Plus, Save, Trash2, Upload } from "lucide-react";

type SettingsRow = {
  id: number;
  dorm_name: string | null;
  dorm_address: string | null;
  dorm_phone: string | null;
  water_rate: number | null;
  electricity_rate: number | null;
  common_fee: number | null;
  water_min_units: number | null;
  water_min_price: number | null;
  billing_day: number | null;
  due_day: number | null;
  late_fee_start_day: number | null;
  late_fee_per_day: number | null;
  ui_language: AppLocale | null;
  role_permissions: any;
  additional_fees: AdditionalFee[] | null;
  additional_discounts: AdditionalFee[] | null;
};

type AdditionalFee = {
  id: string;
  label: string;
  calc_type: "fixed" | "electricity_units" | "water_units";
  value: number;
};

type PaymentMethod = {
  id?: string;
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

type ReceiptProfile = {
  id?: string;
  label: string;
  company_name: string;
  tax_id: string;
  branch: string;
  address: string;
};

type Building = { id: string; name: string };
type Room = {
  id: string;
  room_number: string;
  room_type: string | null;
  price_month: number | null;
  status: string;
};

const tabs = ["General", "Utilities", "Invoice Config", "Payment Methods", "Rooms", "Access Control"] as const;

type PendingAction = {
  title: string;
  message: string;
  action: () => Promise<void>;
};

type UserRoleRow = {
  id: string;
  email: string | null;
  phone: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  role: RoleKey;
};

const toNumber = (value: string | number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const roomNumberCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const newFee = (): AdditionalFee => ({
  id: crypto.randomUUID(),
  label: "",
  calc_type: "fixed",
  value: 0,
});

const newPaymentMethod = (): PaymentMethod => ({
  label: "",
  bank_name: "",
  account_name: "",
  account_number: "",
  qr_url: null,
});

const newReceiptProfile = (): ReceiptProfile => ({
  label: "",
  company_name: "",
  tax_id: "",
  branch: "",
  address: "",
});

const roleLabelThai = (role: RoleKey) => {
  if (role === "owner") return "เจ้าของ";
  if (role === "admin") return "แอดมิน";
  if (role === "staff") return "พนักงาน";
  return "ดูอย่างเดียว";
};

const permissionLabelThai = (permission: (typeof PERMISSION_KEYS)[number]) => {
  const labels: Record<(typeof PERMISSION_KEYS)[number], string> = {
    "invoice.create": "สร้างใบแจ้งหนี้",
    "invoice.edit": "แก้ไขรายละเอียดใบแจ้งหนี้",
    "invoice.delete": "ลบใบแจ้งหนี้",
    "invoice.status.update": "เปลี่ยนสถานะใบแจ้งหนี้",
    "invoice.payment.record": "บันทึกการชำระเงิน/สลิป",
    "tenant.view": "ดูข้อมูลผู้เช่า",
    "tenant.edit": "แก้ไขข้อมูลผู้เช่า",
    "tenant.line.manage": "จัดการ LINE ผู้เช่า",
    "room.view": "ดูข้อมูลห้อง",
    "room.edit": "แก้ไขห้อง/อาคาร",
    "meter.edit": "แก้ไขมิเตอร์",
    "settings.general": "แก้ไขตั้งค่าทั่วไป",
    "settings.utilities": "แก้ไขค่าสาธารณูปโภค",
    "settings.invoice_config": "แก้ไขตั้งค่าใบแจ้งหนี้",
    "settings.payment_methods": "แก้ไขช่องทางชำระเงิน",
    "settings.rooms": "แก้ไขข้อมูลห้องในตั้งค่า",
    "settings.permissions": "แก้ไขสิทธิ์และบทบาท",
  };
  return labels[permission] ?? PERMISSION_LABELS[permission];
};

export default function SettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { can } = usePermissions();
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("General");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState<SettingsRow>({
    id: 1,
    dorm_name: "",
    dorm_address: "",
    dorm_phone: "",
    water_rate: 0,
    electricity_rate: 0,
    common_fee: 0,
    water_min_units: 0,
    water_min_price: 0,
    billing_day: 1,
    due_day: 5,
    late_fee_start_day: 6,
    late_fee_per_day: 0,
    ui_language: "th",
    role_permissions: {},
    additional_fees: [],
    additional_discounts: [],
  });

  const [fees, setFees] = useState<AdditionalFee[]>([]);
  const [discounts, setDiscounts] = useState<AdditionalFee[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [initialMethodIds, setInitialMethodIds] = useState<string[]>([]);
  const [receiptProfiles, setReceiptProfiles] = useState<ReceiptProfile[]>([]);
  const [initialReceiptProfileIds, setInitialReceiptProfileIds] = useState<string[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<string>("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [rolePermissions, setRolePermissions] = useState<RolePermissionMap>(defaultRolePermissions());
  const [userRoles, setUserRoles] = useState<UserRoleRow[]>([]);
  const [selectedAccessUserId, setSelectedAccessUserId] = useState<string>("");
  const [loadingUserRoles, setLoadingUserRoles] = useState(false);
  const [buildingName, setBuildingName] = useState("");
  const [buildingAddress, setBuildingAddress] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [roomType, setRoomType] = useState("");
  const [roomPrice, setRoomPrice] = useState(0);
  const [saving, setSaving] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const openConfirm = (pending: PendingAction) => {
    setPendingAction(pending);
    setConfirmOpen(true);
  };

  const tabPermission = (tab: (typeof tabs)[number]) => {
    if (tab === "General") return "settings.general" as const;
    if (tab === "Utilities") return "settings.utilities" as const;
    if (tab === "Invoice Config") return "settings.invoice_config" as const;
    if (tab === "Payment Methods") return "settings.payment_methods" as const;
    if (tab === "Rooms") return "settings.rooms" as const;
    return "settings.permissions" as const;
  };

  const tabLocked = (tab: (typeof tabs)[number]) => !can(tabPermission(tab));

  const requireTabPermission = (tab: (typeof tabs)[number], actionLabel: string) => {
    if (!tabLocked(tab)) return true;
    const message = `ไม่มีสิทธิ์${actionLabel}`;
    setStatusMessage(message);
    if (typeof window !== "undefined") toast.success(message);
    return false;
  };

  const panelClass = (base: string, tab: (typeof tabs)[number]) =>
    `${base} ${tabLocked(tab) ? "relative opacity-60 pointer-events-none cursor-not-allowed" : ""}`;

  const executePending = async () => {
    if (!pendingAction) return;
    setSaving(true);
    try {
      await pendingAction.action();
    } finally {
      setSaving(false);
      setConfirmOpen(false);
      setPendingAction(null);
    }
  };

  const loadSettings = async () => {
    const { data, error } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();

    if (error) {
      setStatusMessage(error.message);
      return;
    }

    if (!data) {
      const { data: inserted } = await supabase
        .from("settings")
        .insert({ id: 1 })
        .select("*")
        .single();
      if (inserted) {
        setSettings(inserted as SettingsRow);
        setRolePermissions(normalizeRolePermissions((inserted as any).role_permissions));
        setFees(Array.isArray(inserted.additional_fees) ? inserted.additional_fees : []);
        setDiscounts(
          Array.isArray((inserted as any).additional_discounts) ? (inserted as any).additional_discounts : []
        );
      }
      return;
    }

    setSettings(data as SettingsRow);
    setRolePermissions(normalizeRolePermissions((data as any).role_permissions));
    setFees(Array.isArray(data.additional_fees) ? data.additional_fees : []);
    setDiscounts(Array.isArray((data as any).additional_discounts) ? (data as any).additional_discounts : []);
  };

  const loadPaymentMethods = async () => {
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id,label,bank_name,account_name,account_number,qr_url")
      .order("label", { ascending: true });

    if (error) {
      setStatusMessage(error.message);
      setMethods([]);
      return;
    }

    const rows = (data as PaymentMethod[]) ?? [];
    setMethods(rows);
    setInitialMethodIds(rows.map((row) => row.id!).filter(Boolean));
  };

  const loadReceiptProfiles = async () => {
    const { data, error } = await supabase
      .from("receipt_profiles")
      .select("id,label,company_name,tax_id,branch,address")
      .order("label", { ascending: true });

    if (error) {
      setStatusMessage(error.message);
      setReceiptProfiles([]);
      return;
    }

    const rows = (data as ReceiptProfile[]) ?? [];
    setReceiptProfiles(rows);
    setInitialReceiptProfileIds(rows.map((row) => row.id!).filter(Boolean));
  };

  const loadBuildings = async () => {
    const { data, error } = await supabase
      .from("buildings")
      .select("id,name")
      .order("name", { ascending: true });
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    const rows = (data ?? []) as Building[];
    setBuildings(rows);
    if (!selectedBuilding && rows.length > 0) {
      setSelectedBuilding(rows[0].id);
    }
  };

  const getAuthHeaders = async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    } as const;
  };

  const callSettingsAction = async (action: string, payload: Record<string, unknown>) => {
    const response = await fetch("/api/admin/settings/actions", {
      method: "POST",
      headers: await getAuthHeaders(),
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error ?? "บันทึกการตั้งค่าไม่สำเร็จ");
    return data;
  };

  const loadUserRoles = async () => {
    setLoadingUserRoles(true);
    try {
      const response = await fetch("/api/admin/user-roles", {
        headers: await getAuthHeaders(),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatusMessage(data?.error ?? "โหลดรายการผู้ใช้ไม่สำเร็จ");
        setUserRoles([]);
        return;
      }
      const rows = (data?.users ?? []) as UserRoleRow[];
      setUserRoles(rows);
      setSelectedAccessUserId((prev) => prev || rows[0]?.id || "");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "โหลดรายการผู้ใช้ไม่สำเร็จ");
      setUserRoles([]);
    } finally {
      setLoadingUserRoles(false);
    }
  };

  const loadRooms = async (buildingId: string) => {
    if (!buildingId) {
      setRooms([]);
      return;
    }
    const { data, error } = await supabase
      .from("rooms")
      .select("id,room_number,room_type,price_month,status")
      .eq("building_id", buildingId)
      .order("room_number", { ascending: true });
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    const sorted = ((data ?? []) as Room[]).sort((a, b) =>
      roomNumberCompare(a.room_number, b.room_number)
    );
    setRooms(sorted);
  };

  useEffect(() => {
    loadSettings();
    loadPaymentMethods();
    loadReceiptProfiles();
    loadBuildings();
  }, []);

  useEffect(() => {
    if (activeTab === "Access Control" && !tabLocked("Access Control")) {
      void loadUserRoles();
    }
  }, [activeTab]);

  useEffect(() => {
    if (selectedBuilding) {
      loadRooms(selectedBuilding);
    }
  }, [selectedBuilding]);

  const saveGeneral = async () => {
    const payload = {
      dorm_name: settings.dorm_name,
      dorm_address: settings.dorm_address,
      dorm_phone: settings.dorm_phone,
      ui_language: settings.ui_language ?? "th",
      updated_at: new Date().toISOString(),
    };
    try {
      await callSettingsAction("save_general", { payload });
      setStatusMessage("บันทึกตั้งค่าทั่วไปเรียบร้อย");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกตั้งค่าทั่วไปไม่สำเร็จ");
    }
  };

  const saveUtilities = async () => {
    const payload = {
      water_rate: settings.water_rate,
      electricity_rate: settings.electricity_rate,
      common_fee: settings.common_fee,
      water_min_units: settings.water_min_units,
      water_min_price: settings.water_min_price,
      updated_at: new Date().toISOString(),
    };
    try {
      await callSettingsAction("save_utilities", { payload });
      setStatusMessage("บันทึกค่าสาธารณูปโภคเรียบร้อย");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกค่าสาธารณูปโภคไม่สำเร็จ");
    }
  };

  const saveInvoiceConfig = async () => {
    const cleaned = fees
      .filter((fee) => fee.label.trim().length > 0)
      .map((fee) => ({ ...fee, value: toNumber(fee.value) }));
    const cleanedDiscounts = discounts
      .filter((fee) => fee.label.trim().length > 0)
      .map((fee) => ({ ...fee, value: toNumber(fee.value) }));

    const payload = {
      common_fee: settings.common_fee,
      billing_day: toNumber(settings.billing_day ?? 1),
      due_day: toNumber(settings.due_day ?? 5),
      late_fee_start_day: toNumber(settings.late_fee_start_day ?? 6),
      late_fee_per_day: toNumber(settings.late_fee_per_day ?? 0),
      additional_fees: cleaned,
      additional_discounts: cleanedDiscounts,
      updated_at: new Date().toISOString(),
    };

    try {
      await callSettingsAction("save_invoice_config", { payload });
      setStatusMessage("บันทึกตั้งค่าใบแจ้งหนี้เรียบร้อย");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกตั้งค่าใบแจ้งหนี้ไม่สำเร็จ");
    }
  };

  const savePaymentMethods = async () => {
    const cleaned = methods.map((method) => ({
      id: method.id,
      label: method.label.trim(),
      bank_name: method.bank_name.trim(),
      account_name: method.account_name.trim(),
      account_number: method.account_number.trim(),
      qr_url: method.qr_url,
    }));

    try {
      await callSettingsAction("save_payment_methods", { methods: cleaned, initialMethodIds });
      setStatusMessage("บันทึกช่องทางชำระเงินเรียบร้อย");
      await loadPaymentMethods();
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกช่องทางชำระเงินไม่สำเร็จ");
    }
  };

  const saveReceiptProfiles = async () => {
    const cleaned = receiptProfiles.map((profile) => ({
      id: profile.id,
      label: profile.label.trim(),
      company_name: profile.company_name.trim(),
      tax_id: profile.tax_id.trim() || null,
      branch: profile.branch.trim() || null,
      address: profile.address.trim(),
    }));

    try {
      await callSettingsAction("save_receipt_profiles", {
        profiles: cleaned,
        initialProfileIds: initialReceiptProfileIds,
      });
      setStatusMessage("บันทึกข้อมูลออกใบเสร็จเรียบร้อย");
      await loadReceiptProfiles();
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกข้อมูลออกใบเสร็จไม่สำเร็จ");
    }
  };

  const uploadQr = async (index: number, file?: File | null) => {
    if (!file) return;

    const methodId = methods[index].id ?? crypto.randomUUID();
    if (!methods[index].id) {
      setMethods((prev) =>
        prev.map((item, idx) => (idx === index ? { ...item, id: methodId } : item))
      );
    }

    const path = `payment-methods/${methodId}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from("payment-methods")
      .upload(path, file, { upsert: true });

    if (uploadError) {
      setStatusMessage(uploadError.message);
      return;
    }

    const { data } = supabase.storage.from("payment-methods").getPublicUrl(path);
    setMethods((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, qr_url: data.publicUrl, id: methodId } : item))
    );
    setStatusMessage("อัปโหลด QR แล้ว กรุณากดบันทึกช่องทางชำระเงิน");
  };

  const removeMethod = (index: number) => {
    setMethods((prev) => prev.filter((_, idx) => idx !== index));
  };

  const removeReceiptProfile = (index: number) => {
    setReceiptProfiles((prev) => prev.filter((_, idx) => idx !== index));
  };

  const addBuilding = async () => {
    if (!buildingName.trim()) {
      setStatusMessage("กรุณากรอกชื่ออาคาร");
      return;
    }
    let data: any = null;
    try {
      const result = await callSettingsAction("add_building", {
        payload: { name: buildingName.trim(), address: buildingAddress.trim() || null },
      });
      data = result?.data;
    } catch (error: any) {
      setStatusMessage(error?.message ?? "เพิ่มอาคารไม่สำเร็จ");
      return;
    }
    setBuildingName("");
    setBuildingAddress("");
    setStatusMessage("เพิ่มอาคารเรียบร้อย");
    await loadBuildings();
    if (data?.id) setSelectedBuilding(data.id);
  };

  const addRoom = async () => {
    if (!selectedBuilding) {
      setStatusMessage("กรุณาเลือกอาคาร");
      return;
    }
    if (!roomNumber.trim()) {
      setStatusMessage("กรุณากรอกเลขห้อง");
      return;
    }
    try {
      await callSettingsAction("add_room", {
        payload: {
          building_id: selectedBuilding,
          room_number: roomNumber.trim(),
          room_type: roomType.trim() || null,
          price_month: roomPrice > 0 ? roomPrice : null,
          status: "available",
        },
      });
    } catch (error: any) {
      setStatusMessage(error?.message ?? "เพิ่มห้องไม่สำเร็จ");
      return;
    }
    setRoomNumber("");
    setRoomType("");
    setRoomPrice(0);
    setStatusMessage("เพิ่มห้องเรียบร้อย");
    await loadRooms(selectedBuilding);
  };

  const saveRooms = async () => {
    try {
      await callSettingsAction("save_rooms", {
        rooms: rooms.map((room) => ({
          id: room.id,
          room_number: room.room_number,
          room_type: room.room_type,
          price_month: room.price_month,
          status: room.status,
        })),
      });
      setStatusMessage("บันทึกการเปลี่ยนแปลงห้องเรียบร้อย");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกการเปลี่ยนแปลงห้องไม่สำเร็จ");
    }
  };

  const deleteRoom = async (roomId: string) => {
    try {
      await callSettingsAction("delete_room", { roomId });
    } catch (error: any) {
      setStatusMessage(error?.message ?? "ลบห้องไม่สำเร็จ");
      return;
    }
    setRooms((prev) => prev.filter((room) => room.id !== roomId));
    setStatusMessage("ลบห้องเรียบร้อย");
  };

  const savePermissions = async () => {
    try {
      await callSettingsAction("save_permissions", { role_permissions: rolePermissions });
      setStatusMessage("บันทึกสิทธิ์เรียบร้อย");
    } catch (error: any) {
      setStatusMessage(error?.message ?? "บันทึกสิทธิ์ไม่สำเร็จ");
    }
  };

  const togglePermission = (role: RoleKey, permission: (typeof PERMISSION_KEYS)[number]) => {
    setRolePermissions((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        [permission]: !prev[role][permission],
      },
    }));
  };

  const saveUserRole = async (userId: string, role: RoleKey) => {
    const response = await fetch("/api/admin/user-roles", {
      method: "POST",
      headers: await getAuthHeaders(),
      body: JSON.stringify({ userId, role }),
    });
    const data = await response.json().catch(() => ({}));
    setStatusMessage(response.ok ? "บันทึกบทบาทผู้ใช้เรียบร้อย" : data?.error ?? "บันทึกบทบาทผู้ใช้ไม่สำเร็จ");
    if (response.ok) {
      setUserRoles((prev) =>
        prev.map((row) => (row.id === userId ? { ...row, role } : row))
      );
    }
  };

  const locale = (settings.ui_language ?? "th") as AppLocale;
  const tabLabel = (tab: (typeof tabs)[number]) => {
    if (tab === "General") return "ทั่วไป";
    if (tab === "Utilities") return "ค่าน้ำ/ค่าไฟ";
    if (tab === "Invoice Config") return "ตั้งค่าใบแจ้งหนี้";
    if (tab === "Payment Methods") return "ช่องทางชำระเงิน";
    if (tab === "Rooms") return "ห้อง";
    if (tab === "Access Control") return "สิทธิ์และบทบาท";
    return "สิทธิ์";
  };

  const selectedAccessUser = userRoles.find((row) => row.id === selectedAccessUserId) ?? userRoles[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              if (tabLocked(tab)) {
                setStatusMessage("ส่วนนี้ถูกล็อกสำหรับสิทธิ์ของคุณ");
                return;
              }
              setActiveTab(tab);
            }}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition hover-lift animate-soft-pop ${
              activeTab === tab
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 border border-slate-200 hover:border-blue-200"
            } ${tabLocked(tab) ? "cursor-not-allowed border-red-200 text-red-600 hover:border-red-300" : ""}`}
            title={tabLocked(tab) ? "ถูกล็อก: ไม่มีสิทธิ์" : undefined}
          >
            <span className="inline-flex items-center gap-2">
              {tabLabel(tab)}
              {tabLocked(tab) && <Lock size={12} />}
            </span>
          </button>
        ))}
      </div>

      {statusMessage && <Badge variant="info">{statusMessage}</Badge>}
      {tabLocked(activeTab) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          ส่วนนี้ถูกล็อกสำหรับสิทธิ์ของคุณ
        </div>
      )}

      {activeTab === "General" && (
        <div className={panelClass("space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "General")}>
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="ชื่อหอพัก"
              value={settings.dorm_name ?? ""}
              onChange={(event) => setSettings((prev) => ({ ...prev, dorm_name: event.target.value }))}
            />
            <Input
              label="เบอร์โทร"
              value={settings.dorm_phone ?? ""}
              onChange={(event) => setSettings((prev) => ({ ...prev, dorm_phone: event.target.value }))}
            />
            <label className="text-sm text-slate-600">
              {t(locale, "ui_language")}
              <select
                value={settings.ui_language ?? "th"}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, ui_language: event.target.value as AppLocale }))
                }
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
              >
                <option value="th">{t(locale, "thai")}</option>
                <option value="en">{t(locale, "english")}</option>
              </select>
            </label>
            <label className="md:col-span-2 text-sm text-slate-600">
              ที่อยู่
              <textarea
                value={settings.dorm_address ?? ""}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, dorm_address: event.target.value }))
                }
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
              />
            </label>
          </div>
          <button
            onClick={() =>
              openConfirm({
                title: "บันทึกตั้งค่าทั่วไป",
                message: "ยืนยันการบันทึกตั้งค่าทั่วไป?",
                action: saveGeneral,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            บันทึกตั้งค่าทั่วไป
          </button>
        </div>
      )}

      {activeTab === "Utilities" && (
        <div className={panelClass("space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "Utilities")}>
          <div className="grid gap-4 md:grid-cols-3">
            <Input
              label="ค่าไฟต่อหน่วย"
              type="number"
              value={settings.electricity_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, electricity_rate: toNumber(event.target.value) }))
              }
            />
            <Input
              label="ค่าน้ำต่อหน่วย"
              type="number"
              value={settings.water_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, water_rate: toNumber(event.target.value) }))
              }
            />
            <Input
              label="ค่าส่วนกลาง"
              type="number"
              value={settings.common_fee ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, common_fee: toNumber(event.target.value) }))
              }
            />
            <Input
              label="หน่วยน้ำขั้นต่ำ"
              type="number"
              value={settings.water_min_units ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, water_min_units: toNumber(event.target.value) }))
              }
            />
            <Input
              label="ราคาน้ำขั้นต่ำ"
              type="number"
              value={settings.water_min_price ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, water_min_price: toNumber(event.target.value) }))
              }
            />
          </div>
          <button
            onClick={() =>
              openConfirm({
                title: "บันทึกตั้งค่าสาธารณูปโภค",
                message: "ยืนยันการบันทึกตั้งค่าสาธารณูปโภค?",
                action: saveUtilities,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            บันทึกค่าน้ำ/ค่าไฟ
          </button>
        </div>
      )}

      {activeTab === "Invoice Config" && (
        <div className={panelClass("space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "Invoice Config")}>
          <div className="grid gap-4 md:grid-cols-3">
            <Input
              label="ค่าส่วนกลาง"
              type="number"
              value={settings.common_fee ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, common_fee: toNumber(event.target.value) }))
              }
            />
            <Input
              label="วันตัดรอบบิล (1-28)"
              type="number"
              value={settings.billing_day ?? 1}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, billing_day: toNumber(event.target.value) }))
              }
            />
            <Input
              label="วันครบกำหนดชำระ (1-28)"
              type="number"
              value={settings.due_day ?? 5}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, due_day: toNumber(event.target.value) }))
              }
            />
            <Input
              label="วันเริ่มคิดค่าปรับ (1-28)"
              type="number"
              value={settings.late_fee_start_day ?? 6}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  late_fee_start_day: toNumber(event.target.value),
                }))
              }
            />
            <Input
              label="ค่าปรับต่อวัน"
              type="number"
              value={settings.late_fee_per_day ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  late_fee_per_day: toNumber(event.target.value),
                }))
              }
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">ค่าธรรมเนียมเพิ่มเติม</p>
              <button
                onClick={() => setFees((prev) => [...prev, newFee()])}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Plus size={14} />
                เพิ่มค่าธรรมเนียม
              </button>
            </div>

            {fees.map((fee, index) => (
              <div key={fee.id} className="grid gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-4">
                <Input
                  label="ชื่อค่าธรรมเนียม"
                  value={fee.label}
                  onChange={(event) =>
                    setFees((prev) =>
                      prev.map((item, idx) => (idx === index ? { ...item, label: event.target.value } : item))
                    )
                  }
                />
                <label className="text-sm text-slate-600">
                  วิธีคำนวณ
                  <select
                    value={fee.calc_type}
                    onChange={(event) =>
                      setFees((prev) =>
                        prev.map((item, idx) =>
                          idx === index
                            ? {
                                ...item,
                                calc_type: event.target.value as AdditionalFee["calc_type"],
                              }
                            : item
                        )
                      )
                    }
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  >
                    <option value="fixed">จำนวนเงินคงที่</option>
                    <option value="electricity_units">คิดตามหน่วยไฟ</option>
                    <option value="water_units">คิดตามหน่วยน้ำ</option>
                  </select>
                </label>
                <Input
                  label={fee.calc_type === "fixed" ? "จำนวนเงิน" : "อัตรา / หน่วย"}
                  type="number"
                  value={fee.value}
                  onChange={(event) =>
                    setFees((prev) =>
                      prev.map((item, idx) =>
                        idx === index ? { ...item, value: toNumber(event.target.value) } : item
                      )
                    )
                  }
                />
                <div className="flex items-end">
                  <button
                    onClick={() =>
                      openConfirm({
                        title: "ลบค่าธรรมเนียม",
                        message: "ยืนยันการลบค่าธรรมเนียมนี้?",
                        action: async () => {
                          setFees((prev) => prev.filter((_, idx) => idx !== index));
                          setStatusMessage("ลบรายการออกจากตารางแล้ว กรุณากดบันทึกตั้งค่าใบแจ้งหนี้");
                        },
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    ลบ
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">กฎส่วนลด</p>
              <button
                onClick={() => setDiscounts((prev) => [...prev, newFee()])}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Plus size={14} />
                เพิ่มส่วนลด
              </button>
            </div>

            {discounts.map((fee, index) => (
              <div key={`discount-${fee.id}`} className="grid gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-4">
                <Input
                  label="ชื่อส่วนลด"
                  value={fee.label}
                  onChange={(event) =>
                    setDiscounts((prev) =>
                      prev.map((item, idx) => (idx === index ? { ...item, label: event.target.value } : item))
                    )
                  }
                />
                <label className="text-sm text-slate-600">
                  วิธีคำนวณ
                  <select
                    value={fee.calc_type}
                    onChange={(event) =>
                      setDiscounts((prev) =>
                        prev.map((item, idx) =>
                          idx === index
                            ? {
                                ...item,
                                calc_type: event.target.value as AdditionalFee["calc_type"],
                              }
                            : item
                        )
                      )
                    }
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                  >
                    <option value="fixed">จำนวนเงินคงที่</option>
                    <option value="electricity_units">คิดตามหน่วยไฟ</option>
                    <option value="water_units">คิดตามหน่วยน้ำ</option>
                  </select>
                </label>
                <Input
                  label={fee.calc_type === "fixed" ? "จำนวนเงิน" : "อัตรา / หน่วย"}
                  type="number"
                  value={fee.value}
                  onChange={(event) =>
                    setDiscounts((prev) =>
                      prev.map((item, idx) =>
                        idx === index ? { ...item, value: toNumber(event.target.value) } : item
                      )
                    )
                  }
                />
                <div className="flex items-end">
                  <button
                    onClick={() =>
                      openConfirm({
                        title: "ลบส่วนลด",
                        message: "ยืนยันการลบส่วนลดนี้?",
                        action: async () => {
                          setDiscounts((prev) => prev.filter((_, idx) => idx !== index));
                          setStatusMessage("ลบรายการส่วนลดออกจากตารางแล้ว กรุณากดบันทึกตั้งค่าใบแจ้งหนี้");
                        },
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    ลบ
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() =>
              openConfirm({
                title: "บันทึกตั้งค่าใบแจ้งหนี้",
                message: "ยืนยันการบันทึกตั้งค่าใบแจ้งหนี้?",
                action: saveInvoiceConfig,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            บันทึกตั้งค่าใบแจ้งหนี้
          </button>
        </div>
      )}

      {activeTab === "Payment Methods" && (
        <div className={panelClass("space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "Payment Methods")}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800">ช่องทางชำระเงิน</p>
            <button
              onClick={() => setMethods((prev) => [...prev, newPaymentMethod()])}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
            >
              <Plus size={14} />
              เพิ่มช่องทางชำระเงิน
            </button>
          </div>

          <div className="space-y-3">
            {methods.map((method, index) => (
              <div key={method.id ?? `new-${index}`} className="rounded-xl border border-slate-200 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    label="ชื่อแสดงผล"
                    value={method.label}
                    onChange={(event) =>
                      setMethods((prev) =>
                        prev.map((item, idx) =>
                          idx === index ? { ...item, label: event.target.value } : item
                        )
                      )
                    }
                  />
                  <Input
                    label="ธนาคาร"
                    value={method.bank_name}
                    onChange={(event) =>
                      setMethods((prev) =>
                        prev.map((item, idx) =>
                          idx === index ? { ...item, bank_name: event.target.value } : item
                        )
                      )
                    }
                  />
                  <Input
                    label="ชื่อบัญชี"
                    value={method.account_name}
                    onChange={(event) =>
                      setMethods((prev) =>
                        prev.map((item, idx) =>
                          idx === index ? { ...item, account_name: event.target.value } : item
                        )
                      )
                    }
                  />
                  <Input
                    label="เลขบัญชี"
                    value={method.account_number}
                    onChange={(event) =>
                      setMethods((prev) =>
                        prev.map((item, idx) =>
                          idx === index ? { ...item, account_number: event.target.value } : item
                        )
                      )
                    }
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
                    <Upload size={14} />
                    อัปโหลด QR
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => uploadQr(index, event.target.files?.[0])}
                    />
                  </label>

                  {method.qr_url && (
                    <a
                      href={method.qr_url}
                      target="_blank"
                      className="text-sm text-blue-600 underline"
                      rel="noreferrer"
                    >
                      ดู QR
                    </a>
                  )}

                  <button
                    onClick={() =>
                      openConfirm({
                        title: "ลบช่องทางชำระเงิน",
                        message: "ยืนยันการลบช่องทางชำระเงินนี้?",
                        action: async () => removeMethod(index),
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    ลบ
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() =>
              openConfirm({
                title: "บันทึกช่องทางชำระเงิน",
                message: "ยืนยันการบันทึกช่องทางชำระเงิน?",
                action: savePaymentMethods,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            บันทึกช่องทางชำระเงิน
          </button>

          <div className="mt-6 border-t border-slate-200 pt-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">ข้อมูลออกใบเสร็จ (นิติบุคคล)</p>
              <button
                onClick={() => setReceiptProfiles((prev) => [...prev, newReceiptProfile()])}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Plus size={14} />
                เพิ่มโปรไฟล์ใบเสร็จ
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {receiptProfiles.map((profile, index) => (
                <div key={profile.id ?? `receipt-${index}`} className="rounded-xl border border-slate-200 p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <Input
                      label="ชื่อโปรไฟล์"
                      value={profile.label}
                      onChange={(event) =>
                        setReceiptProfiles((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, label: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Input
                      label="ชื่อนิติบุคคล/บริษัท"
                      value={profile.company_name}
                      onChange={(event) =>
                        setReceiptProfiles((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, company_name: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Input
                      label="เลขผู้เสียภาษี"
                      value={profile.tax_id}
                      onChange={(event) =>
                        setReceiptProfiles((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, tax_id: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Input
                      label="สาขา"
                      value={profile.branch}
                      onChange={(event) =>
                        setReceiptProfiles((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, branch: event.target.value } : item
                          )
                        )
                      }
                    />
                    <div className="md:col-span-2">
                      <Input
                        label="ที่อยู่ออกใบเสร็จ"
                        value={profile.address}
                        onChange={(event) =>
                          setReceiptProfiles((prev) =>
                            prev.map((item, idx) =>
                              idx === index ? { ...item, address: event.target.value } : item
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={() =>
                        openConfirm({
                          title: "ลบโปรไฟล์ใบเสร็จ",
                          message: "ยืนยันการลบโปรไฟล์ใบเสร็จนี้?",
                          action: async () => removeReceiptProfile(index),
                        })
                      }
                      className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                    >
                      <Trash2 size={14} />
                      ลบ
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() =>
                openConfirm({
                  title: "บันทึกโปรไฟล์ใบเสร็จ",
                  message: "ยืนยันการบันทึกข้อมูลออกใบเสร็จ?",
                  action: saveReceiptProfiles,
                })
              }
              className="mt-3 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Save size={16} />
              บันทึกโปรไฟล์ใบเสร็จ
            </button>
          </div>
        </div>
      )}

      {activeTab === "Rooms" && (
        <div className={panelClass("space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "Rooms")}>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-800">เพิ่มอาคาร</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Input
                label="ชื่ออาคาร"
                value={buildingName}
                onChange={(event) => setBuildingName(event.target.value)}
                placeholder="อาคาร A"
              />
              <Input
                label="ที่อยู่"
                value={buildingAddress}
                onChange={(event) => setBuildingAddress(event.target.value)}
                placeholder="ไม่บังคับ"
              />
              <div className="flex items-end">
                <button
                  onClick={() =>
                    openConfirm({
                      title: "เพิ่มอาคาร",
                      message: "ยืนยันการเพิ่มอาคารนี้?",
                      action: addBuilding,
                    })
                  }
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  <Plus size={16} />
                  เพิ่มอาคาร
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-600">
              อาคาร
              <select
                value={selectedBuilding}
                onChange={(event) => setSelectedBuilding(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
              >
                {buildings.length === 0 && <option value="">ไม่มีอาคาร</option>}
                {buildings.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="เลขห้อง"
              value={roomNumber}
              onChange={(event) => setRoomNumber(event.target.value)}
            />
            <Input
              label="ประเภทห้อง"
              value={roomType}
              onChange={(event) => setRoomType(event.target.value)}
            />
            <Input
              label="ราคา / เดือน"
              type="number"
              value={roomPrice}
              onChange={(event) => setRoomPrice(toNumber(event.target.value))}
            />
            <button
              onClick={() =>
                openConfirm({
                  title: "เพิ่มห้อง",
                  message: "ยืนยันการเพิ่มห้องนี้?",
                  action: addRoom,
                })
              }
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Plus size={16} />
              เพิ่มห้อง
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">เลขห้อง</th>
                  <th className="px-4 py-3">ประเภทห้อง</th>
                  <th className="px-4 py-3">ราคา / เดือน</th>
                  <th className="px-4 py-3">สถานะ</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {[...rooms]
                  .sort((a, b) => roomNumberCompare(a.room_number, b.room_number))
                  .map((room) => (
                  <tr key={room.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <input
                        value={room.room_number}
                        onChange={(event) =>
                          setRooms((prev) =>
                            prev.map((item) =>
                              item.id === room.id
                                ? { ...item, room_number: event.target.value }
                                : item
                            )
                          )
                        }
                        className="w-32 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        value={room.room_type ?? ""}
                        onChange={(event) =>
                          setRooms((prev) =>
                            prev.map((item) =>
                              item.id === room.id
                                ? { ...item, room_type: event.target.value }
                                : item
                            )
                          )
                        }
                        className="w-36 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        value={room.price_month ?? 0}
                        onChange={(event) =>
                          setRooms((prev) =>
                            prev.map((item) =>
                              item.id === room.id
                                ? { ...item, price_month: toNumber(event.target.value) }
                                : item
                            )
                          )
                        }
                        className="w-28 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={room.status}
                        onChange={(event) =>
                          setRooms((prev) =>
                            prev.map((item) =>
                              item.id === room.id ? { ...item, status: event.target.value } : item
                            )
                          )
                        }
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                      >
                        <option value="available">ว่าง</option>
                        <option value="occupied">มีผู้เช่า</option>
                        <option value="maintenance">ซ่อมบำรุง</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() =>
                          openConfirm({
                            title: "ลบห้อง",
                            message: "ยืนยันการลบห้องนี้?",
                            action: async () => deleteRoom(room.id),
                          })
                        }
                        className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-1 text-xs text-red-600"
                      >
                        <Trash2 size={12} />
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={() =>
              openConfirm({
                title: "บันทึกข้อมูลห้อง",
                message: "ยืนยันการบันทึกการเปลี่ยนแปลงห้องทั้งหมด?",
                action: saveRooms,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            บันทึกการเปลี่ยนแปลงห้อง
          </button>
        </div>
      )}

      {activeTab === "Access Control" && (
        <div className={panelClass("space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-fade-in-up", "Access Control")}>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            จัดการบทบาทผู้ใช้และสิทธิ์ในหน้าเดียวกัน เมื่อคลิกผู้ใช้ ระบบจะแสดงสิทธิ์ที่ได้จากบทบาทนั้นทันที
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-800">ผู้ใช้และบทบาท</p>
                <button
                  onClick={() => void loadUserRoles()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"
                >
                  รีเฟรช
                </button>
              </div>
              {loadingUserRoles ? (
                <div className="space-y-3 animate-pulse">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex h-14 items-center gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4">
                      <div className="h-4 w-32 rounded bg-slate-200"></div>
                      <div className="h-4 w-24 rounded bg-slate-200"></div>
                      <div className="h-8 w-24 rounded-lg bg-slate-200"></div>
                      <div className="h-8 w-24 rounded-lg bg-slate-200"></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-slate-100 text-slate-600">
                      <tr>
                        <th className="px-4 py-3 text-left">อีเมล</th>
                        <th className="px-4 py-3 text-left">เข้าใช้ล่าสุด</th>
                        <th className="px-4 py-3 text-left">บทบาท</th>
                        <th className="px-4 py-3 text-left">บันทึก</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userRoles.map((user) => (
                        <tr
                          key={user.id}
                          onClick={() => setSelectedAccessUserId(user.id)}
                          className={`border-t border-slate-100 cursor-pointer ${
                            selectedAccessUser?.id === user.id ? "bg-blue-50" : "hover:bg-slate-50"
                          }`}
                          title="คลิกเพื่อดูสิทธิ์ของผู้ใช้นี้"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">{user.email ?? "-"}</div>
                            <div className="font-mono text-[11px] text-slate-500">{user.id}</div>
                            {user.phone && <div className="text-xs text-slate-500">{user.phone}</div>}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString("th-TH") : "ไม่เคย"}
                          </td>
                          <td className="px-4 py-3">
                            <select
                              value={user.role}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(event) =>
                                setUserRoles((prev) =>
                                  prev.map((row) =>
                                    row.id === user.id ? { ...row, role: event.target.value as RoleKey } : row
                                  )
                                )
                              }
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                            >
                              <option value="owner">owner</option>
                              <option value="admin">admin</option>
                              <option value="staff">staff</option>
                              <option value="viewer">viewer</option>
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openConfirm({
                                  title: "บันทึกบทบาทผู้ใช้",
                                  message: `ตั้งค่าบทบาทสำหรับ ${user.email ?? user.id} ใช่หรือไม่?`,
                                  action: async () => saveUserRole(user.id, user.role),
                                });
                              }}
                              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"
                            >
                              <Save size={12} />
                              บันทึกบทบาท
                            </button>
                          </td>
                        </tr>
                      ))}
                      {userRoles.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
                            ไม่พบผู้ใช้ในระบบ Auth
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold text-slate-800">สิทธิ์ของผู้ใช้ที่เลือก</p>
              {selectedAccessUser ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="space-y-1 border-b border-slate-200 pb-3">
                    <p className="font-semibold text-slate-900">{selectedAccessUser.email ?? "-"}</p>
                    <p className="text-xs text-slate-500 font-mono">{selectedAccessUser.id}</p>
                    <p className="text-sm text-slate-700">
                      บทบาท: <span className="font-semibold">{roleLabelThai(selectedAccessUser.role)} ({selectedAccessUser.role})</span>
                    </p>
                  </div>
                  <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
                    {PERMISSION_KEYS.map((permission) => {
                      const allowed = !!rolePermissions[selectedAccessUser.role]?.[permission];
                      return (
                        <div
                          key={`selected-${selectedAccessUser.id}-${permission}`}
                          className={`rounded-lg border px-3 py-2 text-sm ${
                            allowed ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="font-medium text-slate-800">{permissionLabelThai(permission)}</div>
                              <div className="text-xs text-slate-500">{permission}</div>
                            </div>
                            <span className={`text-xs font-semibold ${allowed ? "text-green-700" : "text-red-700"}`}>
                              {allowed ? "อนุญาต" : "ไม่อนุญาต"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  เลือกผู้ใช้จากตารางด้านซ้ายเพื่อดูสิทธิ์
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-800">ตารางสิทธิ์ตามบทบาท</p>
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left">สิทธิ์</th>
                    {(["owner", "admin", "staff", "viewer"] as RoleKey[]).map((role) => (
                      <th key={role} className="px-4 py-3 text-center">
                        {roleLabelThai(role)}
                        <div className="text-[11px] font-normal text-slate-500">{role}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_KEYS.map((permission) => (
                    <tr key={permission} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{permissionLabelThai(permission)}</div>
                        <div className="text-xs text-slate-500">{permission}</div>
                      </td>
                      {(["owner", "admin", "staff", "viewer"] as RoleKey[]).map((role) => (
                        <td key={`${role}-${permission}`} className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={!!rolePermissions[role]?.[permission]}
                            onChange={() => togglePermission(role, permission)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={() =>
                openConfirm({
                  title: "บันทึกสิทธิ์",
                  message: "ยืนยันการบันทึกสิทธิ์ตามบทบาท?",
                  action: savePermissions,
                })
              }
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Save size={16} />
              บันทึกสิทธิ์
            </button>
          </div>
        </div>
      )}

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} title={pendingAction?.title ?? "ยืนยัน"} size="md">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{pendingAction?.message}</p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700"
              disabled={saving}
            >
              ยกเลิก
            </button>
            <button
              onClick={executePending}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saving}
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? "กำลังบันทึก..." : "ยืนยัน"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
