import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

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
      referrerRoomOrPhone,
    } = body ?? {};

    if ((!roomNumber && !roomId) || !fullName || !phoneNumber || !userId) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }

    if (!accessToken) {
      return NextResponse.json({ error: "Missing LINE access token." }, { status: 401 });
    }
    const profile = await verifyLineAccessToken(String(accessToken));
    if (!profile) {
      return NextResponse.json({ error: "Unable to verify LINE profile." }, { status: 401 });
    }
    if (profile.userId !== userId) {
      return NextResponse.json({ error: "LINE user mismatch." }, { status: 401 });
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
      .select("id,line_user_id,move_out_date")
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
    // Only allowed once the current tenant already has a move-out date on record — otherwise
    // anyone could claim any occupied room by guessing its number with no real connection to it.
    if (
      shouldMarkAsNewTenant &&
      tenant?.id &&
      (!tenant.line_user_id || tenant.line_user_id !== userId) &&
      !tenant.move_out_date
    ) {
      return NextResponse.json(
        {
          error:
            "ห้องนี้มีผู้เช่าอยู่และยังไม่ได้แจ้งย้ายออก กรุณาติดต่อผู้ดูแลหอพักโดยตรงหากต้องการย้ายเข้าห้องนี้",
        },
        { status: 409 }
      );
    }

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

    let registeredTenantId: string | null = null;

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
      registeredTenantId = tenant.id;
    } else {
      const { data: insertedTenant, error: insertError } = await supabase
        .from("tenants")
        .insert({
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
        })
        .select("id")
        .single();

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
      registeredTenantId = (insertedTenant as any)?.id ?? null;
    }

    if (room.status !== "occupied") {
      await supabase.from("rooms").update({ status: "occupied" }).eq("id", room.id);
    }

    // Self-reported referral: only recorded for an actual new-tenant sign-up
    // (never overwritten/moved on a returning-tenant edit), and always left
    // pending_approval — no points are granted until an admin reviews it from
    // the Rewards admin page (fraud protection, since this is unverified).
    // Best-effort: never fail registration itself if this lookup/insert breaks.
    const referrerLookup = String(referrerRoomOrPhone ?? "").trim();
    if (shouldMarkAsNewTenant && registeredTenantId && referrerLookup) {
      try {
        const { data: referrerByPhone } = await supabase
          .from("tenants")
          .select("id")
          .eq("phone_number", referrerLookup)
          .neq("id", registeredTenantId)
          .maybeSingle();

        let referrerTenantId = (referrerByPhone as any)?.id ?? null;

        if (!referrerTenantId) {
          const { data: referrerRoom } = await supabase
            .from("rooms")
            .select("id")
            .eq("room_number", referrerLookup)
            .maybeSingle();
          if (referrerRoom?.id) {
            const { data: referrerByRoom } = await supabase
              .from("tenants")
              .select("id")
              .eq("room_id", referrerRoom.id)
              .eq("status", "active")
              .neq("id", registeredTenantId)
              .maybeSingle();
            referrerTenantId = (referrerByRoom as any)?.id ?? null;
          }
        }

        if (referrerTenantId) {
          await supabase.from("tenant_referrals").insert({
            referrer_tenant_id: referrerTenantId,
            new_tenant_id: registeredTenantId,
            status: "pending_approval",
          });
        }
      } catch (referralErr) {
        console.error("[register] Failed to record self-reported referral:", referralErr);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
