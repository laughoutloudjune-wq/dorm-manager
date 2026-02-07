"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { Plus, Save, Search, Trash2 } from "lucide-react";

type TenantRow = {
  id: string;
  full_name: string;
  phone_number: string | null;
  line_user_id: string | null;
  move_in_date: string;
  status: string;
  room_id: string;
  custom_payment_method: any;
  rooms: { room_number: string; buildings: { name: string }[] | null }[] | null;
};

type RoomRow = {
  id: string;
  room_number: string;
  buildings: { name: string }[] | null;
};

type PaymentMethod = {
  id: string;
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

const roomLabel = (room: RoomRow) => {
  const building = room.buildings?.[0]?.name;
  return `${room.room_number}${building ? ` (${building})` : ""}`;
};

export default function TenantsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [search, setSearch] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTenant, setActiveTenant] = useState<TenantRow | null>(null);
  const [useCustomPayment, setUseCustomPayment] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);

  const [form, setForm] = useState({
    full_name: "",
    phone_number: "",
    room_id: "",
    move_in_date: "",
    status: "active",
  });

  const loadTenants = async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id,full_name,phone_number,line_user_id,move_in_date,status,room_id,custom_payment_method,rooms(room_number,buildings(name))"
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
      .select("id,room_number,buildings(name)")
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

  useEffect(() => {
    loadTenants();
    loadRooms();
    loadMethods();
  }, []);

  const openModal = (tenant?: TenantRow) => {
    if (tenant) {
      setActiveTenant(tenant);
      setForm({
        full_name: tenant.full_name,
        phone_number: tenant.phone_number ?? "",
        room_id: tenant.room_id,
        move_in_date: tenant.move_in_date,
        status: tenant.status,
      });
      const custom = tenant.custom_payment_method;
      if (custom?.methodId) {
        setUseCustomPayment(true);
        setSelectedMethodId(custom.methodId);
      } else {
        setUseCustomPayment(false);
        setSelectedMethodId("");
      }
    } else {
      setActiveTenant(null);
      setForm({ full_name: "", phone_number: "", room_id: "", move_in_date: "", status: "active" });
      setUseCustomPayment(false);
      setSelectedMethodId("");
    }

    setIsModalOpen(true);
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
      phone_number: form.phone_number || null,
      room_id: form.room_id,
      move_in_date: form.move_in_date || new Date().toISOString().slice(0, 10),
      status: form.status,
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
    setIsModalOpen(false);
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

    const { error } = await supabase
      .from("tenants")
      .update({ line_user_id: null })
      .eq("id", activeTenant.id);

    if (error) {
      setStatus(error.message);
      return;
    }

    setActiveTenant({ ...activeTenant, line_user_id: null });
    setStatus("LINE link removed.");
    await loadTenants();
  };

  const filtered = tenants.filter((tenant) => {
    const room = tenant.rooms?.[0]?.room_number ?? "";
    return (
      tenant.full_name.toLowerCase().includes(search.toLowerCase()) ||
      room.toLowerCase().includes(search.toLowerCase())
    );
  });

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
          onClick={() => openModal()}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20"
        >
          <Plus size={16} />
          Add Tenant
        </button>
      </div>

      {status && <Badge variant="info">{status}</Badge>}

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
            {filtered.map((tenant) => (
              <tr key={tenant.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-900">{tenant.full_name}</td>
                <td className="px-4 py-3">{tenant.rooms?.[0]?.room_number ?? "-"}</td>
                <td className="px-4 py-3">{tenant.phone_number ?? "-"}</td>
                <td className="px-4 py-3">
                  <Badge variant={tenant.status === "active" ? "success" : "warning"}>{tenant.status}</Badge>
                </td>
                <td className="px-4 py-3">
                  <button
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
                    onClick={() => openModal(tenant)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Tenant Details" size="xl">
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label="Full Name"
            value={form.full_name}
            onChange={(event) => setForm({ ...form, full_name: event.target.value })}
          />
          <Input
            label="Phone"
            value={form.phone_number}
            onChange={(event) => setForm({ ...form, phone_number: event.target.value })}
          />
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
          <Input
            label="Move-in Date"
            type="date"
            value={form.move_in_date}
            onChange={(event) => setForm({ ...form, move_in_date: event.target.value })}
          />

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
            <p className="text-sm text-slate-600">
              Current LINE ID: {activeTenant?.line_user_id ?? "Not linked"}
            </p>
            <button
              onClick={() => setConfirmUnlinkOpen(true)}
              disabled={!activeTenant?.line_user_id}
              className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm text-red-600 disabled:opacity-50"
            >
              Remove LINE Link
            </button>
          </div>
        </div>

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
    </div>
  );
}
