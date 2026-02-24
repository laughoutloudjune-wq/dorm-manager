import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireAdminPermission } from "@/lib/admin-api-auth";

const ALLOWED_ROLES = ["owner", "admin", "staff", "viewer"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

export async function GET(req: Request) {
  try {
    const authz = await requireAdminPermission(req, "settings.permissions");
    if ("error" in authz) return authz.error;
    const supabase = createAdminClient();

    const {
      data: { users },
      error: authError,
    } = await supabase.auth.admin.listUsers();

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 500 });
    }

    const userIds = (users ?? []).map((user) => user.id);
    const { data: roles, error: roleError } = await supabase
      .from("user_roles")
      .select("user_id,role")
      .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);

    if (roleError) {
      return NextResponse.json({ error: roleError.message }, { status: 500 });
    }

    const roleMap = new Map<string, string>((roles ?? []).map((r: any) => [r.user_id, r.role]));
    const rows = (users ?? []).map((user) => ({
      id: user.id,
      email: user.email ?? null,
      phone: user.phone ?? null,
      created_at: user.created_at ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
      role: roleMap.get(user.id) ?? "viewer",
    }));

    return NextResponse.json({ users: rows });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to load user roles." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const authz = await requireAdminPermission(req, "settings.permissions");
    if ("error" in authz) return authz.error;
    const body = await req.json();
    const userId = String(body?.userId ?? "");
    const role = String(body?.role ?? "") as AllowedRole;

    if (!userId) {
      return NextResponse.json({ error: "Missing userId." }, { status: 400 });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { error } = await supabase.from("user_roles").upsert(
      {
        user_id: userId,
        role,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to save user role." },
      { status: 500 }
    );
  }
}
