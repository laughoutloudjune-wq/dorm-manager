import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    if (action !== "save_all") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    const auth = await requireAdminPermission(req, "meter.edit");
    if ("error" in auth) return auth.error;
    const payload = Array.isArray(body?.payload) ? body.payload : [];

    const { error } = await auth.supabase.from("meter_readings").upsert(payload, {
      onConflict: "room_id,reading_month",
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}

