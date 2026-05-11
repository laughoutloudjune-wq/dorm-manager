import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token = String(body?.token ?? "");
    const accessToken = String(body?.accessToken ?? "");
    if (!token || !accessToken) {
      return NextResponse.json({ error: "Missing token or accessToken" }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile?.userId) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }
    const lineUserId = String(profile.userId);

    const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const isAdmin = adminLineUserIds.includes(lineUserId);

    const supabase = createAdminClient();
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("id,opened_count,first_opened_at,last_opened_at,tenants(line_user_id)")
      .eq("public_token", token)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const invoiceTenant = Array.isArray((invoice as any).tenants) ? (invoice as any).tenants[0] : (invoice as any).tenants;
    const invoiceLineUserId = String(invoiceTenant?.line_user_id ?? "");
    if (!isAdmin && !invoiceLineUserId) {
      return NextResponse.json({ error: "Invoice tenant is missing LINE user id" }, { status: 403 });
    }
    if (!isAdmin && invoiceLineUserId !== lineUserId) {
      return NextResponse.json({ error: "LINE user mismatch for this invoice" }, { status: 403 });
    }

    const nowIso = new Date().toISOString();
    const nextCount = Number((invoice as any).opened_count ?? 0) + 1;
    const firstOpenedAt = (invoice as any).first_opened_at ?? nowIso;

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        opened_count: nextCount,
        first_opened_at: firstOpenedAt,
        last_opened_at: nowIso,
      })
      .eq("id", (invoice as any).id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      opened_count: nextCount,
      first_opened_at: firstOpenedAt,
      last_opened_at: nowIso,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
