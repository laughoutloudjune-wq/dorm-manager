import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/** Meter readings are physical measurements — never negative, never absurdly large. */
const toNonNegativeNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const normalizeDate = (value: unknown) => {
  const raw = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    if (action !== "save_all") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    const auth = await requireAdminPermission(req, "meter.edit");
    if ("error" in auth) return auth.error;
    const rawPayload = Array.isArray(body?.payload) ? body.payload : [];

    // Only forward known meter columns, normalized — never pass the client's raw
    // object straight into the database (arbitrary keys, negative/NaN readings).
    const payload = rawPayload
      .map((row: any) => {
        const roomId = String(row?.room_id ?? "");
        const readingMonth = normalizeDate(row?.reading_month);
        if (!roomId || !readingMonth) return null;
        return {
          room_id: roomId,
          reading_month: readingMonth,
          previous_electricity: toNonNegativeNumber(row?.previous_electricity),
          current_electricity: toNonNegativeNumber(row?.current_electricity),
          electricity_usage: toNonNegativeNumber(row?.electricity_usage),
          previous_water: toNonNegativeNumber(row?.previous_water),
          current_water: toNonNegativeNumber(row?.current_water),
          water_usage: toNonNegativeNumber(row?.water_usage),
        };
      })
      .filter(Boolean);

    if (payload.length === 0) {
      return NextResponse.json({ error: "No valid meter rows to save." }, { status: 400 });
    }

    const { error } = await auth.supabase.from("meter_readings").upsert(payload, {
      onConflict: "room_id,reading_month",
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, saved: payload.length });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}

