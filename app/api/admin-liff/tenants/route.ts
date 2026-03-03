import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";

const roomCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const query = String(body?.query ?? "").trim().toLowerCase();
    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("tenants")
      .select("id,full_name,phone_number,line_user_id,move_in_date,status,rooms(room_number,buildings(name))")
      .order("created_at", { ascending: false })
      .limit(800);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const normalized = (data ?? []).map((row: any) => {
      const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
      const building = Array.isArray(room?.buildings) ? room?.buildings[0] : room?.buildings;
      return {
        id: row.id,
        full_name: row.full_name ?? "-",
        phone_number: row.phone_number ?? "-",
        line_user_id: row.line_user_id ?? null,
        move_in_date: row.move_in_date ?? null,
        status: row.status ?? "unknown",
        room_number: room?.room_number ?? "-",
        building_name: building?.name ?? "Unassigned",
      };
    });

    const filtered = query
      ? normalized.filter((row) => {
          const blob = `${row.full_name} ${row.phone_number} ${row.room_number} ${row.building_name}`.toLowerCase();
          return blob.includes(query);
        })
      : normalized;

    filtered.sort((a, b) => {
      const buildingCmp = a.building_name.localeCompare(b.building_name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (buildingCmp !== 0) return buildingCmp;
      return roomCompare(a.room_number, b.room_number);
    });

    return NextResponse.json({ tenants: filtered });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}

