import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  aggregateCredits,
  balancesFromView,
  payoutsFromRows,
  refundRowsFromView,
  summarizeTotals,
  type CreditBalance,
} from "@/lib/money/credits-refunds-view";
import { isMissingTable } from "@/lib/money/reconciliation-loader";

/**
 * Credits and refunds report. READ ONLY: selects only, never writes a credit,
 * payout or adjustment. Each source is optional; a missing table or view is
 * reported as "not available" rather than failing the page.
 */

const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);

export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "credits.view");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const load = async (table: string, columns: string, order?: { column: string }) => {
      let q = supabase.from(table).select(columns);
      if (order) q = q.order(order.column, { ascending: false });
      const { data, error } = await q.limit(5000);
      if (error) {
        if (isMissingTable(String(error.message ?? ""))) return { available: false, rows: [] as any[] };
        throw new Error(error.message);
      }
      return { available: true, rows: (data ?? []) as any[] };
    };

    const [viewRes, refundRes, payoutRes] = await Promise.all([
      load("tenant_credit_balances", "tenant_id,deposit_held,advance_held,unapplied_credit"),
      load("refund_due_vs_paid", "tenant_id,refund_due,refund_paid,refund_outstanding"),
      load(
        "refund_payouts",
        "id,tenant_id,amount,paid_at,method,recipient,reference,voided_at,void_reason",
        { column: "paid_at" },
      ),
    ]);

    let balances: CreditBalance[] = [];
    let creditsAvailable = viewRes.available;
    if (viewRes.available) {
      balances = balancesFromView(viewRes.rows);
    } else {
      // Fallback: aggregate the ledger rows directly.
      const ledger = await load("tenant_credits", "tenant_id,bucket,amount");
      creditsAvailable = ledger.available;
      balances = aggregateCredits(ledger.rows);
    }

    const refunds = refundRowsFromView(refundRes.rows);
    const payouts = payoutsFromRows(payoutRes.rows);

    const tenantIds = Array.from(
      new Set([...balances.map((b) => b.tenantId), ...refunds.map((r) => r.tenantId), ...payouts.map((p) => p.tenantId)]),
    );
    const tenantById = new Map<string, any>();
    for (let i = 0; i < tenantIds.length; i += 200) {
      const { data, error } = await supabase
        .from("tenants")
        .select("id,full_name,rooms(room_number)")
        .in("id", tenantIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const t of data ?? []) tenantById.set((t as any).id, t);
    }
    const named = <T extends { tenantId: string }>(rows: T[]) =>
      rows.map((r) => {
        const t = tenantById.get(r.tenantId);
        return { ...r, tenantName: t?.full_name ?? null, roomNumber: one<any>(t?.rooms)?.room_number ?? null };
      });

    const byName = <T extends { tenantName: string | null }>(rows: T[]) =>
      [...rows].sort((a, b) => String(a.tenantName ?? "").localeCompare(String(b.tenantName ?? ""), "th"));

    return NextResponse.json({
      creditsAvailable,
      creditsFromView: viewRes.available,
      refundsAvailable: refundRes.available,
      payoutsAvailable: payoutRes.available,
      balances: byName(named(balances)),
      // Largest amount still owed first.
      refunds: named(refunds).sort((a, b) => b.outstanding - a.outstanding),
      payouts: named(payouts),
      totals: summarizeTotals(balances, refunds),
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Credits report failed." }, { status: 500 });
  }
}
