import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatDate = (value: string | null | undefined) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH");
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const rowHtml = (label: string, value: string) => `
  <div class="row">
    <span class="label">${escapeHtml(label)}</span>
    <span class="value">${escapeHtml(value)}</span>
  </div>
`;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const token = decodeURIComponent(parts[parts.length - 1] ?? "");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("invoices")
      .select(
        "id,public_token,status,issue_date,due_date,total_amount,paid_amount,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,discount_amount,late_fee_amount,payment_history,tenants(full_name,address,custom_receipt_profile),rooms(room_number,buildings(name))"
      )
      .eq("public_token", token)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if ((data as any).status !== "paid") {
      return NextResponse.json(
        { error: "Receipt PDF is available only after payment is verified." },
        { status: 400 }
      );
    }

    const tenant = Array.isArray((data as any).tenants) ? (data as any).tenants[0] : (data as any).tenants;
    const room = Array.isArray((data as any).rooms) ? (data as any).rooms[0] : (data as any).rooms;
    const building =
      Array.isArray(room?.buildings) ? room?.buildings?.[0] : room?.buildings;

    const customReceipt = (tenant as any)?.custom_receipt_profile ?? null;
    const paymentHistory = Array.isArray((data as any).payment_history)
      ? (data as any).payment_history
      : [];
    const paymentDate =
      paymentHistory.length > 0
        ? paymentHistory[paymentHistory.length - 1]?.paid_at
        : null;
    const receiptNo = `RC-${String((data as any).id).slice(0, 8).toUpperCase()}`;

    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
      @page { size: A4; margin: 12mm; }
      body { font-family: "Sarabun", "Tahoma", sans-serif; color: #111827; font-size: 12px; }
      h1 { margin: 0; font-size: 22px; }
      .sub { color: #4b5563; margin-top: 4px; margin-bottom: 14px; }
      .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
      .card h2 { margin: 0 0 10px 0; font-size: 13px; }
      .row { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 6px; }
      .label { color: #4b5563; }
      .value { font-weight: 600; text-align: right; white-space: pre-wrap; }
      .total { margin-top: 10px; padding-top: 8px; border-top: 1px solid #d1d5db; font-size: 14px; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>ใบเสร็จรับเงิน</h1>
    <div class="sub">เลขที่ใบเสร็จ: ${escapeHtml(receiptNo)} | วันที่ชำระ: ${escapeHtml(formatDate(paymentDate))}</div>

    <div class="card">
      <h2>ข้อมูลผู้รับใบเสร็จ</h2>
      ${customReceipt?.label ? rowHtml("โปรไฟล์ใบเสร็จ", String(customReceipt.label)) : ""}
      ${rowHtml("ชื่อ", String(customReceipt?.company_name ?? tenant?.full_name ?? "-"))}
      ${customReceipt?.tax_id ? rowHtml("เลขผู้เสียภาษี", String(customReceipt.tax_id)) : ""}
      ${customReceipt?.branch ? rowHtml("สาขา", String(customReceipt.branch)) : ""}
      ${rowHtml("ที่อยู่", String(customReceipt?.address ?? tenant?.address ?? "-"))}
      ${rowHtml("อาคาร / ห้อง", `${String(building?.name ?? "-")} / ${String(room?.room_number ?? "-")}`)}
      ${rowHtml("งวดบิล", formatDate(String((data as any).issue_date)))}
      ${rowHtml("วันครบกำหนด", formatDate(String((data as any).due_date)))}
    </div>

    <div class="card">
      <h2>รายละเอียดค่าใช้จ่าย</h2>
      ${rowHtml("ค่าเช่า", formatMoney(toNumber((data as any).rent_amount)))}
      ${rowHtml("ค่าน้ำ", formatMoney(toNumber((data as any).water_bill)))}
      ${rowHtml("ค่าไฟ", formatMoney(toNumber((data as any).electricity_bill)))}
      ${rowHtml("ค่าส่วนกลาง", formatMoney(toNumber((data as any).common_fee)))}
      ${rowHtml("ค่าธรรมเนียมเพิ่มเติม", formatMoney(toNumber((data as any).additional_fees_total)))}
      ${rowHtml("ส่วนลด", `-${formatMoney(toNumber((data as any).discount_amount))}`)}
      ${rowHtml("ค่าปรับล่าช้า", formatMoney(toNumber((data as any).late_fee_amount)))}
      <div class="total row">
        <span>ยอดที่ชำระ</span>
        <span>${escapeHtml(
          formatMoney(
            toNumber((data as any).paid_amount) || toNumber((data as any).total_amount)
          )
        )}</span>
      </div>
    </div>
  </body>
</html>`;

    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath());

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
    await browser.close();

    const filename = `receipt-${String(room?.room_number ?? "room")}-${String((data as any).issue_date ?? "").slice(
      0,
      7
    )}.pdf`;

    return new Response(Buffer.from(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
