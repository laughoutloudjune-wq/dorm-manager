import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import { bangkokDayStartIso } from "@/lib/money/bangkok-date";
import { isMissingSchemaError } from "@/lib/money/report-definitions";

// The FK hint is required: invoice_payment_allocations has TWO foreign keys
// to invoices (invoice_id and trigger_invoice_id), so an unqualified
// `invoices(...)` embed is ambiguous and PostgREST rejects it. Aliased to
// `invoice` so the filter path below reads unambiguously too. Money columns
// on the embedded invoice are pulled in so each allocation can be prorated
// into rent/utilities/late-fee shares via chargesFromInvoiceRow (client-side,
// unchanged) — payments aren't itemized by line item in the ledger.
const ALLOCATION_BASE_COLUMNS =
  "id,payment_batch_id,invoice_id,amount,paid_at,source,payment_method_id,payment_method_snapshot,";
const ALLOCATION_INVOICE_EMBED =
  "invoice:invoices!invoice_payment_allocations_invoice_id_fkey!inner(" +
  "id,start_date,due_date,tenant_id,room_id,rent_amount,water_bill,electricity_bill,common_fee," +
  "late_fee_amount,additional_fees_total,additional_fees_breakdown,carry_forward_amount,discount_amount," +
  "tenants(full_name),rooms(room_number,buildings(name)))";
// reverses_allocation_id exists only after the void-payment migration; a DB
// without it falls back to the legacy select (no reversal rows exist there).
const ALLOCATION_SELECT = ALLOCATION_BASE_COLUMNS + "reverses_allocation_id," + ALLOCATION_INVOICE_EMBED;
const ALLOCATION_SELECT_LEGACY = ALLOCATION_BASE_COLUMNS + ALLOCATION_INVOICE_EMBED;

// Runs the allocation select with reverses_allocation_id, retrying without it
// when that column does not exist yet.
async function fetchAllocations(supabase: any, filter: (query: any) => any) {
  const run = (columns: string) =>
    filter(supabase.from("invoice_payment_allocations").select(columns)).order("paid_at", { ascending: false });
  const first = await run(ALLOCATION_SELECT);
  if (first.error && isMissingSchemaError(first.error)) return run(ALLOCATION_SELECT_LEGACY);
  return first;
}

