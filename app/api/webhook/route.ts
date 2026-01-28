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

      // ============================================================
      // SCENARIO 1: TEXT MESSAGES (Register OR Repair)
      // ============================================================
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        
        // --- 1.A: REGISTRATION (Format: 101/1 or 205/2) ---
        // Regex: 3 digits, forward slash, 1 digit (e.g. 101/1)
        if (/^\d{3}\/[12]$/.test(text)) {
          const roomNumber = text;
          
          const { data: room } = await supabase.from('rooms').select('id').eq('room_number', roomNumber).single();
          
          if (!room) {
            return client.replyMessage(event.replyToken, { type: 'text', text: `❌ ไม่พบห้องหมายเลข ${roomNumber} ในระบบ\n(ตรวจสอบว่าพิมพ์ถูกหรือไม่ เช่น 101/1)` });
          }

          const { data: existingTenant } = await supabase.from('tenants').select('id, name').eq('room_id', room.id).eq('status', 'active').single();

          if (existingTenant) {
             // Link to existing tenant
             await supabase.from('tenants').update({ line_user_id: userId }).eq('id', existingTenant.id);
             return client.replyMessage(event.replyToken, { type: 'text', text: `✅ เชื่อมต่อสำเร็จ! สวัสดีคุณ ${existingTenant.name} (ห้อง ${roomNumber})` });
          } else {
             // Create new tenant placeholder
             await supabase.from('tenants').insert({ room_id: room.id, name: 'ผู้เช่าใหม่', line_user_id: userId, status: 'active' });
             await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);
             return client.replyMessage(event.replyToken, { type: 'text', text: `✅ ลงทะเบียนสำเร็จ! คุณคือผู้เช่าห้อง ${roomNumber}` });
          }
        }

        // --- 1.B: HELPER FOR OLD FORMAT (User types "101") ---
        else if (/^\d{3}$/.test(text)) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⚠️ กรุณาระบุตึกด้วยครับ\n\n- ตึก 1 พิมพ์: ${text}/1\n- ตึก 2 พิมพ์: ${text}/2` 
            });
        }

        // --- 1.C: MAINTENANCE (User types "ซ่อม..." or "Repair...") ---
        else if (text.match(/^(repair|fix|ซ่อม|แจ้ง|ปัญหา)/i)) {
          
          const { data: tenant } = await supabase.from('tenants').select('room_id').eq('line_user_id', userId).eq('status', 'active').single();

          if (!tenant) {
            return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ คุณยังไม่ได้ลงทะเบียน กรุณาพิมพ์เลขห้องก่อน (เช่น 101/1)" });
          }

          // Remove the keyword to get the description
          const description = text.replace(/^(repair|fix|ซ่อม|แจ้ง|ปัญหา)\s*:?\s*/i, ''); 

          if (!description) {
             return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ กรุณาระบุอาการด้วยครับ เช่น 'ซ่อมแอร์ ไม่เย็น'" });
          }

          const { error } = await supabase.from('maintenance_requests').insert({
            room_id: tenant.room_id,
            description: description,
            status: 'pending'
          });

          if (error) {
            console.error("Database Error:", error);
            return client.replyMessage(event.replyToken, { type: 'text', text: "❌ เกิดข้อผิดพลาด: ไม่สามารถบันทึกข้อมูลได้" });
          }

          return client.replyMessage(event.replyToken, { 
            type: 'text', text: `🛠️ รับเรื่องแล้วครับ!\n\nรายการ: ${description}\n\nเราจะรีบตรวจสอบให้เร็วที่สุด` 
          });
        }
      }

      // ============================================================
      // SCENARIO 2: IMAGES (Payment Slips)
      // ============================================================
      else if (event.type === 'message' && event.message.type === 'image') {
        const { data: tenant } = await supabase
          .from('tenants')
          .select('room_id, rooms(room_number)')
          .eq('line_user_id', userId)
          .eq('status', 'active')
          .single();

        if (!tenant) {
           return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ คุณยังไม่ได้ลงทะเบียน กรุณาพิมพ์เลขห้องก่อน (เช่น 101/1)" });
        }

        // Safe access for Room Number
        const roomData: any = tenant.rooms;
        const roomNumber = Array.isArray(roomData) ? roomData[0]?.room_number : roomData?.room_number;

        // Find Unpaid Invoice
        const { data: invoice } = await supabase.from('invoices')
          .select('id, month, year')
          .eq('room_id', tenant.room_id)
          .neq('payment_status', 'paid')
          .order('year', { ascending: false }).order('month', { ascending: false }).limit(1).single();

        if (!invoice) {
           return client.replyMessage(event.replyToken, { type: 'text', text: `❓ ไม่พบยอดค้างชำระสำหรับห้อง ${roomNumber}` });
        }

        const messageId = event.message.id;
        const stream = await client.getMessageContent(messageId);
        const chunks: any[] = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);

        // Naming: 101-1_Month_Year.jpg (Slashes are bad in filenames, so we replace / with -)
        const safeRoomNum = roomNumber.replace('/', '-');
        const fileName = `${safeRoomNum}_${invoice.month}_${invoice.year}_${Date.now()}.jpg`;
        
        const { error } = await supabase.storage.from('slips').upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });

        if (!error) {
            const { data: { publicUrl } } = supabase.storage.from('slips').getPublicUrl(fileName);
            await supabase.from('invoices').update({ slip_url: publicUrl, payment_status: 'verification_pending' }).eq('id', invoice.id);
            return client.replyMessage(event.replyToken, { type: 'text', text: `✅ ได้รับสลิปห้อง ${roomNumber} (ยอด ${invoice.month}/${invoice.year}) แล้วครับ` });
        }
      }
    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error("Critical Error:", error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}