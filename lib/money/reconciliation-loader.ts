/**
 * Read-only loader for the reconciliation checks. Single source of the paging
 * and selects, shared by app/api/admin/reconciliation/route.ts (which needs the
 * raw rows to resolve names) and the action queue (which only needs findings).
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

export type ReconciliationData = {
  /** Invoice rows exactly as selected, including the tenants/rooms name joins. */
  invoiceRows: any[];
  invoices: InvoiceRow[];
  batches: BatchRow[];
  allocations: AllocationRow[];
  carryForwards: CarryForwardRow[];
  /** undefined when money_events does not exist: the audit-trail check is skipped. */
  moneyEvents: MoneyEventRow[] | undefined;
};

export async function loadReconciliationData(supabase: any): Promise<ReconciliationData> {
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

  const invoices: InvoiceRow[] = invoiceRows.map(({ tenants: _t, rooms: _r, ...inv }: any) => inv);
  return { invoiceRows, invoices, batches, allocations, carryForwards, moneyEvents };
}

export async function loadReconciliationFindings(supabase: any): Promise<ReconciliationFinding[]> {
  const { invoices, batches, allocations, carryForwards, moneyEvents } = await loadReconciliationData(supabase);
  return runReconciliation({ invoices, batches, allocations, carryForwards, moneyEvents });
}