/**
 * Powers ReportsPageView.tsx, which used to run 9 parallel direct-anon-key
 * reads from the browser (finding C1). Every query and every filter is
 * copied verbatim; the page's own client-side transforms
 * (filtering/mapping into display shape) are unchanged — only the raw
 * fetch moved. Gated on "tenant.view" alone rather than replicating the
 * page's `tenant.view || room.view || invoice.create` OR-check exactly:
 * all four default roles already have tenant.view, so this only differs
 * from the client check under a hand-customized permission matrix.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;
  const supabase = auth.supabase;

  try {
    const body = await req.json();
    const year = Number(body?.year);
    if (!year) {
      return NextResponse.json({ error: "Missing year." }, { status: 400 });
    }
    const start = `${year}-01-01`;
    const end = `${year + 1}-01-01`;

    const [settingsRes, invoicesRes, tenantsRes, metersRes, logsRes, transfersRes, settlementInvoicesRes, allocationsByPaidAtRes, allocationsByPeriodRes] =
      await Promise.all([
        supabase.from("settings").select("water_rate,electricity_rate").eq("id", 1).maybeSingle(),
        supabase
          .from("invoices")
          .select(
            "id,tenant_id,room_id,status,total_amount,paid_amount,carry_forward_amount,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,additional_fees_total,additional_fees_breakdown,payment_history,tenants(full_name,custom_payment_method),rooms(room_number,buildings(name))"
          )
          .gte("start_date", start)
          .lt("start_date", end)
          .order("start_date", { ascending: true }),
        supabase
          .from("tenants")
          .select("id,room_id,full_name,move_in_date,move_out_date,advance_rent_amount,security_deposit_amount,rooms(room_number,buildings(name))")
          .order("move_in_date", { ascending: false }),
        supabase
          .from("meter_readings")
          .select("room_id,reading_month,electricity_usage,water_usage,rooms(room_number,buildings(name))")
          .gte("reading_month", start)
          .lt("reading_month", end)
          .order("reading_month", { ascending: true }),
        supabase
          .from("room_tenant_logs")
          .select("id,room_id,tenant_id,tenant_name,move_in_date,move_out_date,rooms(room_number,buildings(name))")
          .order("move_in_date", { ascending: false }),
        supabase
          .from("tenant_room_transfers")
          .select("id,tenant_id,from_room_id,to_room_id,transfer_date,old_electric_usage,old_water_usage,old_rent_amount,new_rent_amount")
          .gte("transfer_date", start)
          .lt("transfer_date", end)
          .order("transfer_date", { ascending: false }),
        supabase
          .from("invoices")
          .select("id,tenant_id,room_id,total_amount,discount_amount,notes,issue_date,rooms(room_number,buildings(name))")
          .ilike("notes", "ย้ายออก%")
          .order("issue_date", { ascending: false }),
        fetchAllocations(supabase, (q) => q.gte("paid_at", bangkokDayStartIso(start)).lt("paid_at", bangkokDayStartIso(end))),
        fetchAllocations(supabase, (q) => q.gte("invoice.start_date", start).lt("invoice.start_date", end)),
      ]);

    const firstError =
      settingsRes.error ||
      invoicesRes.error ||
      tenantsRes.error ||
      metersRes.error ||
      logsRes.error ||
      transfersRes.error ||
      settlementInvoicesRes.error ||
      allocationsByPaidAtRes.error ||
      allocationsByPeriodRes.error;
    if (firstError) {
      return NextResponse.json({ error: firstError.message }, { status: 500 });
    }

    // A handful of legacy allocation rows never got their own
    // payment_method_snapshot even though the payment_batches row they
    // belong to has one (it was attached after the fact via the invoice's
    // Payments tab, which only updated the batch in some older runs). Fall
    // back to the batch's snapshot here, matching what the invoice detail
    // modal already does — this used to run as a follow-up browser query in
    // ReportsPageView.tsx (finding C1).
    const allAllocations = [...(allocationsByPaidAtRes.data ?? []), ...(allocationsByPeriodRes.data ?? [])];
    const batchIdsNeedingFallback = [
      ...new Set(
        allAllocations
          .filter((row: any) => !row.payment_method_snapshot && row.payment_batch_id)
          .map((row: any) => String(row.payment_batch_id)),
      ),
    ];
    let batchSnapshotById = new Map<string, any>();
    if (batchIdsNeedingFallback.length > 0) {
      const { data: batchRows, error: batchError } = await supabase
        .from("payment_batches")
        .select("id,payment_method_snapshot")
        .in("id", batchIdsNeedingFallback);
      if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 });
      batchSnapshotById = new Map((batchRows ?? []).map((row: any) => [String(row.id), row.payment_method_snapshot]));
    }

    // Voided receipts: the allocation rows stay (with negative reversal rows),
    // but a voided batch is no longer money received. Tolerates a DB without
    // voided_at (migration not applied) by treating nothing as voided.
    const allBatchIds = [...new Set(allAllocations.map((row: any) => String(row.payment_batch_id ?? "")).filter(Boolean))];
    const voidedBatchIds: string[] = [];
    for (let i = 0; i < allBatchIds.length; i += 200) {
      const { data: voidRows, error: voidError } = await supabase
        .from("payment_batches")
        .select("id,voided_at")
        .in("id", allBatchIds.slice(i, i + 200))
        .not("voided_at", "is", null);
      if (voidError) {
        if (isMissingSchemaError(voidError)) break;
        return NextResponse.json({ error: voidError.message }, { status: 500 });
      }
      for (const row of voidRows ?? []) voidedBatchIds.push(String((row as any).id));
    }

    // Refunds actually paid out and admin adjustments (waived / written off),
    // by event date within the year. Optional: a missing table is just empty.
    const optional = async (run: () => PromiseLike<{ data: any[] | null; error: any }>) => {
      const res = await run();
      if (res.error) {
        if (isMissingSchemaError(res.error)) return [] as any[];
        throw new Error(res.error.message);
      }
      return res.data ?? [];
    };
    const refundPayouts = await optional(() =>
      supabase.from("refund_payouts").select("id,tenant_id,amount,paid_at,voided_at").gte("paid_at", bangkokDayStartIso(start)).lt("paid_at", bangkokDayStartIso(end)),
    );
    const adjustments = await optional(() =>
      supabase
        .from("adjustments")
        .select("id,type,amount,invoice_id,tenant_id,reverses_adjustment_id,created_at")
        .gte("created_at", start)
        .lt("created_at", end),
    );
    const withSnapshotFallback = (rows: any[]) =>
      rows.map((row: any) =>
        row.payment_method_snapshot
          ? row
          : { ...row, payment_method_snapshot: batchSnapshotById.get(String(row.payment_batch_id ?? "")) ?? null }
      );

    return NextResponse.json({
      settings: settingsRes.data,
      invoices: invoicesRes.data ?? [],
      tenants: tenantsRes.data ?? [],
      meters: metersRes.data ?? [],
      logs: logsRes.data ?? [],
      transfers: transfersRes.data ?? [],
      settlementInvoices: settlementInvoicesRes.data ?? [],
      allocationsByPaidAt: withSnapshotFallback(allocationsByPaidAtRes.data ?? []),
      allocationsByPeriod: withSnapshotFallback(allocationsByPeriodRes.data ?? []),
      voidedBatchIds,
      refundPayouts,
      adjustments,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
  }
}
