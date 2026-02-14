import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { accessToken } = body ?? {};

    if (!accessToken) {
      return NextResponse.json({ error: "Missing access token" }, { status: 400 });
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileResponse.ok) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    const profile = await profileResponse.json();
    const lineUserId = profile.userId as string;

    const supabase = createAdminClient();

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id,room_id,full_name,rooms(room_number)")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    if (!tenant) {
      return NextResponse.json({
        tenant: null,
        invoices: [],
        message: "ไม่พบบัญชีผู้เช่าที่เชื่อมกับ LINE นี้",
      });
    }

    const { data: invoices, error: invoiceError } = await supabase
      .from("invoices")
      .select(
        "id,public_token,issue_date,due_date,total_amount,paid_amount,status,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total"
      )
      .eq("tenant_id", tenant.id)
      .in("status", ["pending", "partial", "overdue", "verifying"])
      .order("issue_date", { ascending: false });

    if (invoiceError) {
      return NextResponse.json({ error: invoiceError.message }, { status: 500 });
    }

    const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        full_name: (tenant as any).full_name,
        room_number: roomRel?.room_number ?? "-",
      },
      invoices: invoices ?? [],
      message: null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
