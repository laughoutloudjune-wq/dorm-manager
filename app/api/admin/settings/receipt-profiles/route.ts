import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to save_receipt_profiles in
 * app/api/admin/settings/actions/route.ts. Same "tenant.view" gate as its
 * siblings.
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("receipt_profiles")
    .select("id,label,company_name,tax_id,branch,address")
    .order("label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ profiles: data ?? [] });
}
