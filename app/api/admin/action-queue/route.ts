import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  bangkokToday,
  buildLateFeeRows,
  isSlipAwaitingReview,
  positiveRefunds,
  positiveUnapplied,
  type QueueInvoice,
  type RefundOutstanding,
  type TenantCreditBalance,
} from "@/lib/money/action-queue";
import { isMissingTable, loadReconciliationFindings } from "@/lib/money/reconciliation-loader";
import { summarizeFindings } from "@/lib/money/reconciliation-view";

/**
 * Admin action queue. READ ONLY: selects only, never posts a fee, records a
 * payment or changes a status.
 */

const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);

export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "action_queue.view");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const today = bangkokToday();

    const [{ data: settingsRow, error: settingsError }, { data: invoiceData, error: invoiceError }] = await Promise.all([
      supabase.from("settings").select("late_fee_start_day,late_fee_per_day").eq("id", 1).maybeSingle(),
      supabase
        .from("invoices")
        .select(
          "id,tenant_id,status,due_date,total_amount,paid_amount,slip_url,slip_uploaded_at,late_fee_start_date,late_fee_per_day,locked_late_fee_amount,tenants(full_name),rooms(room_number)"
        )
        .in("status", ["verifying", "pending", "partial", "overdue"])
        .limit(5000),
    ]);
    if (settingsError) throw new Error(settingsError.message);
    if (invoiceError) throw new Error(invoiceError.message);

    const invoices: QueueInvoice[] = (invoiceData ?? []).map((i: any) => ({
      ...i,
      tenantName: one<any>(i.tenants)?.full_name ?? null,
      roomNumber: one<any>(i.rooms)?.room_number ?? null,
    }));

    const slips = invoices
      .filter(isSlipAwaitingReview)
      .map((i: any) => ({
        invoiceId: i.id,
        tenantName: i.tenantName,
        roomNumber: i.roomNumber,
        amount: Number(i.total_amount ?? 0) - Number(i.paid_amount ?? 0),
        uploadedAt: i.slip_uploaded_at ?? null,
      }))
      .sort((a, b) => String(a.uploadedAt ?? "").localeCompare(String(b.uploadedAt ?? "")));

    const lateFees = buildLateFeeRows(invoices, (settingsRow as any) ?? {}, today);

    // Optional tables: tolerate a missing view/table, show "not enabled" instead.
    const loadOptional = async <T,>(table: string, columns: string): Promise<{ available: boolean; rows: T[] }> => {
      const { data, error } = await supabase.from(table).select(columns).limit(5000);
      if (error) {
        if (isMissingTable(String(error.message ?? ""))) return { available: false, rows: [] };
        throw new Error(error.message);
      }
      return { available: true, rows: (data ?? []) as T[] };
    };
    const [refundRes, creditRes] = await Promise.all([
      loadOptional<RefundOutstanding>("refund_due_vs_paid", "tenant_id,refund_due,refund_paid,refund_outstanding"),
      loadOptional<TenantCreditBalance>("tenant_credit_balances", "tenant_id,unapplied_credit"),
    ]);
    const refunds = positiveRefunds(refundRes.rows);
    const credits = positiveUnapplied(creditRes.rows);

    const tenantIds = Array.from(new Set([...refunds, ...credits].map((r) => r.tenant_id)));
    const tenantById = new Map<string, any>();
    for (let i = 0; i < tenantIds.length; i += 200) {
      const { data, error } = await supabase
        .from("tenants")
        .select("id,full_name,rooms(room_number)")
        .in("id", tenantIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const t of data ?? []) tenantById.set((t as any).id, t);
    }
    const named = <T extends { tenant_id: string }>(rows: T[]) =>
      rows.map((r) => {
        const t = tenantById.get(r.tenant_id);
        return { ...r, tenantName: t?.full_name ?? null, roomNumber: one<any>(t?.rooms)?.room_number ?? null };
      });

    const findings = await loadReconciliationFindings(supabase);
    const summary = summarizeFindings(findings);

    return NextResponse.json({
      today,
      slips,
      lateFees,
      refunds: { available: refundRes.available, rows: named(refunds) },
      credits: { available: creditRes.available, rows: named(credits) },
      reconciliation: { total: summary.total, bySeverity: summary.bySeverity },
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Action queue failed." }, { status: 500 });
  }
}
