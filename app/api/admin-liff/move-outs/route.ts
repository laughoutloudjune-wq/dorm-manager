import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;

    const supabase = createAdminClient();

    // "requested" and "approved" are the two states an admin still has work to
    // do on — requested needs a decision, approved is just awaiting the actual
    // move-out date. Terminal states (rejected/completed/cancelled) aren't
    // useful on a phone-sized triage list.
    const { data, error } = await supabase
      .from("move_out_requests")
      .select(
        "id,tenant_id,notice_date,requested_move_out_date,approved_move_out_date,status,request_note,admin_note,created_at,tenants(full_name,rooms(room_number,buildings(name)))"
      )
      .in("status", ["requested", "approved"])
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const requests = (data ?? []).map((row: any) => {
      const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
      const room = Array.isArray(tenant?.rooms) ? tenant?.rooms[0] : tenant?.rooms;
      const building = Array.isArray(room?.buildings) ? room?.buildings[0] : room?.buildings;
      return {
        id: row.id,
        tenant_id: row.tenant_id,
        tenant_name: tenant?.full_name ?? "-",
        room_number: room?.room_number ?? "-",
        building_name: building?.name ?? "-",
        notice_date: row.notice_date,
        requested_move_out_date: row.requested_move_out_date,
        approved_move_out_date: row.approved_move_out_date,
        status: row.status,
        request_note: row.request_note,
        admin_note: row.admin_note,
        created_at: row.created_at,
      };
    });

    return NextResponse.json({ requests });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
