import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to add_building in
 * app/api/admin/settings/actions/route.ts. Same "tenant.view" gate as its
 * siblings — editing is separately gated on settings.rooms.
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("buildings")
    .select("id,name")
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ buildings: data ?? [] });
}
