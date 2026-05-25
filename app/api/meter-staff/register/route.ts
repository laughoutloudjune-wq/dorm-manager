import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const staffNote = body?.staffNote ? String(body.staffNote).trim() : null;

    if (!accessToken) {
      return NextResponse.json({ error: "Missing accessToken." }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile?.userId) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const nowIso = new Date().toISOString();

    const { data: existing, error: existingError } = await supabase
      .from("line_meter_users")
      .select("id,status,display_name")
      .eq("line_user_id", profile.userId)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }

    const payload = {
      line_user_id: profile.userId,
      display_name: profile.displayName ?? existing?.display_name ?? null,
      picture_url: profile.pictureUrl ?? null,
      source_channel: "meter_staff_liff",
      registered_via: "liff_register",
      staff_note: staffNote,
      status: "active",
      last_event_type: "staff_register",
      last_seen_at: nowIso,
      updated_at: nowIso,
    };

    const { data: saved, error: upsertError } = await supabase
      .from("line_meter_users")
      .upsert(payload, { onConflict: "line_user_id" })
      .select("id,line_user_id,display_name,status,staff_note,registered_via")
      .single();

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      staff: saved,
      message: existing?.id
        ? "อัปเดตข้อมูลพนักงานมิเตอร์แล้ว"
        : "ลงทะเบียนพนักงานมิเตอร์สำเร็จ — สามารถเปิดหน้าบันทึกมิเตอร์ได้ทันที",
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
