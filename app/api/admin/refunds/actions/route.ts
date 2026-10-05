import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import type { PermissionKey } from "@/lib/permissions";
import { buildRefundPayoutPayload, explainRefundError, tenantRefundForSettlement } from "@/lib/money/refund-actions";

/**
 * Refund payouts and move-out settlement correction (migration 20261002000650).
 *
 *   list_settlements       credits.view      read-only: settlements with tenant, room, refund due/paid, live payouts
 *   record_refund_payout   refund.record     record_refund_payout    (money actually sent to a tenant)
 *   void_refund_payout     refund.record     void_refund_payout      (reason required)
 *   void_settlement        settlement.void   void_move_out_settlement (reason required)
 *
 * Every write is ONE SQL function call: atomic, idempotent where it records money, audited in money_events.
 * The server never trusts the client for amounts owed; the database caps a payout at the refund still due.
 */

const PERMISSION_BY_ACTION: Record<string, PermissionKey> = {
  list_settlements: "credits.view",
  record_refund_payout: "refund.record",
  void_refund_payout: "refund.record",
  void_settlement: "settlement.void",
};

const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    const permission = PERMISSION_BY_ACTION[action];
    if (!permission) return NextResponse.json({ error: "Unknown action." }, { status: 400 });

    const auth = await requireAdminPermission(req, permission);
    if ("error" in auth) return auth.error;
    const supabase = auth.supabase;
    const actor = String(auth.user.id);

    if (action === "list_settlements") {
      const { data, error } = await supabase
        .from("move_out_settlements")
        .select("id,tenant_id,room_id,final_invoice_id,created_at,created_by,voided_at,voided_by,void_reason,settlement,tenants(full_name),rooms(room_number)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      const tenantIds = [...new Set((data ?? []).map((r: any) => String(r.tenant_id)))];
      const due = new Map<string, { due: number; paid: number }>();
      const livePayouts = new Map<string, number>();
      if (tenantIds.length > 0) {
        const [{ data: dueRows }, { data: payoutRows }] = await Promise.all([
          supabase.from("refund_due_vs_paid").select("tenant_id,refund_due,refund_paid").in("tenant_id", tenantIds),
          supabase.from("refund_payouts").select("id,tenant_id").is("voided_at", null).in("tenant_id", tenantIds),
        ]);
        for (const r of (dueRows ?? []) as any[]) due.set(String(r.tenant_id), { due: Number(r.refund_due ?? 0), paid: Number(r.refund_paid ?? 0) });
        for (const r of (payoutRows ?? []) as any[]) livePayouts.set(String(r.tenant_id), (livePayouts.get(String(r.tenant_id)) ?? 0) + 1);
      }
      return NextResponse.json({
        settlements: (data ?? []).map((r: any) => ({
          id: r.id,
          tenantId: r.tenant_id,
          tenantName: one<any>(r.tenants)?.full_name ?? null,
          roomNumber: one<any>(r.rooms)?.room_number ?? null,
          finalInvoiceId: r.final_invoice_id,
          createdAt: r.created_at,
          voidedAt: r.voided_at,
          voidReason: r.void_reason,
          // Tenant-level figures (refund_due_vs_paid is per tenant). Only the live settlement carries them; voided rows get null.
          tenantRefund: tenantRefundForSettlement(r, {
            due: due.get(String(r.tenant_id))?.due ?? 0,
            paid: due.get(String(r.tenant_id))?.paid ?? 0,
            livePayouts: livePayouts.get(String(r.tenant_id)) ?? 0,
          }),
        })),
      });
    }

    let fn: string;
    let payload: Record<string, unknown>;
    if (action === "record_refund_payout") {
      fn = "record_refund_payout";
      payload = buildRefundPayoutPayload(
        {
          tenantId: body?.tenantId,
          amount: body?.amount,
          paidAt: body?.paidAt,
          method: body?.method,
          recipient: body?.recipient,
          reference: body?.reference,
          evidenceUrl: body?.evidenceUrl,
          idempotencyKey: body?.idempotencyKey,
        },
        actor,
      );
    } else if (action === "void_refund_payout") {
      fn = "void_refund_payout";
      payload = { payout_id: String(body?.payoutId ?? ""), reason: String(body?.reason ?? ""), actor };
    } else {
      fn = "void_move_out_settlement";
      payload = { settlement_id: String(body?.settlementId ?? ""), reason: String(body?.reason ?? ""), actor };
    }

    const { data, error } = await supabase.rpc(fn, { p: payload });
    if (error) {
      const mapped = explainRefundError(error.message);
      return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    }
    return NextResponse.json({ success: true, ...(data as object) });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed." }, { status: 500 });
  }
}
