import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";
import { isLateFeeBreakdownRow } from "@/lib/invoice-utils";

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
      .select(
        "id,room_id,start_date,total_amount,paid_amount,carry_forward_amount,late_fee_amount,payment_history,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,additional_fees_breakdown,discount_amount,discount_breakdown,status,slip_url,opened_count,first_opened_at,last_opened_at,tenants(full_name,custom_payment_method,move_in_date,line_user_id),rooms(room_number,price_month)"
      )
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

    // Everything else app/(public)/payment/[token]/page.tsx needs to render —
    // moved here from separate direct-anon-key reads the browser used to make
    // right after this same authorization check, with no ownership check of
    // their own (finding C1, docs/audit/2026-09-29-system-audit-detailed.md).
    // Fetched with the exact query shapes the page always used; only WHERE
    // they run changed — the page still does its own normalization/fallback
    // logic on the raw rows returned below, unchanged.
    const additionalFeesBreakdown = Array.isArray((invoice as any).additional_fees_breakdown)
      ? (invoice as any).additional_fees_breakdown
      : [];
    const ownLateFeeRows = additionalFeesBreakdown.filter(isLateFeeBreakdownRow);
    const readingMonthDate = new Date(String((invoice as any).start_date));
    const readingMonth = `${readingMonthDate.getFullYear()}-${String(readingMonthDate.getMonth() + 1).padStart(2, "0")}-01`;

    const [updateResult, methodResult, settingsResult, arrearsResult, meterResult] = await Promise.all([
      supabase
        .from("invoices")
        .update({ opened_count: nextCount, first_opened_at: firstOpenedAt, last_opened_at: nowIso })
        .eq("id", (invoice as any).id),
      supabase
        .from("payment_methods")
        .select("label,bank_name,account_name,account_number,qr_url")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase.from("settings").select("billing_day,water_rate,electricity_rate").eq("id", 1).maybeSingle(),
      ownLateFeeRows.length === 0
        ? supabase
            .from("invoice_arrears_snapshots")
            .select(
              "id,source_invoice_id,snapshot_as_of,late_fee_amount,days_overdue,daily_rate,source_invoice:source_invoice_id(start_date)"
            )
            .eq("target_invoice_id", (invoice as any).id)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as any[], error: null }),
      supabase
        .from("meter_readings")
        .select(
          "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
        )
        .eq("room_id", (invoice as any).room_id)
        .eq("reading_month", readingMonth)
        .maybeSingle(),
    ]);

    if (updateResult.error) {
      return NextResponse.json({ error: updateResult.error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      opened_count: nextCount,
      first_opened_at: firstOpenedAt,
      last_opened_at: nowIso,
      invoiceRow: invoice,
      defaultMethod: methodResult.data ?? null,
      settingsRow: settingsResult.data ?? null,
      arrearsRows: (arrearsResult as any)?.data ?? [],
      meterReading: meterResult.data ?? null,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
