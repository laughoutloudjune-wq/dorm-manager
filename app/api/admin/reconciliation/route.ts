import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { runReconciliation } from "@/lib/money/reconciliation-checks";
import { loadReconciliationData } from "@/lib/money/reconciliation-loader";
import { sortFindings, summarizeFindings, type ViewFinding } from "@/lib/money/reconciliation-view";

/**
 * Money reconciliation report. READ ONLY: this route only runs selects and
 * never writes, repairs or voids anything. It reports; a person decides.
 */

export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "reconciliation.view");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const { invoiceRows, invoices, batches, allocations, carryForwards, moneyEvents } =
      await loadReconciliationData(supabase);
    const raw = runReconciliation({ invoices, batches, allocations, carryForwards, moneyEvents });

    // Resolve display names. Batches carry no room, so fall back to the
    // tenant's own current room, then to the invoice's.
    const invoiceById = new Map<string, any>(invoiceRows.map((i: any) => [i.id, i]));
    const tenantIds = Array.from(new Set(raw.map((f) => f.tenantId).filter(Boolean) as string[]));
    const tenantById = new Map<string, any>();
    for (let i = 0; i < tenantIds.length; i += 200) {
      const { data, error } = await supabase
        .from("tenants")
        .select("id,full_name,rooms(room_number)")
        .in("id", tenantIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const t of data ?? []) tenantById.set((t as any).id, t);
    }
    const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);

    const findings: ViewFinding[] = sortFindings(
      raw.map((f) => {
        const inv = f.invoiceId ? invoiceById.get(f.invoiceId) : undefined;
        const tenant = f.tenantId ? tenantById.get(f.tenantId) : undefined;
        return {
          ...f,
          tenantName: one<any>(tenant)?.full_name ?? one<any>(inv?.tenants)?.full_name ?? null,
          roomNumber: one<any>(inv?.rooms)?.room_number ?? one<any>(one<any>(tenant)?.rooms)?.room_number ?? null,
        };
      })
    );

    return NextResponse.json({
      findings,
      summary: summarizeFindings(findings),
      moneyEventsAvailable: moneyEvents !== undefined,
      counts: {
        invoices: invoices.length,
        batches: batches.length,
        allocations: allocations.length,
        carryForwards: carryForwards.length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Reconciliation failed." }, { status: 500 });
  }
}
