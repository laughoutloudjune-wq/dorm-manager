import { Client, FlexMessage } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicSiteOrigin } from "@/lib/public-site-url";
import {
  bahtEquivalent,
  getRewardsConfig,
  getTenantPointBalance,
  POINTS_REASON_LABELS_TH,
  type PointLedgerRow,
} from "@/lib/points-ledger";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineClient = channelAccessToken ? new Client({ channelAccessToken }) : null;

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Pushes a "you just earned points" flex message to the tenant right after a
 * payment is verified. Best-effort and silent on any failure (missing LINE
 * link, missing channel token, LINE API error) — a notification going out is
 * never allowed to fail the payment response itself, same reasoning as
 * syncPointsAfterPayment at each payment call site.
 */
export async function notifyTenantPointsEarned(
  supabase: SupabaseClient,
  tenantId: string,
  awardedEntries: PointLedgerRow[],
) {
  if (!lineClient || awardedEntries.length === 0) return;
  try {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("line_user_id,rooms(room_number)")
      .eq("id", tenantId)
      .maybeSingle();
    const lineUserId = (tenant as any)?.line_user_id;
    if (!lineUserId) return;
    const room = Array.isArray((tenant as any)?.rooms) ? (tenant as any).rooms[0] : (tenant as any)?.rooms;

    const config = await getRewardsConfig(supabase);
    const totalEarned = awardedEntries.reduce((sum, entry) => sum + entry.points, 0);
    const balance = await getTenantPointBalance(supabase, tenantId);

    const origin = getPublicSiteOrigin();
    const pointsUrl = origin ? `${origin}/payment/liff/points` : null;

    const flexMessage: FlexMessage = {
      type: "flex",
      altText: `คุณได้รับคะแนนสะสม ${totalEarned.toLocaleString("th-TH")} แต้ม!`,
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "🎉 ได้รับคะแนนสะสม!", weight: "bold", size: "xl", color: "#1DB446" },
            { type: "text", text: `ห้อง ${room?.room_number ?? "-"}`, margin: "md", size: "sm", color: "#666666" },
            {
              type: "box",
              layout: "vertical",
              margin: "md",
              spacing: "xs",
              contents: awardedEntries.map((entry) => ({
                type: "text" as const,
                text: `${POINTS_REASON_LABELS_TH[entry.reason] ?? entry.reason} +${entry.points.toLocaleString("th-TH")} แต้ม`,
                size: "sm" as const,
                color: "#374151",
              })),
            },
            {
              type: "text",
              text: `รวมที่ได้รับ +${totalEarned.toLocaleString("th-TH")} แต้ม`,
              margin: "md",
              size: "md",
              weight: "bold",
              color: "#1DB446",
            },
            {
              type: "text",
              text: `คะแนนสะสมทั้งหมด ${balance.toLocaleString("th-TH")} แต้ม (≈ ฿${formatMoney(bahtEquivalent(balance, config))})`,
              margin: "sm",
              size: "xs",
              color: "#888888",
            },
          ],
        },
        footer: pointsUrl
          ? {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                {
                  type: "button",
                  style: "primary",
                  color: "#1DB446",
                  action: { type: "uri", label: "ดูคะแนนสะสม", uri: pointsUrl },
                },
              ],
            }
          : undefined,
      },
    };

    await lineClient.pushMessage(lineUserId, flexMessage);
  } catch (err) {
    console.error("[rewards] Failed to send points-earned LINE notification:", tenantId, err);
  }
}
