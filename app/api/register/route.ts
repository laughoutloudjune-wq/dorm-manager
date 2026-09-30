import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

const normalizePhone = (value: unknown) => String(value ?? "").replace(/\D/g, "");

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
      // securityDepositAmount / advanceRentAmount intentionally not read:
      // this endpoint must never set money fields on a tenant — see below.
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

    // Already-registered guard: this LINE account may only be linked to one
    // active tenancy at a time. Re-submitting for the same room is allowed (it
    // acts as a profile edit); pointing it at a different room is not — that
    // would silently leave the old room linked to nobody. A tenant who has
    // moved out is `status='inactive'`, so they fall through and can register
    // for a new room normally.
    const { data: existingLink, error: existingLinkError } = await supabase
      .from("tenants")
      .select("id,room_id,rooms(room_number)")
      .eq("line_user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (existingLinkError) {
      return NextResponse.json({ error: existingLinkError.message }, { status: 500 });
    }

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

    if (existingLink?.id && String(existingLink.room_id ?? "") !== String(room.id)) {
      const linkedRoom = Array.isArray((existingLink as any).rooms)
        ? (existingLink as any).rooms[0]
        : (existingLink as any).rooms;
      const linkedRoomNumber = linkedRoom?.room_number ?? null;
      return NextResponse.json(
        {
          error: linkedRoomNumber
            ? `บัญชี LINE นี้ลงทะเบียนกับห้อง ${linkedRoomNumber} อยู่แล้ว หากต้องการเปลี่ยนห้องกรุณาติดต่อผู้ดูแลหอพัก`
            : "บัญชี LINE นี้ลงทะเบียนกับห้องพักอื่นอยู่แล้ว กรุณาติดต่อผู้ดูแลหอพัก",
          alreadyRegistered: true,
          registeredRoomNumber: linkedRoomNumber,
        },
        { status: 409 }
      );
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id,line_user_id,move_out_date,phone_number")
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

    // Deposit and advance rent are never written from this endpoint — the
    // registration page doesn't even collect them, so writing a computed 0
    // here used to silently wipe whatever the owner had actually entered in
    // the tenant profile modal. Those amounts are the owner's to enter, full
    // stop (see CLAUDE.md's "Deposit/advance amounts are entered by the
    // owner" rule and docs/audit/2026-09-29-system-audit-detailed.md finding
    // C4).
    let registeredTenantId: string | null = null;

    if (tenant) {
      if (tenant.line_user_id && tenant.line_user_id !== userId) {
        return NextResponse.json({ error: "This room is already linked to another LINE account." }, { status: 400 });
      }
      // An unlinked tenant record (created by an admin who hasn't sent them a
      // LINE registration link yet) may only be claimed by whoever the admin
      // actually entered — otherwise anyone who knows or guesses a room
      // number could link themselves to that tenant and see their bills. If
      // the admin never recorded a phone number for this tenant, there's
      // nothing to verify against, so the link is allowed (matches prior
      // behaviour for that edge case only).
      if (!tenant.line_user_id) {
        const onFile = normalizePhone(tenant.phone_number);
        const submitted = normalizePhone(phoneNumber);
        if (onFile && onFile.slice(-9) !== submitted.slice(-9)) {
          return NextResponse.json(
            {
              error:
                "หมายเลขโทรศัพท์ไม่ตรงกับข้อมูลที่ผู้ดูแลหอพักบันทึกไว้ กรุณาติดต่อผู้ดูแลหอพักเพื่อยืนยันตัวตน",
            },
            { status: 403 }
          );
        }
      }
      // Money fields and move-in date are never touched here — an existing
      // tenant record may already carry owner-entered values, and this
      // endpoint has no way to tell "left blank" apart from "trying to erase
      // it". Only the tenant profile modal (admin-side) may change those.
      const { error: updateError } = await supabase
        .from("tenants")
        .update({
          line_user_id: tenant.line_user_id ?? userId,
          full_name: fullName,
          phone_number: phoneNumber,
          deposit_slip_url: shouldMarkAsNewTenant ? depositSlipUrl ?? null : null,
          advance_rent_slip_url: shouldMarkAsNewTenant ? advanceRentSlipUrl ?? null : null,
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
      // Brand-new tenant, no admin-created row to protect — move-in date is
      // safe to set here since there's no pre-existing value it could
      // clobber. Deposit/advance still never get written (see above).
      const { data: insertedTenant, error: insertError } = await supabase
        .from("tenants")
        .insert({
          room_id: room.id,
          full_name: fullName,
          phone_number: phoneNumber,
          line_user_id: userId,
          move_in_date: normalizedMoveInDate,
          status: "active",
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
