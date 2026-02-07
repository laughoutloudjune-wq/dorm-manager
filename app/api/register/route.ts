import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { roomNumber, fullName, userId, accessToken } = body ?? {};

    if (!roomNumber || !fullName || !userId) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    if (accessToken) {
      const profileResponse = await fetch("https://api.line.me/v2/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!profileResponse.ok) {
        return NextResponse.json({ error: "Unable to verify LINE profile." }, { status: 401 });
      }
      const profile = await profileResponse.json();
      if (profile.userId !== userId) {
        return NextResponse.json({ error: "LINE user mismatch." }, { status: 401 });
      }
    }

    const supabase = createAdminClient();

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id,status")
      .eq("room_number", roomNumber)
      .single();

    if (roomError || !room) {
      return NextResponse.json({ error: "Room not found." }, { status: 404 });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id,line_user_id")
      .eq("room_id", room.id)
      .maybeSingle();

    const moveInDate = new Date().toISOString().slice(0, 10);

    if (tenant) {
      if (tenant.line_user_id && tenant.line_user_id !== userId) {
        return NextResponse.json({ error: "This room is already linked to another LINE account." }, { status: 400 });
      }
      const { error: updateError } = await supabase
        .from("tenants")
        .update({ line_user_id: tenant.line_user_id ?? userId, full_name: fullName })
        .eq("id", tenant.id);

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    } else {
      const { error: insertError } = await supabase.from("tenants").insert({
        room_id: room.id,
        full_name: fullName,
        line_user_id: userId,
        move_in_date: moveInDate,
        status: "active",
      });

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }

    if (room.status !== "occupied") {
      await supabase.from("rooms").update({ status: "occupied" }).eq("id", room.id);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
