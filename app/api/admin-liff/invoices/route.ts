import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const statuses = Array.isArray(body?.statuses) ? (body.statuses as string[]) : null;
    const month = body?.month ? String(body.month) : null;
    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;
    const profile = auth.profile;

    const supabase = createAdminClient();
    const validStatuses =
      statuses && statuses.length > 0
        ? statuses
        : (["pending", "partial", "overdue", "verifying"] as string[]);

    let query = supabase
      .from("invoices")
      .select(
        "id,public_token,status,issue_date,due_date,total_amount,paid_amount,slip_url,payment_history,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,carry_forward_amount,late_fee_amount,discount_amount,additional_fees_breakdown,discount_breakdown,tenants(full_name,phone_number),rooms(room_number,buildings(name))"
      )
      .in("status", validStatuses);

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, mon] = month.split("-").map(Number);
      const start = `${year}-${String(mon).padStart(2, "0")}-01`;
      const end = new Date(year, mon, 0).toISOString().slice(0, 10);
      query = query.gte("start_date", start).lte("start_date", end);
    }

    const { data: invoices, error } = await query
      .order("issue_date", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      profile,
      invoices: invoices ?? [],
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
