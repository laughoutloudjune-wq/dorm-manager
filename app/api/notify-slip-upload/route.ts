import { NextResponse } from "next/server";
import { Client } from "@line/bot-sdk";
import { createAdminClient } from "@/lib/supabase-admin";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const adminLineUserIds = (process.env.LINE_ADMIN_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const lineClient = new Client({ channelAccessToken });

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export async function POST(req: Request) {
  try {
    if (!channelAccessToken) {
      return NextResponse.json({ error: "LINE channel access token is missing." }, { status: 500 });
    }
    if (adminLineUserIds.length === 0) {
      return NextResponse.json(
        { error: "LINE_ADMIN_USER_IDS is missing. No admin recipients configured." },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { invoiceId, slipUrl } = body ?? {};
    if (!invoiceId) {
      return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("id,total_amount,paid_amount,tenants(full_name),rooms(room_number)")
      .eq("id", invoiceId)
      .single();

    if (error || !invoice) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }

    const tenant = Array.isArray(invoice.tenants) ? invoice.tenants[0] : invoice.tenants;
    const room = Array.isArray(invoice.rooms) ? invoice.rooms[0] : invoice.rooms;
    const remaining = Math.max(
      0,
      Number(invoice.total_amount ?? 0) - Number(invoice.paid_amount ?? 0)
    );

    const message = [
      "มีการอัปโหลดสลิปใหม่",
      `ห้อง: ${room?.room_number ?? "-"}`,
      `ผู้เช่า: ${tenant?.full_name ?? "-"}`,
      `ยอดรวม: ฿${formatMoney(Number(invoice.total_amount ?? 0))}`,
      `คงเหลือ: ฿${formatMoney(remaining)}`,
      slipUrl ? `สลิป: ${slipUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.all(
      adminLineUserIds.map((userId) =>
        lineClient.pushMessage(userId, {
          type: "text",
          text: message,
        })
      )
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    const lineMessage =
      error?.originalError?.response?.data?.message || error?.message || "Unknown error";
    return NextResponse.json(
      { error: "Failed to notify admin about uploaded slip.", detail: lineMessage },
      { status: 500 }
    );
  }
}

