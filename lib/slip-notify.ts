import { Client, FlexMessage } from "@line/bot-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicSiteOrigin } from "@/lib/public-site-url";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineClient = channelAccessToken ? new Client({ channelAccessToken }) : null;

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Tells the tenant their payment slip was declined and they need to upload a
 * new one. Best-effort and silent on any failure (no LINE link, no channel
 * token, LINE API error) — the decline itself has already been written, and a
 * notification must never fail the admin's action, same reasoning as
 * notifyTenantPointsEarned.
 *
 * Uses the danger-red accent rather than the usual navy/green of the invoice and
 * points messages: this is the one notification in the set that asks the tenant
 * to go fix something, and it needs to read differently at a glance in a busy
 * LINE thread.
 */
export async function notifyTenantSlipDeclined(
  supabase: SupabaseClient,
  options: { tenantId: string | null; invoiceId: string; reason: string },
) {
  const { tenantId, invoiceId, reason } = options;
  if (!lineClient || !tenantId) return;
  try {
    const [{ data: tenant }, { data: invoice }] = await Promise.all([
      supabase
        .from("tenants")
        .select("line_user_id,rooms(room_number)")
        .eq("id", tenantId)
        .maybeSingle(),
      supabase
        .from("invoices")
        .select("total_amount,paid_amount,due_date,public_token")
        .eq("id", invoiceId)
        .maybeSingle(),
    ]);

    const lineUserId = (tenant as any)?.line_user_id;
    if (!lineUserId) return;
    const room = Array.isArray((tenant as any)?.rooms) ? (tenant as any).rooms[0] : (tenant as any)?.rooms;

    const total = Number((invoice as any)?.total_amount ?? 0);
    const paid = Number((invoice as any)?.paid_amount ?? 0);
    const outstanding = Math.max(0, total - paid);

    const origin = getPublicSiteOrigin();
    const uploadUrl = origin ? `${origin}/payment/liff/invoices` : null;

    const flexMessage: FlexMessage = {
      type: "flex",
      altText: "สลิปการชำระเงินไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่",
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "ตรวจสอบไม่ผ่าน", weight: "bold", size: "xxl", color: "#FFFFFF" },
            { type: "text", text: "สลิปการชำระเงิน", size: "xs", color: "#F5C2C7", margin: "md" },
          ],
          paddingAll: "20px",
          backgroundColor: "#B42318",
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
              type: "text",
              text: "สลิปที่ส่งมาไม่สามารถใช้ยืนยันการชำระเงินได้ กรุณาตรวจสอบและอัปโหลดสลิปใหม่อีกครั้ง",
              size: "sm",
              color: "#333333",
              wrap: true,
              margin: "lg",
            },
            {
              type: "box",
              layout: "vertical",
              margin: "lg",
              paddingAll: "12px",
              backgroundColor: "#FEF3F2",
              cornerRadius: "8px",
              contents: [
                { type: "text", text: "เหตุผล", size: "xs", color: "#B42318", weight: "bold" },
                { type: "text", text: reason, size: "sm", color: "#333333", wrap: true, margin: "sm" },
              ],
            },
            { type: "separator", margin: "lg" },
            {
              type: "box",
              layout: "baseline",
              margin: "lg",
              contents: [
                { type: "text", text: "ยอดค้างชำระ", color: "#aaaaaa", size: "sm", flex: 2 },
                {
                  type: "text",
                  text: `฿${formatMoney(outstanding)}`,
                  weight: "bold",
                  color: "#B42318",
                  size: "xl",
                  flex: 4,
                  align: "end",
                },
              ],
            },
          ],
        },
        footer: uploadUrl
          ? {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                {
                  type: "button",
                  style: "primary",
                  height: "md",
                  action: { type: "uri", label: "อัปโหลดสลิปใหม่", uri: uploadUrl },
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
    console.error("[slip-review] Failed to send slip-declined LINE notification:", invoiceId, err);
  }
}
