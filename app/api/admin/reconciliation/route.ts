import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  runReconciliation,
  type AllocationRow,
  type BatchRow,
  type CarryForwardRow,
  type InvoiceRow,
  type MoneyEventRow,
} from "@/lib/money/reconciliation-checks";
import { sortFindings, summarizeFindings, type ViewFinding } from "@/lib/money/reconciliation-view";

/**
 * Money reconciliation report. READ ONLY: this route only runs selects and
 * never writes, repairs or voids anything. It reports; a person decides.
 */

const PAGE = 1000;

// PostgREST caps a response at 1000 rows, so page until a short page comes back.
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: any; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message ?? "Query failed");
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const isMissingTable = (message: string) =>
  /does not exist|could not find the table|schema cache|relation .* not found/i.test(message);

export async function GET(req: Request) {
  const auth = await requireAdminPermission(req, "reconciliation.view");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const [invoiceRows, batches, allocations, carryForwards] = await Promise.all([
      fetchAll<any>((from, to) =>
        supabase
          .from("invoices")
          .select(
            "id,tenant_id,room_id,status,total_amount,paid_amount,locked_late_fee_amount,payment_history,tenants(full_name),rooms(room_number)"
          )
          .order("id")
          .range(from, to)
      ),
      fetchAll<BatchRow>((from, to) =>
        supabase
          .from("payment_batches")
          .select("id,tenant_id,amount_received,amount_allocated,paid_at,voided_at,payment_method_snapshot")
          .order("id")
          .range(from, to)
      ),
      fetchAll<AllocationRow>((from, to) =>
        supabase
          .from("invoice_payment_allocations")
          .select("id,payment_batch_id,invoice_id,amount,paid_at,reverses_allocation_id,payment_method_snapshot")
          .order("id")
          .range(from, to)
      ),
      fetchAll<CarryForwardRow>((from, to) =>
        supabase
          .from("invoice_carry_forwards")
          .select("id,source_invoice_id,target_invoice_id,amount")
          .order("id")
          .range(from, to)
      ),
    ]);

    // The audit-trail check cannot be judged without the log. If the table is
    // absent we SKIP that check (undefined) rather than pass an empty list,
    // which would flag every paid invoice as lacking an audit trail.
    let moneyEvents: MoneyEventRow[] | undefined;
    try {
      moneyEvents = await fetchAll<MoneyEventRow>((from, to) =>
        supabase.from("money_events").select("id,invoice_id,payment_batch_id").order("id").range(from, to)
      );
    } catch (err: any) {
      if (!isMissingTable(String(err?.message ?? ""))) throw err;
      moneyEvents = undefined;
    }

    const invoices: InvoiceRow[] = invoiceRows.map(({ tenants: _t, rooms: _r, ...inv }: any) => inv);
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
