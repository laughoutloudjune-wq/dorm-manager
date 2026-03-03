import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineMeterAccess } from "@/lib/line-admin-auth";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roomCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const monthText = String(body?.month ?? new Date().toISOString().slice(0, 7));
    const auth = await requireLineMeterAccess(accessToken);
    if ("error" in auth) return auth.error;

    const [yearRaw, monthRaw] = monthText.split("-").map(Number);
    const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
    const month = Number.isFinite(monthRaw) ? monthRaw : new Date().getMonth() + 1;
    const monthStart = toLocalDateString(new Date(year, month - 1, 1));
    const monthEndExclusive = toLocalDateString(new Date(year, month, 1));
    const prevMonthStart = toLocalDateString(new Date(year, month - 2, 1));

    const supabase = createAdminClient();
    const [{ data: rooms, error: roomError }, { data: currentReadings }, { data: previousReadings }, { data: settings }] =
      await Promise.all([
        supabase.from("rooms").select("id,room_number,buildings(name)").order("room_number", { ascending: true }),
        supabase
          .from("meter_readings")
          .select(
            "room_id,reading_month,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,previous_reading,current_reading,usage"
          )
          .gte("reading_month", monthStart)
          .lt("reading_month", monthEndExclusive)
          .order("reading_month", { ascending: false })
          .order("created_at", { ascending: false }),
        supabase
          .from("meter_readings")
          .select("room_id,current_electricity,current_water,current_reading")
          .gte("reading_month", prevMonthStart)
          .lt("reading_month", monthStart)
          .order("reading_month", { ascending: false })
          .order("created_at", { ascending: false }),
        supabase.from("settings").select("water_rate,electricity_rate").maybeSingle(),
      ]);

    if (roomError) return NextResponse.json({ error: roomError.message }, { status: 500 });

    const currentMap = new Map<string, any>();
    for (const row of currentReadings ?? []) {
      if (!currentMap.has((row as any).room_id)) currentMap.set((row as any).room_id, row);
    }
    const prevMap = new Map<string, any>();
    for (const row of previousReadings ?? []) {
      if (!prevMap.has((row as any).room_id)) prevMap.set((row as any).room_id, row);
    }

    const rows = (rooms ?? []).map((room: any) => {
      const current = currentMap.get(room.id);
      const prev = prevMap.get(room.id);
      const building = Array.isArray(room.buildings) ? room.buildings[0] : room.buildings;
      const previousElectricity = toNumber(prev?.current_electricity ?? current?.previous_electricity);
      const currentElectricity = toNumber(current?.current_electricity);
      const electricityUsage = Math.max(
        0,
        toNumber(current?.electricity_usage ?? currentElectricity - previousElectricity)
      );
      const previousWater = toNumber(
        prev?.current_water ?? prev?.current_reading ?? current?.previous_water ?? current?.previous_reading
      );
      const currentWater = toNumber(current?.current_water ?? current?.current_reading);
      const waterUsage = Math.max(0, toNumber(current?.water_usage ?? current?.usage ?? currentWater - previousWater));
      return {
        room_id: room.id,
        room_number: room.room_number ?? "-",
        building_name: building?.name ?? "Unassigned",
        reading_month: monthStart,
        previous_electricity: previousElectricity,
        current_electricity: currentElectricity,
        electricity_usage: electricityUsage,
        previous_water: previousWater,
        current_water: currentWater,
        water_usage: waterUsage,
      };
    });

    rows.sort((a, b) => {
      const buildingCmp = a.building_name.localeCompare(b.building_name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (buildingCmp !== 0) return buildingCmp;
      return roomCompare(a.room_number, b.room_number);
    });

    return NextResponse.json({
      month: `${year}-${String(month).padStart(2, "0")}`,
      rates: {
        water_rate: toNumber((settings as any)?.water_rate),
        electricity_rate: toNumber((settings as any)?.electricity_rate),
      },
      rows,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
