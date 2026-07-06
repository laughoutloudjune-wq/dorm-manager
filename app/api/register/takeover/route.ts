import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const mode = String(body?.mode ?? "create"); // create | status
    const roomId = body?.roomId ? String(body.roomId) : "";
    const fullName = body?.fullName ? String(body.fullName) : "";
    const phoneNumber = body?.phoneNumber ? String(body.phoneNumber) : "";

    if (!accessToken) {
      return NextResponse.json({ error: "Missing accessToken." }, { status: 400 });
    }
    if (!roomId) {
      return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile?.userId) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }
    const lineUserId = String(profile.userId);

    const supabase = createAdminClient();

    if (mode === "status") {
      const { data: takeover, error } = await supabase
        .from("room_takeover_requests")
        .select("id,room_id,status,admin_note,created_at,updated_at")
        .eq("room_id", roomId)
        .eq("requester_line_user_id", lineUserId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ takeover: takeover ?? null });
    }

    // Create takeover request
    if (!fullName || !phoneNumber) {
      return NextResponse.json({ error: "Missing fullName/phoneNumber." }, { status: 400 });
    }

    const { data: activeTenant, error: activeTenantError } = await supabase
      .from("tenants")
      .select("id,line_user_id,move_out_date")
      .eq("room_id", roomId)
      .eq("status", "active")
      .maybeSingle();

    if (activeTenantError) {
      return NextResponse.json({ error: activeTenantError.message }, { status: 500 });
    }

    if (!activeTenant?.id) {
      return NextResponse.json(
        { error: "Room has no active tenant. Please register normally." },
        { status: 409 }
      );
    }

    if (activeTenant.line_user_id && activeTenant.line_user_id === lineUserId) {
      return NextResponse.json({ error: "This is already your active tenant record." }, { status: 400 });
    }

    // Only allow a takeover claim once the current tenant already has a move-out
    // date on record — otherwise anyone could claim any occupied room by guessing
    // its room ID with no real connection to it.
    if (!activeTenant.move_out_date) {
      return NextResponse.json(
        {
          error:
            "Room's current tenant has not given move-out notice yet. Please contact the office directly.",
        },
        { status: 409 }
      );
    }

    const existing = await supabase
      .from("room_takeover_requests")
      .select("id,status")
      .eq("room_id", roomId)
      .eq("requester_line_user_id", lineUserId)
      .eq("status", "requested")
      .maybeSingle();

    if (existing.error) {
      return NextResponse.json({ error: existing.error.message }, { status: 500 });
    }
    if (existing.data?.id) {
      return NextResponse.json({ success: true, takeoverRequestId: existing.data.id });
    }

    const takeoverRequestId = crypto.randomUUID();
    const { error: insertErr } = await supabase.from("room_takeover_requests").insert({
      id: takeoverRequestId,
      room_id: roomId,
      requester_line_user_id: lineUserId,
      requester_full_name: fullName,
      requester_phone: phoneNumber,
      status: "requested",
      current_active_tenant_id: activeTenant.id,
    });

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      takeoverRequestId,
      status: "requested",
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}

