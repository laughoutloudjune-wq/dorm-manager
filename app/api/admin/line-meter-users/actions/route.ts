import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "save") {
      const auth = await requireAdminPermission(req, "meter.edit");
      if ("error" in auth) return auth.error;

      const lineUserId = String(body?.lineUserId ?? "").trim();
      const displayName = body?.displayName ? String(body.displayName).trim() : null;
      const staffNote = body?.staffNote != null ? String(body.staffNote).trim() : null;
      const status = String(body?.status ?? "active");
      const id = body?.id ? String(body.id) : null;
      const notifyPayment = Boolean(body?.notifyPayment ?? false);
      const notifyMoveOut = Boolean(body?.notifyMoveOut ?? false);

      if (!lineUserId && !id) {
        return NextResponse.json({ error: "Missing line user id." }, { status: 400 });
      }
      if (!["active", "inactive"].includes(status)) {
        return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      }

      const nowIso = new Date().toISOString();
      const payload: Record<string, unknown> = {
        display_name: displayName,
        staff_note: staffNote || null,
        status,
        notify_payment: notifyPayment,
        notify_move_out: notifyMoveOut,
        registered_via: "admin",
        source_channel: "admin_console",
        updated_at: nowIso,
        last_seen_at: nowIso,
      };

      if (lineUserId) payload.line_user_id = lineUserId;

      if (id) {
        const { error } = await auth.supabase.from("line_meter_users").update(payload).eq("id", id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      } else {
        const { error } = await auth.supabase.from("line_meter_users").upsert(
          {
            ...payload,
            line_user_id: lineUserId,
            first_seen_at: nowIso,
            created_at: nowIso,
          },
          { onConflict: "line_user_id" }
        );
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    if (action === "delete") {
      const auth = await requireAdminPermission(req, "meter.edit");
      if ("error" in auth) return auth.error;

      const id = String(body?.id ?? "");
      if (!id) {
        return NextResponse.json({ error: "Missing id." }, { status: 400 });
      }

      const { error } = await auth.supabase.from("line_meter_users").delete().eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "set_status") {
      const auth = await requireAdminPermission(req, "meter.edit");
      if ("error" in auth) return auth.error;

      const id = String(body?.id ?? "");
      const status = String(body?.status ?? "");
      if (!id || !["active", "inactive"].includes(status)) {
        return NextResponse.json({ error: "Missing id or invalid status." }, { status: 400 });
      }

      const { error } = await auth.supabase
        .from("line_meter_users")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error." },
      { status: 500 }
    );
  }
}
