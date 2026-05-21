import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      roomId,
      roomNumber,
      fullName,
      phoneNumber,
      userId,
      accessToken,
      securityDepositAmount,
      advanceRentAmount,
      depositSlipUrl,
      advanceRentSlipUrl,
      isNewTenant,
      moveInDate,
      policyAccepted,
      policyAcceptedAt,
      policyVersion,
    } = body ?? {};

    if ((!roomNumber && !roomId) || !fullName || !phoneNumber || !userId) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    if (accessToken) {
      const profileResponse = await fetch("https://api.line.me/v2/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!profileResponse.ok) {
        return NextResponse.json({ error: "Unable to verify LINE profile." }, { status: 401 });
      }
      const profile = await profileResponse.json();
      if (profile.userId !== userId) {
        return NextResponse.json({ error: "LINE user mismatch." }, { status: 401 });
      }
    }

    const supabase = createAdminClient();

    const trimmedRoomNumber = typeof roomNumber === "string" ? roomNumber.trim() : "";
    const trimmedRoomId = typeof roomId === "string" ? roomId.trim() : "";

    let room: { id: string; status: string } | null = null;

    if (trimmedRoomId) {
      const { data: byId, error: roomError } = await supabase
        .from("rooms")
        .select("id,status")
        .eq("id", trimmedRoomId)
        .maybeSingle();
      if (roomError || !byId) {
        return NextResponse.json({ error: "Room not found." }, { status: 404 });
      }
      room = byId;
    } else if (trimmedRoomNumber) {
      const { data: candidates, error: roomError } = await supabase
        .from("rooms")
        .select("id,status,room_number")
        .eq("room_number", trimmedRoomNumber);

      if (roomError) {
        return NextResponse.json({ error: roomError.message }, { status: 500 });
      }
      const rows = candidates ?? [];
      if (rows.length === 0) {
        return NextResponse.json({ error: "Room not found." }, { status: 404 });
      }
      if (rows.length > 1) {
        return NextResponse.json(
          {
            error:
              "เลขห้องนี้มีมากกว่าหนึ่งรายการ (หลายอาคาร) — โปรดเลือกห้องจากรายการที่แสดง แทนการพิมพ์เอง",
          },
          { status: 400 }
        );
      }
      room = rows[0];
    } else {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id,line_user_id")
      .eq("room_id", room.id)
      .eq("status", "active")
      .maybeSingle();

    const shouldMarkAsNewTenant = Boolean(isNewTenant);
    const normalizedMoveInDate =
      shouldMarkAsNewTenant && /^\d{4}-\d{2}-\d{2}$/.test(String(moveInDate ?? ""))
        ? String(moveInDate)
        : null;
    const normalizedPolicyAccepted = shouldMarkAsNewTenant ? Boolean(policyAccepted) : false;
    const normalizedPolicyAcceptedAt =
      normalizedPolicyAccepted && typeof policyAcceptedAt === "string" ? policyAcceptedAt : null;
    const normalizedPolicyVersion =
      normalizedPolicyAccepted && typeof policyVersion === "string" && policyVersion.trim()
        ? policyVersion.trim()
        : null;

    if (shouldMarkAsNewTenant && !normalizedPolicyAccepted) {
      return NextResponse.json({ error: "กรุณายอมรับกฎระเบียบหอพักก่อนลงทะเบียน" }, { status: 400 });
    }

    // Self-service takeover flow:
    // If room has an active tenant (any occupant) and user registers as new tenant, create takeover request.
    if (
      shouldMarkAsNewTenant &&
      tenant?.id &&
      (!tenant.line_user_id || tenant.line_user_id !== userId)
    ) {
      const takeoverRequestId = crypto.randomUUID();
      const { error: takeoverError } = await supabase.from("room_takeover_requests").insert({
        id: takeoverRequestId,
        room_id: room.id,
        requester_line_user_id: userId,
        requester_full_name: fullName,
        requester_phone: phoneNumber,
        status: "requested",
        current_active_tenant_id: tenant.id,
      });

      if (takeoverError) {
        return NextResponse.json({ error: takeoverError.message }, { status: 500 });
      }

      return NextResponse.json(
        {
          error: "ห้องนี้มีผู้เช่าอยู่แล้ว ระบบได้ส่งคำขอย้ายเข้าให้แอดมินตรวจสอบแล้ว กรุณารอการอนุมัติก่อนลงทะเบียน",
          takeoverRequestId,
        },
        { status: 409 }
      );
    }

    const depositAmount = Number.isFinite(Number(securityDepositAmount))
      ? Number(securityDepositAmount)
      : 0;
    const advanceAmount = Number.isFinite(Number(advanceRentAmount))
      ? Number(advanceRentAmount)
      : 0;

    if (tenant) {
      if (tenant.line_user_id && tenant.line_user_id !== userId) {
        return NextResponse.json({ error: "This room is already linked to another LINE account." }, { status: 400 });
      }
      const { error: updateError } = await supabase
        .from("tenants")
        .update({
          line_user_id: tenant.line_user_id ?? userId,
          full_name: fullName,
          phone_number: phoneNumber,
          security_deposit_amount: depositAmount,
          advance_rent_amount: advanceAmount,
          deposit_slip_url: shouldMarkAsNewTenant ? depositSlipUrl ?? null : null,
          advance_rent_slip_url: shouldMarkAsNewTenant ? advanceRentSlipUrl ?? null : null,
          move_in_date: normalizedMoveInDate,
          policy_accepted: normalizedPolicyAccepted,
          policy_accepted_at: normalizedPolicyAcceptedAt,
          policy_version: normalizedPolicyVersion,
        })
        .eq("id", tenant.id);

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    } else {
      const { error: insertError } = await supabase.from("tenants").insert({
        room_id: room.id,
        full_name: fullName,
        phone_number: phoneNumber,
        line_user_id: userId,
        move_in_date: normalizedMoveInDate,
        status: "active",
        security_deposit_amount: depositAmount,
        advance_rent_amount: advanceAmount,
        deposit_slip_url: shouldMarkAsNewTenant ? depositSlipUrl ?? null : null,
        advance_rent_slip_url: shouldMarkAsNewTenant ? advanceRentSlipUrl ?? null : null,
        policy_accepted: normalizedPolicyAccepted,
        policy_accepted_at: normalizedPolicyAcceptedAt,
        policy_version: normalizedPolicyVersion,
      });

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }

    if (room.status !== "occupied") {
      await supabase.from("rooms").update({ status: "occupied" }).eq("id", room.id);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
