import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';
import { supabase } from '../../../lib/supabase';

// Setup LINE Client
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
      const replyToken = event.replyToken;

      // ============================================================
      // SCENARIO 1: TEXT MESSAGES (Register OR Repair)
      // ============================================================
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        const parts = text.split(/\s+/);

        // --- 1.A Register (Room + Name) ---
        if (parts.length >= 2 && /^\d{3}\/[12]$/.test(parts[0])) {
          const inputRoom = parts[0];     
          const fullName = parts.slice(1).join(' '); 

          const { data: room } = await supabase.from('rooms').select('id').eq('room_number', inputRoom).single();
          
          if (!room) {
            return client.replyMessage(replyToken, { type: 'text', text: `❌ ไม่พบห้อง ${inputRoom}` });
          }

          const { data: existingTenant } = await supabase.from('tenants').select('id').eq('room_id', room.id).single();

          if (existingTenant) {
            await supabase.from('tenants').update({ line_user_id: userId, name: fullName, status: 'active' }).eq('id', existingTenant.id);
          } else {
            await supabase.from('tenants').insert({ room_id: room.id, line_user_id: userId, name: fullName, status: 'active' });
          }
          await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);

          return client.replyMessage(replyToken, { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nห้อง: ${inputRoom}\nชื่อ: ${fullName}` });
        }
        
        // --- 1.B Fallback Helper ---
        else if (/^\d{3}\/[12]$/.test(text)) {
           return client.replyMessage(replyToken, { type: 'text', text: `⚠️ กรุณาพิมพ์ชื่อต่อท้ายเลขห้อง\nตัวอย่าง: ${text} สมชาย` });
        }
      }

      // ============================================================
      // SCENARIO 2: IMAGES (Payment Slips)
      // ============================================================
      else if (event.type === 'message' && event.message.type === 'image') {
        
        // 1. Identify Tenant
        const { data: tenant } = await supabase
          .from('tenants')
          .select('room_id, rooms(room_number)')
          .eq('line_user_id', userId)
          .eq('status', 'active')
          .single();

        if (!tenant) {
           return client.replyMessage(replyToken, { type: 'text', text: "⚠️ คุณยังไม่ได้ลงทะเบียน กรุณาพิมพ์เลขห้องและชื่อก่อน" });
        }

        const roomData: any = tenant.rooms;
        const roomNumber = Array.isArray(roomData) ? roomData[0]?.room_number : roomData?.room_number;

        // 2. Find Unpaid Invoice
        const { data: invoice } = await supabase.from('invoices')
          .select('id, month, year')
          .eq('room_id', tenant.room_id)
          .neq('payment_status', 'paid')
          .neq('payment_status', 'verification_pending') // Optional: Don't overwrite if already sent?
          .order('year', { ascending: false }).order('month', { ascending: false })
          .limit(1)
          .single();

        if (!invoice) {
           return client.replyMessage(replyToken, { type: 'text', text: `✅ ไม่มียอดค้างชำระสำหรับห้อง ${roomNumber} ครับ` });
        }

        // 3. Process Image
        try {
          // Get image content from LINE
          const messageId = event.message.id;
          const stream = await client.getMessageContent(messageId);
          const chunks: any[] = [];
          for await (const chunk of stream) { chunks.push(chunk); }
          const buffer = Buffer.concat(chunks);

          // Upload to Supabase
          const safeRoomNum = roomNumber.replace('/', '-');
          const fileName = `${safeRoomNum}_${invoice.month}_${invoice.year}_${Date.now()}.jpg`;
          
          const { error: uploadError } = await supabase.storage
            .from('slips') // <--- MAKE SURE THIS BUCKET EXISTS
            .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });

          if (uploadError) {
             console.error("Upload Failed:", uploadError);
             return client.replyMessage(replyToken, { type: 'text', text: `❌ บันทึกรูปไม่สำเร็จ: ${uploadError.message}` });
          }

          // 4. Update Invoice Status
          const { data: { publicUrl } } = supabase.storage.from('slips').getPublicUrl(fileName);
          
          await supabase.from('invoices')
            .update({ slip_url: publicUrl, payment_status: 'verification_pending' })
            .eq('id', invoice.id);

          return client.replyMessage(replyToken, { 
            type: 'text', 
            text: `✅ ได้รับสลิปแล้วครับ\nห้อง: ${roomNumber}\nยอดเดือน: ${invoice.month}/${invoice.year}\n\nเจ้าหน้าที่จะตรวจสอบความถูกต้องครับ` 
          });

        } catch (err: any) {
          console.error("Processing Error:", err);
          return client.replyMessage(replyToken, { type: 'text', text: `❌ เกิดข้อผิดพลาด: ${err.message}` });
        }
      }
    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error("Critical Webhook Error:", error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}