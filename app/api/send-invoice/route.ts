import { NextResponse } from 'next/server';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    // 1. รับค่าทั้งหมดที่จำเป็น (รวมถึงรายการใหม่ๆ)
    const { 
      userId, roomNumber, month, year, roomId,
      rent = 0, 
      waterUnit = 0, waterPrice = 0, 
      elecUnit = 0, elecPrice = 0, 
      commonFee = 0,    // ค่าส่วนกลาง
      lateFee = 0,      // ค่าปรับ
      otherFees = 0,    // ค่าอื่นๆ
      discount = 0,     // ส่วนลด
      total = 0
    } = body;

    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 });

    // 2. ดึงข้อมูลการชำระเงินของผู้เช่า
    const { data: tenant } = await supabase
      .from('tenants')
      .select('payment_methods(bank_name, account_number, account_name, qr_url, type)')
      .eq('room_id', roomId)
      .eq('status', 'active')
      .single();

    const payMethod: any = Array.isArray(tenant?.payment_methods) 
      ? tenant.payment_methods[0] 
      : tenant?.payment_methods;

    // 3. สร้างรายการบิล (Invoice Rows) แบบ Dynamic
    // ฟังก์ชันช่วยสร้างแถวรายการ เพื่อลดความซ้ำซ้อน
    const createRow = (label: string, value: number, color: string = "#555555", prefix: string = "") => ({
      type: "box", 
      layout: "horizontal", 
      contents: [
        { type: "text", text: label, size: "sm", color: "#555555", flex: 3 }, 
        { type: "text", text: `${prefix}${Number(value).toLocaleString()}`, size: "sm", align: "end", flex: 2, color: color }
      ]
    });

    // เริ่มต้นใส่รายการพื้นฐาน
    const invoiceDetails: any[] = [
      createRow("ค่าเช่าห้อง", rent),
      createRow(`ค่าไฟ (${elecUnit} หน่วย)`, elecPrice),
      createRow(`ค่าน้ำ (${waterUnit} หน่วย)`, waterPrice),
    ];

    // ตรวจสอบรายการเสริม ถ้ามีให้เพิ่มเข้าไป
    if (commonFee > 0) {
      invoiceDetails.push(createRow("ค่าส่วนกลาง", commonFee));
    }
    if (otherFees > 0) {
      invoiceDetails.push(createRow("ค่าอื่นๆ", otherFees));
    }
    if (lateFee > 0) {
      invoiceDetails.push(createRow("ค่าปรับล่าช้า", lateFee, "#ef4444")); // สีแดง
    }
    if (discount > 0) {
      invoiceDetails.push(createRow("ส่วนลด", discount, "#22c55e", "-")); // สีเขียว และใส่เครื่องหมายลบ
    }

    // เพิ่มเส้นกั้นและยอดรวม
    invoiceDetails.push({ type: "separator", margin: "lg" });
    invoiceDetails.push({ 
      type: "box", 
      layout: "horizontal", 
      margin: "lg", 
      contents: [
        { type: "text", text: "ยอดรวมสุทธิ", size: "md", weight: "bold" }, 
        { type: "text", text: `${Number(total).toLocaleString()} บาท`, size: "xl", weight: "bold", color: "#1DB446", align: "end" }
      ] 
    });

    // 4. สร้างส่วนการชำระเงิน (Payment Section)
    let paymentSection: any[] = [
       { type: "separator", margin: "lg" },
       { type: "text", text: "ช่องทางการชำระเงิน", weight: "bold", size: "sm", margin: "md", color: "#111111" }
    ];

    if (payMethod) {
      if (payMethod.type === 'qr' && payMethod.qr_url) {
        paymentSection.push({
          type: "image",
          url: payMethod.qr_url,
          size: "lg",
          aspectMode: "cover",
          margin: "md"
        });
        paymentSection.push({
          type: "text", text: "สแกนเพื่อจ่าย (Scan to Pay)", size: "xs", color: "#aaaaaa", align: "center", margin: "xs"
        });
      } else {
        paymentSection.push({
          type: "box", layout: "vertical", margin: "md", spacing: "sm",
          contents: [
            { type: "text", text: payMethod.bank_name || 'Bank', size: "sm", weight: "bold" },
            { type: "text", text: payMethod.account_number || '-', size: "xl", weight: "bold", color: "#1DB446" },
            { type: "text", text: payMethod.account_name || '-', size: "xs", color: "#555555" }
          ]
        });
      }
    } else {
       paymentSection.push({ type: "text", text: "กรุณาติดต่อเจ้าหน้าที่", size: "sm", color: "#ff5555" });
    }

    // --- FINAL FLEX MESSAGE ---
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
            ...invoiceDetails, // ใส่รายการที่สร้างไว้ข้างบน
            ...paymentSection  // ใส่ส่วนการจ่ายเงิน
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