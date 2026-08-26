import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `@sparticuz/chromium` ships a Linux-only binary for the serverless runtime.
 * On a Windows/macOS dev machine `executablePath()` points at a file that was
 * never extracted (`spawn .../chromium ENOENT`), so fall back to whatever
 * Chrome/Edge the developer already has installed.
 */
const localBrowserCandidates = () => {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    return [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : "",
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [];
};

const resolveBrowser = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: chromium.args };
  }

  if (process.platform === "linux") {
    return { executablePath: await chromium.executablePath(), args: chromium.args };
  }

  const local = localBrowserCandidates().find((candidate) => existsSync(candidate));
  if (!local) {
    throw new Error(
      "ไม่พบ Chrome หรือ Edge สำหรับสร้างไฟล์ PDF บนเครื่องนี้ กรุณาติดตั้ง Chrome หรือกำหนด PUPPETEER_EXECUTABLE_PATH ใน .env.local"
    );
  }
  // chromium.args is tuned for the serverless sandbox (--single-process and
  // friends) and destabilises a desktop Chrome — a desktop build needs none.
  return { executablePath: local, args: [] as string[] };
};

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

const monthStartFromDate = (dateString: string) => {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
};

const resolveElectricityUsage = (reading: any) => {
  if (!reading) return null;
  if (reading.electricity_usage != null) return toNumber(reading.electricity_usage);
  if (reading.current_electricity != null && reading.previous_electricity != null) {
    return toNumber(reading.current_electricity) - toNumber(reading.previous_electricity);
  }
  return null;
};

const resolveWaterUsage = (reading: any) => {
  if (!reading) return null;
  if (reading.water_usage != null) return toNumber(reading.water_usage);
  if (reading.usage != null) return toNumber(reading.usage);
  if (reading.current_water != null && reading.previous_water != null) {
    return toNumber(reading.current_water) - toNumber(reading.previous_water);
  }
  if (reading.current_reading != null && reading.previous_reading != null) {
    return toNumber(reading.current_reading) - toNumber(reading.previous_reading);
  }
  return null;
};

const formatUnit = (value: number | null | undefined) => {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(2);
};

const rowHtml = (label: string, value: string) => `
  <div class="row">
    <span class="label">${escapeHtml(label)}</span>
    <span class="value">${escapeHtml(value)}</span>
  </div>
`;

const isCarryForwardBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "carry_forward";

const isTransferBreakdownRow = (row: any) =>
  String(row?.item_type ?? row?.type ?? "").toLowerCase() === "transfer_detail";

const isLateFeeBreakdownRow = (row: any) => {
  const type = String(row?.item_type ?? row?.type ?? "").toLowerCase();
  if (type === "late_fee_line" || type === "late_fee") return true;
  const label = String(row?.detail ?? row?.label ?? "").toLowerCase();
  return label.includes("ค่าปรับล่าช้า") || label.includes("late fee");
};

