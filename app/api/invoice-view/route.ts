import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const token = String(body?.token ?? "");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("id,opened_count,first_opened_at,last_opened_at")
      .eq("public_token", token)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
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
