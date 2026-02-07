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
  buildings: { name: string }[] | null;
};

type MeterRow = {
  room_id: string;
  room_number: string;
  reading_month: string;
  previous_electricity: number;
  current_electricity: number;
  electricity_usage: number;
  previous_water: number;
  current_water: number;
  water_usage: number;
};

type MeterReadingDb = {
  room_id: string;
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

export default function MetersPage() {
  const supabase = useMemo(() => createClient(), []);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<Record<string, MeterRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setStatus(null);

    const [year, month] = selectedMonth.split("-").map(Number);
    const monthDate = new Date(year, month - 1, 1);
    const prevMonthDate = new Date(year, month - 2, 1);
    const currentMonthKey = monthDate.toISOString().slice(0, 10);
    const prevMonthKey = prevMonthDate.toISOString().slice(0, 10);

    const { data: roomData, error: roomError } = await supabase
      .from("rooms")
      .select("id,room_number,buildings(name)")
      .order("room_number", { ascending: true });

    if (roomError) {
      setStatus(roomError.message);
      setLoading(false);
      return;
    }

    const { data: currentReadings } = await supabase
      .from("meter_readings")
      .select(
        "room_id,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,previous_reading,current_reading,usage"
      )
      .eq("reading_month", currentMonthKey);

    const { data: previousReadings } = await supabase
      .from("meter_readings")
      .select("room_id,current_electricity,current_water,current_reading")
      .eq("reading_month", prevMonthKey);

    const previousMap = new Map(
      (previousReadings ?? []).map((item: any) => [item.room_id, item])
    );
    const currentMap = new Map(
      (currentReadings ?? []).map((item: MeterReadingDb) => [item.room_id, item])
    );

    const grouped: Record<string, MeterRow[]> = {};

    (roomData ?? []).forEach((room: RoomRow) => {
      const current = currentMap.get(room.id);
      const previous = previousMap.get(room.id) ?? {};

      const previousElec =
        current?.previous_electricity ?? previous.current_electricity ?? 0;
      const previousWater =
        current?.previous_water ?? previous.current_water ?? previous.current_reading ?? 0;

      const currentElec = current?.current_electricity ?? previousElec;
      const currentWater = current?.current_water ?? current?.current_reading ?? previousWater;

      const row: MeterRow = {
        room_id: room.id,
        room_number: room.room_number,
        reading_month: currentMonthKey,
        previous_electricity: toNumber(previousElec),
        current_electricity: toNumber(currentElec),
        electricity_usage: toNumber(currentElec) - toNumber(previousElec),
        previous_water: toNumber(previousWater),
        current_water: toNumber(currentWater),
        water_usage: toNumber(currentWater) - toNumber(previousWater),
      };

      const buildingName = room.buildings?.[0]?.name ?? "Unassigned";
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
        next.electricity_usage = next.current_electricity - next.previous_electricity;
        next.water_usage = next.current_water - next.previous_water;
        return next;
      }),
    }));
  };

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
    inputRefs.current[key]?.focus();
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
        <div className="grid gap-6 xl:grid-cols-2">
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
                    <th className="px-4 py-3">Elec Prev</th>
                    <th className="px-4 py-3">Elec Current</th>
                    <th className="px-4 py-3">Elec Usage</th>
                    <th className="px-4 py-3">Water Prev</th>
                    <th className="px-4 py-3">Water Current</th>
                    <th className="px-4 py-3">Water Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {buildingRows.map((row) => (
                    <tr key={row.room_id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-900">{row.room_number}</td>
                      <td className="px-4 py-3">{row.previous_electricity}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          value={row.current_electricity}
                          ref={(element) => {
                            inputRefs.current[`${building}:${row.room_id}:current_electricity`] = element;
                          }}
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
                      <td className="px-4 py-3">
                        <span className={row.electricity_usage < 0 ? "text-red-600" : "text-slate-700"}>
                          {row.electricity_usage}
                        </span>
                      </td>
                      <td className="px-4 py-3">{row.previous_water}</td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          value={row.current_water}
                          ref={(element) => {
                            inputRefs.current[`${building}:${row.room_id}:current_water`] = element;
                          }}
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
                      <td className="px-4 py-3">
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
