import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-side counterpart to app/api/admin/meters/actions/route.ts (which
 * only handles saves). Powers useMeterReadingsRawData in
 * lib/hooks/use-data.ts — 4 parallel reads plus a conditional follow-up
 * used to run directly from the browser with the anon key (finding C1).
 * Every query and the month-boundary math are unchanged, just relocated.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "meter.edit");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const body = await req.json();
    const selectedMonth = String(body?.selectedMonth ?? "");
    const [year, month] = selectedMonth.split("-").map(Number);
    if (!year || !month) {
      return NextResponse.json({ error: "Missing or invalid selectedMonth." }, { status: 400 });
    }

    const currentMonthDate = new Date(year, month - 1, 1);
    const prevMonthDate = new Date(year, month - 2, 1);
    const nextMonthDate = new Date(year, month, 1);

    const currentMonthKey = `${currentMonthDate.getFullYear()}-${String(currentMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;

    const [
      { data: roomData, error: roomError },
      { data: currentReadings },
      { data: previousReadings },
      { data: activeTenants },
    ] = await Promise.all([
      supabase.from("rooms").select("id,room_number,buildings(name)").order("room_number", { ascending: true }),
      supabase
        .from("meter_readings")
        .select(
          "id,room_id,reading_month,created_at,previous_electricity,current_electricity,electricity_usage,previous_water,current_water,water_usage,previous_reading,current_reading,usage,previous_source"
        )
        .gte("reading_month", currentMonthKey)
        .lt("reading_month", nextMonthKey)
        .order("reading_month", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("meter_readings")
        .select("id,room_id,reading_month,created_at,current_electricity,current_water,current_reading")
        .gte("reading_month", prevMonthKey)
        .lt("reading_month", currentMonthKey)
        .order("reading_month", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("tenants")
        .select("id,room_id,full_name,move_in_date,initial_electricity_reading,initial_water_reading,status")
        .lt("move_in_date", nextMonthKey)
        .eq("status", "active")
        .order("move_in_date", { ascending: false }),
    ]);

    if (roomError) return NextResponse.json({ error: roomError.message }, { status: 500 });

    const activeTenantIds = ((activeTenants ?? []) as any[]).map((item) => String(item?.id ?? "")).filter(Boolean);
    let tenantInvoices: any[] = [];
    if (activeTenantIds.length > 0) {
      // Up through the end of the currently-viewed month, not just before
      // it — otherwise a regular invoice already generated FOR this month
      // is invisible to this check, and the room keeps showing the "first
      // billing cycle" banner even after it's no longer true.
      const { data } = await supabase
        .from("invoices")
        .select("tenant_id,start_date,status")
        .in("tenant_id", activeTenantIds)
        .lt("start_date", nextMonthKey)
        .neq("status", "cancelled");
      tenantInvoices = data ?? [];
    }

    return NextResponse.json({
      roomData,
      currentReadings,
      previousReadings,
      activeTenants,
      tenantInvoices,
      currentMonthKey,
      nextMonthKey,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
