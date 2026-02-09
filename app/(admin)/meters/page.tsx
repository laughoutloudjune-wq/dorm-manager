"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { createClient } from "@/lib/supabase-client";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { Save } from "lucide-react";

type RoomRow = {
  id: string;
  room_number: string;
  buildings: { name: string }[] | { name: string } | null;
};

type MeterRow = {
  room_id: string;
  room_number: string;
  reading_month: string;
  rollover: boolean;
  previous_electricity: number;
  current_electricity: number;
  electricity_usage: number;
  previous_water: number;
  current_water: number;
  water_usage: number;
};

type MeterReadingDb = {
  id?: string;
  room_id: string;
  reading_month?: string;
  created_at?: string;
  previous_electricity: number | null;
  current_electricity: number | null;
  electricity_usage: number | null;
  previous_water: number | null;
  current_water: number | null;
  water_usage: number | null;
  previous_reading: number | null;
  current_reading: number | null;
  usage: number | null;
};

const toNumber = (value: string | number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;

export default function MetersPage() {
  const supabase = useMemo(() => createClient(), []);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<Record<string, MeterRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [electricityMax, setElectricityMax] = useState(9999);
  const [waterMax, setWaterMax] = useState(9999);

  const calcUsage = (previous: number, current: number, maxValue: number, rollover: boolean) => {
    if (!rollover) return current - previous;
    if (current >= previous) return current - previous;
    const safeMax = Math.max(maxValue, previous, current);
    return safeMax - previous + current;
  };

  const fetchData = async () => {
    setLoading(true);
    setStatus(null);

    const [year, month] = selectedMonth.split("-").map(Number);
    const monthDate = new Date(year, month - 1, 1);
    const prevMonthDate = new Date(year, month - 2, 1);
    const currentMonthKey = toLocalDateString(monthDate);
    const prevMonthKey = toLocalDateString(prevMonthDate);

    const { data: roomData, error: roomError } = await supabase
      .from("rooms")
      .select("id,room_number,buildings(name)")
      .order("room_number", { ascending: true });

    if (roomError) {
      setStatus(roomError.message);
      setLoading(false);
      return;
    }

    const nextMonthDate = new Date(year, month, 1);
    const nextMonthKey = toLocalDateString(nextMonthDate);

    const { data: currentReadings } = await supabase
      .from("meter_readings")
      .select(
        "id,room_id,reading_month,created_at,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,previous_reading,current_reading,usage"
      )
      .gte("reading_month", currentMonthKey)
      .lt("reading_month", nextMonthKey)
      .order("reading_month", { ascending: false })
      .order("created_at", { ascending: false });

    const { data: previousReadings } = await supabase
      .from("meter_readings")
      .select("id,room_id,reading_month,created_at,current_electricity,current_water,current_reading")
      .gte("reading_month", prevMonthKey)
      .lt("reading_month", currentMonthKey)
      .order("reading_month", { ascending: false })
      .order("created_at", { ascending: false });

    const previousMap = new Map<string, any>();
    for (const item of previousReadings ?? []) {
      if (!previousMap.has(item.room_id)) previousMap.set(item.room_id, item);
    }
    const currentMap = new Map<string, MeterReadingDb>();
    for (const item of (currentReadings ?? []) as MeterReadingDb[]) {
      if (!currentMap.has(item.room_id)) currentMap.set(item.room_id, item);
    }

    const grouped: Record<string, MeterRow[]> = {};

    (roomData ?? []).forEach((room: RoomRow) => {
      const current = currentMap.get(room.id);
      const previous = previousMap.get(room.id) ?? {};

      const previousElec =
        current?.previous_electricity ?? previous.current_electricity ?? 0;
      const previousWater =
        current?.previous_water ?? previous.current_water ?? previous.current_reading ?? 0;

      const currentElec = current?.current_electricity ?? 0;
      const currentWater = current?.current_water ?? current?.current_reading ?? 0;

      const inferredRollover =
        current != null &&
        (toNumber(currentElec) < toNumber(previousElec) ||
          toNumber(currentWater) < toNumber(previousWater)) &&
        toNumber(current?.electricity_usage ?? 0) >= 0 &&
        toNumber(current?.water_usage ?? 0) >= 0;

      const electricityUsage = calcUsage(
        toNumber(previousElec),
        toNumber(currentElec),
        Math.max(0, toNumber(electricityMax)),
        inferredRollover
      );
      const waterUsage = calcUsage(
        toNumber(previousWater),
        toNumber(currentWater),
        Math.max(0, toNumber(waterMax)),
        inferredRollover
      );

      const row: MeterRow = {
        room_id: room.id,
        room_number: room.room_number,
        reading_month: currentMonthKey,
        rollover: inferredRollover,
        previous_electricity: toNumber(previousElec),
        current_electricity: toNumber(currentElec),
        electricity_usage: electricityUsage,
        previous_water: toNumber(previousWater),
        current_water: toNumber(currentWater),
        water_usage: waterUsage,
      };

      const buildingName = Array.isArray(room.buildings)
        ? room.buildings[0]?.name ?? "Unassigned"
        : room.buildings?.name ?? "Unassigned";
      if (!grouped[buildingName]) grouped[buildingName] = [];
      grouped[buildingName].push(row);
    });
    for (const building of Object.keys(grouped)) {
      grouped[building].sort((a, b) =>
        a.room_number.localeCompare(b.room_number, undefined, { numeric: true, sensitivity: "base" })
      );
    }

    setRows(grouped);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [selectedMonth]);

  const updateMeter = (
    building: string,
    roomId: string,
    field: "current_electricity" | "current_water",
    value: number
  ) => {
    setRows((prev) => ({
      ...prev,
      [building]: prev[building].map((row) => {
        if (row.room_id !== roomId) return row;
        const next = { ...row, [field]: value } as MeterRow;
        next.electricity_usage = calcUsage(
          next.previous_electricity,
          next.current_electricity,
          Math.max(0, toNumber(electricityMax)),
          next.rollover
        );
        next.water_usage = calcUsage(
          next.previous_water,
          next.current_water,
          Math.max(0, toNumber(waterMax)),
          next.rollover
        );
        return next;
      }),
    }));
  };

  const updateRollover = (building: string, roomId: string, enabled: boolean) => {
    setRows((prev) => ({
      ...prev,
      [building]: prev[building].map((row) => {
        if (row.room_id !== roomId) return row;
        const next = { ...row, rollover: enabled };
        next.electricity_usage = calcUsage(
          next.previous_electricity,
          next.current_electricity,
          Math.max(0, toNumber(electricityMax)),
          enabled
        );
        next.water_usage = calcUsage(
          next.previous_water,
          next.current_water,
          Math.max(0, toNumber(waterMax)),
          enabled
        );
        return next;
      }),
    }));
  };

  useEffect(() => {
    setRows((prev) => {
      const next: Record<string, MeterRow[]> = {};
      for (const [building, buildingRows] of Object.entries(prev)) {
        next[building] = buildingRows.map((row) => ({
          ...row,
          electricity_usage: calcUsage(
            row.previous_electricity,
            row.current_electricity,
            Math.max(0, toNumber(electricityMax)),
            row.rollover
          ),
          water_usage: calcUsage(
            row.previous_water,
            row.current_water,
            Math.max(0, toNumber(waterMax)),
            row.rollover
          ),
        }));
      }
      return next;
    });
  }, [electricityMax, waterMax]);

  const saveAll = async () => {
    setSaving(true);
    const payload = Object.values(rows)
      .flat()
      .map((row) => ({
        room_id: row.room_id,
        reading_month: row.reading_month,
        previous_electricity: row.previous_electricity,
        current_electricity: row.current_electricity,
        electricity_usage: row.electricity_usage,
        previous_water: row.previous_water,
        current_water: row.current_water,
        water_usage: row.water_usage,
        previous_reading: row.previous_water,
        current_reading: row.current_water,
        usage: row.water_usage,
      }));

    const { error } = await supabase.from("meter_readings").upsert(payload, {
      onConflict: "room_id,reading_month",
    });

    setSaving(false);
    setConfirmOpen(false);
    if (error) {
      setStatus(error.message);
    } else {
      setStatus("Meter readings saved.");
      await fetchData();
    }
  };

  const sortedBuildings = useMemo(
    () =>
      Object.entries(rows).sort(([a], [b]) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
      ),
    [rows]
  );

  const focusNextRowInput = (
    currentBuilding: string,
    roomId: string,
    field: "current_electricity" | "current_water"
  ) => {
    const buildingIndex = sortedBuildings.findIndex(([building]) => building === currentBuilding);
    if (buildingIndex < 0) return;
    const currentRows = sortedBuildings[buildingIndex][1];
    const rowIndex = currentRows.findIndex((row) => row.room_id === roomId);
    if (rowIndex < 0) return;

    let nextBuildingIndex = buildingIndex;
    let nextRowIndex = rowIndex + 1;
    if (nextRowIndex >= currentRows.length) {
      nextBuildingIndex = buildingIndex + 1;
      nextRowIndex = 0;
    }
    const nextBuildingRows = sortedBuildings[nextBuildingIndex]?.[1];
    const nextBuildingName = sortedBuildings[nextBuildingIndex]?.[0];
    const nextRoom = nextBuildingRows?.[nextRowIndex];
    if (!nextBuildingName || !nextRoom) return;

    const key = `${nextBuildingName}:${nextRoom.room_id}:${field}`;
    const nextInput = inputRefs.current[key];
    if (!nextInput) return;
    nextInput.focus();
    nextInput.select();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-sm">
          <Input
            label="Select Month"
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <label className="text-sm text-slate-700">Meter max value</label>
          <input
            type="number"
            value={electricityMax}
            onChange={(event) => setElectricityMax(toNumber(event.target.value))}
            className="w-28 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
            placeholder="Elec max"
          />
          <input
            type="number"
            value={waterMax}
            onChange={(event) => setWaterMax(toNumber(event.target.value))}
            className="w-28 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
            placeholder="Water max"
          />
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
        >
          <Save size={16} />
          Save All Readings
        </button>
      </div>

      {status && <Badge variant="info">{status}</Badge>}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Loading readings...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {sortedBuildings.map(([building, buildingRows]) => (
          <div key={building} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">{building}</h2>
              <Badge variant="info">Electricity + Water</Badge>
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Room</th>
                    <th className="px-4 py-3">Rollover</th>
                    <th className="bg-amber-50 px-4 py-3 text-amber-800">Elec Prev</th>
                    <th className="bg-amber-50 px-4 py-3 text-amber-800">Elec Current</th>
                    <th className="bg-amber-50 px-4 py-3 text-amber-800">Elec Usage</th>
                    <th className="bg-cyan-50 px-4 py-3 text-cyan-800">Water Prev</th>
                    <th className="bg-cyan-50 px-4 py-3 text-cyan-800">Water Current</th>
                    <th className="bg-cyan-50 px-4 py-3 text-cyan-800">Water Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {buildingRows.map((row) => (
                    <tr key={row.room_id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{row.room_number}</td>
                      <td className="px-4 py-3">
                        <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={row.rollover}
                            onChange={(event) =>
                              updateRollover(building, row.room_id, event.target.checked)
                            }
                          />
                          Enabled
                        </label>
                      </td>
                      <td className="bg-amber-50/60 px-4 py-3">{row.previous_electricity}</td>
                      <td className="bg-amber-50/60 px-4 py-3">
                        <input
                          type="number"
                          value={row.current_electricity}
                          ref={(element) => {
                            inputRefs.current[`${building}:${row.room_id}:current_electricity`] = element;
                          }}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              focusNextRowInput(building, row.room_id, "current_electricity");
                            }
                          }}
                          onChange={(event) =>
                            updateMeter(
                              building,
                              row.room_id,
                              "current_electricity",
                              toNumber(event.target.value)
                            )
                          }
                          className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                        />
                      </td>
                      <td className="bg-amber-50/60 px-4 py-3">
                        <span className={row.electricity_usage < 0 ? "text-red-600" : "text-slate-700"}>
                          {row.electricity_usage}
                        </span>
                      </td>
                      <td className="bg-cyan-50/60 px-4 py-3">{row.previous_water}</td>
                      <td className="bg-cyan-50/60 px-4 py-3">
                        <input
                          type="number"
                          value={row.current_water}
                          ref={(element) => {
                            inputRefs.current[`${building}:${row.room_id}:current_water`] = element;
                          }}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              focusNextRowInput(building, row.room_id, "current_water");
                            }
                          }}
                          onChange={(event) =>
                            updateMeter(
                              building,
                              row.room_id,
                              "current_water",
                              toNumber(event.target.value)
                            )
                          }
                          className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                        />
                      </td>
                      <td className="bg-cyan-50/60 px-4 py-3">
                        <span className={row.water_usage < 0 ? "text-red-600" : "text-slate-700"}>
                          {row.water_usage}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        </div>
      )}

      <ConfirmActionModal
        isOpen={confirmOpen}
        title="Confirm Save"
        message="Save all electricity and water readings for this month?"
        confirmLabel="Save All"
        loading={saving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={saveAll}
      />
    </div>
  );
}
