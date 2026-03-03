import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const payload = { ...(body?.payload ?? {}) } as any;
      const roomId = body?.roomId ? String(body.roomId) : "";
      if (!payload.id) payload.id = crypto.randomUUID();
      const tenantId = String(payload.id);

      let previousTenant: any = null;
      if (tenantId) {
        const { data } = await auth.supabase
          .from("tenants")
          .select("id,room_id,move_in_date,full_name")
          .eq("id", tenantId)
          .maybeSingle();
        previousTenant = data ?? null;
      }

      const { error } = await auth.supabase.from("tenants").upsert(payload, { onConflict: "id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const effectiveTenantId = tenantId;
      const moveInDate = payload?.move_in_date ? String(payload.move_in_date) : null;
      const fullName = payload?.full_name ? String(payload.full_name) : null;

      const shouldLogMoveIn =
        !!roomId &&
        !!moveInDate &&
        !!fullName &&
        (!previousTenant ||
          String(previousTenant.room_id ?? "") !== roomId ||
          String(previousTenant.move_in_date ?? "") !== moveInDate);

      const roomChanged =
        !!previousTenant &&
        !!previousTenant.room_id &&
        String(previousTenant.room_id) !== roomId;

      if (roomChanged) {
        const closeDate = moveInDate || new Date().toISOString().slice(0, 10);
        await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: closeDate, updated_at: new Date().toISOString() })
          .eq("room_id", String(previousTenant.room_id))
          .eq("tenant_id", tenantId)
          .is("move_out_date", null);
      }

      if (shouldLogMoveIn) {
        await auth.supabase.from("room_tenant_logs").upsert(
          {
            room_id: roomId,
            tenant_id: effectiveTenantId || null,
            tenant_name: fullName,
            move_in_date: moveInDate,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "room_id,tenant_id,move_in_date" }
        );
      }

      if (roomId) {
        const roomAuth = await requireAdminPermission(req, "room.edit");
        if ("error" in roomAuth) return roomAuth.error;
        await roomAuth.supabase.from("rooms").update({ status: "occupied" }).eq("id", roomId);
        await roomAuth.supabase.from("room_logs").insert({
          room_id: roomId,
          event_type: "move_in",
          created_at: new Date().toISOString(),
        });
      }
      return NextResponse.json({ success: true });
    }

    if (action === "delete_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").delete().eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "unlink_line") {
      const auth = await requireAdminPermission(req, "tenant.line.manage");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const { error } = await auth.supabase.from("tenants").update({ line_user_id: null }).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "move_out") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const roomAuth = await requireAdminPermission(req, "room.edit");
      if ("error" in roomAuth) return roomAuth.error;

      const tenantId = String(body?.tenantId ?? "");
      const roomId = String(body?.roomId ?? "");
      const payload = body?.payload ?? {};
      const { error } = await auth.supabase.from("tenants").update(payload).eq("id", tenantId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const moveOutDate = payload?.move_out_date ? String(payload.move_out_date) : new Date().toISOString().slice(0, 10);
      const { data: openLog } = await auth.supabase
        .from("room_tenant_logs")
        .select("id")
        .eq("room_id", roomId)
        .eq("tenant_id", tenantId)
        .is("move_out_date", null)
        .order("move_in_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openLog?.id) {
        await auth.supabase
          .from("room_tenant_logs")
          .update({ move_out_date: moveOutDate, updated_at: new Date().toISOString() })
          .eq("id", openLog.id);
      }

      await roomAuth.supabase.from("rooms").update({ status: "available" }).eq("id", roomId);
      await roomAuth.supabase.from("room_logs").insert({
        room_id: roomId,
        event_type: "move_out",
        created_at: new Date().toISOString(),
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