const shortInvoiceId = (value: string | null | undefined) =>
  String(value ?? "").slice(0, 8).toUpperCase() || "-";

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
        "id,room_id,start_date,public_token,status,issue_date,due_date,total_amount,paid_amount,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,additional_fees_breakdown,discount_amount,late_fee_amount,payment_history,slip_uploaded_at,tenants(full_name,address,phone_number,custom_receipt_profile),rooms(room_number,buildings(name))"
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
    const building = Array.isArray(room?.buildings) ? room?.buildings?.[0] : room?.buildings;

    const { data: settings } = await supabase
      .from("settings")
      .select("dorm_name,dorm_address,dorm_phone,water_rate,electricity_rate")
      .eq("id", 1)
      .maybeSingle();

    const readingMonth = monthStartFromDate(
      String((data as any).start_date ?? (data as any).issue_date)
    );
    const { data: reading } = await supabase
      .from("meter_readings")
      .select(
        "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
      )
      .eq("room_id", String((data as any).room_id))
      .eq("reading_month", readingMonth)
      .maybeSingle();
    // `invoice_arrears_snapshots` is a permanent audit log written once at
    // generation time — it is never updated or cleared when an admin later
    // edits or recalculates this invoice's carry-forward, so reading it
    // unconditionally can show a late fee the invoice no longer actually
    // bills. The invoice's OWN current breakdown is authoritative when it has
    // an itemized late-fee row; the audit log is only a fallback for a
    // legacy invoice that predates itemized breakdowns.
    const ownLateFeeRowsForReceipt = (
      Array.isArray((data as any).additional_fees_breakdown)
        ? (data as any).additional_fees_breakdown
        : []
    ).filter((row: any) => isLateFeeBreakdownRow(row));
    const { data: arrearsSnapshots } =
      ownLateFeeRowsForReceipt.length === 0
        ? await supabase
            .from("invoice_arrears_snapshots")
            .select(
              "id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate"
            )
            .eq("target_invoice_id", String((data as any).id))
            .order("created_at", { ascending: true })
        : { data: [] as any[] };

    const waterUsage = resolveWaterUsage(reading);
    const electricityUsage = resolveElectricityUsage(reading);
    const waterRate = toNumber((settings as any)?.water_rate);
    const electricityRate = toNumber((settings as any)?.electricity_rate);

    const customReceipt = (tenant as any)?.custom_receipt_profile ?? null;
    const paymentHistory = Array.isArray((data as any).payment_history)
      ? (data as any).payment_history
      : [];
    const paymentDate =
      paymentHistory.length > 0
        ? paymentHistory[paymentHistory.length - 1]?.paid_at
        : (data as any).slip_uploaded_at ?? null;
    const receiptNo = `RC-${String((data as any).id).slice(0, 8).toUpperCase()}`;

    const issuerName = String(
      customReceipt?.company_name ?? (settings as any)?.dorm_name ?? "Apartment Flow"
    );
    const issuerAddress = String(customReceipt?.address ?? (settings as any)?.dorm_address ?? "-");
    const issuerPhone = String((settings as any)?.dorm_phone ?? "-");
    const issuerTaxId = customReceipt?.tax_id ? String(customReceipt.tax_id) : null;
    const issuerBranch = customReceipt?.branch ? String(customReceipt.branch) : null;

    const additionalFees = Array.isArray((data as any).additional_fees_breakdown)
      ? (data as any).additional_fees_breakdown
      : [];
    const carryForwardFees = additionalFees.filter((row: any) => isCarryForwardBreakdownRow(row));
    // Late-fee rows render via their own dedicated section below (lateFeeRowsHtml),
    // so they're excluded here too — otherwise a late fee sourced from the
    // invoice's own breakdown would render twice.
    const normalAdditionalFees = additionalFees.filter(
      (row: any) =>
        !isCarryForwardBreakdownRow(row) &&
        !isTransferBreakdownRow(row) &&
        !isLateFeeBreakdownRow(row)
    );
    const hasNormalAdditionalFeeBreakdown = normalAdditionalFees.length > 0;
    const arrearsSnapshotRows = Array.isArray(arrearsSnapshots) ? arrearsSnapshots : [];
    const lateFeeRowsHtml =
      ownLateFeeRowsForReceipt.length > 0
        ? ownLateFeeRowsForReceipt
            .map(
              (row: any) =>
                `<tr><td>${escapeHtml(String(row?.detail ?? row?.label ?? "ค่าปรับล่าช้า"))}</td><td>${escapeHtml(
                  formatMoney(toNumber(row?.total_amount ?? row?.amount ?? 0))
                )}</td></tr>`
            )
            .join("")
        : arrearsSnapshotRows.length > 0
          ? arrearsSnapshotRows
              .map(
                (row: any) =>
                  `<tr><td>ค่าปรับล่าช้า - บิล ${escapeHtml(shortInvoiceId(String(row?.source_invoice_id ?? "")))} (${escapeHtml(
                    `${Math.round(toNumber(row?.days_overdue)).toLocaleString("th-TH")} วัน x ${formatMoney(
                      toNumber(row?.daily_rate)
                    )}/วัน`
                  )})</td><td>${escapeHtml(formatMoney(toNumber(row?.late_fee_amount)))}</td></tr>`
              )
              .join("")
          : toNumber((data as any).late_fee_amount) > 0
            ? `<tr><td>ค่าปรับล่าช้า</td><td>${escapeHtml(formatMoney(toNumber((data as any).late_fee_amount)))}</td></tr>`
            : "";

    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap');
      @page { size: A4; margin: 12mm; }
      body { font-family: "Google Sans", "Google Sans Text", "Product Sans", "Noto Sans Thai", "Sarabun", "Tahoma", sans-serif; color: #111827; font-size: 14px; }
      h1 { margin: 0; font-size: 28px; color: #0f172a; }
      .sub { color: #334155; margin-top: 4px; margin-bottom: 14px; font-size: 13px; }
      .header { border: 2px solid #1e40af; border-radius: 12px; background: #eff6ff; padding: 14px; margin-bottom: 14px; }
      .card { border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #ffffff; }
      .card h2 { margin: 0 0 10px 0; font-size: 15px; color: #1e3a8a; }
      .row { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 6px; }
      .label { color: #4b5563; }
      .value { font-weight: 600; text-align: right; white-space: pre-wrap; }
      .total { margin-top: 10px; padding-top: 8px; border-top: 1px solid #d1d5db; font-size: 16px; font-weight: 700; color: #0f172a; }
      .formula { color: #475569; font-size: 12px; margin-top: 2px; }
      .charges-table { width: 100%; border-collapse: collapse; }
      .charges-table th, .charges-table td { border-bottom: 1px solid #e2e8f0; padding: 8px 4px; text-align: left; }
      .charges-table th:last-child, .charges-table td:last-child { text-align: right; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>ใบเสร็จรับเงิน</h1>
      <div class="sub">เลขที่ใบเสร็จ: ${escapeHtml(receiptNo)} | วันที่ชำระ: ${escapeHtml(formatDate(paymentDate))}</div>
      ${rowHtml("ผู้ออกเอกสาร", issuerName)}
      ${rowHtml("ที่อยู่ผู้ออกเอกสาร", issuerAddress)}
      ${rowHtml("โทรศัพท์", issuerPhone)}
      ${issuerTaxId ? rowHtml("เลขผู้เสียภาษี", issuerTaxId) : ""}
      ${issuerBranch ? rowHtml("สาขา", issuerBranch) : ""}
    </div>

    <div class="card">
      <h2>ข้อมูลผู้เช่า</h2>
      ${rowHtml("ชื่อ-นามสกุล", String(tenant?.full_name ?? "-"))}
      ${rowHtml("ที่อยู่", String(tenant?.address ?? "-"))}
      ${rowHtml("เบอร์โทรศัพท์", String(tenant?.phone_number ?? "-"))}
      ${rowHtml("เลขห้อง", `${String(room?.room_number ?? "-")}${building?.name ? ` (${String(building.name)})` : ""}`)}
    </div>

    <div class="card">
      <h2>รายละเอียดค่าใช้จ่าย</h2>
      <table class="charges-table">
        <thead>
          <tr><th>รายการ</th><th>จำนวนเงิน (บาท)</th></tr>
        </thead>
        <tbody>
          <tr><td>ค่าเช่า</td><td>${escapeHtml(formatMoney(toNumber((data as any).rent_amount)))}</td></tr>
          <tr>
            <td>ค่าน้ำ
              <div class="formula">(${escapeHtml(formatUnit((reading as any)?.previous_water ?? (reading as any)?.previous_reading ?? null))} - ${escapeHtml(formatUnit((reading as any)?.current_water ?? (reading as any)?.current_reading ?? null))} = ${escapeHtml(formatUnit(waterUsage))} หน่วย) x ${escapeHtml(formatUnit(waterRate))}</div>
            </td>
            <td>${escapeHtml(formatMoney(toNumber((data as any).water_bill)))}</td>
          </tr>
          <tr>
            <td>ค่าไฟฟ้า
              <div class="formula">(${escapeHtml(formatUnit((reading as any)?.previous_electricity ?? (reading as any)?.previous_reading ?? null))} - ${escapeHtml(formatUnit((reading as any)?.current_electricity ?? (reading as any)?.current_reading ?? null))} = ${escapeHtml(formatUnit(electricityUsage))} หน่วย) x ${escapeHtml(formatUnit(electricityRate))}</div>
            </td>
            <td>${escapeHtml(formatMoney(toNumber((data as any).electricity_bill)))}</td>
          </tr>
          <tr><td>ค่าส่วนกลาง</td><td>${escapeHtml(formatMoney(toNumber((data as any).common_fee)))}</td></tr>
          ${carryForwardFees
            .map(
              (fee: any) =>
                `<tr><td>ยอดค้างยกมา - ${escapeHtml(String(fee?.detail ?? fee?.label ?? "-"))}</td><td>${escapeHtml(
                  formatMoney(toNumber(fee?.total_amount ?? fee?.amount ?? 0))
                )}</td></tr>`
            )
            .join("")}
          ${normalAdditionalFees
            .map(
              (fee: any) =>
                `<tr><td>${escapeHtml(String(fee?.detail ?? fee?.label ?? "ค่าธรรมเนียมเพิ่มเติม"))}</td><td>${escapeHtml(
                  formatMoney(toNumber(fee?.total_amount ?? fee?.amount ?? 0))
                )}</td></tr>`
            )
            .join("")}
          ${
            hasNormalAdditionalFeeBreakdown
              ? ""
              : toNumber((data as any).additional_fees_total) > 0
                ? `<tr><td>ค่าธรรมเนียมเพิ่มเติม</td><td>${escapeHtml(
                    formatMoney(toNumber((data as any).additional_fees_total))
                  )}</td></tr>`
                : ""
          }
          <tr><td>ส่วนลด</td><td>-${escapeHtml(formatMoney(toNumber((data as any).discount_amount)))}</td></tr>
          ${lateFeeRowsHtml}
        </tbody>
      </table>
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

    const { executablePath, args } = await resolveBrowser();

    const browser = await puppeteer.launch({
      args,
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
    await browser.close();

    const filename = `receipt-${String(room?.room_number ?? "room")}-${String((data as any).issue_date ?? "").slice(
      0,
      7
    )}.pdf`;

    return new Response(Buffer.from(pdfBytes), {
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
