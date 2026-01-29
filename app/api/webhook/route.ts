import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const events = body.events;

    await Promise.all(events.map(async (event: any) => {
      const userId = event.source.userId;
      const replyToken = event.replyToken;

      // ============================================================
      // 1. TEXT MESSAGE: Register / Connect
      // ============================================================
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        const parts = text.split(/\s+/);

        if (parts.length >= 2 && /^\d{3}\/[12]$/.test(parts[0])) {
          const inputRoom = parts[0];     
          const fullName = parts.slice(1).join(' '); 

          // A. Find Room
          const { data: room } = await supabase.from('rooms').select('id, allow_line_register, status').eq('room_number', inputRoom).single();
          
          if (!room) {
            return client.replyMessage(replyToken, { type: 'text', text: `❌ ไม่พบห้อง ${inputRoom}` });
          }

          // B. Check for Existing Tenant in this Room
          const { data: existingTenant } = await supabase.from('tenants')
             .select('id, line_user_id')
             .eq('room_id', room.id)
             .eq('status', 'active')
             .single();

          // SCENARIO 1: Tenant exists, but NO LINE ID (Manual Move-in) -> CONNECT THEM
          if (existingTenant && !existingTenant.line_user_id) {
             await supabase.from('tenants').update({ line_user_id: userId, name: fullName }).eq('id', existingTenant.id);
             return client.replyMessage(replyToken, { type: 'text', text: `✅ เชื่อมต่อข้อมูลสำเร็จ!\nห้อง: ${inputRoom}\nชื่อ: ${fullName}` });
          }

          // SCENARIO 2: Room is Vacant -> REGISTER NEW
          // (Only allowed if 'Allow LINE Register' checkbox is ON)
          if (!existingTenant) {
              if (room.allow_line_register) {
                  await supabase.from('tenants').insert({ room_id: room.id, line_user_id: userId, name: fullName, status: 'active' });
                  await supabase.from('rooms').update({ status: 'occupied', allow_line_register: false }).eq('id', room.id);
                  return client.replyMessage(replyToken, { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nห้อง: ${inputRoom}\nชื่อ: ${fullName}` });
              } else {
                  return client.replyMessage(replyToken, { type: 'text', text: `🔒 ห้อง ${inputRoom} ไม่เปิดให้ลงทะเบียนผ่านไลน์ กรุณาติดต่อแอดมิน` });
              }
          }

          // SCENARIO 3: Tenant exists AND has LINE ID -> ERROR
          if (existingTenant && existingTenant.line_user_id) {
             return client.replyMessage(replyToken, { type: 'text', text: `⚠️ ห้องนี้มีผู้ใช้งานลงทะเบียนแล้ว` });
          }
        }
      }

      // ============================================================
      // 2. IMAGE MESSAGE: Payment Slip
      // ============================================================
      else if (event.type === 'message' && event.message.type === 'image') {
        // Find tenant by LINE ID
        const { data: tenant } = await supabase.from('tenants').select('room_id, rooms(room_number)').eq('line_user_id', userId).eq('status', 'active').single();

        if (!tenant) {
           return client.replyMessage(replyToken, { type: 'text', text: "⚠️ คุณยังไม่ได้เชื่อมต่อข้อมูลห้องพัก\n\nกรุณาพิมพ์ 'เลขห้อง ชื่อสกุล' เพื่อเชื่อมต่อระบบก่อนครับ\nตัวอย่าง: 101/1 สมชาย" });
        }

        const roomData: any = tenant.rooms;
        const roomNumber = Array.isArray(roomData) ? roomData[0]?.room_number : roomData?.room_number;

        // Find Unpaid Invoice
        const { data: invoice } = await supabase.from('invoices')
          .select('id, month, year')
          .eq('room_id', tenant.room_id)
          .neq('payment_status', 'paid')
          .order('year', { ascending: false }).order('month', { ascending: false })
          .limit(1)
          .single();

        if (!invoice) {
           return client.replyMessage(replyToken, { type: 'text', text: `✅ ไม่มียอดค้างชำระครับ` });
        }

        // Upload
        const messageId = event.message.id;
        const stream = await client.getMessageContent(messageId);
        const chunks: any[] = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);
        const fileName = `${roomNumber.replace('/', '-')}_${invoice.month}_${invoice.year}_${Date.now()}.jpg`;
          
        const { error: uploadError } = await supabase.storage.from('slips').upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });

        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('slips').getPublicUrl(fileName);
          await supabase.from('invoices').update({ slip_url: publicUrl, payment_status: 'verification_pending' }).eq('id', invoice.id);
          return client.replyMessage(replyToken, { type: 'text', text: `✅ ได้รับสลิปแล้ว (ห้อง ${roomNumber})` });
        }
      }
    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}