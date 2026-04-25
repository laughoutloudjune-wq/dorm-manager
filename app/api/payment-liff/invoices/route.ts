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

    const pendingInvoiceIds = (pendingInvoices ?? []).map((row: any) => String(row.id));
    const { data: carryRows, error: carryError } =
      pendingInvoiceIds.length > 0
        ? await supabase
            .from("invoice_carry_forwards")
            .select("source_invoice_id,target_invoice_id")
            .in("source_invoice_id", pendingInvoiceIds)
        : { data: [], error: null as any };

    if (carryError) {
      return NextResponse.json({ error: carryError.message }, { status: 500 });
    }

    const carryTargetIds = [...new Set((carryRows ?? []).map((row: any) => String(row.target_invoice_id)).filter(Boolean))];
    const { data: carryTargets, error: carryTargetError } =
      carryTargetIds.length > 0
        ? await supabase
            .from("invoices")
            .select("id,status")
            .in("id", carryTargetIds)
        : { data: [], error: null as any };

    if (carryTargetError) {
      return NextResponse.json({ error: carryTargetError.message }, { status: 500 });
    }

    const openTargetIds = new Set(
      (carryTargets ?? [])
        .filter((row: any) => ["pending", "partial", "overdue", "verifying"].includes(String(row.status)))
        .map((row: any) => String(row.id))
    );
    const hiddenSourceIds = new Set(
      (carryRows ?? [])
        .filter((row: any) => openTargetIds.has(String(row.target_invoice_id)))
        .map((row: any) => String(row.source_invoice_id))
    );
    const visiblePendingInvoices = (pendingInvoices ?? []).filter(
      (invoice: any) => !hiddenSourceIds.has(String(invoice.id))
    );

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

    const { data: moveOutRequest, error: moveOutError } = await supabase
      .from("move_out_requests")
      .select(
        "id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at,updated_at"
      )
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (moveOutError) {
      return NextResponse.json({ error: moveOutError.message }, { status: 500 });
    }

    const visiblePendingInvoiceIds = visiblePendingInvoices.map((row: any) => String(row.id));
    const { data: arrearsSnapshots, error: arrearsError } =
      visiblePendingInvoiceIds.length > 0
        ? await supabase
            .from("invoice_arrears_snapshots")
            .select(
              "id,target_invoice_id,source_invoice_id,snapshot_as_of,late_fee_amount,days_overdue,daily_rate"
            )
            .in("target_invoice_id", visiblePendingInvoiceIds)
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
      invoices: visiblePendingInvoices.map((invoice: any) => ({
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
      pending_invoices: visiblePendingInvoices.map((invoice: any) => ({
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
      move_out_request: moveOutRequest ?? null,
      message: null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
