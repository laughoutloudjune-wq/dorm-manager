import { NextResponse } from "next/server";
import { Client, FlexMessage } from "@line/bot-sdk";
import { createAdminClient } from "@/lib/supabase-admin";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const client = new Client({
  channelAccessToken,
});

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export async function POST(req: Request) {
  try {
    if (!channelAccessToken) {
      return NextResponse.json(
        { error: "LINE channel access token is missing in environment." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const { userId, roomNumber, month, year, total, publicToken, invoiceId } = body ?? {};

    if (!userId) {
      return NextResponse.json({ error: "Missing LINE user ID." }, { status: 400 });
    }

    let resolved = {
      roomNumber: roomNumber ?? "",
      month: month ?? "",
      year: year ?? "",
      total: total ?? 0,
      publicToken: publicToken ?? "",
      dueDate: "",
      rentAmount: 0,
      waterBill: 0,
      electricityBill: 0,
      commonFee: 0,
      additionalFeesTotal: 0,
    };

    if (invoiceId) {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "public_token,total_amount,issue_date,due_date,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,rooms(room_number)"
        )
        .eq("id", invoiceId)
        .single();

      if (error || !data) {
        return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
      }

      const room = Array.isArray(data.rooms) ? data.rooms[0] : data.rooms;
      const issueDate = new Date(data.issue_date);
      resolved = {
        roomNumber: room?.room_number ?? "",
        month: issueDate.getMonth() + 1,
        year: issueDate.getFullYear(),
        total: data.total_amount ?? 0,
        publicToken: data.public_token ?? "",
        dueDate: data.due_date ?? "",
        rentAmount: data.rent_amount ?? 0,
        waterBill: data.water_bill ?? 0,
        electricityBill: data.electricity_bill ?? 0,
        commonFee: data.common_fee ?? 0,
        additionalFeesTotal: data.additional_fees_total ?? 0,
      };
    }

    if (!resolved.publicToken) {
      return NextResponse.json({ error: "Missing payment token." }, { status: 400 });
    }

    if (!process.env.NEXT_PUBLIC_BASE_URL) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_BASE_URL is missing in environment." },
        { status: 500 }
      );
    }

    const baseUrlRaw = process.env.NEXT_PUBLIC_BASE_URL.trim();
    const baseUrl = /^https?:\/\//i.test(baseUrlRaw) ? baseUrlRaw : `https://${baseUrlRaw}`;
    const payUrl = `${baseUrl.replace(/\/$/, "")}/payment/${resolved.publicToken}`;
    const dueDateText = resolved.dueDate
      ? new Date(resolved.dueDate).toLocaleDateString("th-TH")
      : "-";
    const periodText =
      resolved.month && resolved.year ? `${resolved.month}/${resolved.year}` : "รอบปัจจุบัน";

    const flexMessage: FlexMessage = {
      type: "flex",
      altText: `ใบแจ้งหนี้ห้อง ${resolved.roomNumber}`,
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "ใบแจ้งหนี้", weight: "bold", size: "xxl", color: "#FFFFFF" },
            { type: "text", text: `รอบบิล: ${periodText}`, size: "xs", color: "#cccccc", margin: "md" },
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
                {
                  type: "text",
                  text: String(resolved.roomNumber),
                  size: "sm",
                  color: "#111111",
                  align: "end",
                },
              ],
            },
            { type: "separator", margin: "lg" },
            {
              type: "box",
              layout: "baseline",
              margin: "lg",
              contents: [
                { type: "text", text: "ยอดที่ต้องชำระ", color: "#aaaaaa", size: "sm", flex: 2 },
                {
                  type: "text",
                  text: `${formatMoney(Number(resolved.total))} บาท`,
                  weight: "bold",
                  color: "#1DB446",
                  size: "xl",
                  flex: 4,
                  align: "end",
                },
              ],
            },
            { type: "separator", margin: "lg" },
            {
              type: "text",
              text: `ครบกำหนดชำระ: ${dueDateText}`,
              size: "xs",
              color: "#666666",
              margin: "md",
            },
            {
              type: "text",
              text: `ค่าเช่า ${formatMoney(Number(resolved.rentAmount))} | ค่าน้ำ ${formatMoney(
                Number(resolved.waterBill)
              )} | ค่าไฟ ${formatMoney(Number(resolved.electricityBill))}`,
              size: "xs",
              color: "#666666",
              wrap: true,
              margin: "sm",
            },
            {
              type: "text",
              text: `ค่าส่วนกลาง ${formatMoney(Number(resolved.commonFee))} | ค่าธรรมเนียมเพิ่ม ${formatMoney(
                Number(resolved.additionalFeesTotal)
              )}`,
              size: "xs",
              color: "#666666",
              wrap: true,
              margin: "sm",
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "button",
              style: "primary",
              height: "md",
              action: { type: "uri", label: "ดูรายละเอียดและชำระเงิน", uri: payUrl },
              color: "#1E40AF",
            },
          ],
          flex: 0,
        },
      },
    };

    await client.pushMessage(userId, flexMessage);
    return NextResponse.json({ success: true, message: "Invoice sent to LINE." });
  } catch (error: any) {
    const statusCode = error?.statusCode || error?.originalError?.response?.status || 500;
    const lineMessage =
      error?.originalError?.response?.data?.message ||
      error?.originalError?.response?.data?.details?.[0]?.message ||
      error?.message ||
      "Unknown LINE API error";

    return NextResponse.json(
      {
        error: "Failed to send invoice via LINE.",
        lineStatus: statusCode,
        lineMessage,
      },
      { status: 500 }
    );
  }
}
