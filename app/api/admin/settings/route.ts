import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to app/api/admin/settings/actions/route.ts. Gated
 * on "tenant.view" — the same low bar app/api/admin/dashboard-stats/route.ts
 * uses — since every admin role needs to read settings (rates, config)
 * even when it can't edit any of it; that boundary is enforced by the
 * settings page's own per-tab lock, not by this read.
 *
 * Bootstraps the singleton settings row (id=1) if it doesn't exist yet,
 * so the caller never has to special-case "missing row" itself — this
 * replaces the direct-from-browser insert that used to live in
 * app/(admin)/settings/page.tsx's loadSettings (finding C1).
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data) {
    return NextResponse.json({ settings: data });
  }

  const { data: inserted, error: insertError } = await auth.supabase
    .from("settings")
    .insert({ id: 1 })
    .select("*")
    .single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ settings: inserted });
}
