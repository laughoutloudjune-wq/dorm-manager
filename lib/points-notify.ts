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

    // Matches the invoice-notification flex message design exactly
    // (app/api/send-invoice/route.ts): navy header, green amount, blue button —
    // rather than an ad-hoc palette, so tenants see one consistent visual
    // language across every LINE notification from this app.
    const flexMessage: FlexMessage = {
      type: "flex",
      altText: `คุณได้รับคะแนนสะสม ${totalEarned.toLocaleString("th-TH")} แต้ม!`,
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "คะแนนสะสม", weight: "bold", size: "xxl", color: "#FFFFFF" },
            { type: "text", text: "แจ้งเตือนได้รับคะแนน", size: "xs", color: "#cccccc", margin: "md" },
          ],
          paddingAll: "20px",
          backgroundColor: "#0F172A",
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "horizontal",
              contents: [
                { type: "text", text: "ห้อง", size: "sm", color: "#555555", flex: 0 },
                { type: "text", text: String(room?.room_number ?? "-"), size: "sm", color: "#111111", align: "end" },
              ],
            },
            { type: "separator", margin: "lg" },
            {
              type: "box",
              layout: "baseline",
              margin: "lg",
              contents: [
                { type: "text", text: "คะแนนที่ได้รับ", color: "#aaaaaa", size: "sm", flex: 2 },
                {
                  type: "text",
                  text: `+${totalEarned.toLocaleString("th-TH")} แต้ม`,
                  weight: "bold",
                  color: "#1DB446",
                  size: "xl",
                  flex: 4,
                  align: "end",
                },
              ],
            },
            { type: "separator", margin: "lg" },
            ...awardedEntries.map((entry) => ({
              type: "text" as const,
              text: `${POINTS_REASON_LABELS_TH[entry.reason] ?? entry.reason} +${entry.points.toLocaleString("th-TH")} แต้ม`,
              size: "xs" as const,
              color: "#666666",
              wrap: true,
              margin: "sm" as const,
            })),
            {
              type: "text",
              text: `คะแนนสะสมทั้งหมด ${balance.toLocaleString("th-TH")} แต้ม (≈ ฿${formatMoney(bahtEquivalent(balance, config))})`,
              size: "xs",
              color: "#666666",
              wrap: true,
              margin: "md",
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
                  height: "md",
                  action: { type: "uri", label: "ดูคะแนนสะสม", uri: pointsUrl },
                  color: "#1E40AF",
                },
              ],
              flex: 0,
            }
          : undefined,
      },
    };

    await lineClient.pushMessage(lineUserId, flexMessage);
  } catch (err) {
    console.error("[rewards] Failed to send points-earned LINE notification:", tenantId, err);
  }
}
