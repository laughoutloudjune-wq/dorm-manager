import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to save_payment_methods in
 * app/api/admin/settings/actions/route.ts. Gated on "tenant.view" — same
 * reasoning as app/api/admin/settings/route.ts: every admin role needs to
 * read this, editing is separately gated on settings.payment_methods.
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("payment_methods")
    .select("id,label,bank_name,account_name,account_number,qr_url")
    .order("label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ methods: data ?? [] });
}
