"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase-client";
import { Plus, Save, Trash2 } from "lucide-react";

const tabs = ["General", "Utilities", "Invoice Config", "Payment Methods", "Rooms"] as const;

type SettingsRow = {
  id: number;
  default_payment_method: any;
  water_rate: number | null;
  electricity_rate: number | null;
  common_fee: number | null;
};

type Building = { id: string; name: string };

type Room = { id: string; room_number: string; status: string; room_type: string | null; price_month: number | null };

type PaymentMethod = {
  id: string;
  label: string;
  bank: string;
  account: string;
};

const toNumber = (value: string | number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export default function SettingsView() {
  const supabase = useMemo(() => createClient(), []);
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("General");
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [buildingName, setBuildingName] = useState("");
  const [buildingAddress, setBuildingAddress] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [roomType, setRoomType] = useState("");
  const [roomPrice, setRoomPrice] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadSettings = async () => {
    const { data } = await supabase.from("settings").select("*").eq("id", 1).single();
    if (data) {
      setSettings(data as SettingsRow);
      const existing = (data as SettingsRow).default_payment_method;
      const methodsFromDb = existing?.methods ?? [];
      setMethods(methodsFromDb);
    }
  };

  const loadBuildings = async () => {
    const { data } = await supabase.from("buildings").select("id,name").order("name");
    if (data) {
      setBuildings(data as Building[]);
      if (!selectedBuilding && data.length > 0) {
        setSelectedBuilding(data[0].id);
      }
    }
  };

  const loadRooms = async (buildingId: string) => {
    const { data } = await supabase
      .from("rooms")
      .select("id,room_number,status,room_type,price_month")
      .eq("building_id", buildingId)
      .order("room_number");
    if (data) setRooms(data as Room[]);
  };

  useEffect(() => {
    loadSettings();
    loadBuildings();
  }, []);

  useEffect(() => {
    if (selectedBuilding) {
      loadRooms(selectedBuilding);
    }
  }, [selectedBuilding]);

  const saveUtilities = async () => {
    if (!settings) return;
    await supabase
      .from("settings")
      .update({
        water_rate: settings.water_rate,
        electricity_rate: settings.electricity_rate,
        common_fee: settings.common_fee,
        default_payment_method: { methods },
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    setStatusMessage("Settings saved.");
  };

  const addPaymentMethod = () => {
    setMethods((prev) => [
      ...prev,
      { id: crypto.randomUUID(), label: "Bank", bank: "", account: "" },
    ]);
  };

  const updateMethod = (id: string, field: keyof PaymentMethod, value: string) => {
    setMethods((prev) => prev.map((method) => (method.id === id ? { ...method, [field]: value } : method)));
  };

  const removeMethod = (id: string) => {
    setMethods((prev) => prev.filter((method) => method.id !== id));
  };

  const saveRooms = async () => {
    if (!selectedBuilding) return;
    for (const room of rooms) {
      await supabase
        .from("rooms")
        .update({
          room_number: room.room_number,
          room_type: room.room_type,
          price_month: room.price_month,
          status: room.status,
        })
        .eq("id", room.id);
    }
    setStatusMessage("Rooms updated.");
  };

  const addBuilding = async () => {
    if (!buildingName.trim()) {
      setStatusMessage("Building name is required.");
      return;
    }
    const { data, error } = await supabase
      .from("buildings")
      .insert({ name: buildingName.trim(), address: buildingAddress.trim() || null })
      .select("id,name")
      .single();
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    setBuildings((prev) => [...prev, data as Building]);
    setSelectedBuilding((data as Building).id);
    setBuildingName("");
    setBuildingAddress("");
    setStatusMessage("Building added.");
  };

  const deleteRoom = async (roomId: string) => {
    const { error } = await supabase.from("rooms").delete().eq("id", roomId);
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    setRooms((prev) => prev.filter((room) => room.id !== roomId));
    setStatusMessage("Room deleted.");
  };

  const addRooms = async () => {
    if (!selectedBuilding) {
      setStatusMessage("Please add/select a building first.");
      return;
    }
    if (!roomNumber.trim()) {
      setStatusMessage("Room number is required.");
      return;
    }
    const payload = {
      building_id: selectedBuilding,
      room_number: roomNumber.trim(),
      room_type: roomType.trim() || null,
      price_month: roomPrice > 0 ? roomPrice : null,
      status: "available",
    };

    const { error } = await supabase.from("rooms").insert(payload);
    if (!error) {
      await loadRooms(selectedBuilding);
      setRoomNumber("");
      setRoomType("");
      setRoomPrice(0);
      setStatusMessage("Rooms added.");
    } else {
      setStatusMessage(error.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
              activeTab === tab
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 border border-slate-200 hover:border-blue-200"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {statusMessage && <Badge variant="info">{statusMessage}</Badge>}

      {activeTab === "General" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Dorm Name" placeholder="DormManager Residence" />
          <Input label="Phone" placeholder="02-000-0000" />
          <label className="md:col-span-2 text-sm text-slate-600">
            Address
            <textarea className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40" />
          </label>
        </div>
      )}

      {activeTab === "Utilities" && settings && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Electricity Unit Price"
              value={settings.electricity_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) =>
                  prev ? { ...prev, electricity_rate: toNumber(event.target.value) } : prev
                )
              }
            />
            <Input
              label="Water Unit Price"
              value={settings.water_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) =>
                  prev ? { ...prev, water_rate: toNumber(event.target.value) } : prev
                )
              }
            />
            <Input
              label="Common Fee"
              value={settings.common_fee ?? 0}
              onChange={(event) =>
                setSettings((prev) =>
                  prev ? { ...prev, common_fee: toNumber(event.target.value) } : prev
                )
              }
            />
          </div>
          <button
            onClick={saveUtilities}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Utilities
          </button>
        </div>
      )}

      {activeTab === "Invoice Config" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Common Fee Label" placeholder="Common Area Fee" />
          <Input label="Common Fee Amount" placeholder="100" />
          <Input label="Late Fee (per day)" placeholder="30" />
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-900">Late Fee Policy</p>
            <p className="mt-2 text-xs text-slate-500">
              Late fee will apply after the due date and is calculated daily.
            </p>
          </div>
        </div>
      )}

      {activeTab === "Payment Methods" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Bank Accounts</h3>
              <p className="text-sm text-slate-500">
                These accounts will appear on public invoices.
              </p>
            </div>
            <button
              onClick={addPaymentMethod}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Plus size={16} />
              Add Account
            </button>
          </div>
          <div className="grid gap-3">
            {methods.map((method) => (
              <div
                key={method.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex-1 grid gap-2 md:grid-cols-3">
                  <Input
                    label="Label"
                    value={method.label}
                    onChange={(event) => updateMethod(method.id, "label", event.target.value)}
                  />
                  <Input
                    label="Bank"
                    value={method.bank}
                    onChange={(event) => updateMethod(method.id, "bank", event.target.value)}
                  />
                  <Input
                    label="Account"
                    value={method.account}
                    onChange={(event) => updateMethod(method.id, "account", event.target.value)}
                  />
                </div>
                <button
                  onClick={() => removeMethod(method.id)}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={saveUtilities}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Payment Methods
          </button>
        </div>
      )}

      {activeTab === "Rooms" && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-700">Add Building</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Input
                label="Building Name"
                value={buildingName}
                onChange={(event) => setBuildingName(event.target.value)}
                placeholder="Building A"
              />
              <Input
                label="Address"
                value={buildingAddress}
                onChange={(event) => setBuildingAddress(event.target.value)}
                placeholder="Optional"
              />
              <div className="flex items-end">
                <button
                  onClick={addBuilding}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  <Plus size={16} />
                  Add Building
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-600">
              Building
              <select
                value={selectedBuilding ?? ""}
                onChange={(event) => setSelectedBuilding(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
              >
                {buildings.length === 0 && <option value="">No buildings yet</option>}
                {buildings.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Room Number"
              value={roomNumber}
              onChange={(event) => setRoomNumber(event.target.value)}
            />
            <Input
              label="Room Type"
              value={roomType}
              onChange={(event) => setRoomType(event.target.value)}
            />
            <Input
              label="Price / Month"
              type="number"
              value={roomPrice}
              onChange={(event) => setRoomPrice(toNumber(event.target.value))}
            />
            <button
              onClick={addRooms}
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Plus size={16} />
              Add Room
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Room Number</th>
                  <th className="px-4 py-3">Room Type</th>
                  <th className="px-4 py-3">Price / Month</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => (
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
                        <option value="available">available</option>
                        <option value="occupied">occupied</option>
                        <option value="maintenance">maintenance</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => deleteRoom(room.id)}
                        className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-1 text-xs text-red-600"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={saveRooms}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Room Changes
          </button>
        </div>
      )}
    </div>
  );
}
