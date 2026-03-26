import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const invoiceIds = Array.isArray(body?.invoiceIds)
      ? (body.invoiceIds as string[]).map(String).filter(Boolean)
      : [];
    const slipUrl = body?.slipUrl ? String(body.slipUrl) : null;

    if (!accessToken || invoiceIds.length === 0 || !slipUrl) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileResponse.ok) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    const profile = await profileResponse.json();
    const lineUserId = String(profile.userId ?? "");
    const supabase = createAdminClient();

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("line_user_id", lineUserId)
      .maybeSingle();
    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }
    if (!tenant?.id) {
      return NextResponse.json({ error: "Tenant not found for this LINE account." }, { status: 404 });
    }

    const { data: invoices, error: invoiceError } = await supabase
      .from("invoices")
      .select("id,status,tenant_id")
      .eq("tenant_id", tenant.id)
      .in("id", invoiceIds)
      .in("status", ["pending", "partial", "overdue"]);
    if (invoiceError) {
      return NextResponse.json({ error: invoiceError.message }, { status: 500 });
    }

    const validInvoices = invoices ?? [];
    if (validInvoices.length !== invoiceIds.length) {
      return NextResponse.json({ error: "Some selected invoices are invalid." }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        slip_url: slipUrl,
        slip_uploaded_at: nowIso,
        status: "verifying",
      })
      .in("id", invoiceIds);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    await Promise.all(
      invoiceIds.map((invoiceId) =>
        fetch(`${new URL(req.url).origin}/api/notify-slip-upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId, slipUrl }),
        }).catch(() => null)
      )
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
