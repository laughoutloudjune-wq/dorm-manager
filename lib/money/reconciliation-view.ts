/**
 * Pure helpers for the admin reconciliation review page. REPORT ONLY:
 * filtering, counting and labelling findings - nothing here fixes data.
 */
import {
  findingsToCsv,
  FINDING_CSV_COLUMNS,
  type CheckName,
  type ReconciliationFinding,
  type Severity,
} from "@/lib/money/reconciliation-checks";

/** A finding plus the display names the API resolved for it. */
export type ViewFinding = ReconciliationFinding & {
  tenantName?: string | null;
  roomNumber?: string | null;
};

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "สูง",
  medium: "กลาง",
  low: "ต่ำ",
};

export const CHECK_LABELS: Record<CheckName, string> = {
  batch_vs_allocations: "ยอดรับเงิน vs การจัดสรร",
  invoice_paid_vs_allocations: "ยอดชำระบนบิล vs การจัดสรร",
  orphan_allocation: "การจัดสรรไม่มีใบรับเงิน",
  batch_without_allocations: "ใบรับเงินไม่มีการจัดสรร",
  payment_history_mismatch: "ประวัติการชำระไม่ตรง",
  status_vs_balance: "สถานะบิล vs ยอดคงเหลือ",
  carry_forward: "ยอดยกมา",
  missing_money_event: "ไม่มีบันทึกตรวจสอบย้อนหลัง",
  missing_account_snapshot: "ไม่ทราบบัญชีรับเงิน",
};

export const CHECK_ORDER = Object.keys(CHECK_LABELS) as CheckName[];

/** Column labels, shared by the on-screen table and the CSV header. */
export const COLUMN_LABELS: Record<(typeof FINDING_CSV_COLUMNS)[number], string> = {
  id: "รหัสรายการ",
  check: "การตรวจสอบ",
  severity: "ระดับ",
  amount: "จำนวนเงิน (บาท)",
  tenantId: "รหัสผู้เช่า",
  roomId: "รหัสห้อง",
  invoiceId: "รหัสบิล",
  batchId: "รหัสใบรับเงิน",
  explanation: "คำอธิบาย",
  suggestedNextStep: "ขั้นตอนถัดไปที่แนะนำ",
};

export type FindingFilter = {
  severity?: Severity | "all";
  check?: CheckName | "all";
};

export function filterFindings<T extends ReconciliationFinding>(findings: T[], filter: FindingFilter): T[] {
  return findings.filter(
    (f) =>
      (!filter.severity || filter.severity === "all" || f.severity === filter.severity) &&
      (!filter.check || filter.check === "all" || f.check === filter.check)
  );
}

export type FindingSummary = {
  total: number;
  bySeverity: Record<Severity, number>;
  byCheck: Partial<Record<CheckName, number>>;
};

export function summarizeFindings(findings: ReconciliationFinding[]): FindingSummary {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const byCheck: Partial<Record<CheckName, number>> = {};
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  }
  return { total: findings.length, bySeverity, byCheck };
}

/** Most severe first, then largest amount, then id for a stable order. */
export function sortFindings<T extends ReconciliationFinding>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.amount - a.amount ||
      a.id.localeCompare(b.id)
  );
}

/** findingsToCsv with the header row swapped for the on-screen Thai labels. */
export function findingsToLabelledCsv(findings: ReconciliationFinding[]): string {
  const raw = findingsToCsv(findings);
  const headerEnd = raw.indexOf("\r\n");
  const header = FINDING_CSV_COLUMNS.map((c) => COLUMN_LABELS[c]).join(",");
  return headerEnd === -1 ? header : header + raw.slice(headerEnd);
}
