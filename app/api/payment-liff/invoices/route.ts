import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { loadV2LateFeeStates, type V2LateFeeState } from "@/lib/fee-model-v2";

/**
 * v2 bills (from the 25 Oct 2026 cycle) store only their own charges; the late
 * fee is derived by the balance engine. Give the LINE pages the engine's
 * answer in the fields they already read, so a v2 bill shows (and is paid as)
 * charges + fee − waived − paid. Legacy rows pass through untouched.
 */
const withV2Balance = (row: any, states: Map<string, V2LateFeeState>) => {
  const state = states.get(String(row.id));
  if (!state) return row;
  const b = state.balance;
  return {
    ...row,
    amount_due: b.amountDue,
    // Late fee still owed on this bill (accrued − waived − already paid).
    late_fee_amount: b.feeDue,
    late_fee_days: b.feeDays,
    late_fee_accrued: b.feeAccrued,
    late_fee_waived: b.feeWaived,
    late_fee_running: b.feeRunning,
  };
};

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
        "id,public_token,issue_date,due_date,total_amount,paid_amount,status,fee_model,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,carry_forward_amount,late_fee_amount,late_fee_per_day,late_fee_start_date,waived_late_fee_amount,locked_late_fee_amount"
      )
      .eq("tenant_id", tenant.id)
      .in("status", ["pending", "partial", "overdue", "verifying"])
      .order("issue_date", { ascending: false });

    if (pendingError) {
      return NextResponse.json({ error: pendingError.message }, { status: 500 });
    }

    const v2States = await loadV2LateFeeStates(
      supabase,
      (pendingInvoices ?? []).filter((row: any) => row.fee_model === "v2").map((row: any) => String(row.id)),
    );
    const visiblePendingInvoices = (pendingInvoices ?? []).map((row: any) => withV2Balance(row, v2States));

    const { data: paidInvoices, error: paidError } = await supabase
      .from("invoices")
      .select("id,public_token,issue_date,due_date,total_amount,paid_amount,status,late_fee_amount")
      .eq("tenant_id", tenant.id)
      .eq("status", "paid")
      .order("issue_date", { ascending: false })
      .limit(12);

    if (paidError) {
      return NextResponse.json({ error: paidError.message }, { status: 500 });
    }

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
      invoices: visiblePendingInvoices,
      pending_invoices: visiblePendingInvoices,
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
