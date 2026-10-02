import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Read-only data for the invoice Payments tab. Unlike get_payment_chains it
 * also returns reversal rows, void metadata, and every allocation on each
 * touched invoice so remaining balances can be derived. Never writes.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "get_invoice_ledger");
  if (action !== "get_invoice_ledger") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  const invoiceId = String(body?.invoiceId ?? "");
  if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
  const supabase = auth.supabase;

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .select("id,total_amount,paid_amount")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
  if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

  const { data: mine, error: mineErr } = await supabase
    .from("invoice_payment_allocations")
    .select("payment_batch_id")
    .eq("invoice_id", invoiceId);
  if (mineErr) return NextResponse.json({ error: mineErr.message }, { status: 500 });
  const batchIds = [...new Set((mine ?? []).map((r: any) => String(r.payment_batch_id ?? "")).filter(Boolean))];
  if (batchIds.length === 0) {
    return NextResponse.json({ invoice, allocations: [], batches: [], invoiceTotals: {} });
  }

  const [batchAllocs, batches] = await Promise.all([
    supabase
      .from("invoice_payment_allocations")
      .select(
        "id,payment_batch_id,invoice_id,amount,created_at,paid_at,slip_url,source,reverses_allocation_id,reversal_reason,payment_method_snapshot," +
          "invoice:invoices!invoice_payment_allocations_invoice_id_fkey(id,start_date,total_amount,rooms(room_number))",
      )
      .in("payment_batch_id", batchIds),
    supabase
      .from("payment_batches")
      .select("id,amount_received,paid_at,slip_url,source,trigger_invoice_id,payment_method_snapshot,voided_at,void_reason")
      .in("id", batchIds),
  ]);
  if (batchAllocs.error) return NextResponse.json({ error: batchAllocs.error.message }, { status: 500 });
  if (batches.error) return NextResponse.json({ error: batches.error.message }, { status: 500 });

  const rows = (batchAllocs.data ?? []) as any[];
  const invoiceTotals: Record<string, number> = {};
  const touched = new Set<string>();
  for (const r of rows) {
    const inv = Array.isArray(r.invoice) ? r.invoice[0] : r.invoice;
    touched.add(String(r.invoice_id));
    if (inv?.total_amount != null) invoiceTotals[String(r.invoice_id)] = Number(inv.total_amount);
  }

  // Remaining balance needs EVERY allocation on each touched invoice, not just
  // the ones from these batches. Those extra rows are marked context_only.
  const { data: others, error: othersErr } = await supabase
    .from("invoice_payment_allocations")
    .select(
      "id,payment_batch_id,invoice_id,amount,created_at,paid_at,slip_url,source,reverses_allocation_id,reversal_reason,payment_method_snapshot",
    )
    .in("invoice_id", [...touched]);
  if (othersErr) return NextResponse.json({ error: othersErr.message }, { status: 500 });

  const known = new Set(rows.map((r) => String(r.id)));
  const allocations = [
    ...rows.map((r) => {
      const inv = Array.isArray(r.invoice) ? r.invoice[0] : r.invoice;
      const room = Array.isArray(inv?.rooms) ? inv.rooms[0] : inv?.rooms;
      const { invoice: _drop, ...rest } = r;
      return { ...rest, start_date: inv?.start_date ?? null, room_number: room?.room_number ?? null };
    }),
    ...(others ?? [])
      .filter((r: any) => !known.has(String(r.id)))
      .map((r: any) => ({ ...r, context_only: true })),
  ];

  return NextResponse.json({ invoice, allocations, batches: batches.data ?? [], invoiceTotals });
}
