import { NextResponse } from "next/server";
import { bangkokYmd } from "@/lib/move-out-notice";
import { createAdminClient } from "@/lib/supabase-admin";

const ACTIVE_MOVE_OUT_STATUSES = ["requested", "approved"];

const verifyLineProfile = async (accessToken: string) => {
  const profileResponse = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!profileResponse.ok) {
    throw new Error("LINE profile verification failed");
  }

  return (await profileResponse.json()) as { userId?: string };
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "get_status");
    const accessToken = String(body?.accessToken ?? "");

    if (!accessToken) {
      return NextResponse.json({ error: "Missing access token" }, { status: 400 });
    }

    const profile = await verifyLineProfile(accessToken);
    const lineUserId = String(profile.userId ?? "");
    if (!lineUserId) {
      return NextResponse.json({ error: "LINE user not found" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id,full_name,room_id,rooms(room_number)")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    if (!tenant?.id) {
      return NextResponse.json({ error: "Tenant not found for this LINE account." }, { status: 404 });
    }

    if (action === "get_status") {
      const { data: latestRequest, error: requestError } = await supabase
        .from("move_out_requests")
        .select(
          "id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at,updated_at"
        )
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (requestError) {
        return NextResponse.json({ error: requestError.message }, { status: 500 });
      }

      const roomRel = Array.isArray((tenant as any).rooms) ? (tenant as any).rooms[0] : (tenant as any).rooms;
      return NextResponse.json({
        tenant: {
          id: tenant.id,
          full_name: (tenant as any).full_name ?? "",
          room_number: roomRel?.room_number ?? "-",
        },
        move_out_request: latestRequest ?? null,
      });
    }

    if (action === "create_request") {
      const requestedMoveOutDate = String(body?.requestedMoveOutDate ?? "");
      const requestNote = String(body?.requestNote ?? "").trim() || null;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedMoveOutDate)) {
        return NextResponse.json({ error: "กรุณาเลือกวันที่ย้ายออก" }, { status: 400 });
      }

      const { data: existingRequest, error: existingError } = await supabase
        .from("move_out_requests")
        .select("id,status,notice_date,created_at")
        .eq("tenant_id", tenant.id)
        .in("status", ACTIVE_MOVE_OUT_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingError) {
        return NextResponse.json({ error: existingError.message }, { status: 500 });
      }

      if (existingRequest?.id && String(existingRequest.status) === "approved") {
        return NextResponse.json(
          { error: "คุณมีคำขอย้ายออกที่อนุมัติแล้ว กรุณาติดต่อหอพักหากต้องการเปลี่ยนวันที่" },
          { status: 400 }
        );
      }

      const nowIso = new Date().toISOString();
      if (existingRequest?.id) {
        const existingNotice = (existingRequest as { notice_date?: string | null }).notice_date;
        const updatePayload: Record<string, unknown> = {
          requested_move_out_date: requestedMoveOutDate,
          request_note: requestNote,
          status: "requested",
          admin_note: null,
          updated_at: nowIso,
        };
        if (!existingNotice) {
          const createdAt = (existingRequest as { created_at?: string }).created_at;
          updatePayload.notice_date = createdAt
            ? bangkokYmd(new Date(createdAt))
            : bangkokYmd(new Date());
        }

        const { error: updateError } = await supabase
          .from("move_out_requests")
          .update(updatePayload)
          .eq("id", existingRequest.id);

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }
      } else {
        const { error: insertError } = await supabase.from("move_out_requests").insert({
          tenant_id: tenant.id,
          notice_date: bangkokYmd(new Date()),
          requested_move_out_date: requestedMoveOutDate,
          request_note: requestNote,
          status: "requested",
          created_at: nowIso,
          updated_at: nowIso,
        });

        if (insertError) {
          return NextResponse.json({ error: insertError.message }, { status: 500 });
        }
      }

      const { data: latestRequest, error: requestError } = await supabase
        .from("move_out_requests")
        .select(
          "id,notice_date,requested_move_out_date,approved_move_out_date,actual_move_out_date,status,request_note,admin_note,created_at,updated_at"
        )
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (requestError) {
        return NextResponse.json({ error: requestError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, move_out_request: latestRequest ?? null });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
