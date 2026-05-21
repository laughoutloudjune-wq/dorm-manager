import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/** Strip ILIKE wildcard chars so typed room numbers behave as literals (patterns use % externally). */
const sanitizeIlikeSubstring = (raw: string) => raw.trim().replace(/[%_\\\u0000-\u001F]/g, "");

const roomSortKey = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = sanitizeIlikeSubstring(searchParams.get("query") ?? "");

    if (!query) {
      return NextResponse.json({ rooms: [] });
    }

    const supabase = createAdminClient();

    // Large enough pool: LINE/T filters run after — small limits here dropped all free rooms.
    const { data: matches, error: matchErr } = await supabase
      .from("rooms")
      .select("id,room_number,buildings(name)")
      .ilike("room_number", `%${query}%`)
      .order("room_number", { ascending: true })
      .limit(400);

    if (matchErr) {
      return NextResponse.json({ error: matchErr.message }, { status: 500 });
    }

    let rooms = matches ?? [];

    // Prefer rows whose room_number matches the typed query exactly (case-insensitive, trimmed).
    const qLower = query.toLowerCase();
    const rank = (roomNumber: string) => {
      const n = String(roomNumber ?? "").trim().toLowerCase();
      if (n === qLower) return 0;
      if (n.startsWith(query.toLowerCase())) return 1;
      return 2;
    };

    rooms = [...rooms].sort((x: any, y: any) => {
      const dr = rank(x.room_number) - rank(y.room_number);
      if (dr !== 0) return dr;
      const a = Array.isArray(x.buildings) ? x.buildings[0] : x.buildings;
      const b = Array.isArray(y.buildings) ? y.buildings[0] : y.buildings;
      const bn = roomSortKey(String(a?.name ?? ""), String(b?.name ?? ""));
      if (bn !== 0) return bn;
      return roomSortKey(String(x.room_number ?? ""), String(y.room_number ?? ""));
    });

    const roomIds = rooms.map((row: any) => row.id);
    if (roomIds.length === 0) {
      return NextResponse.json({ rooms: [] });
    }

    const { data: activeTenants, error: tenantError } = await supabase
      .from("tenants")
      .select("room_id,line_user_id")
      .in("room_id", roomIds)
      .eq("status", "active");

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    const activeByRoom = new Map<string, { line_user_id: string | null }>();
    for (const row of activeTenants ?? []) {
      activeByRoom.set(String((row as any).room_id), {
        line_user_id: (row as any).line_user_id ?? null,
      });
    }

    const mapped = rooms.map((row: any) => {
      const building = Array.isArray(row.buildings) ? row.buildings[0] : row.buildings;
      const active = activeByRoom.get(String(row.id));
      const registration_status = active ? "takeover_required" : "available";
      return {
        id: row.id,
        room_number: row.room_number,
        building_name: building?.name ?? null,
        registration_status,
        has_active_tenant: Boolean(active),
      };
    });

    return NextResponse.json({ rooms: mapped.slice(0, 12) });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
