import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

type LineWebhookEvent = {
  type?: string;
  source?: {
    type?: string;
    userId?: string;
  };
};

const normalizeSecret = (value: string | undefined) =>
  String(value ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");

const channelSecrets = [
  normalizeSecret(process.env.LINE_METER_WEBHOOK_CHANNEL_SECRET),
  normalizeSecret(process.env.LINE_CHANNEL_SECRET),
].filter(Boolean);
const channelAccessToken =
  process.env.LINE_METER_CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const isValidSignature = (rawBody: string, signature: string, secret: string) => {
  const digest = crypto.createHmac("SHA256", secret).update(rawBody).digest("base64");
  return digest === signature;
};

const isValidWithAnySecret = (rawBody: string, signature: string) =>
  channelSecrets.some((secret) => isValidSignature(rawBody, signature, secret));

const fetchLineProfile = async (userId: string) => {
  if (!channelAccessToken) return null;
  const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
    },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as { displayName?: string; pictureUrl?: string };
};

export async function POST(req: Request) {
  try {
    if (channelSecrets.length === 0) {
      return NextResponse.json(
        { error: "Missing LINE_METER_WEBHOOK_CHANNEL_SECRET (or LINE_CHANNEL_SECRET)." },
        { status: 500 }
      );
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature") || "";
    if (!signature || !isValidWithAnySecret(rawBody, signature)) {
      return NextResponse.json({ error: "Invalid LINE webhook signature." }, { status: 401 });
    }

    const parsed = JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    if (events.length === 0) return NextResponse.json({ success: true, received: 0, stored: 0 });

    const supabase = createAdminClient();
    let stored = 0;

    for (const event of events) {
      const userId = String(event?.source?.userId ?? "");
      if (!userId) continue;

      const profile = await fetchLineProfile(userId).catch(() => null);
      const payload = {
        line_user_id: userId,
        display_name: profile?.displayName ?? null,
        picture_url: profile?.pictureUrl ?? null,
        source_channel: "meter_webhook",
        last_event_type: String(event?.type ?? "unknown"),
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("line_meter_users").upsert(payload, {
        onConflict: "line_user_id",
      });
      if (!error) stored += 1;
    }

    return NextResponse.json({ success: true, received: events.length, stored });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected webhook error." },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "meter webhook endpoint is alive" });
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
