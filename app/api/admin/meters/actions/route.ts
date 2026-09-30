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

const normalizePreviousSource = (value: unknown) => {
  return value === "move_in" || value === "prev_month" ? value : null;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "get_latest_reading") {
      // Powers MoveRoomWizardModal.tsx's old-room/new-room meter lookups,
      // which used to read directly from the browser with the anon key
      // (finding C1). Gated on "tenant.view" — viewing a reading isn't the
      // sensitive part, saving one is (still gated on meter.edit below).
      const authView = await requireAdminPermission(req, "tenant.view");
      if ("error" in authView) return authView.error;
      const roomId = String(body?.roomId ?? "");
      if (!roomId) return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
      const { data, error } = await authView.supabase
        .from("meter_readings")
        .select("current_electricity,current_water")
        .eq("room_id", roomId)
        .order("reading_month", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ reading: data ?? null });
    }

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
          previous_source: normalizePreviousSource(row?.previous_source),
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

