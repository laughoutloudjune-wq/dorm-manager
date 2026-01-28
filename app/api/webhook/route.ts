import { NextResponse } from 'next/server';
import * as line from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';

// 1. Setup LINE Config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new line.Client(lineConfig);

// 2. Setup Supabase Config
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; // Use Service Role Key for backend writes
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const events = body.events;

    // Process all events (usually just one)
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event);
      }
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in webhook:', error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}

// --- MAIN LOGIC ---
async function handleTextMessage(event: any) {
  const text = event.message.text.trim();
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // 1. Split the text by spaces (handling multiple spaces if user makes a mistake)
  // Example Input: "101/1  สมชาย   หนึ่ง" -> ["101/1", "สมชาย", "หนึ่ง"]
  const parts = text.split(/\s+/);

  // 2. Check if it matches the format: [Room] [First] [Last]
  // We require at least 3 parts to avoid false positives with normal chat
  if (parts.length >= 3) {
    const inputRoom = parts[0];     // "101/1"
    const firstName = parts[1];     // "สมชาย"
    const lastName = parts[2];      // "หนึ่ง" (or combine more parts if needed)
    const fullName = `${firstName} ${lastName}`;

    // 3. Try to Register in Supabase
    // Logic: Find the room -> Update tenant info -> Return the updated row
    const { data, error } = await supabase
      .from('tenants')
      .update({
        line_user_id: userId,   // Link their LINE ID
        name: fullName,         // Update their name
        // status: 'occupied'   // Optional: Mark room as occupied if needed
      })
      .eq('room_number', inputRoom) // MUST match a room in your database
      .select();

    // 4. If Supabase found the room and updated it:
    if (data && data.length > 0) {
      // Success! Reply to the user
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ ลงทะเบียนเรียบร้อยครับ\n\nห้อง: ${inputRoom}\nชื่อ: ${fullName}\n\nเมื่อชำระเงินสามารถส่งสลิปเข้ามาได้เลยครับ`
      });
      return; // Stop here so we don't trigger other bot logic
    }
    
    if (error) {
        console.error("Supabase Error:", error);
    }
  }

  // --- (Optional) Handle Other Messages Here ---
  // If the code reaches here, it means the text was NOT a valid registration
  // You can add logic here to reply to "Help" or just ignore
  
  if (text === 'help' || text === 'ช่วยเหลือ') {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: "พิมพ์เลขห้องและชื่อเพื่อลงทะเบียน\nตัวอย่าง: 101/1 สมชาย ใจดี"
      });
  }
}