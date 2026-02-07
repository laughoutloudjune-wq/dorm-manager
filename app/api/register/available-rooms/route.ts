import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") || "").trim();

    if (!query) {
      return NextResponse.json({ rooms: [] });
    }

    const supabase = createAdminClient();
    const { data: rooms, error } = await supabase
      .from("rooms")
      .select("id,room_number,buildings(name)")
      .ilike("room_number", `%${query}%`)
      .order("room_number", { ascending: true })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const roomIds = (rooms ?? []).map((row: any) => row.id);
    if (roomIds.length === 0) {
      return NextResponse.json({ rooms: [] });
    }

    const { data: linkedTenants, error: tenantError } = await supabase
      .from("tenants")
      .select("room_id")
      .in("room_id", roomIds)
      .not("line_user_id", "is", null);

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    const linkedRoomIds = new Set((linkedTenants ?? []).map((row: any) => row.room_id));

    const availableForRegister = (rooms ?? []).filter((row: any) => !linkedRoomIds.has(row.id));

    const mapped = availableForRegister.map((row: any) => {
      const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings;
      return {
        id: row.id,
        room_number: row.room_number,
        building_name: building?.name ?? null,
      };
    });

    return NextResponse.json({ rooms: mapped.slice(0, 12) });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
