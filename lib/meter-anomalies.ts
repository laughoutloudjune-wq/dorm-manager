import type { SupabaseClient } from "@supabase/supabase-js";

export type MeterAnomaly = {
  id: string;
  severity: "high" | "medium";
  text: string;
};

const nextMonthStart = (monthKey: string): string => {
  const [year, month] = monthKey.split("-").map(Number); // month is 1-12
  // Date's month param is 0-indexed, so passing the 1-indexed `month`
  // value directly already lands on the first day of the FOLLOWING month.
  return new Date(year, month, 1).toISOString().slice(0, 10);
};

/**
 * New-VALUE sanity checks on meter_readings for one billing month: current
 * < previous, and usage more than double a room's own trailing average.
 * This is separate from the occupancy/invoice-presence anomalies already
 * computed inline in app/api/admin/dashboard-stats/route.ts (which check
 * whether a room/invoice/meter exist for each other at all, not whether the
 * reading VALUES look sane) — a future cleanup could merge the two, not
 * done here to avoid touching a working admin page for this pass.
 *
 * Strictly read-only. Per CLAUDE.md's meter_readings rule, only the Meters
 * page and the meter-staff LIFF may ever write this table — this must stay
 * a reader alongside everything else.
 */
export async function findMeterAnomalies(
  supabase: SupabaseClient,
  monthKey: string // "YYYY-MM"
): Promise<MeterAnomaly[]> {
  const anomalies: MeterAnomaly[] = [];
  const monthStart = `${monthKey}-01`;
  const monthEnd = nextMonthStart(monthKey);

  const [{ data: currentRows, error: currentError }, { data: occupiedRooms }, { data: historyRows }] =
    await Promise.all([
      supabase
        .from("meter_readings")
        .select(
          "id,room_id,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,rooms(room_number)"
        )
        .gte("reading_month", monthStart)
        .lt("reading_month", monthEnd),
      supabase.from("rooms").select("id,room_number").eq("status", "occupied"),
      supabase
        .from("meter_readings")
        .select("room_id,electricity_usage,water_usage,reading_month")
        .lt("reading_month", monthStart)
        .order("reading_month", { ascending: false }),
    ]);

  if (currentError) {
    anomalies.push({
      id: "meter-query-error",
      severity: "high",
      text: `ตรวจสอบมิเตอร์ไม่สำเร็จ: ${currentError.message}`,
    });
    return anomalies;
  }

  const rows = currentRows ?? [];

  // Missing: an occupied room with no reading row at all for this month.
  const readRoomIds = new Set(rows.map((row: any) => String(row.room_id)));
  for (const room of occupiedRooms ?? []) {
    if (!readRoomIds.has(String(room.id))) {
      anomalies.push({
        id: `meter-missing-${room.id}-${monthKey}`,
        severity: "medium",
        text: `ห้อง ${room.room_number}: ยังไม่มีการจดมิเตอร์เดือน ${monthKey}`,
      });
    }
  }

  // Trailing average per room (up to 6 prior months), to flag a reading
  // more than double a room's own recent usage.
  const historyByRoom = new Map<string, { electricity: number[]; water: number[] }>();
  for (const row of (historyRows ?? []) as any[]) {
    const key = String(row.room_id);
    const entry = historyByRoom.get(key) ?? { electricity: [], water: [] };
    if (entry.electricity.length < 6) entry.electricity.push(Number(row.electricity_usage ?? 0));
    if (entry.water.length < 6) entry.water.push(Number(row.water_usage ?? 0));
    historyByRoom.set(key, entry);
  }
  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  for (const row of rows as any[]) {
    const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
    const roomNo = room?.room_number ?? "-";

    if (Number(row.current_electricity) < Number(row.previous_electricity)) {
      anomalies.push({
        id: `elec-decrease-${row.id}`,
        severity: "high",
        text: `ห้อง ${roomNo}: มิเตอร์ไฟเดือน ${monthKey} ค่าปัจจุบัน (${row.current_electricity}) น้อยกว่าค่าก่อนหน้า (${row.previous_electricity})`,
      });
    }
    if (Number(row.current_water) < Number(row.previous_water)) {
      anomalies.push({
        id: `water-decrease-${row.id}`,
        severity: "high",
        text: `ห้อง ${roomNo}: มิเตอร์น้ำเดือน ${monthKey} ค่าปัจจุบัน (${row.current_water}) น้อยกว่าค่าก่อนหน้า (${row.previous_water})`,
      });
    }

    const history = historyByRoom.get(String(row.room_id));
    const avgElectricity = history ? average(history.electricity) : 0;
    const avgWater = history ? average(history.water) : 0;

    if (avgElectricity > 0 && Number(row.electricity_usage) > avgElectricity * 2) {
      anomalies.push({
        id: `elec-spike-${row.id}`,
        severity: "medium",
        text: `ห้อง ${roomNo}: ใช้ไฟเดือน ${monthKey} (${row.electricity_usage} หน่วย) มากกว่า 2 เท่าของค่าเฉลี่ย (${avgElectricity.toFixed(0)} หน่วย)`,
      });
    }
    if (avgWater > 0 && Number(row.water_usage) > avgWater * 2) {
      anomalies.push({
        id: `water-spike-${row.id}`,
        severity: "medium",
        text: `ห้อง ${roomNo}: ใช้น้ำเดือน ${monthKey} (${row.water_usage} หน่วย) มากกว่า 2 เท่าของค่าเฉลี่ย (${avgWater.toFixed(0)} หน่วย)`,
      });
    }
  }

  return anomalies;
}
