import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { buildTenantStatement } from "@/lib/money/tenant-statement";
import { loadPostedLateFeesBySource } from "@/lib/money/late-fee-posting";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

// Every column buildTenantStatement / chargesFromInvoiceRow reads, plus the
// legacy fields the LIFF page already renders.
const INVOICE_STATEMENT_SELECT =
  "id,public_token,issue_date,start_date,due_date,total_amount,paid_amount,status,slip_url,slip_uploaded_at,payment_history,additional_fees_breakdown,discount_amount,discount_breakdown,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,carry_forward_amount,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount";

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
      .select("id,room_id,full_name,custom_receipt_profile,policy_accepted,rooms(room_number)")
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
        INVOICE_STATEMENT_SELECT
      )
      .eq("tenant_id", tenant.id)
      .in("status", ["pending", "partial", "overdue", "verifying"])
      .order("issue_date", { ascending: false });

    if (pendingError) {
      return NextResponse.json({ error: pendingError.message }, { status: 500 });
    }

    const visiblePendingInvoices = pendingInvoices ?? [];

    const { data: paidInvoices, error: paidError } = await supabase
      .from("invoices")
      .select(INVOICE_STATEMENT_SELECT)
      .eq("tenant_id", tenant.id)
      .eq("status", "paid")
      .order("issue_date", { ascending: false })
      .limit(12);

    if (paidError) {
      return NextResponse.json({ error: paidError.message }, { status: 500 });
    }

    // Additive per-invoice statement (pending and paid); existing fields are untouched.
    const withStatements = async (rows: any[]) => {
      try {
        const ids = rows.map((i: any) => i.id);
        let allocs: any[] = [];
        if (ids.length > 0) {
          const res = await supabase
            .from("invoice_payment_allocations")
            .select("*,invoice:invoice_id(start_date)")
            .in("invoice_id", ids);
          if (!res.error) {
            allocs = (res.data ?? []).map((r: any) => ({
              ...r,
              invoice_period: (Array.isArray(r.invoice) ? r.invoice[0] : r.invoice)?.start_date ?? null,
            }));
          }
        }
        const postedBySource = await loadPostedLateFeesBySource(supabase, ids);
        return rows.map((inv: any) => ({
          ...inv,
          statement: buildTenantStatement(
            inv,
            allocs.filter((a) => String(a.invoice_id) === String(inv.id)),
            Array.isArray(inv.payment_history) ? inv.payment_history : [],
            { postedLateFees: postedBySource.get(String(inv.id)) }
          ),
        }));
      } catch {
        return rows;
      }
    };
    const invoicesWithStatement = await withStatements(visiblePendingInvoices);
    const paidWithStatement = await withStatements(paidInvoices ?? []);

    const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;

    // Move-out request status/history has its own dedicated endpoint
    // (app/api/payment-liff/move-out's get_status action) — not duplicated here.
    return NextResponse.json({
      tenant: {
        id: tenant.id,
        full_name: (tenant as any).full_name,
        room_number: roomRel?.room_number ?? "-",
        has_corporate_receipt: !!(tenant as any)?.custom_receipt_profile,
        policy_accepted: !!(tenant as any)?.policy_accepted,
      },
      invoices: invoicesWithStatement,
      pending_invoices: invoicesWithStatement,
      paid_invoices: paidWithStatement,
      message: null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
