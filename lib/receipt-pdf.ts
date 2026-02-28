import PDFDocument from "pdfkit";

type ReceiptInvoiceData = {
  id: string;
  public_token: string;
  issue_date: string;
  due_date: string;
  total_amount: number;
  paid_amount: number;
  rent_amount: number;
  water_bill: number;
  electricity_bill: number;
  common_fee: number;
  additional_fees_total: number;
  discount_amount: number;
  late_fee_amount: number;
  payment_history: any[];
  tenant_name: string;
  tenant_address?: string | null;
  tenant_tax_id?: string | null;
  tenant_branch?: string | null;
  receipt_profile_label?: string | null;
  room_number: string;
  building_name: string;
};

const money = (value: number) =>
  Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const dateText = (value: string | null | undefined) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH");
};

function line(doc: PDFKit.PDFDocument, label: string, value: string, y: number) {
  doc.font("Helvetica").fontSize(11).fillColor("#4b5563").text(label, 50, y, { width: 250 });
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#111827")
    .text(value, 320, y, { width: 220, align: "right" });
}

export async function renderReceiptPdf(invoice: ReceiptInvoiceData): Promise<Buffer> {
  const receiptNo = `RC-${invoice.id.slice(0, 8).toUpperCase()}`;
  const paymentDate =
    Array.isArray(invoice.payment_history) && invoice.payment_history.length > 0
      ? invoice.payment_history[invoice.payment_history.length - 1]?.paid_at
      : null;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks: Buffer[] = [];

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text("RECEIPT");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#4b5563")
      .text(`Receipt No: ${receiptNo}   Payment Date: ${dateText(paymentDate)}`);

    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text("Tenant / Receipt Info");
    doc.moveDown(0.4);

    let y = doc.y;
    if (invoice.receipt_profile_label) {
      line(doc, "Receipt Profile", invoice.receipt_profile_label, y);
      y += 18;
    }
    line(doc, "Name", invoice.tenant_name || "-", y);
    y += 18;
    if (invoice.tenant_tax_id) {
      line(doc, "Tax ID", invoice.tenant_tax_id, y);
      y += 18;
    }
    if (invoice.tenant_branch) {
      line(doc, "Branch", invoice.tenant_branch, y);
      y += 18;
    }
    if (invoice.tenant_address) {
      line(doc, "Address", invoice.tenant_address, y);
      y += 18;
    }
    line(doc, "Building / Room", `${invoice.building_name || "-"} / ${invoice.room_number || "-"}`, y);
    y += 18;
    line(doc, "Billing Period", dateText(invoice.issue_date), y);
    y += 18;
    line(doc, "Due Date", dateText(invoice.due_date), y);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text("Charges");
    doc.moveDown(0.4);

    y = doc.y;
    line(doc, "Rent", money(invoice.rent_amount), y);
    y += 18;
    line(doc, "Water", money(invoice.water_bill), y);
    y += 18;
    line(doc, "Electricity", money(invoice.electricity_bill), y);
    y += 18;
    line(doc, "Common Fee", money(invoice.common_fee), y);
    y += 18;
    line(doc, "Additional Fees", money(invoice.additional_fees_total), y);
    y += 18;
    line(doc, "Discount", `-${money(invoice.discount_amount)}`, y);
    y += 18;
    line(doc, "Late Fee", money(invoice.late_fee_amount), y);
    y += 26;

    doc.moveTo(50, y).lineTo(545, y).strokeColor("#d1d5db").stroke();
    y += 10;
    line(doc, "Total Paid", money(invoice.paid_amount || invoice.total_amount), y);

    doc.end();
  });
}

