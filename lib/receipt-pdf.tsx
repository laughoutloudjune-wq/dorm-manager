import React from "react";
import { Document, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";

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

const styles = StyleSheet.create({
  page: {
    padding: 24,
    fontSize: 11,
    color: "#111827",
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 10,
    color: "#4b5563",
    marginBottom: 16,
  },
  section: {
    marginBottom: 12,
    border: "1 solid #e5e7eb",
    padding: 10,
    borderRadius: 6,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  rowLabel: {
    color: "#4b5563",
  },
  rowValue: {
    fontWeight: 600,
  },
  totalBox: {
    marginTop: 8,
    borderTop: "1 solid #d1d5db",
    paddingTop: 8,
  },
  totalText: {
    fontSize: 13,
    fontWeight: 700,
  },
});

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

export async function renderReceiptPdf(invoice: ReceiptInvoiceData) {
  const receiptNo = `RC-${invoice.id.slice(0, 8).toUpperCase()}`;
  const paymentDate =
    Array.isArray(invoice.payment_history) && invoice.payment_history.length > 0
      ? invoice.payment_history[invoice.payment_history.length - 1]?.paid_at
      : null;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>ใบเสร็จรับเงิน</Text>
        <Text style={styles.subtitle}>
          เลขที่ใบเสร็จ: {receiptNo} | วันที่ชำระ: {dateText(paymentDate)}
        </Text>

        <View style={styles.section}>
          {invoice.receipt_profile_label ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>โปรไฟล์ใบเสร็จ</Text>
              <Text style={styles.rowValue}>{invoice.receipt_profile_label}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ผู้เช่า</Text>
            <Text style={styles.rowValue}>{invoice.tenant_name || "-"}</Text>
          </View>
          {invoice.tenant_tax_id ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>เลขผู้เสียภาษี</Text>
              <Text style={styles.rowValue}>{invoice.tenant_tax_id}</Text>
            </View>
          ) : null}
          {invoice.tenant_branch ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>สาขา</Text>
              <Text style={styles.rowValue}>{invoice.tenant_branch}</Text>
            </View>
          ) : null}
          {invoice.tenant_address ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>ที่อยู่ออกใบเสร็จ</Text>
              <Text style={styles.rowValue}>{invoice.tenant_address}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>อาคาร / ห้อง</Text>
            <Text style={styles.rowValue}>
              {invoice.building_name || "-"} / {invoice.room_number || "-"}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>งวดบิล</Text>
            <Text style={styles.rowValue}>{dateText(invoice.issue_date)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>วันครบกำหนด</Text>
            <Text style={styles.rowValue}>{dateText(invoice.due_date)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าเช่า</Text>
            <Text>{money(invoice.rent_amount)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าน้ำ</Text>
            <Text>{money(invoice.water_bill)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าไฟ</Text>
            <Text>{money(invoice.electricity_bill)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าส่วนกลาง</Text>
            <Text>{money(invoice.common_fee)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าธรรมเนียมเพิ่มเติม</Text>
            <Text>{money(invoice.additional_fees_total)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ส่วนลด</Text>
            <Text>-{money(invoice.discount_amount)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>ค่าปรับล่าช้า</Text>
            <Text>{money(invoice.late_fee_amount)}</Text>
          </View>
          <View style={styles.totalBox}>
            <View style={styles.row}>
              <Text style={styles.totalText}>ยอดที่ชำระ</Text>
              <Text style={styles.totalText}>{money(invoice.paid_amount || invoice.total_amount)}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );

  const buffer = await pdf(doc).toBuffer();
  return buffer;
}
