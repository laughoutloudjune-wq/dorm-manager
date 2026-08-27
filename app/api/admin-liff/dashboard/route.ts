import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { requireLineAdminAccess } from "@/lib/line-admin-auth";
import { sumOwnOutstanding } from "@/lib/invoice-ledger";

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
          .select("status,total_amount,paid_amount,carry_forward_amount")
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
    const paidAmount = accountingRows.reduce((sum, row) => sum + row.paid_amount, 0);
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
        paid_amount: paidAmount,
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

