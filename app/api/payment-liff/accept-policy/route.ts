import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { accessToken, policyVersion } = body ?? {};

    if (!accessToken) {
      return NextResponse.json({ error: "Missing access token" }, { status: 400 });
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileResponse.ok) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    const profile = await profileResponse.json();
    const lineUserId = profile.userId as string;

    const supabase = createAdminClient();

    const { error: updateError } = await supabase
      .from("tenants")
      .update({
        policy_accepted: true,
        policy_accepted_at: new Date().toISOString(),
        policy_version: policyVersion || "v1.0",
      })
      .eq("line_user_id", lineUserId)
      .eq("status", "active");

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
