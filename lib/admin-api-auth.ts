import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { normalizeRolePermissions, PermissionKey, RoleKey } from "@/lib/permissions";

export const getBearerToken = (req: Request) => {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

export async function requireAdminPermission(req: Request, permission: PermissionKey) {
  const token = getBearerToken(req);
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const supabase = createAdminClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const [{ data: roleRow }, { data: settingsRow }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
    supabase.from("settings").select("role_permissions").eq("id", 1).maybeSingle(),
  ]);

  const role = (((roleRow as any)?.role ?? "viewer") as RoleKey);
  const matrix = normalizeRolePermissions((settingsRow as any)?.role_permissions);
  if (!matrix[role]?.[permission]) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { supabase, user, role, matrix };
}

