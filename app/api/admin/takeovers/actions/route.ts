import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    const requestId = String(body?.requestId ?? "");
    const adminNote = body?.adminNote != null ? String(body.adminNote) : null;

    if (!action || !requestId) {
      return NextResponse.json({ error: "Missing action or requestId." }, { status: 400 });
    }

    const authTenant = await requireAdminPermission(req, "tenant.edit");
    if ("error" in authTenant) return authTenant.error;
    const authRoom = await requireAdminPermission(req, "room.edit");
    if ("error" in authRoom) return authRoom.error;

    const supabase = authTenant.supabase;
    const nowIso = new Date().toISOString();
    const moveOutDate = String(body?.approvedMoveOutDate ?? nowIso.slice(0, 10));

    const { data: takeover, error: takeoverError } = await supabase
      .from("room_takeover_requests")
      .select("id,room_id,requester_line_user_id,current_active_tenant_id,status")
      .eq("id", requestId)
      .maybeSingle();

    if (takeoverError) {
      return NextResponse.json({ error: takeoverError.message }, { status: 500 });
    }
    if (!takeover) {
      return NextResponse.json({ error: "Takeover request not found." }, { status: 404 });
    }
    if (takeover.status !== "requested") {
      return NextResponse.json({ error: `Invalid takeover request status: ${takeover.status}` }, { status: 400 });
    }

    const roomId = String(takeover.room_id);
    const requesterLineUserId = String(takeover.requester_line_user_id ?? "");

    if (action === "reject") {
      const { error: updateErr } = await supabase
        .from("room_takeover_requests")
        .update({ status: "rejected", admin_note: adminNote, updated_at: nowIso })
        .eq("id", requestId);
      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action !== "approve") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    // Approve: close the current active tenant, free the room, and mark request approved.
    const activeTenantIdFromSnapshot = takeover.current_active_tenant_id ? String(takeover.current_active_tenant_id) : "";
    let activeTenantId = activeTenantIdFromSnapshot;
    if (!activeTenantId) {
      const { data: activeTenant, error: activeTenantError } = await supabase
        .from("tenants")
        .select("id")
        .eq("room_id", roomId)
        .eq("status", "active")
        .maybeSingle();
      if (activeTenantError) return NextResponse.json({ error: activeTenantError.message }, { status: 500 });
      activeTenantId = activeTenant?.id ? String(activeTenant.id) : "";
    }

    const { error: approveErr } = await supabase
      .from("room_takeover_requests")
      .update({ status: "approved", admin_note: adminNote, updated_at: nowIso })
      .eq("id", requestId);
    if (approveErr) return NextResponse.json({ error: approveErr.message }, { status: 500 });

    if (activeTenantId) {
      const { error: updateTenantErr } = await supabase
        .from("tenants")
        .update({ status: "inactive", move_out_date: moveOutDate, updated_at: nowIso })
        .eq("id", activeTenantId);
      if (updateTenantErr) return NextResponse.json({ error: updateTenantErr.message }, { status: 500 });

      const { data: openLog, error: openLogError } = await supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", activeTenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLogError) return NextResponse.json({ error: openLogError.message }, { status: 500 });

      if (openLog?.id) {
        const { error: closeLogErr } = await supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: nowIso })
          .eq("id", openLog.id);
        if (closeLogErr) return NextResponse.json({ error: closeLogErr.message }, { status: 500 });
      }
    }

    const { error: roomErr } = await authRoom.supabase
      .from("rooms")
      .update({ status: "available" })
      .eq("id", roomId);
    if (roomErr) return NextResponse.json({ error: roomErr.message }, { status: 500 });

    // Room movement journal (for occupancy reconciliation).
    const { error: roomLogErr } = await authRoom.supabase.from("room_logs").insert({
      room_id: roomId,
      event_type: "move_out",
      created_at: nowIso,
    });
    if (roomLogErr) {
      // Non-fatal: room is freed even if journal insert fails.
      // eslint-disable-next-line no-console
      console.warn("room_logs insert failed:", roomLogErr.message);
    }

    return NextResponse.json({ success: true, roomId, requesterLineUserId });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}

