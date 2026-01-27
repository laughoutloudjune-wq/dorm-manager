import { NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';

// Initialize the LINE Client
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userId, pdfUrl, amount, month } = body;

    if (!userId) {
      return NextResponse.json({ error: 'User ID is missing' }, { status: 400 });
    }

    // Create the message bubble
    const flexMessage: any = {
      type: "flex",
      altText: `Invoice for ${month}`,
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "INVOICE", weight: "bold", color: "#1DB446", size: "sm" },
            { type: "text", text: `${amount} THB`, weight: "bold", size: "xxl", margin: "md" },
            { type: "text", text: `For Month: ${month}`, size: "xs", color: "#aaaaaa", wrap: true }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "button",
              style: "primary",
              height: "sm",
              action: { type: "uri", label: "View PDF Invoice", uri: pdfUrl }
            }
          ]
        }
      }
    };

    // Send the push message
    await client.pushMessage(userId, flexMessage);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('LINE Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}