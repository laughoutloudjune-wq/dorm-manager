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

      // --- SCENARIO 1: TEXT MESSAGE (Registration) ---
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        
        // Check if it's a room number (3 digits)
        if (/^\d{3}$/.test(text)) {
          const roomNumber = text;
          
          const { data: room } = await supabase.from('rooms').select('id').eq('room_number', roomNumber).single();
          
          if (!room) {
            return client.replyMessage(event.replyToken, { type: 'text', text: `❌ Room ${roomNumber} not found.` });
          }

          const { data: existingTenant } = await supabase.from('tenants').select('id, name').eq('room_id', room.id).eq('status', 'active').single();

          if (existingTenant) {
             await supabase.from('tenants').update({ line_user_id: userId }).eq('id', existingTenant.id);
             return client.replyMessage(event.replyToken, { type: 'text', text: `✅ Reconnected to Room ${roomNumber}.` });
          } else {
             await supabase.from('tenants').insert({ room_id: room.id, name: 'New Tenant', line_user_id: userId, status: 'active' });
             await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);
             return client.replyMessage(event.replyToken, { type: 'text', text: `✅ Registered to Room ${roomNumber}.` });
          }
        }
      }

      // --- SCENARIO 2: IMAGE MESSAGE (Payment Slip) ---
      else if (event.type === 'message' && event.message.type === 'image') {
        const { data: tenant } = await supabase
          .from('tenants')
          .select('room_id, rooms(room_number)')
          .eq('line_user_id', userId)
          .eq('status', 'active')
          .single();

        if (!tenant) {
           return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ You are not registered. Please type your Room Number first (e.g., 101)." });
        }

        // --- FIX: Safely extract room number ---
        // We force TypeScript to treat 'rooms' as 'any' so we can check if it's an array or an object
        const roomData: any = tenant.rooms;
        const roomNumber = Array.isArray(roomData) ? roomData[0]?.room_number : roomData?.room_number;

        if (!roomNumber) {
           return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ Error finding your room details." });
        }

        // Get image content
        const messageId = event.message.id;
        const stream = await client.getMessageContent(messageId);
        const chunks: any[] = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);

        // Use the safe 'roomNumber' variable here
        const fileName = `${roomNumber}_${Date.now()}.jpg`;
        
        const { error: uploadError } = await supabase
          .storage
          .from('slips')
          .upload(fileName, buffer, { contentType: 'image/jpeg' });

        if (uploadError) {
          console.error("Upload failed:", uploadError);
          return client.replyMessage(event.replyToken, { type: 'text', text: "❌ System error uploading slip." });
        }

        const { data: { publicUrl } } = supabase.storage.from('slips').getPublicUrl(fileName);

        // Update Invoice
        const { data: invoice } = await supabase
          .from('invoices')
          .select('id')
          .eq('room_id', tenant.room_id)
          .neq('payment_status', 'paid')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (invoice) {
          await supabase
            .from('invoices')
            .update({ slip_url: publicUrl, payment_status: 'verification_pending' })
            .eq('id', invoice.id);

          return client.replyMessage(event.replyToken, { type: 'text', text: "✅ Slip received! Admin will verify shortly." });
        } else {
           return client.replyMessage(event.replyToken, { type: 'text', text: "❓ No pending invoice found for your room." });
        }
      }
    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}