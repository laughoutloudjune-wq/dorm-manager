import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';
import { supabase } from '../../../lib/supabase';

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const events = body.events;

    await Promise.all(events.map(async (event: any) => {
      const userId = event.source.userId;

      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        const parts = text.split(/\s+/); // Split by spaces

        // ============================================================
        // LOGIC: REGISTER (Format: Room + Name)
        // Check if 1st part looks like "101/1"
        // ============================================================
        if (parts.length >= 2 && /^\d{3}\/[12]$/.test(parts[0])) {
          const inputRoom = parts[0];     // "101/1"
          // Join the rest of the words as the name (e.g. "Somchai Jai Dee")
          const fullName = parts.slice(1).join(' '); 

          // 1. Find the Room ID
          const { data: room } = await supabase.from('rooms').select('id').eq('room_number', inputRoom).single();
          
          if (!room) {
            return client.replyMessage(event.replyToken, { type: 'text', text: `❌ ไม่พบห้อง ${inputRoom} ในระบบ` });
          }

          // 2. CHECK if tenant exists (Crucial Step!)
          const { data: existingTenant } = await supabase
            .from('tenants')
            .select('id')
            .eq('room_id', room.id)
            .single();

          if (existingTenant) {
            // CASE A: Tenant exists -> UPDATE info
            await supabase.from('tenants').update({ 
              line_user_id: userId, 
              name: fullName, 
              status: 'active' 
            }).eq('id', existingTenant.id);
          } else {
            // CASE B: No tenant -> INSERT new row
            await supabase.from('tenants').insert({ 
              room_id: room.id, 
              line_user_id: userId, 
              name: fullName, 
              status: 'active' 
            });
          }

          // 3. Mark Room as Occupied
          await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);

          return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: `✅ ลงทะเบียนสำเร็จ!\n\nห้อง: ${inputRoom}\nชื่อ: ${fullName}\n\nเมื่อชำระเงินสามารถส่งสลิปเข้ามาได้เลยครับ` 
          });
        }
        
        // ============================================================
        // LOGIC: FALLBACK (If they typed ONLY "101/1" without name)
        // ============================================================
        else if (/^\d{3}\/[12]$/.test(text)) {
           return client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `⚠️ กรุณาพิมพ์ชื่อต่อท้ายเลขห้องด้วยครับ\n\nตัวอย่าง:\n${text} สมชาย ใจดี` 
            });
        }

        // ============================================================
        // LOGIC: MAINTENANCE (Repair/Fix)
        // ============================================================
        else if (text.match(/^(repair|fix|ซ่อม|แจ้ง|ปัญหา)/i)) {
          // ... (Keep your existing repair logic here) ...
          // I can include it if you need the full file again
        }
      }
      
      // ... (Keep your existing Image/Payment logic here) ...

    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}