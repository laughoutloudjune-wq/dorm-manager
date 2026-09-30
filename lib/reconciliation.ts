import type { SupabaseClient } from "@supabase/supabase-js";

export type ReconciliationFinding = {
  id: string;
  severity: "high" | "medium";
  text: string;
  amount?: number;
};

/**
 * Read-only data-quality checks mirroring section 6 ("Data found during
 * this audit") of docs/audit/2026-09-29-system-audit-detailed.md. This is
 * the Phase 3 "nightly reconciliation" item — deliberately report-only.
 *
 * Never writes anything, and never should: this codebase already had one
 * real incident from unattended money automation (see CLAUDE.md's "Before
 * this, picking 'paid' from the status dropdown..." note, ฿150,000+ of
 * fake receipts). A nightly job that "fixes" what it finds here would be
 * exactly that failure mode again, just automated instead of manual — it
 * surfaces drift for a human to review, same as the audit itself did by
 * hand. See [[forward-fix-not-retroactive]] / [[explain-before-fixing]].
 */
export async function runReconciliationChecks(
  supabase: SupabaseClient
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];

  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id,status,total_amount,paid_amount,locked_late_fee_amount,late_fee_billed_at,created_at,rooms(room_number),tenants(full_name,status)"
    )
    .neq("status", "cancelled");

  if (error) {
    findings.push({
      id: "reconciliation-query-error",
      severity: "high",
      text: `ตรวจสอบข้อมูลไม่สำเร็จ: ${error.message}`,
    });
    return findings;
  }

  for (const row of (data ?? []) as any[]) {
    const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    const roomNo = room?.room_number ?? "-";
    const total = Number(row.total_amount ?? 0);
    const paid = Number(row.paid_amount ?? 0);

    // H3 pattern: status says "paid" but the money doesn't back it up. A
    // half-baht rounding tolerance avoids flagging float noise.
    if (row.status === "paid" && paid < total - 0.5) {
      findings.push({
        id: `status-money-mismatch-${row.id}`,
        severity: "high",
        text: `ห้อง ${roomNo}: สถานะ "ชำระแล้ว" แต่รับเงินจริง ${paid.toLocaleString("th-TH")} จากยอด ${total.toLocaleString("th-TH")}`,
        amount: total - paid,
      });
    }

    // H8 pattern: a draft that somehow already holds money.
    if (row.status === "draft" && paid > 0) {
      findings.push({
        id: `draft-holds-money-${row.id}`,
        severity: "high",
        text: `ห้อง ${roomNo}: บิลยังเป็นฉบับร่างแต่มีเงินเข้าแล้ว ${paid.toLocaleString("th-TH")}`,
        amount: paid,
      });
    }

    // M17 pattern: an old draft nobody sent to the tenant.
    if (row.status === "draft" && row.created_at) {
      const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86400000;
      if (ageDays > 14) {
        findings.push({
          id: `stale-draft-${row.id}`,
          severity: "medium",
          text: `ห้อง ${roomNo}: บิลฉบับร่างค้างมา ${Math.floor(ageDays)} วันโดยยังไม่ส่ง`,
        });
      }
    }

    // H5 pattern: a negative total means money is owed BACK to the tenant.
    // The current final_move_out flow has no refund-payout record at all —
    // this just flags that one exists to check, it does not know whether
    // the refund actually went out.
    if (total < 0) {
      findings.push({
        id: `negative-total-${row.id}`,
        severity: "high",
        text: `ห้อง ${roomNo}: ยอดบิลติดลบ ${total.toLocaleString("th-TH")} (มีเงินต้องคืนผู้เช่า) — ตรวจสอบว่าคืนเงินแล้วหรือยัง`,
        amount: Math.abs(total),
      });
    }

    // H11 pattern: a late fee was frozen but never billed onto a later
    // invoice (late_fee_billed_at still null), and the tenant it belongs to
    // has already moved out — there is no "next invoice" left for it to
    // land on, so without this flag it just quietly never gets charged.
    if (
      Number(row.locked_late_fee_amount ?? 0) > 0 &&
      !row.late_fee_billed_at &&
      tenant?.status === "inactive"
    ) {
      findings.push({
        id: `unbilled-late-fee-${row.id}`,
        severity: "medium",
        text: `ห้อง ${roomNo}: ค่าปรับล่าช้าค้างบิล ${Number(row.locked_late_fee_amount).toLocaleString("th-TH")} — ผู้เช่าย้ายออกไปแล้ว อาจไม่ถูกเรียกเก็บ`,
        amount: Number(row.locked_late_fee_amount),
      });
    }
  }

  return findings;
}
