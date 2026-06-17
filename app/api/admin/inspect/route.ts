import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from("invoices")
    .select("id, status, total_amount, rent_amount, water_bill, electricity_bill, late_fee_amount, locked_late_fee_amount, waived_late_fee_amount, late_fee_start_date, late_fee_per_day")
    .like("start_date", "2026-03%");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
