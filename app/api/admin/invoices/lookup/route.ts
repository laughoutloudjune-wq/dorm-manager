import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-only: resolves which billing period an invoice belongs to, so a deep
 * link (/invoices?invoice=<id>) can switch the month before opening it.
 */
export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  const { data, error } = await auth.supabase.from("invoices").select("id,start_date").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ id: data.id, startDate: data.start_date });
}
