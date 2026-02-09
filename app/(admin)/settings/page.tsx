"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase-client";
import { Plus, Save, Trash2, Upload } from "lucide-react";

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

type Building = { id: string; name: string };
type Room = {
  id: string;
  room_number: string;
  room_type: string | null;
  price_month: number | null;
  status: string;
};

const tabs = ["General", "Utilities", "Invoice Config", "Payment Methods", "Rooms"] as const;

type PendingAction = {
  title: string;
  message: string;
  action: () => Promise<void>;
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

export default function SettingsPage() {
  const supabase = useMemo(() => createClient(), []);
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
    additional_fees: [],
    additional_discounts: [],
  });

  const [fees, setFees] = useState<AdditionalFee[]>([]);
  const [discounts, setDiscounts] = useState<AdditionalFee[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [initialMethodIds, setInitialMethodIds] = useState<string[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<string>("");
  const [rooms, setRooms] = useState<Room[]>([]);
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
        setFees(Array.isArray(inserted.additional_fees) ? inserted.additional_fees : []);
        setDiscounts(
          Array.isArray((inserted as any).additional_discounts) ? (inserted as any).additional_discounts : []
        );
      }
      return;
    }

    setSettings(data as SettingsRow);
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
    loadBuildings();
  }, []);

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
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("settings").update(payload).eq("id", 1);
    setStatusMessage(error ? error.message : "General settings saved.");
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
    const { error } = await supabase.from("settings").update(payload).eq("id", 1);
    setStatusMessage(error ? error.message : "Utility settings saved.");
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

    const { error } = await supabase.from("settings").update(payload).eq("id", 1);
    setStatusMessage(error ? error.message : "Invoice configuration saved.");
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

    const existingIdSet = new Set(initialMethodIds);
    const existingRows = cleaned.filter((row) => row.id && existingIdSet.has(row.id));
    const newRows = cleaned
      .filter((row) => !row.id || (row.id && !existingIdSet.has(row.id)))
      .map(({ id, ...rest }) => rest);

    for (const row of existingRows) {
      const { id, ...payload } = row;
      const { error: updateError } = await supabase
        .from("payment_methods")
        .update(payload)
        .eq("id", id as string);
      if (updateError) {
        setStatusMessage(updateError.message);
        return;
      }
    }

    if (newRows.length > 0) {
      const { error: insertError } = await supabase.from("payment_methods").insert(newRows);
      if (insertError) {
        setStatusMessage(insertError.message);
        return;
      }
    }

    const currentIds = existingRows.map((row) => row.id).filter(Boolean) as string[];
    const removedIds = initialMethodIds.filter((id) => !currentIds.includes(id));

    if (removedIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("payment_methods")
        .delete()
        .in("id", removedIds);

      if (deleteError) {
        setStatusMessage(deleteError.message);
        return;
      }
    }

    setStatusMessage("Payment methods saved.");
    await loadPaymentMethods();
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
    setStatusMessage("QR image uploaded. Save Payment Methods to persist changes.");
  };

  const removeMethod = (index: number) => {
    setMethods((prev) => prev.filter((_, idx) => idx !== index));
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
    setBuildingName("");
    setBuildingAddress("");
    setStatusMessage("Building added.");
    await loadBuildings();
    if (data?.id) setSelectedBuilding(data.id);
  };

  const addRoom = async () => {
    if (!selectedBuilding) {
      setStatusMessage("Please select a building.");
      return;
    }
    if (!roomNumber.trim()) {
      setStatusMessage("Room number is required.");
      return;
    }
    const { error } = await supabase.from("rooms").insert({
      building_id: selectedBuilding,
      room_number: roomNumber.trim(),
      room_type: roomType.trim() || null,
      price_month: roomPrice > 0 ? roomPrice : null,
      status: "available",
    });
    if (error) {
      setStatusMessage(error.message);
      return;
    }
    setRoomNumber("");
    setRoomType("");
    setRoomPrice(0);
    setStatusMessage("Room added.");
    await loadRooms(selectedBuilding);
  };

  const saveRooms = async () => {
    for (const room of rooms) {
      const { error } = await supabase
        .from("rooms")
        .update({
          room_number: room.room_number,
          room_type: room.room_type,
          price_month: room.price_month,
          status: room.status,
        })
        .eq("id", room.id);
      if (error) {
        setStatusMessage(error.message);
        return;
      }
    }
    setStatusMessage("Room changes saved.");
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
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="Dorm Name"
              value={settings.dorm_name ?? ""}
              onChange={(event) => setSettings((prev) => ({ ...prev, dorm_name: event.target.value }))}
            />
            <Input
              label="Phone"
              value={settings.dorm_phone ?? ""}
              onChange={(event) => setSettings((prev) => ({ ...prev, dorm_phone: event.target.value }))}
            />
            <label className="md:col-span-2 text-sm text-slate-600">
              Address
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
                title: "Save General Settings",
                message: "Are you sure you want to save general settings?",
                action: saveGeneral,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save General
          </button>
        </div>
      )}

      {activeTab === "Utilities" && (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-3">
            <Input
              label="Electricity Unit Price"
              type="number"
              value={settings.electricity_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, electricity_rate: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Water Unit Price"
              type="number"
              value={settings.water_rate ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, water_rate: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Common Fee"
              type="number"
              value={settings.common_fee ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, common_fee: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Water Minimum Units"
              type="number"
              value={settings.water_min_units ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, water_min_units: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Water Minimum Price"
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
                title: "Save Utility Settings",
                message: "Are you sure you want to save utility settings?",
                action: saveUtilities,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Utilities
          </button>
        </div>
      )}

      {activeTab === "Invoice Config" && (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-3">
            <Input
              label="Common Fee"
              type="number"
              value={settings.common_fee ?? 0}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, common_fee: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Billing Day (1-28)"
              type="number"
              value={settings.billing_day ?? 1}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, billing_day: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Due Day (1-28)"
              type="number"
              value={settings.due_day ?? 5}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, due_day: toNumber(event.target.value) }))
              }
            />
            <Input
              label="Late Fee Start Day (1-28)"
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
              label="Late Fee / Day"
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
              <p className="text-sm font-semibold text-slate-800">Additional Fees</p>
              <button
                onClick={() => setFees((prev) => [...prev, newFee()])}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Plus size={14} />
                Add Fee
              </button>
            </div>

            {fees.map((fee, index) => (
              <div key={fee.id} className="grid gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-4">
                <Input
                  label="Fee Name"
                  value={fee.label}
                  onChange={(event) =>
                    setFees((prev) =>
                      prev.map((item, idx) => (idx === index ? { ...item, label: event.target.value } : item))
                    )
                  }
                />
                <label className="text-sm text-slate-600">
                  Calculation Type
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
                    <option value="fixed">Fixed Amount</option>
                    <option value="electricity_units">Based on Electricity Units</option>
                    <option value="water_units">Based on Water Units</option>
                  </select>
                </label>
                <Input
                  label={fee.calc_type === "fixed" ? "Amount" : "Rate / Unit"}
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
                        title: "Delete Fee",
                        message: "Are you sure you want to delete this fee?",
                        action: async () => {
                          setFees((prev) => prev.filter((_, idx) => idx !== index));
                          setStatusMessage("Fee removed from list. Save Invoice Config to persist.");
                        },
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">Discount Rules</p>
              <button
                onClick={() => setDiscounts((prev) => [...prev, newFee()])}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Plus size={14} />
                Add Discount
              </button>
            </div>

            {discounts.map((fee, index) => (
              <div key={`discount-${fee.id}`} className="grid gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-4">
                <Input
                  label="Discount Name"
                  value={fee.label}
                  onChange={(event) =>
                    setDiscounts((prev) =>
                      prev.map((item, idx) => (idx === index ? { ...item, label: event.target.value } : item))
                    )
                  }
                />
                <label className="text-sm text-slate-600">
                  Calculation Type
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
                    <option value="fixed">Fixed Amount</option>
                    <option value="electricity_units">Based on Electricity Units</option>
                    <option value="water_units">Based on Water Units</option>
                  </select>
                </label>
                <Input
                  label={fee.calc_type === "fixed" ? "Amount" : "Rate / Unit"}
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
                        title: "Delete Discount",
                        message: "Are you sure you want to delete this discount?",
                        action: async () => {
                          setDiscounts((prev) => prev.filter((_, idx) => idx !== index));
                          setStatusMessage("Discount removed from list. Save Invoice Config to persist.");
                        },
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() =>
              openConfirm({
                title: "Save Invoice Config",
                message: "Are you sure you want to save invoice configuration?",
                action: saveInvoiceConfig,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Invoice Config
          </button>
        </div>
      )}

      {activeTab === "Payment Methods" && (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800">Payment Methods</p>
            <button
              onClick={() => setMethods((prev) => [...prev, newPaymentMethod()])}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
            >
              <Plus size={14} />
              Add Payment Method
            </button>
          </div>

          <div className="space-y-3">
            {methods.map((method, index) => (
              <div key={method.id ?? `new-${index}`} className="rounded-xl border border-slate-200 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    label="Label"
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
                    label="Bank Name"
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
                    label="Account Name"
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
                    label="Account Number"
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
                    Upload QR Image
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
                      View QR
                    </a>
                  )}

                  <button
                    onClick={() =>
                      openConfirm({
                        title: "Delete Payment Method",
                        message: "Are you sure you want to remove this payment method?",
                        action: async () => removeMethod(index),
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() =>
              openConfirm({
                title: "Save Payment Methods",
                message: "Are you sure you want to save payment methods?",
                action: savePaymentMethods,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Payment Methods
          </button>
        </div>
      )}

      {activeTab === "Rooms" && (
        <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-800">Add Building</p>
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
                  onClick={() =>
                    openConfirm({
                      title: "Add Building",
                      message: "Add this building?",
                      action: addBuilding,
                    })
                  }
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  <Plus size={16} />
                  Add Building
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-600">
              Building
              <select
                value={selectedBuilding}
                onChange={(event) => setSelectedBuilding(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm"
              >
                {buildings.length === 0 && <option value="">No buildings</option>}
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
              onClick={() =>
                openConfirm({
                  title: "Add Room",
                  message: "Add this room?",
                  action: addRoom,
                })
              }
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Plus size={16} />
              Add Room
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Room Number</th>
                  <th className="px-4 py-3">Room Type</th>
                  <th className="px-4 py-3">Price / Month</th>
                  <th className="px-4 py-3">Status</th>
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
                        <option value="available">available</option>
                        <option value="occupied">occupied</option>
                        <option value="maintenance">maintenance</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() =>
                          openConfirm({
                            title: "Delete Room",
                            message: "Delete this room?",
                            action: async () => deleteRoom(room.id),
                          })
                        }
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
            onClick={() =>
              openConfirm({
                title: "Save Rooms",
                message: "Save all room changes?",
                action: saveRooms,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            <Save size={16} />
            Save Room Changes
          </button>
        </div>
      )}

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} title={pendingAction?.title ?? "Confirm"} size="md">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{pendingAction?.message}</p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmOpen(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={executePending}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              disabled={saving}
            >
              {saving ? "Saving..." : "Confirm"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
