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
      // We only care about text messages
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        const userId = event.source.userId;

        // CHECK 1: Did they type a Room Number? (e.g., "101", "205")
        // This regex checks if the text is exactly 3 digits
        if (/^\d{3}$/.test(text)) {
          const roomNumber = text;

          // A. Find the Room in DB
          const { data: room } = await supabase
            .from('rooms')
            .select('id, status')
            .eq('room_number', roomNumber)
            .single();

          if (!room) {
            return client.replyMessage(event.replyToken, {
              type: 'text', text: `❌ Room ${roomNumber} does not exist in the system.`
            });
          }

          // B. Link the User ID to the Tenant in that room
          // First, check if there is an active tenant there
          const { data: existingTenant } = await supabase
            .from('tenants')
            .select('id, name')
            .eq('room_id', room.id)
            .eq('status', 'active')
            .single();

          if (existingTenant) {
            // Update the existing tenant with this LINE ID
            await supabase
              .from('tenants')
              .update({ line_user_id: userId })
              .eq('id', existingTenant.id);

            return client.replyMessage(event.replyToken, {
              type: 'text', text: `✅ Connected! Hello ${existingTenant.name}, you will now receive bills for Room ${roomNumber} here.`
            });
          } else {
            // If room is empty in DB, create a new tenant entry
            await supabase.from('tenants').insert({
              room_id: room.id,
              name: 'New Tenant', // You can edit the name later in your dashboard
              line_user_id: userId,
              status: 'active'
            });
            
            // Mark room as occupied
            await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);

            return client.replyMessage(event.replyToken, {
              type: 'text', text: `✅ Registered! You are now set as the tenant for Room ${roomNumber}.`
            });
          }
        }
      }
    }));

    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}