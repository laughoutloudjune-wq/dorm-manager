import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

// Tells the register LIFF whether this LINE account is already linked to an
// active tenancy, so it can show a "you're already connected" screen instead of
// an empty registration form. Only reports the *active* tenancy — a tenant who
// moved out keeps their line_user_id on the inactive row and must be able to
// register again for a new room.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { accessToken } = body ?? {};

    if (!accessToken) {
      return NextResponse.json({ error: "Missing LINE access token." }, { status: 401 });
    }

    const profile = await verifyLineAccessToken(String(accessToken));
    if (!profile) {
      return NextResponse.json({ error: "Unable to verify LINE profile." }, { status: 401 });
    }

    const supabase = createAdminClient();

    const { data: tenant, error } = await supabase
      .from("tenants")
      .select("id,full_name,phone_number,move_out_date,rooms(room_number,buildings(name))")
      .eq("line_user_id", profile.userId)
      .eq("status", "active")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!tenant) {
      return NextResponse.json({ registered: false, tenant: null });
    }

    const room = Array.isArray((tenant as any).rooms)
      ? (tenant as any).rooms[0]
      : (tenant as any).rooms;
    const building = Array.isArray(room?.buildings) ? room.buildings[0] : room?.buildings;

    return NextResponse.json({
      registered: true,
      tenant: {
        fullName: (tenant as any).full_name ?? null,
        phoneNumber: (tenant as any).phone_number ?? null,
        moveOutDate: (tenant as any).move_out_date ?? null,
        roomNumber: room?.room_number ?? null,
        buildingName: building?.name ?? null,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Server error" }, { status: 500 });
  }
}
