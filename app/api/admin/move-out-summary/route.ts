import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";

/**
 * Data for the printable move-out settlement summary. READ ONLY — selects only.
 *
 * Everything money-related comes from the frozen `move_out_settlements.settlement`
 * plan (what was actually settled), the final invoice it created, and live refund
 * payouts. Nothing is recalculated here, so the printout always matches the books.
 * Optional sources that cannot be read (older schema) are named in `unavailable`.
 */
export async function POST(req: Request) {
  const auth = await requireAdminPermission(req, "tenant.view");
  if ("error" in auth) return auth.error;
  const body = await req.json().catch(() => ({}));
  const tenantId = String(body?.tenantId ?? "");
  if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
  const supabase = auth.supabase;

  const unavailable: string[] = [];

  // move_out_kind / move_out_note only exist once the lifecycle migration is applied.
  let settlementRow: any = null;
  const full = await supabase
    .from("move_out_settlements")
    .select("id,tenant_id,room_id,settlement,final_invoice_id,created_at,created_by,move_out_kind,move_out_note")
    .eq("tenant_id", tenantId)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (full.error) {
    unavailable.push("move_out_kind");
    const basic = await supabase
      .from("move_out_settlements")
      .select("id,tenant_id,room_id,settlement,final_invoice_id,created_at,created_by")
      .eq("tenant_id", tenantId)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (basic.error) return NextResponse.json({ error: basic.error.message }, { status: 500 });
    settlementRow = basic.data;
  } else {
    settlementRow = full.data;
  }
  if (!settlementRow) {
    return NextResponse.json(
      { error: "ผู้เช่ารายนี้ยังไม่มีการสรุปยอดย้ายออก (หรือถูกยกเลิกแล้ว)" },
      { status: 404 }
    );
  }

  const roomId = settlementRow.room_id ? String(settlementRow.room_id) : null;
  const [tenantRes, roomRes, invoiceRes, payoutsRes, settingsRes] = await Promise.all([
    supabase
      .from("tenants")
      .select("id,full_name,phone_number,address,move_in_date,move_out_date")
      .eq("id", tenantId)
      .maybeSingle(),
    roomId
      ? supabase.from("rooms").select("room_number,buildings(name)").eq("id", roomId).maybeSingle()
      : Promise.resolve({ data: null, error: null } as any),
    settlementRow.final_invoice_id
      ? supabase
          .from("invoices")
          .select(
            "id,start_date,end_date,issue_date,due_date,status,total_amount,paid_amount,rent_amount,water_bill,electricity_bill,common_fee,additional_fees_total,additional_fees_breakdown,discount_amount,discount_breakdown,late_fee_amount,carry_forward_amount,electricity_reading_start,electricity_reading_end,water_reading_start,water_reading_end,notes"
          )
          .eq("id", String(settlementRow.final_invoice_id))
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as any),
    supabase
      .from("refund_payouts")
      .select("id,amount,paid_at,method,recipient,reference,voided_at")
      .eq("tenant_id", tenantId)
      .is("voided_at", null)
      .order("paid_at", { ascending: true }),
    supabase.from("settings").select("dorm_name,dorm_address,dorm_phone,water_rate,electricity_rate").eq("id", 1).maybeSingle(),
  ]);

  if (tenantRes.error) return NextResponse.json({ error: tenantRes.error.message }, { status: 500 });
  if (invoiceRes.error) unavailable.push("final_invoice");
  if (payoutsRes.error) unavailable.push("payouts");

  const room: any = Array.isArray((roomRes as any).data) ? (roomRes as any).data[0] : (roomRes as any).data;
  const building = Array.isArray(room?.buildings) ? room.buildings[0] : room?.buildings;

  // Unpaid bills settled from held money: name the invoice period for each.
  const plan = (settlementRow.settlement ?? {}) as any;
  const debtIds: string[] = Array.isArray(plan.debtPayments)
    ? plan.debtPayments.map((d: any) => String(d.invoiceId)).filter(Boolean)
    : [];
  let debtInvoices: any[] = [];
  if (debtIds.length) {
    const { data } = await supabase
      .from("invoices")
      .select("id,start_date,issue_date,status")
      .in("id", debtIds);
    debtInvoices = (data as any[]) ?? [];
  }

  return NextResponse.json({
    tenant: tenantRes.data ?? null,
    roomNumber: room?.room_number ?? null,
    buildingName: building?.name ?? null,
    settlement: {
      id: settlementRow.id,
      createdAt: settlementRow.created_at,
      moveOutKind: settlementRow.move_out_kind ?? null,
      moveOutNote: settlementRow.move_out_note ?? null,
    },
    plan,
    finalInvoice: invoiceRes.data ?? null,
    debtInvoices,
    payouts: payoutsRes.error ? [] : payoutsRes.data ?? [],
    dorm: settingsRes.data ?? null,
    unavailable,
    generatedAt: new Date().toISOString(),
  });
}
