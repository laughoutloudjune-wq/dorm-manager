import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

async function verifyLineAccessToken(accessToken: string) {
  const profileResponse = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!profileResponse.ok) return null;
  return (await profileResponse.json()) as {
    userId: string;
    displayName: string;
    pictureUrl?: string;
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const statuses = Array.isArray(body?.statuses) ? (body.statuses as string[]) : null;
    if (!accessToken) {
      return NextResponse.json({ error: "Missing access token" }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }

    if (!adminLineUserIds.includes(profile.userId)) {
      return NextResponse.json({ error: "LINE account is not allowed for admin LIFF" }, { status: 403 });
    }

    const supabase = createAdminClient();
    const validStatuses =
      statuses && statuses.length > 0
        ? statuses
        : (["pending", "partial", "overdue", "verifying"] as string[]);

    const { data: invoices, error } = await supabase
      .from("invoices")
      .select(
        "id,public_token,status,issue_date,due_date,total_amount,paid_amount,slip_url,payment_history,tenants(full_name,phone_number),rooms(room_number,buildings(name))"
      )
      .in("status", validStatuses)
      .order("issue_date", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      profile,
      invoices: invoices ?? [],
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}

