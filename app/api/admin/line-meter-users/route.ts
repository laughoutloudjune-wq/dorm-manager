import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

export async function GET(req: Request) {
  try {
    const auth = await requireAdminPermission(req, "meter.edit");
    if ("error" in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from("line_meter_users")
      .select(
      "id,line_user_id,display_name,picture_url,staff_note,status,registered_via,source_channel,last_event_type,first_seen_at,last_seen_at,created_at,notify_payment,notify_move_out"
      )
      .order("last_seen_at", { ascending: false })
      .limit(1000);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ users: data ?? [] });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error." },
      { status: 500 }
    );
  }
}

