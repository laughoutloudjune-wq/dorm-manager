import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";

/**
 * Mirrors the "manage_move_out_request" branch of
 * app/api/admin/tenants/actions/route.ts, but gated by the LINE admin
 * allowlist (requireLineAdminAccess) instead of the desktop permission
 * matrix — the admin LIFF has no concept of per-user roles, only "is this
 * LINE account on the admin list."
 *
 * Deliberately does NOT expose "completed": that status is only set by the
 * desktop settlement wizard (final_move_out), which computes prorated rent,
 * utilities and deposit forfeiture from live meter readings. Mobile only
 * triages the request itself — approve (with a move-out date) or reject
 * (with a note) — then the admin finishes settlement on desktop.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const action = String(body?.action ?? "");
    const requestId = String(body?.requestId ?? "");
    if (!accessToken || !action || !requestId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;

    const supabase = createAdminClient();

    const { data: requestRow, error: fetchError } = await supabase
      .from("move_out_requests")
      .select("id,tenant_id,status")
      .eq("id", requestId)
      .maybeSingle();

    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
    if (!requestRow?.id) {
      return NextResponse.json({ error: "Move-out request not found." }, { status: 404 });
    }

    if (action === "approve") {
      const approvedMoveOutDate = String(body?.approvedMoveOutDate ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(approvedMoveOutDate)) {
        return NextResponse.json({ error: "Invalid or missing approved move-out date." }, { status: 400 });
      }
      const adminNote = body?.adminNote != null ? String(body.adminNote) : null;

      const { error: updateError } = await supabase
        .from("move_out_requests")
        .update({
          status: "approved",
          approved_move_out_date: approvedMoveOutDate,
          admin_note: adminNote,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      const { error: tenantError } = await supabase
        .from("tenants")
        .update({ move_out_date: approvedMoveOutDate })
        .eq("id", requestRow.tenant_id);
      if (tenantError) return NextResponse.json({ error: tenantError.message }, { status: 500 });

      return NextResponse.json({ success: true });
    }

    if (action === "reject") {
      const adminNote = body?.adminNote != null ? String(body.adminNote) : null;

      const { error: updateError } = await supabase
        .from("move_out_requests")
        .update({
          status: "rejected",
          admin_note: adminNote,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
