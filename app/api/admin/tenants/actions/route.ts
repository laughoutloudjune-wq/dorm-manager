import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save_tenant") {
      const auth = await requireAdminPermission(req, "tenant.edit");
      if ("error" in auth) return auth.error;
      const payload = body?.payload ?? {};
      const roomId = body?.roomId ? String(body.roomId) : "";

      const { error } = await auth.supabase.from("tenants").upsert(payload, { onConflict: "id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

