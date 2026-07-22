"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { Input, controlClasses } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { PageHeader, Skeleton } from "@/components/ui/Page";
import { createClient } from "@/lib/supabase-client";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { Building2, Droplets, Save, UserRound, Zap } from "lucide-react";
import { toast } from "sonner";
import { toNumber, toLocalDateString, formatThaiDateShort, monthStartFromDateString } from "@/lib/format";
import { useMeterReadingsRawData } from "@/lib/hooks/use-data";

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
  previous_source: "prev_month" | "move_in";
  previous_month_electricity: number;
  previous_month_water: number;
  move_in_electricity: number | null;
  move_in_water: number | null;
  move_in_tenant_name: string | null;
  move_in_date: string | null;
  previous_electricity: number;
  current_electricity: number;
  electricity_usage: number;
  previous_water: number;
  current_water: number;
  water_usage: number;
};

type MoveInTenantRow = {
  tenant_id: string;
  room_id: string;
  full_name: string | null;
  move_in_date: string;
  initial_electricity_reading: number | null;
  initial_water_reading: number | null;
};

type TenantInvoiceRow = {
  tenant_id: string;
  start_date: string;
  status: string | null;
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



const numberCellClass = "px-2 py-2.5 text-right tabular-nums text-slate-800 sm:px-3";
// Derived from the shared control style rather than restated, so meter inputs
// keep the same border, focus ring and radius as every other field in the app.
// Only the size and alignment differ — these sit inside a dense grid.
const numberInputClass = controlClasses({
  className:
    "min-w-[4.5rem] max-w-[6.5rem] px-2.5 py-1.5 text-right text-sm tabular-nums sm:ml-auto",
});

export default function MetersPage() {
  const supabase = useMemo(() => createClient(), []);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const { data: rawData, error: rawError, isLoading: rawLoading, mutate } = useMeterReadingsRawData(selectedMonth);
  const [rows, setRows] = useState<Record<string, MeterRow[]>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [electricityMax, setElectricityMax] = useState(9999);
  const [waterMax, setWaterMax] = useState(9999);

  const callMetersAction = async (action: string, payload: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session expired. Please log in again.");
    const response = await fetch("/api/admin/meters/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const dataJson = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(dataJson?.error ?? "Meter action failed.");
    return dataJson;
  };

  const calcUsage = (previous: number, current: number, maxValue: number, rollover: boolean) => {
    if (!rollover) return current - previous;
    if (current >= previous) return current - previous;
    const safeMax = Math.max(maxValue, previous, current);
    return safeMax - previous + current;
  };

  const recalcRowUsage = (row: MeterRow) => {
    const next = { ...row };
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
  };

  useEffect(() => {
    if (rawError) {
      toast.error(rawError.message);
      return;
    }
    if (!rawData) {
      return;
    }

    const {
      roomData,
      currentReadings,
      previousReadings,
      activeTenants,
      tenantInvoices,
      currentMonthKey,
    } = rawData;

    const previousMap = new Map<string, any>();
    for (const item of previousReadings ?? []) {
      if (!previousMap.has(item.room_id)) previousMap.set(item.room_id, item);
    }
    const currentMap = new Map<string, MeterReadingDb>();
    for (const item of (currentReadings ?? []) as MeterReadingDb[]) {
      if (!currentMap.has(item.room_id)) currentMap.set(item.room_id, item);
    }
    const moveInMap = new Map<string, MoveInTenantRow>();
    const invoicesByTenant = new Map<string, string[]>();
    for (const item of ((tenantInvoices ?? []) as TenantInvoiceRow[])) {
      if (!item?.tenant_id) continue;
      const id = String(item.tenant_id);
      if (!invoicesByTenant.has(id)) invoicesByTenant.set(id, []);
      invoicesByTenant.get(id)!.push(item.start_date);
    }

    for (const item of ((activeTenants ?? []) as any[])) {
      if (!item?.room_id) continue;
      const tenantId = String(item.id ?? "");
      const moveInDate = String(item.move_in_date ?? "");
      if (!tenantId || !moveInDate) continue;
      
      const invoices = invoicesByTenant.get(tenantId) ?? [];
      const hasRegularInvoice = invoices.length > 1 || invoices.some(date => date !== moveInDate);
      if (hasRegularInvoice) continue;

      if (!moveInMap.has(item.room_id)) {
        moveInMap.set(item.room_id, {
          tenant_id: tenantId,
          room_id: item.room_id,
          full_name: item.full_name ?? null,
          move_in_date: moveInDate,
          initial_electricity_reading: item.initial_electricity_reading ?? null,
          initial_water_reading: item.initial_water_reading ?? null,
        });
      }
    }

    const grouped: Record<string, MeterRow[]> = {};

    (roomData ?? []).forEach((room: RoomRow) => {
      const current = currentMap.get(room.id);
      const previous = previousMap.get(room.id) ?? {};

      // Always derive previous readings from the prior month when available.
      // This keeps later months in sync if an earlier month is edited later.
      const previousMonthElec =
        previous.current_electricity ?? current?.previous_electricity ?? 0;
      const previousMonthWater =
        previous.current_water ?? previous.current_reading ?? current?.previous_water ?? 0;
      const moveInTenant = moveInMap.get(room.id) ?? null;
      const hasMoveInReading =
        moveInTenant &&
        (moveInTenant.initial_electricity_reading != null || moveInTenant.initial_water_reading != null);
      const isFirstBillingCycle =
        !!moveInTenant &&
        monthStartFromDateString(moveInTenant.move_in_date) <= currentMonthKey;
      const previousSource: MeterRow["previous_source"] = hasMoveInReading ? "move_in" : "prev_month";
      const previousElec =
        previousSource === "move_in"
          ? toNumber(moveInTenant?.initial_electricity_reading ?? previousMonthElec)
          : toNumber(previousMonthElec);
      const previousWater =
        previousSource === "move_in"
          ? toNumber(moveInTenant?.initial_water_reading ?? previousMonthWater)
          : toNumber(previousMonthWater);

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
        previous_source: isFirstBillingCycle ? previousSource : "prev_month",
        previous_month_electricity: toNumber(previousMonthElec),
        previous_month_water: toNumber(previousMonthWater),
        move_in_electricity: moveInTenant?.initial_electricity_reading ?? null,
        move_in_water: moveInTenant?.initial_water_reading ?? null,
        move_in_tenant_name: moveInTenant?.full_name ?? null,
        move_in_date: moveInTenant?.move_in_date ?? null,
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
  }, [rawData, rawError, electricityMax, waterMax]);

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
        return recalcRowUsage({ ...row, rollover: enabled });
      }),
    }));
  };

  const updatePreviousSource = (
    building: string,
    roomId: string,
    source: MeterRow["previous_source"]
  ) => {
    setRows((prev) => ({
      ...prev,
      [building]: prev[building].map((row) => {
        if (row.room_id !== roomId) return row;
        const next: MeterRow = {
          ...row,
          previous_source: source,
          previous_electricity:
            source === "move_in"
              ? toNumber(row.move_in_electricity ?? row.previous_month_electricity)
              : toNumber(row.previous_month_electricity),
          previous_water:
            source === "move_in"
              ? toNumber(row.move_in_water ?? row.previous_month_water)
              : toNumber(row.previous_month_water),
        };
        return recalcRowUsage(next);
      }),
    }));
  };

  useEffect(() => {
    setRows((prev) => {
      const next: Record<string, MeterRow[]> = {};
      for (const [building, buildingRows] of Object.entries(prev)) {
        next[building] = buildingRows.map((row) => recalcRowUsage(row));
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
    try {
      await callMetersAction("save_all", { payload });
      toast.success("บันทึกค่ามิเตอร์เรียบร้อย");
      setConfirmOpen(false);
      await mutate();
    } catch (error: any) {
      toast.error(error?.message ?? "บันทึกค่ามิเตอร์ไม่สำเร็จ");
    } finally {
      setSaving(false);
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
      <PageHeader
        description="กรอกเลขมิเตอร์ไฟและน้ำของแต่ละห้องประจำเดือน"
        actions={
          <Button
            onClick={() => setConfirmOpen(true)}
            loading={saving}
            icon={<Save size={16} />}
          >
            {saving ? "กำลังบันทึก..." : "บันทึกมิเตอร์ทั้งหมด"}
          </Button>
        }
      />

      <Card>
        <CardContent className="!p-4 md:!p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <Input
              label="เดือนที่บันทึก"
              type="month"
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
            />
            <Input
              label="ค่าสูงสุดมิเตอร์ (ไฟ)"
              type="number"
              value={electricityMax}
              onChange={(event) => setElectricityMax(toNumber(event.target.value))}
              className="text-right tabular-nums"
              min={0}
            />
            <Input
              label="ค่าสูงสุดมิเตอร์ (น้ำ)"
              type="number"
              value={waterMax}
              onChange={(event) => setWaterMax(toNumber(event.target.value))}
              className="text-right tabular-nums"
              min={0}
            />
          </div>
          {status && (
            <div className="mt-3">
              <Badge variant="info">{status}</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {rawLoading ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-8" />
                <div className="space-y-1">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
              <Skeleton className="h-80" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {sortedBuildings.map(([building, buildingRows]) => {
            const firstBillCount = buildingRows.filter((r) => r.move_in_date).length;
            return (
              <div key={building} className="space-y-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-control bg-white text-slate-600 shadow-float">
                      <Building2 size={16} />
                    </span>
                    <div>
                      <h2 className="text-base font-semibold tracking-tight text-slate-900">{building}</h2>
                      <p className="text-xs text-slate-500">
                        {buildingRows.length} ห้อง
                        {firstBillCount > 0 && (
                          <span className="text-success-700"> · มีรอบบิลแรก {firstBillCount} ห้อง</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="overflow-hidden rounded-card border border-slate-200/70 bg-white shadow-float">
                  <div className="scrollbar-slim overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-200/80 bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <th
                            className="w-[7.5rem] min-w-[7rem] px-2 py-2.5 sm:px-3"
                            rowSpan={2}
                          >
                            ห้อง
                          </th>
                          <th
                            colSpan={3}
                            className="border-l-2 border-warning-200/90 bg-warning-50/50 px-2 py-2 text-warning-900 sm:px-3"
                          >
                            <span className="inline-flex items-center justify-center gap-1.5">
                              <Zap className="h-3.5 w-3.5" aria-hidden />
                              ไฟฟ้า
                            </span>
                          </th>
                          <th
                            colSpan={3}
                            className="border-l-2 border-cyan-200/90 bg-cyan-50/50 px-2 py-2 text-cyan-900 sm:px-3"
                          >
                            <span className="inline-flex items-center justify-center gap-1.5">
                              <Droplets className="h-3.5 w-3.5" aria-hidden />
                              น้ำประปา
                            </span>
                          </th>
                        </tr>
                        <tr className="border-b border-slate-200/80 bg-slate-50/80 text-2xs font-medium uppercase tracking-wide text-slate-500 sm:text-xs">
                          <th className="border-l-2 border-warning-200/80 bg-warning-50/40 px-2 py-2 text-warning-900/90 sm:px-3">
                            ก่อนหน้า
                          </th>
                          <th className="bg-warning-50/30 px-2 py-2 text-warning-900/90 sm:px-3">ปัจจุบัน</th>
                          <th className="bg-warning-50/20 px-2 py-2 text-warning-900/80 sm:px-3">ใช้ไป</th>
                          <th className="border-l-2 border-cyan-200/80 bg-cyan-50/40 px-2 py-2 text-cyan-900/90 sm:px-3">
                            ก่อนหน้า
                          </th>
                          <th className="bg-cyan-50/30 px-2 py-2 text-cyan-900/90 sm:px-3">ปัจจุบัน</th>
                          <th className="bg-cyan-50/20 px-2 py-2 text-cyan-900/80 sm:px-3">ใช้ไป</th>
                        </tr>
                      </thead>
                      <tbody>
                        {buildingRows.map((row) => (
                          <Fragment key={row.room_id}>
                            <tr className="border-b border-slate-100/90 transition-colors hover:bg-slate-50/50">
                              <td className="align-top border-r border-slate-100/80 px-2 py-2.5 sm:px-3">
                                <div className="font-semibold tabular-nums text-slate-900">{row.room_number}</div>
                                <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-2xs text-slate-500">
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500/30"
                                    checked={row.rollover}
                                    onChange={(event) =>
                                      updateRollover(building, row.room_id, event.target.checked)
                                    }
                                  />
                                  มิเตอร์หมุน
                                </label>
                              </td>
                              <td className={`${numberCellClass} border-l-2 border-warning-200/60 bg-warning-50/25`}>
                                {row.previous_electricity}
                              </td>
                              <td className={`${numberCellClass} bg-warning-50/10`}>
                                <input
                                  type="number"
                                  value={row.current_electricity}
                                  ref={(element) => {
                                    inputRefs.current[
                                      `${building}:${row.room_id}:current_electricity`
                                    ] = element;
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
                                  className={numberInputClass}
                                />
                              </td>
                              <td
                                className={`${numberCellClass} font-medium ${
                                  row.electricity_usage < 0 ? "text-danger-600" : "text-warning-950/80"
                                } bg-warning-50/5`}
                              >
                                {row.electricity_usage}
                              </td>
                              <td className={`${numberCellClass} border-l-2 border-cyan-200/60 bg-cyan-50/25`}>
                                {row.previous_water}
                              </td>
                              <td className={`${numberCellClass} bg-cyan-50/10`}>
                                <input
                                  type="number"
                                  value={row.current_water}
                                  ref={(element) => {
                                    inputRefs.current[
                                      `${building}:${row.room_id}:current_water`
                                    ] = element;
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
                                  className={numberInputClass}
                                />
                              </td>
                              <td
                                className={`${numberCellClass} font-medium ${
                                  row.water_usage < 0 ? "text-danger-600" : "text-cyan-950/80"
                                } bg-cyan-50/5`}
                              >
                                {row.water_usage}
                              </td>
                            </tr>
                            {row.move_in_date && (
                              <tr className="bg-success-50/40">
                                <td colSpan={7} className="border-b border-slate-100/80 p-0">
                                  <div className="border-l-[3px] border-success-500 px-3 py-2.5 sm:px-4">
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                      <div className="flex min-w-0 items-start gap-2 text-xs text-success-900">
                                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-success-100/90 text-success-800">
                                          <UserRound className="h-3.5 w-3.5" aria-hidden />
                                        </span>
                                        <div className="min-w-0 leading-snug">
                                          <p className="font-semibold">รอบบิลแรกหลังย้ายเข้า</p>
                                          <p className="text-2xs text-success-800/90 sm:text-xs">
                                            {row.move_in_tenant_name ? (
                                              <span className="font-medium">{row.move_in_tenant_name}</span>
                                            ) : (
                                              "ผู้เช่า"
                                            )}
                                            <span className="text-success-700/80"> · </span>
                                            เข้าอยู่ {formatThaiDateShort(row.move_in_date)}
                                          </p>
                                        </div>
                                      </div>
                                      <div className="w-full min-w-0 sm:max-w-md sm:shrink-0 sm:self-center">
                                        <label className="mb-0.5 block text-2xs font-medium text-success-800/80 sm:text-xs">
                                          ฐานคำนวณ “ก่อนหน้า”
                                        </label>
                                        <select
                                          value={row.previous_source}
                                          onChange={(event) =>
                                            updatePreviousSource(
                                              building,
                                              row.room_id,
                                              event.target.value as MeterRow["previous_source"]
                                            )
                                          }
                                          className={controlClasses({ className: "border-success-200/80 px-2.5 py-2 text-xs focus:border-success-400 focus:ring-success-500/20 sm:text-sm" })}
                                        >
                                          <option value="move_in">
                                            ค่าเริ่มตอนเข้าอยู่ (ยังไม่มีบิลรอบก่อน)
                                          </option>
                                          <option value="prev_month">ยอดสิ้นเดือนก่อน</option>
                                        </select>
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmActionModal
        isOpen={confirmOpen}
        title="ยืนยันการบันทึก"
        message="บันทึกค่ามิเตอร์ไฟฟ้าและน้ำทั้งหมดของเดือนนี้?"
        confirmLabel="บันทึกทั้งหมด"
        loading={saving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={saveAll}
      />
    </div>
  );
}
