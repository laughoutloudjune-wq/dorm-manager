import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineMeterAccess } from "@/lib/line-admin-auth";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDate = (value: unknown) => {
  const raw = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const action = String(body?.action ?? "");
    if (!accessToken || action !== "save_all") {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const auth = await requireLineMeterAccess(accessToken);
    if ("error" in auth) return auth.error;

    const rawRows = Array.isArray(body?.rows) ? body.rows : [];
    if (rawRows.length === 0) {
      return NextResponse.json({ error: "No meter rows to save" }, { status: 400 });
    }

    const payload = rawRows
      .map((row: any) => {
        const readingMonth = normalizeDate(row?.reading_month);
        const roomId = String(row?.room_id ?? "");
        if (!readingMonth || !roomId) return null;
        const previousElectricity = toNumber(row?.previous_electricity);
        const currentElectricity = toNumber(row?.current_electricity);
        const electricityUsage = toNumber(row?.electricity_usage);
        const previousWater = toNumber(row?.previous_water);
        const currentWater = toNumber(row?.current_water);
        const waterUsage = toNumber(row?.water_usage);
        return {
          room_id: roomId,
          reading_month: readingMonth,
          previous_electricity: previousElectricity,
          current_electricity: currentElectricity,
          electricity_usage: electricityUsage,
          previous_water: previousWater,
          current_water: currentWater,
          water_usage: waterUsage,
          previous_reading: previousWater,
          current_reading: currentWater,
          usage: waterUsage,
        };
      })
      .filter(Boolean);

    if (payload.length === 0) {
      return NextResponse.json({ error: "No valid meter rows to save" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { error } = await supabase.from("meter_readings").upsert(payload, {
      onConflict: "room_id,reading_month",
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, saved: payload.length });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
