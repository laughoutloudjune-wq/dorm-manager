import { NextResponse } from "next/server";
import { Client } from "@line/bot-sdk";
import { getPublicSiteOrigin } from "@/lib/public-site-url";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyLineAccessToken } from "@/lib/line-admin-auth";

const channelAccessToken =
  process.env.LINE_SLIP_NOTIFY_CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const adminLineUserIds = (
  process.env.LINE_SLIP_NOTIFY_ADMIN_USER_IDS || process.env.LINE_ADMIN_USER_IDS || ""
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const lineClient = new Client({ channelAccessToken });

export async function POST(req: Request) {
  try {
    if (!channelAccessToken) {
      return NextResponse.json(
        {
          error:
            "LINE channel access token is missing. Set LINE_SLIP_NOTIFY_CHANNEL_ACCESS_TOKEN (or fallback LINE_CHANNEL_ACCESS_TOKEN).",
        },
        { status: 500 }
      );
    }
    if (adminLineUserIds.length === 0) {
      return NextResponse.json(
        {
          error:
            "Recipient LINE user IDs are missing. Set LINE_SLIP_NOTIFY_ADMIN_USER_IDS (or fallback LINE_ADMIN_USER_IDS).",
        },
        { status: 400 }
      );
    }

    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const invoiceId = String(body?.invoiceId ?? "");
    const slipUrl = body?.slipUrl ? String(body.slipUrl) : "";
    if (!invoiceId) {
      return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
    }
    if (!accessToken) {
      return NextResponse.json({ error: "Missing accessToken." }, { status: 400 });
    }
    if (!slipUrl) {
      return NextResponse.json({ error: "Missing slipUrl." }, { status: 400 });
    }

    const profile = await verifyLineAccessToken(accessToken);
    if (!profile?.userId) {
      return NextResponse.json({ error: "LINE profile verification failed" }, { status: 401 });
    }
    const lineUserId = String(profile.userId);

    const supabase = createAdminClient();

    // Authorization: only the tenant that owns this invoice may trigger notifications.
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("line_user_id", lineUserId)
      .maybeSingle();
    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }
    if (!tenant?.id) {
      return NextResponse.json({ error: "Tenant not found for this LINE account." }, { status: 404 });
    }

    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id,public_token,issue_date,tenants(full_name),rooms(room_number)")
      .eq("id", invoiceId)
      .eq("tenant_id", tenant.id)
      .single();

    if (error || !invoice) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }

    const tenant = Array.isArray((invoice as any).tenants) ? (invoice as any).tenants[0] : (invoice as any).tenants;
    const room = Array.isArray((invoice as any).rooms) ? (invoice as any).rooms[0] : (invoice as any).rooms;

    const baseUrl = (getPublicSiteOrigin() || "").replace(/\/$/, "");
    const publicToken = (invoice as any).public_token as string | null;
    const paymentUrl = baseUrl && publicToken ? `${baseUrl}/payment/${publicToken}` : null;
    const adminLiffUrl = baseUrl ? `${baseUrl}/admin-liff?invoiceId=${encodeURIComponent(String((invoice as any).id))}` : null;
    const adminInvoicesUrl = baseUrl ? `${baseUrl}/invoices` : null;
    const issueMonthLabel = (invoice as any).issue_date
      ? new Date((invoice as any).issue_date).toLocaleDateString("th-TH", {
          month: "long",
          year: "numeric",
        })
      : "-";

    const footerButtons: any[] = [];
    if (paymentUrl) {
      footerButtons.push({
        type: "button",
        style: "primary",
        height: "sm",
        color: "#2563EB",
        action: {
          type: "uri",
          label: "ดูสลิป / หน้าชำระเงิน",
          uri: paymentUrl,
        },
      });
    }
    if (adminLiffUrl) {
      footerButtons.push({
        type: "button",
        style: "secondary",
        height: "sm",
        action: {
          type: "uri",
          label: "เปิด Admin LIFF",
          uri: adminLiffUrl,
        },
      });
    } else if (adminInvoicesUrl) {
      footerButtons.push({
        type: "button",
        style: "secondary",
        height: "sm",
        action: {
          type: "uri",
          label: "เปิดหน้าจัดการใบแจ้งหนี้",
          uri: adminInvoicesUrl,
        },
      });
    }

    const message = {
      type: "flex" as const,
      altText: `มีการอัปโหลดสลิปชำระเงิน ห้อง ${room?.room_number ?? "-"}`,
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              type: "text",
              text: "มีการอัปโหลดสลิปชำระเงิน",
              weight: "bold",
              size: "md",
              wrap: true,
              color: "#111827",
            },
            {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                { type: "text", text: `ห้อง: ${room?.room_number ?? "-"}`, size: "sm", color: "#374151" },
                { type: "text", text: `ผู้เช่า: ${tenant?.full_name ?? "-"}`, size: "sm", color: "#374151", wrap: true },
                { type: "text", text: `งวดบิล: ${issueMonthLabel}`, size: "sm", color: "#374151" },
              ],
            },
          ],
        },
        ...(footerButtons.length > 0
          ? {
              footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: footerButtons,
                flex: 0,
              },
            }
          : {}),
      },
    };

    await Promise.all(adminLineUserIds.map((userId) => lineClient.pushMessage(userId, message as any)));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    const lineMessage = error?.originalError?.response?.data?.message || error?.message || "Unknown error";
    return NextResponse.json(
      { error: "Failed to notify admin about uploaded slip.", detail: lineMessage },
      { status: 500 }
    );
  }
}
