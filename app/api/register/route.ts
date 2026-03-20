import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
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

    if (!roomNumber || !fullName || !phoneNumber || !userId) {
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

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id,status")
      .eq("room_number", roomNumber)
      .single();

    if (roomError || !room) {
      return NextResponse.json({ error: "Room not found." }, { status: 404 });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id,line_user_id")
      .eq("room_id", room.id)
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
