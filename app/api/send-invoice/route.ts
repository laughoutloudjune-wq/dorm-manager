import { NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js'; // Import Supabase to fetch Payment Methods

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// Setup Supabase (Use Service Key for safety, or Public key if reading public data)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
      userId, roomNumber, month, year,
      rent, waterUnit, waterPrice, elecUnit, elecPrice, total,
      roomId // We need roomId to find the specific payment method for this tenant
    } = body;

    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 });

    // 1. Fetch Tenant's Payment Method
    const { data: tenant } = await supabase
      .from('tenants')
      .select('payment_methods(bank_name, account_number, account_name, qr_url, type)')
      .eq('room_id', roomId) // Use the roomId passed from frontend
      .eq('status', 'active')
      .single();

    const payMethod: any = Array.isArray(tenant?.payment_methods) 
      ? tenant.payment_methods[0] 
      : tenant?.payment_methods;

    // 2. Construct the Flex Message
    const contents: any[] = [
      // ... (Header & Bill Details remain the same) ...
      { type: "text", text: "ค่าเช่าห้อง", size: "sm", color: "#555555", flex: 3 }, // Example Row
      // ... (I will reconstruct the full body below) ...
    ];

    // 3. Create the "Payment Section" Dynamic Block
    let paymentSection: any[] = [
       { type: "separator", margin: "lg" },
       { type: "text", text: "ช่องทางการชำระเงิน", weight: "bold", size: "sm", margin: "md", color: "#111111" }
    ];

    if (payMethod) {
      if (payMethod.type === 'qr' && payMethod.qr_url) {
        // --- OPTION A: QR CODE IMAGE ---
        paymentSection.push({
          type: "image",
          url: payMethod.qr_url, // Must be a valid HTTPS URL (Supabase Storage URL)
          size: "lg",
          aspectMode: "cover",
          margin: "md"
        });
        paymentSection.push({
          type: "text", text: "สแกนเพื่อจ่าย (Scan to Pay)", size: "xs", color: "#aaaaaa", align: "center", margin: "xs"
        });
      } else {
        // --- OPTION B: BANK ACCOUNT TEXT ---
        paymentSection.push({
          type: "box", layout: "vertical", margin: "md", spacing: "sm",
          contents: [
            { type: "text", text: payMethod.bank_name || 'Bank', size: "sm", weight: "bold" },
            { type: "text", text: payMethod.account_number || '-', size: "xl", weight: "bold", color: "#1DB446" }, // Big Green Numbers
            { type: "text", text: payMethod.account_name || '-', size: "xs", color: "#555555" }
          ]
        });
      }
    } else {
       paymentSection.push({ type: "text", text: "กรุณาติดต่อเจ้าหน้าที่", size: "sm", color: "#ff5555" });
    }

    // --- FINAL FLEX MESSAGE ASSEMBLY ---
    const flexMessage: any = {
      type: "flex",
      altText: `บิลค่าเช่าห้อง ${roomNumber}`,
      contents: {
        type: "bubble",
        size: "giga",
        header: {
          type: "box", layout: "vertical", backgroundColor: "#0F172A", paddingAll: "lg",
          contents: [
            { type: "text", text: "ใบแจ้งหนี้ (Invoice)", color: "#ffffff", weight: "bold", size: "lg" },
            { type: "text", text: `ห้อง ${roomNumber} | รอบ ${month}/${year}`, color: "#cbd5e1", size: "xs", margin: "sm" }
          ]
        },
        body: {
          type: "box", layout: "vertical", spacing: "md",
          contents: [
            // Details
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "ค่าเช่าห้อง", size: "sm", color: "#555555", flex: 3 }, { type: "text", text: `${rent}`, size: "sm", align: "end", flex: 2 }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: `ค่าไฟ (${elecUnit})`, size: "sm", color: "#555555", flex: 3 }, { type: "text", text: `${elecPrice}`, size: "sm", align: "end", flex: 2 }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: `ค่าน้ำ (${waterUnit})`, size: "sm", color: "#555555", flex: 3 }, { type: "text", text: `${waterPrice}`, size: "sm", align: "end", flex: 2 }] },
            { type: "separator", margin: "lg" },
            { type: "box", layout: "horizontal", margin: "lg", contents: [{ type: "text", text: "ยอดรวมสุทธิ", size: "md", weight: "bold" }, { type: "text", text: `${total} บาท`, size: "xl", weight: "bold", color: "#1DB446", align: "end" }] },
            
            // ADD PAYMENT SECTION HERE
            ...paymentSection
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