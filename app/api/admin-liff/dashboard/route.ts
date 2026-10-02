import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";
import { sumOwnOutstanding } from "@/lib/invoice-ledger";
import {
  BASIS_LABELS,
  fetchReceiptLedger,
  isMissingSchemaError,
  summarizeAllocations,
  type AllocationLike,
} from "@/lib/money/report-definitions";

const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken ?? "");
    const monthText = String(body?.month ?? new Date().toISOString().slice(0, 7));
    const auth = await requireLineAdminAccess(accessToken);
    if ("error" in auth) return auth.error;

    const [yearRaw, monthRaw] = monthText.split("-").map(Number);
    const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
    const month = Number.isFinite(monthRaw) ? monthRaw : new Date().getMonth() + 1;
    const periodStart = toLocalDateString(new Date(year, month - 1, 1));
    const periodEnd = toLocalDateString(new Date(year, month, 0));

    const supabase = createAdminClient();
    const [{ data: invoices, error: invoiceError }, { data: tenants }, { data: rooms }] =
      await Promise.all([
        supabase
          .from("invoices")
          .select("id,status,total_amount,paid_amount,carry_forward_amount")
          .eq("start_date", periodStart)
          .eq("end_date", periodEnd),
        supabase.from("tenants").select("id", { count: "exact" }).eq("status", "active"),
        supabase.from("rooms").select("id,status"),
      ]);

    if (invoiceError) return NextResponse.json({ error: invoiceError.message }, { status: 500 });

    const rows = invoices ?? [];
    const normalizedRows = rows.map((row: any) => ({
      status: String(row.status ?? ""),
      total_amount: Number(row.total_amount ?? 0),
      paid_amount: Number(row.paid_amount ?? 0),
      carry_forward_amount: Number(row.carry_forward_amount ?? 0),
    }));

    const accountingRows = normalizedRows.filter((row) => !["draft", "cancelled"].includes(row.status));
    const totalAmount = accountingRows.reduce((sum, row) => sum + row.total_amount, 0);

    // Money figures come from the receipt ledger, not invoices.paid_amount.
    //  - billing basis: payments applied to THIS period's invoices (net of
    //    voids), whenever they arrived. NOT "cash received this month".
    //  - cash basis: cash that actually arrived during the calendar month
    //    (non-cash credit excluded and shown separately).
    const periodInvoiceIds = rows.map((row: any) => String(row.id)).filter(Boolean);
    let appliedRows: AllocationLike[] = [];
    let appliedVoided: string[] = [];
    if (periodInvoiceIds.length > 0) {
      const run = (columns: string) =>
        supabase.from("invoice_payment_allocations").select(columns).in("invoice_id", periodInvoiceIds);
      let appliedRes = await run("id,payment_batch_id,amount,paid_at,source,reverses_allocation_id");
      if (appliedRes.error && isMissingSchemaError(appliedRes.error)) {
        appliedRes = await run("id,payment_batch_id,amount,paid_at,source");
      }
      if (appliedRes.error) return NextResponse.json({ error: appliedRes.error.message }, { status: 500 });
      appliedRows = (appliedRes.data ?? []) as unknown as AllocationLike[];
      const batchIds = [...new Set(appliedRows.map((r) => String(r.payment_batch_id ?? "")).filter(Boolean))];
      for (let i = 0; i < batchIds.length; i += 200) {
        const voidRes = await supabase
          .from("payment_batches")
          .select("id")
          .in("id", batchIds.slice(i, i + 200))
          .not("voided_at", "is", null);
        if (voidRes.error) {
          if (isMissingSchemaError(voidRes.error)) break;
          return NextResponse.json({ error: voidRes.error.message }, { status: 500 });
        }
        appliedVoided.push(...(voidRes.data ?? []).map((r: any) => String(r.id)));
      }
    }
    const applied = summarizeAllocations(appliedRows, appliedVoided);
    const paidAmount = applied.cashReceived + applied.creditApplied;

    const nextMonthStart = toLocalDateString(new Date(year, month, 1));
    const receivedLedger = await fetchReceiptLedger(supabase, periodStart, nextMonthStart);
    if (receivedLedger.error) return NextResponse.json({ error: receivedLedger.error }, { status: 500 });
    const received = summarizeAllocations(receivedLedger.rows, receivedLedger.voidedBatchIds);
    // Own-outstanding: a bundled invoice total can include an earlier
    // period's carried debt, which would otherwise inflate THIS period's
    // outstanding figure with a charge that really belongs to the period it
    // originated in.
    const outstandingAmount = sumOwnOutstanding(
      accountingRows.filter((row) => ["pending", "partial", "overdue", "verifying"].includes(row.status)),
    );
    const byStatus = rows.reduce<Record<string, number>>((acc, row: any) => {
      const key = String(row.status ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      summary: {
        month: `${year}-${String(month).padStart(2, "0")}`,
        invoice_count: rows.length,
        tenant_active_count: tenants?.length ?? 0,
        room_count: rooms?.length ?? 0,
        room_occupied_count: (rooms ?? []).filter((room: any) => room.status === "occupied").length,
        total_amount: totalAmount,
        // Billing basis: payments applied to this period's invoices.
        paid_amount: paidAmount,
        paid_amount_basis: BASIS_LABELS.billing.th,
        // Cash basis: cash actually received during the calendar month.
        cash_received_amount: received.cashReceived,
        credit_applied_amount: received.creditApplied,
        cash_received_basis: BASIS_LABELS.cash.th,
        outstanding_amount: outstandingAmount,
        by_status: byStatus,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}

