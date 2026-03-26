import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

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
      .select("id,room_id,full_name,custom_receipt_profile,rooms(room_number)")
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

    const { data: pendingInvoices, error: pendingError } = await supabase
      .from("invoices")
      .select(
        "id,public_token,issue_date,due_date,total_amount,paid_amount,status,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,carry_forward_amount"
      )
      .eq("tenant_id", tenant.id)
      .in("status", ["pending", "partial", "overdue", "verifying"])
      .order("issue_date", { ascending: false });

    if (pendingError) {
      return NextResponse.json({ error: pendingError.message }, { status: 500 });
    }

    const { data: paidInvoices, error: paidError } = await supabase
      .from("invoices")
      .select("id,public_token,issue_date,due_date,total_amount,paid_amount,status")
      .eq("tenant_id", tenant.id)
      .eq("status", "paid")
      .order("issue_date", { ascending: false })
      .limit(12);

    if (paidError) {
      return NextResponse.json({ error: paidError.message }, { status: 500 });
    }

    const pendingInvoiceIds = (pendingInvoices ?? []).map((row: any) => String(row.id));
    const { data: arrearsSnapshots, error: arrearsError } =
      pendingInvoiceIds.length > 0
        ? await supabase
            .from("invoice_arrears_snapshots")
            .select(
              "id,target_invoice_id,source_invoice_id,snapshot_as_of,late_fee_amount,days_overdue,daily_rate"
            )
            .in("target_invoice_id", pendingInvoiceIds)
            .order("created_at", { ascending: true })
        : { data: [], error: null as any };

    if (arrearsError) {
      return NextResponse.json({ error: arrearsError.message }, { status: 500 });
    }

    const arrearsByInvoice = new Map<string, any[]>();
    for (const row of arrearsSnapshots ?? []) {
      const key = String((row as any).target_invoice_id ?? "");
      if (!arrearsByInvoice.has(key)) arrearsByInvoice.set(key, []);
      arrearsByInvoice.get(key)!.push(row as any);
    }

    const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        full_name: (tenant as any).full_name,
        room_number: roomRel?.room_number ?? "-",
        has_corporate_receipt: !!(tenant as any)?.custom_receipt_profile,
      },
      invoices: (pendingInvoices ?? []).map((invoice: any) => ({
        ...invoice,
        late_fee_breakdown: (arrearsByInvoice.get(String(invoice.id)) ?? []).map((row: any) => ({
          id: String(row.id),
          source_invoice_id: String(row.source_invoice_id),
          snapshot_as_of: String(row.snapshot_as_of),
          late_fee_amount: toNumber(row.late_fee_amount),
          days_overdue: Math.round(toNumber(row.days_overdue)),
          daily_rate: toNumber(row.daily_rate),
        })),
      })),
      pending_invoices: (pendingInvoices ?? []).map((invoice: any) => ({
        ...invoice,
        late_fee_breakdown: (arrearsByInvoice.get(String(invoice.id)) ?? []).map((row: any) => ({
          id: String(row.id),
          source_invoice_id: String(row.source_invoice_id),
          snapshot_as_of: String(row.snapshot_as_of),
          late_fee_amount: toNumber(row.late_fee_amount),
          days_overdue: Math.round(toNumber(row.days_overdue)),
          daily_rate: toNumber(row.daily_rate),
        })),
      })),
      paid_invoices: paidInvoices ?? [],
      message: null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
