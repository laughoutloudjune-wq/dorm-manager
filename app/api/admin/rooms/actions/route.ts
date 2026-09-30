import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "get_rooms") {
      // Powers app/(admin)/rooms/page.tsx's main room list, which used to
      // read directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "room.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("rooms")
        .select("id,room_number,status,buildings(name),tenants(full_name,line_user_id)")
        .order("room_number");
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ rooms: data ?? [] });
    }

    if (action === "get_latest_invoice_for_room") {
      // Powers the "send LINE reminder" flow — same finding as get_rooms.
      const auth = await requireAdminPermission(req, "room.view");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      if (!roomId) return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("public_token,total_amount,issue_date")
        .eq("room_id", roomId)
        .order("issue_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoice: data ?? null });
    }

    if (action === "get_room_movement_logs") {
      // Powers the room detail modal's movement history — same finding as
      // get_rooms.
      const auth = await requireAdminPermission(req, "room.view");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      if (!roomId) return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("room_tenant_logs")
        .select("id,tenant_id,tenant_name,move_in_date,move_out_date")
        .eq("room_id", roomId)
        .order("move_in_date", { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ logs: data ?? [] });
    }

    if (action === "get_room_tenant_detail") {
      // Powers the room detail modal's "view this past tenant" panel — 3
      // parallel reads (tenant, their invoices, their latest move-out
      // request) that used to run directly from the browser. Same finding
      // as get_rooms.
      const auth = await requireAdminPermission(req, "room.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });

      const [tenantRes, invoicesRes, requestsRes] = await Promise.all([
        auth.supabase
          .from("tenants")
          .select(
            "id,room_id,full_name,phone_number,email,address,line_user_id,status,move_in_date,move_out_date,lease_months,security_deposit_amount,advance_rent_amount,forfeit_security_deposit,initial_electricity_reading,initial_water_reading,final_electricity_reading,final_water_reading"
          )
          .eq("id", tenantId)
          .maybeSingle(),
        auth.supabase
          .from("invoices")
          .select("id,issue_date,start_date,total_amount,paid_amount,status,public_token,notes")
          .eq("tenant_id", tenantId)
          .order("issue_date", { ascending: false }),
        auth.supabase
          .from("move_out_requests")
          .select(
            "id,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at"
          )
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      if (tenantRes.error || invoicesRes.error || requestsRes.error) {
        return NextResponse.json(
          { error: tenantRes.error?.message ?? invoicesRes.error?.message ?? requestsRes.error?.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        tenant: tenantRes.data ?? null,
        invoices: invoicesRes.data ?? [],
        moveOutRequest: (requestsRes.data ?? [])[0] ?? null,
      });
    }

    if (action === "toggle_status") {
      const auth = await requireAdminPermission(req, "room.edit");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      const status = String(body?.status ?? "");
      const { error } = await auth.supabase.from("rooms").update({ status }).eq("id", roomId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}

