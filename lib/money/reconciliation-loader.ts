/**
 * Read-only loader that runs the reconciliation checks and returns the raw
 * findings. Mirrors the loading in app/api/admin/reconciliation/route.ts (which
 * is deliberately left untouched); used by the action queue for severity counts.
 */
import {
  runReconciliation,
  type AllocationRow,
  type BatchRow,
  type CarryForwardRow,
  type InvoiceRow,
  type MoneyEventRow,
  type ReconciliationFinding,
} from "@/lib/money/reconciliation-checks";

const PAGE = 1000;

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

export const isMissingTable = (message: string) =>
  /does not exist|could not find the table|schema cache|relation .* not found/i.test(message);

export async function loadReconciliationFindings(supabase: any): Promise<ReconciliationFinding[]> {
  const [invoices, batches, allocations, carryForwards] = await Promise.all([
    fetchAll<InvoiceRow>((from, to) =>
      supabase
        .from("invoices")
        .select("id,tenant_id,room_id,status,total_amount,paid_amount,locked_late_fee_amount,payment_history")
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
      supabase.from("invoice_carry_forwards").select("id,source_invoice_id,target_invoice_id,amount").order("id").range(from, to)
    ),
  ]);

  // Absent log => skip the audit-trail check (undefined), never pass [].
  let moneyEvents: MoneyEventRow[] | undefined;
  try {
    moneyEvents = await fetchAll<MoneyEventRow>((from, to) =>
      supabase.from("money_events").select("id,invoice_id,payment_batch_id").order("id").range(from, to)
    );
  } catch (err: any) {
    if (!isMissingTable(String(err?.message ?? ""))) throw err;
    moneyEvents = undefined;
  }

  return runReconciliation({ invoices, batches, allocations, carryForwards, moneyEvents });
}
