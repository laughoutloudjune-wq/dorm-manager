"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { Plus, Save, Search, Trash2, Upload } from "lucide-react";

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

type SettingsRates = {
  water_rate: number;
  electricity_rate: number;
};

const toNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    return roomRel.buildings[0]?.name ?? "Unassigned";
  }
  const room = roomsById.get(tenant.room_id);
  if (!room?.buildings) return "Unassigned";
  if (Array.isArray(room.buildings)) return room.buildings[0]?.name ?? "Unassigned";
  return room.buildings.name ?? "Unassigned";
};

const leaseEndDateText = (moveInDate: string, leaseMonths: number) => {
  const start = new Date(moveInDate);
  const end = new Date(start);
  end.setMonth(end.getMonth() + leaseMonths);
  return end.toISOString().slice(0, 10);
};

export default function TenantsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [rates, setRates] = useState<SettingsRates>({ water_rate: 0, electricity_rate: 0 });
  const [search, setSearch] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTenant, setActiveTenant] = useState<TenantRow | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "move_in" | "move_out">("info");
  const [useCustomPayment, setUseCustomPayment] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [latestPrevElectricity, setLatestPrevElectricity] = useState(0);
  const [latestPrevWater, setLatestPrevWater] = useState(0);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);

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
  });

  const loadTenants = async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,custom_payment_method,rooms(room_number,price_month,buildings(name))"
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
    setRooms((data ?? []) as RoomRow[]);
  };

  const loadMethods = async () => {
    const { data } = await supabase
      .from("payment_methods")
      .select("id,label,bank_name,account_name,account_number,qr_url")
      .order("label", { ascending: true });
    setMethods((data ?? []) as PaymentMethod[]);
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
    void loadTenants();
    void loadRooms();
    void loadMethods();
    void loadRates();
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
      });
      const custom = tenant.custom_payment_method;
      if (custom?.methodId) {
        setUseCustomPayment(true);
        setSelectedMethodId(custom.methodId);
      } else {
        setUseCustomPayment(false);
        setSelectedMethodId("");
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
      });
      setUseCustomPayment(false);
      setSelectedMethodId("");
      setLatestPrevElectricity(0);
      setLatestPrevWater(0);
    }

    setIsModalOpen(true);
  };

  const uploadDepositSlip = async (file?: File | null) => {
    if (!file) return;
    const tenantId = activeTenant?.id ?? crypto.randomUUID();
    const path = `tenant-docs/${tenantId}/${Date.now()}-${file.name}`;

    const { error } = await supabase.storage.from("tenant-docs").upload(path, file, { upsert: true });
    if (error) {
      setStatus(error.message);
      return;
    }

    const { data } = supabase.storage.from("tenant-docs").getPublicUrl(path);
    setForm((prev) => ({ ...prev, deposit_slip_url: data.publicUrl }));
    setStatus("Deposit slip uploaded.");
  };

  const saveTenant = async () => {
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
      deposit_slip_url: form.deposit_slip_url || null,
      final_electricity_reading: toNumber(form.final_electricity_reading),
      final_water_reading: toNumber(form.final_water_reading),
      custom_payment_method: customPayment,
    };

    if (activeTenant?.id) payload.id = activeTenant.id;

    const { error } = await supabase.from("tenants").upsert(payload, { onConflict: "id" });
    if (error) {
      setStatus(error.message);
      return;
    }

    if (form.room_id) {
      await supabase.from("rooms").update({ status: "occupied" }).eq("id", form.room_id);
    }

    await loadTenants();
    setStatus("Tenant saved.");
    if (activeTenant?.id) {
      const { data: refreshed } = await supabase
        .from("tenants")
        .select(
          "id,full_name,address,phone_number,line_user_id,move_in_date,move_out_date,status,room_id,lease_months,initial_electricity_reading,initial_water_reading,advance_rent_amount,security_deposit_amount,deposit_slip_url,final_electricity_reading,final_water_reading,custom_payment_method,rooms(room_number,price_month,buildings(name))"
        )
        .eq("id", activeTenant.id)
        .maybeSingle();
      if (refreshed) {
        setActiveTenant(refreshed as TenantRow);
      }
    }
  };

  const deleteTenant = async () => {
    if (!activeTenant) return;
    const { error } = await supabase.from("tenants").delete().eq("id", activeTenant.id);
    if (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Tenant deleted.");
    setIsModalOpen(false);
    await loadTenants();
  };

  const unlinkTenantLine = async () => {
    if (!activeTenant) return;
    const { error } = await supabase.from("tenants").update({ line_user_id: null }).eq("id", activeTenant.id);
    if (error) {
      setStatus(error.message);
      return;
    }
    setActiveTenant({ ...activeTenant, line_user_id: null });
    setStatus("LINE link removed.");
    await loadTenants();
  };

  const confirmMoveOut = async () => {
    if (!activeTenant) return;
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from("tenants")
      .update({
        status: "inactive",
        move_out_date: today,
        final_electricity_reading: toNumber(form.final_electricity_reading),
        final_water_reading: toNumber(form.final_water_reading),
      })
      .eq("id", activeTenant.id);

    if (error) {
      setStatus(error.message);
      return;
    }

    await supabase.from("rooms").update({ status: "available" }).eq("id", activeTenant.room_id);
    setStatus("Move out confirmed.");
    setIsModalOpen(false);
    await loadTenants();
  };

  const roomsById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);

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
  const totalCost = roomPrice + utilityTotal;
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
            placeholder="Search by name or room"
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
          />
        </div>
        <button
          onClick={() => void openModal()}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20"
        >
          <Plus size={16} />
          Add Tenant
        </button>
      </div>

      {status && <Badge variant="info">{status}</Badge>}

      {Object.entries(groupedTenants)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .map(([building, buildingTenants]) => (
          <div key={building} className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Tenant</th>
                    <th className="px-4 py-3">Room</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {buildingTenants.map((tenant) => (
                    <tr key={tenant.id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{tenant.full_name}</td>
                      <td className="px-4 py-3">{tenantRoomNumber(tenant, roomsById)}</td>
                      <td className="px-4 py-3">{tenant.phone_number ?? "-"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={tenant.status === "active" ? "success" : "warning"}>
                          {tenant.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
                          onClick={() => void openModal(tenant)}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Tenant Details" size="xl">
        <div className="mb-4 flex gap-2">
          <button
            className={`rounded-full px-3 py-1.5 text-sm ${activeTab === "info" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("info")}
          >
            Info
          </button>
          <button
            className={`rounded-full px-3 py-1.5 text-sm ${activeTab === "move_in" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("move_in")}
          >
            Move In
          </button>
          <button
            className={`rounded-full px-3 py-1.5 text-sm ${activeTab === "move_out" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setActiveTab("move_out")}
          >
            Move Out
          </button>
        </div>

        {activeTab === "info" && (
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Full Name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <Input label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Input label="Phone" value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
            <label className="text-sm text-slate-600">
              Room
              <select
                value={form.room_id}
                onChange={(event) => setForm({ ...form, room_id: event.target.value })}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
              >
                <option value="">Select room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {roomLabel(room)}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-2 md:col-span-2">
              <p className="text-sm font-medium text-slate-700">Payment Method</p>
              <div className="flex items-center gap-3 text-sm text-slate-600">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!useCustomPayment} onChange={() => setUseCustomPayment(false)} />
                  Use default dorm payment
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={useCustomPayment} onChange={() => setUseCustomPayment(true)} />
                  Assign specific bank/QR
                </label>
              </div>
              {useCustomPayment && (
                <select
                  value={selectedMethodId}
                  onChange={(event) => setSelectedMethodId(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
                >
                  <option value="">Select payment method</option>
                  {methods.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.label} - {method.bank_name} ({method.account_number})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-2 md:col-span-2 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-700">LINE Connection</p>
              <div
                className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                  activeTenant?.line_user_id
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                {activeTenant?.line_user_id ? "LINE connected" : "LINE not connected"}
              </div>
              <button
                onClick={() => setConfirmUnlinkOpen(true)}
                disabled={!activeTenant?.line_user_id}
                className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600 disabled:opacity-50"
              >
                Remove LINE Link
              </button>
            </div>
          </div>
        )}

        {activeTab === "move_in" && (
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Move-in Date"
              type="date"
              value={form.move_in_date}
              onChange={(event) => setForm({ ...form, move_in_date: event.target.value })}
            />
            <Input
              label="Lease Term (Months)"
              type="number"
              value={form.lease_months}
              onChange={(event) => setForm({ ...form, lease_months: toNumber(event.target.value) })}
            />
            <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              Lease End: {form.move_in_date ? leaseEnd : "-"} | Status:{" "}
              <span className={leaseActive ? "text-green-700" : "text-red-700"}>
                {leaseActive ? "Active" : "Expired"}
              </span>
            </div>
            <Input
              label="Initial Electricity Reading"
              type="number"
              value={form.initial_electricity_reading}
              onChange={(event) =>
                setForm({ ...form, initial_electricity_reading: toNumber(event.target.value) })
              }
            />
            <Input
              label="Initial Water Reading"
              type="number"
              value={form.initial_water_reading}
              onChange={(event) => setForm({ ...form, initial_water_reading: toNumber(event.target.value) })}
            />
            <Input
              label="Advance Rent Amount"
              type="number"
              value={form.advance_rent_amount}
              onChange={(event) => setForm({ ...form, advance_rent_amount: toNumber(event.target.value) })}
            />
            <Input
              label="Security Deposit Amount"
              type="number"
              value={form.security_deposit_amount}
              onChange={(event) => setForm({ ...form, security_deposit_amount: toNumber(event.target.value) })}
            />
            <div className="md:col-span-2 flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
                <Upload size={14} />
                Upload Deposit Slip
                <input type="file" accept="image/*" className="hidden" onChange={(e) => void uploadDepositSlip(e.target.files?.[0])} />
              </label>
              {form.deposit_slip_url && (
                <a href={form.deposit_slip_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">
                  View Slip
                </a>
              )}
            </div>
          </div>
        )}

        {activeTab === "move_out" && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label={`Final Electricity Reading (Prev ${latestPrevElectricity})`}
                type="number"
                value={form.final_electricity_reading}
                onChange={(event) =>
                  setForm({ ...form, final_electricity_reading: toNumber(event.target.value) })
                }
              />
              <Input
                label={`Final Water Reading (Prev ${latestPrevWater})`}
                type="number"
                value={form.final_water_reading}
                onChange={(event) => setForm({ ...form, final_water_reading: toNumber(event.target.value) })}
              />
            </div>

            <div className="rounded-2xl border border-slate-300 bg-white p-5 text-sm text-slate-700">
              <div className="mb-3 border-b border-dashed border-slate-300 pb-3">
                <p className="text-lg font-semibold text-slate-900">Move-Out Receipt</p>
                <p>Tenant: {form.full_name || "-"}</p>
                <p>Room: {activeTenant ? tenantRoomNumber(activeTenant, roomsById) : "-"}</p>
              </div>
              <div className="space-y-1">
                <p className="flex justify-between"><span>Room Rent</span><span>฿{formatMoney(roomPrice)}</span></p>
                <p className="flex justify-between">
                  <span>Electricity ({electricityUsage} units)</span>
                  <span>฿{formatMoney(electricityUsage * rates.electricity_rate)}</span>
                </p>
                <p className="flex justify-between">
                  <span>Water ({waterUsage} units)</span>
                  <span>฿{formatMoney(waterUsage * rates.water_rate)}</span>
                </p>
              </div>
              <div className="my-3 border-t border-dashed border-slate-300" />
              <div className="space-y-1">
                <p className="flex justify-between font-medium"><span>Total Charges</span><span>฿{formatMoney(totalCost)}</span></p>
                <p className="flex justify-between"><span>Prepaid (Deposit + Advance)</span><span>฿{formatMoney(prepaid)}</span></p>
              </div>
              <div className="my-3 border-t border-dashed border-slate-300" />
              <p className="text-base font-semibold text-slate-900">
                {net >= 0
                  ? `Refund to Tenant: ฿${formatMoney(net)}`
                  : `Tenant Owes: ฿${formatMoney(Math.abs(net))}`}
              </p>
            </div>

            <button
              onClick={() => setConfirmMoveOutOpen(true)}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
              disabled={!activeTenant}
            >
              Confirm Move Out
            </button>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={!activeTenant}
            className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600 disabled:opacity-50"
          >
            <Trash2 size={16} />
            Delete Tenant
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsModalOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600"
            >
              Cancel
            </button>
            <button
              onClick={() => setConfirmSaveOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Save size={16} />
              Save Tenant
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmActionModal
        isOpen={confirmSaveOpen}
        title="Save Tenant"
        message="Save tenant changes?"
        confirmLabel="Save"
        onCancel={() => setConfirmSaveOpen(false)}
        onConfirm={async () => {
          await saveTenant();
          setConfirmSaveOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmDeleteOpen}
        title="Delete Tenant"
        message="This action cannot be undone. Delete tenant?"
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={async () => {
          await deleteTenant();
          setConfirmDeleteOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmUnlinkOpen}
        title="Remove LINE Link"
        message="Remove linked LINE ID from this tenant?"
        confirmLabel="Remove"
        onCancel={() => setConfirmUnlinkOpen(false)}
        onConfirm={async () => {
          await unlinkTenantLine();
          setConfirmUnlinkOpen(false);
        }}
      />

      <ConfirmActionModal
        isOpen={confirmMoveOutOpen}
        title="Confirm Move Out"
        message="Confirm tenant move out and set room to available?"
        confirmLabel="Confirm"
        onCancel={() => setConfirmMoveOutOpen(false)}
        onConfirm={async () => {
          await confirmMoveOut();
          setConfirmMoveOutOpen(false);
        }}
      />
    </div>
  );
}
