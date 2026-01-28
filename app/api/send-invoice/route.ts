import { NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // We expect detailed data now
    const { 
      userId, 
      roomNumber,
      month, 
      year,
      rent,
      waterUnit, waterPrice,
      elecUnit, elecPrice,
      total 
    } = body;

    if (!userId) {
      return NextResponse.json({ error: 'User ID is missing' }, { status: 400 });
    }

    // --- CREATE THAI FLEX MESSAGE ---
    const flexMessage: any = {
      type: "flex",
      altText: `บิลค่าเช่าห้อง ${roomNumber} เดือน ${month}/${year}`,
      contents: {
        type: "bubble",
        size: "giga",
        header: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#0F172A", // Dark Slate Color
          paddingAll: "lg",
          contents: [
            { type: "text", text: "ใบแจ้งหนี้ (Invoice)", color: "#ffffff", weight: "bold", size: "lg" },
            { type: "text", text: `ห้อง ${roomNumber} | ประจำเดือน ${month}/${year}`, color: "#cbd5e1", size: "xs", margin: "sm" }
          ]
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            // 1. Rent Row
            {
              type: "box", layout: "horizontal",
              contents: [
                { type: "text", text: "ค่าเช่าห้อง", size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: `${rent}`, size: "sm", color: "#111111", align: "end", flex: 2 }
              ]
            },
            // 2. Electricity Row
            {
              type: "box", layout: "horizontal",
              contents: [
                { type: "text", text: `ค่าไฟ (${elecUnit} หน่วย)`, size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: `${elecPrice}`, size: "sm", color: "#111111", align: "end", flex: 2 }
              ]
            },
            // 3. Water Row
            {
              type: "box", layout: "horizontal",
              contents: [
                { type: "text", text: `ค่าน้ำ (${waterUnit} หน่วย)`, size: "sm", color: "#555555", flex: 3 },
                { type: "text", text: `${waterPrice}`, size: "sm", color: "#111111", align: "end", flex: 2 }
              ]
            },
            { type: "separator", margin: "lg" },
            // 4. Total Row
            {
              type: "box", layout: "horizontal", margin: "lg",
              contents: [
                { type: "text", text: "ยอดรวมสุทธิ", size: "md", weight: "bold", color: "#111111" },
                { type: "text", text: `${total} บาท`, size: "xl", weight: "bold", color: "#1DB446", align: "end" }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "กรุณาชำระเงินและส่งสลิปในแชทนี้", size: "xs", color: "#aaaaaa", align: "center" }
          ]
        }
      }
    };

    await client.pushMessage(userId, flexMessage);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('LINE Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}