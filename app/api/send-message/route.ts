import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

export async function POST(req: NextRequest) {
  try {
    const { userId, message } = await req.json();
    await client.pushMessage(userId, { type: 'text', text: message });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}