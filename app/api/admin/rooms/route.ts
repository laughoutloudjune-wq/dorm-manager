import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to app/api/admin/rooms/actions/route.ts. Gated on
 * "room.view" — every default role has this, editing is separately gated.
 * Optional ?buildingId= filters to one building — used by the settings
 * page's per-building room list (finding C1), which used to query
 * "rooms" directly from the browser.
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "room.view");
  if ("error" in auth) return auth.error;

  const buildingId = new URL(req.url).searchParams.get("buildingId");

  let query = auth.supabase
    .from("rooms")
    .select("id,room_number,room_type,price_month,status,buildings(name)")
    .order("room_number");
  if (buildingId) query = query.eq("building_id", buildingId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rooms: data ?? [] });
}
