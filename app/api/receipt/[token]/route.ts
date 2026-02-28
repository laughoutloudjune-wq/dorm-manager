import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { renderReceiptPdf } from "@/lib/receipt-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const token = decodeURIComponent(parts[parts.length - 1] ?? "");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("invoices")
      .select(
        "id,public_token,status,issue_date,due_date,total_amount,paid_amount,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,discount_amount,late_fee_amount,payment_history,tenants(full_name,address,custom_receipt_profile),rooms(room_number,buildings(name))"
      )
      .eq("public_token", token)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if ((data as any).status !== "paid") {
      return NextResponse.json(
        { error: "Receipt PDF is available only after payment is verified." },
        { status: 400 }
      );
    }

    const tenant = Array.isArray((data as any).tenants) ? (data as any).tenants[0] : (data as any).tenants;
    const room = Array.isArray((data as any).rooms) ? (data as any).rooms[0] : (data as any).rooms;
    const building =
      Array.isArray(room?.buildings) ? room?.buildings?.[0] : room?.buildings;

    const customReceipt = (tenant as any)?.custom_receipt_profile ?? null;

    const pdfBuffer = await renderReceiptPdf({
      id: String((data as any).id),
      public_token: String((data as any).public_token),
      issue_date: String((data as any).issue_date),
      due_date: String((data as any).due_date),
      total_amount: toNumber((data as any).total_amount),
      paid_amount: toNumber((data as any).paid_amount),
      rent_amount: toNumber((data as any).rent_amount),
      water_bill: toNumber((data as any).water_bill),
      electricity_bill: toNumber((data as any).electricity_bill),
      common_fee: toNumber((data as any).common_fee),
      additional_fees_total: toNumber((data as any).additional_fees_total),
      discount_amount: toNumber((data as any).discount_amount),
      late_fee_amount: toNumber((data as any).late_fee_amount),
      payment_history: Array.isArray((data as any).payment_history) ? (data as any).payment_history : [],
      tenant_name: String(customReceipt?.company_name ?? tenant?.full_name ?? "-"),
      tenant_address: String(customReceipt?.address ?? tenant?.address ?? "-"),
      tenant_tax_id: customReceipt?.tax_id ? String(customReceipt.tax_id) : null,
      tenant_branch: customReceipt?.branch ? String(customReceipt.branch) : null,
      receipt_profile_label: customReceipt?.label ? String(customReceipt.label) : null,
      room_number: String(room?.room_number ?? "-"),
      building_name: String(building?.name ?? "-"),
    });

    const filename = `receipt-${String(room?.room_number ?? "room")}-${String((data as any).issue_date ?? "").slice(
      0,
      7
    )}.pdf`;

    return new Response(pdfBuffer as any, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error" },
      { status: 500 }
    );
  }
}
