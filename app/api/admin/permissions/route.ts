import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { getBearerToken } from "@/lib/admin-api-auth";
import { normalizeRolePermissions, type RoleKey } from "@/lib/permissions";

/**
 * Powers usePermissions() in lib/use-permissions.ts — the client-side
 * `can()` check every admin page gates its UI on. This used to read
 * `settings.role_permissions` and `user_roles` directly from the browser
 * with the anon key (finding C1). Deliberately does NOT use
 * requireAdminPermission: this endpoint's whole job is to tell an
 * authenticated user what they're allowed to do, before they've done
 * anything — the only requirement is a valid session, not any specific
 * permission (there's nothing to gate it on).
 */
export async function GET(req: Request) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: roleRow }, { data: settingsRow }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
    supabase.from("settings").select("role_permissions").eq("id", 1).maybeSingle(),
  ]);

  const rawRole = (roleRow as any)?.role;
  const role: RoleKey =
    rawRole === "owner" || rawRole === "admin" || rawRole === "staff" || rawRole === "viewer" ? rawRole : "viewer";
  const matrix = normalizeRolePermissions((settingsRow as any)?.role_permissions);

  return NextResponse.json({ role, matrix });
}
