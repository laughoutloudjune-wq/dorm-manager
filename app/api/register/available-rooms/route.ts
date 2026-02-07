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
    const { data, error } = await supabase
      .from("rooms")
      .select("id,room_number,status,buildings(name)")
      .or("status.eq.available,status.eq.vacant")
      .ilike("room_number", `%${query}%`)
      .order("room_number", { ascending: true })
      .limit(12);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rooms = (data ?? []).map((row: any) => {
      const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings;
      return {
        id: row.id,
        room_number: row.room_number,
        building_name: building?.name ?? null,
      };
    });

    return NextResponse.json({ rooms });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
