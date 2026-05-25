import { NextResponse } from "next/server";
import { isLineMeterStaffAllowed } from "@/lib/line-meter-auth";

export type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

export async function verifyLineAccessToken(accessToken: string): Promise<LineProfile | null> {
  const profileResponse = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!profileResponse.ok) return null;
  return (await profileResponse.json()) as LineProfile;
}

export async function requireLineAdminAccess(accessToken: string) {
  if (!accessToken) {
    return {
      error: NextResponse.json({ error: "Missing access token" }, { status: 400 }),
    };
  }
  const profile = await verifyLineAccessToken(accessToken);
  if (!profile) {
    return {
      error: NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 }),
    };
  }
  if (!adminLineUserIds.includes(profile.userId)) {
    return {
      error: NextResponse.json(
        { error: "LINE account is not allowed for admin LIFF" },
        { status: 403 }
      ),
    };
  }
  return { profile };
}

export async function requireLineMeterAccess(accessToken: string) {
  if (!accessToken) {
    return {
      error: NextResponse.json({ error: "Missing access token" }, { status: 400 }),
    };
  }
  const profile = await verifyLineAccessToken(accessToken);
  if (!profile) {
    return {
      error: NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 }),
    };
  }
  const allowed = await isLineMeterStaffAllowed(profile.userId);
  if (!allowed) {
    return {
      error: NextResponse.json(
        { error: "LINE account is not allowed for meter LIFF" },
        { status: 403 }
      ),
    };
  }
  return { profile };
}
