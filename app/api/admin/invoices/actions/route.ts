import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  applyInvoicePaymentAllocation,
  syncInvoiceLedger,
  snapshotFromPaymentMethodRow,
} from "@/lib/invoice-ledger";
import { syncPointsForTenant } from "@/lib/points-ledger";
import { notifyTenantPointsEarned } from "@/lib/points-notify";
import { declinePaymentSlip } from "@/lib/slip-review";
import { notifyTenantSlipDeclined } from "@/lib/slip-notify";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Award any newly-earned rewards points (on-time payment, streak bonus) after
 * a successful payment allocation, and push a LINE notification for whatever
 * was newly earned. Never lets a points-sync/notify failure fail the payment
 * response itself — the payment already succeeded.
 */
async function syncPointsAfterPayment(supabase: SupabaseClient, invoiceId: string) {
  try {
    const { data } = await supabase.from("invoices").select("tenant_id").eq("id", invoiceId).maybeSingle();
    const tenantId = (data as any)?.tenant_id;
    if (tenantId) {
      const result = await syncPointsForTenant(supabase, tenantId);
      await notifyTenantPointsEarned(supabase, tenantId, result.awardedEntries);
    }
  } catch (err) {
    console.error("[rewards] Failed to sync points after payment for invoice:", invoiceId, err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "update_status") {
      const auth = await requireAdminPermission(req, "invoice.status.update");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const status = String(body?.status ?? "");
      if (!invoiceId || !status) {
        return NextResponse.json({ error: "Missing invoiceId or status." }, { status: 400 });
      }
      if (status === "paid") {
        const { data: invoice, error: invoiceError } = await auth.supabase
          .from("invoices")
          .select("id,total_amount,paid_amount,slip_url,slip_uploaded_at")
          .eq("id", invoiceId)
          .single();
        if (invoiceError || !invoice) {
          return NextResponse.json({ error: invoiceError?.message ?? "Invoice not found." }, { status: 404 });
        }
        const result = await applyInvoicePaymentAllocation(auth.supabase, {
          invoiceId,
          amount: Number.MAX_SAFE_INTEGER,
          paidAt: String((invoice as any).slip_uploaded_at ?? new Date().toISOString()),
          slipUrl: ((invoice as any).slip_url as string | null | undefined) ?? null,
          mode: "full",
          source: "admin_status_paid",
          createdBy: auth.user.id,
        });
        await syncPointsAfterPayment(auth.supabase, invoiceId);
        return NextResponse.json({ success: true, ...result });
      }
      const { error } = await auth.supabase.from("invoices").update({ status }).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "save_details") {
      const authEdit = await requireAdminPermission(req, "invoice.edit");
      if ("error" in authEdit) return authEdit.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const payload = body?.payload ?? {};
      if (!invoiceId || !payload || typeof payload !== "object") {
        return NextResponse.json({ error: "Invalid save payload." }, { status: 400 });
      }
      if ("status" in payload) {
        const authStatus = await requireAdminPermission(req, "invoice.status.update");
        if ("error" in authStatus) return authStatus.error;
        if (!["paid", "verifying", "cancelled"].includes(String(payload.status))) {
          payload.locked_late_fee_amount = null;
        }
      }
      const { error } = await authEdit.supabase.from("invoices").update(payload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if ("additional_fees_breakdown" in payload) {
        const rows = Array.isArray((payload as any).additional_fees_breakdown)
          ? ((payload as any).additional_fees_breakdown as any[])
          : [];
        const carryRows = rows.filter(
          (row) => String(row?.item_type ?? row?.type ?? "").toLowerCase() === "carry_forward"
        );
        const { error: deleteCarryError } = await authEdit.supabase
          .from("invoice_carry_forwards")
          .delete()
          .eq("target_invoice_id", invoiceId);
        if (deleteCarryError) {
          return NextResponse.json({ error: deleteCarryError.message }, { status: 500 });
        }
        const carryMap = new Map<string, number>();
        for (const row of carryRows) {
          const sourceInvoiceId = row?.source_invoice_id ? String(row.source_invoice_id) : "";
          if (!sourceInvoiceId) continue;
          carryMap.set(
            sourceInvoiceId,
            (carryMap.get(sourceInvoiceId) ?? 0) + Number(row?.total_amount ?? row?.amount ?? 0)
          );
        }
        const insertRows = [...carryMap.entries()].map(([source_invoice_id, amount]) => ({
          source_invoice_id,
          target_invoice_id: invoiceId,
          amount,
        }));
        if (insertRows.length > 0) {
          const { error: insertCarryError } = await authEdit.supabase
            .from("invoice_carry_forwards")
            .upsert(insertRows, { onConflict: "source_invoice_id,target_invoice_id" });
          if (insertCarryError) {
            return NextResponse.json({ error: insertCarryError.message }, { status: 500 });
          }
        }
      }
      return NextResponse.json({ success: true });
    }

    if (action === "record_payment") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const payload = body?.payload ?? {};
      const payment = body?.payment ?? null;
      if (!invoiceId || ((!payload || typeof payload !== "object") && !payment)) {
        return NextResponse.json({ error: "Invalid payment payload." }, { status: 400 });
      }
      if (payment && typeof payment === "object") {
        const result = await applyInvoicePaymentAllocation(auth.supabase, {
          invoiceId,
          amount: Number((payment as any).amount ?? 0),
          paidAt: String((payment as any).paid_at ?? new Date().toISOString()),
          slipUrl: ((payment as any).slip_url as string | null | undefined) ?? null,
          mode: String((payment as any).mode ?? "full"),
          source: String((payment as any).source ?? "admin_webapp"),
          idempotencyKey: (payment as any).idempotency_key
            ? String((payment as any).idempotency_key)
            : null,
          createdBy: auth.user.id,
        });
        await syncPointsAfterPayment(auth.supabase, invoiceId);
        return NextResponse.json({ success: true, ...result });
      }
      const { error } = await auth.supabase.from("invoices").update(payload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "decline_slip") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const reason = String(body?.reason ?? "");
      if (!invoiceId) {
        return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      }
      try {
        const result = await declinePaymentSlip(auth.supabase, {
          invoiceId,
          reason,
          reviewedBy: auth.user.id,
        });
        await notifyTenantSlipDeclined(auth.supabase, {
          tenantId: result.tenantId,
          invoiceId,
          reason: result.reason,
        });
        return NextResponse.json({ success: true, ...result });
      } catch (err: any) {
        return NextResponse.json(
          { error: err?.message ?? "Failed to decline the payment slip." },
          { status: 400 },
        );
      }
    }

    if (action === "sync_overdue") {
      const auth = await requireAdminPermission(req, "invoice.edit");
      if ("error" in auth) return auth.error;
      const invoiceIds = Array.isArray(body?.invoiceIds) ? (body.invoiceIds as string[]) : [];
      const tenantIds = Array.isArray(body?.tenantIds) ? (body.tenantIds as string[]) : [];
      const beforeStartDate = body?.beforeStartDate ? String(body.beforeStartDate) : undefined;
      const result = await syncInvoiceLedger(auth.supabase, { invoiceIds, tenantIds, beforeStartDate });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "delete_many") {
      const auth = await requireAdminPermission(req, "invoice.delete");
      if ("error" in auth) return auth.error;
      const invoiceIds = Array.isArray(body?.invoiceIds) ? (body.invoiceIds as string[]) : [];
      if (invoiceIds.length === 0) {
        return NextResponse.json({ error: "Missing invoiceIds." }, { status: 400 });
      }

      const { data: rows, error: checkError } = await auth.supabase
        .from("invoices")
        .select("id,status,slip_url")
        .in("id", invoiceIds);
      if (checkError) return NextResponse.json({ error: checkError.message }, { status: 500 });

      const blocked = (rows ?? []).filter((row: any) => {
        if (String(row.status) === "draft") return false;
        return !!row.slip_url || row.status === "verifying" || row.status === "paid";
      });
      if (blocked.length > 0) {
        return NextResponse.json(
          { error: "Cannot delete invoices with payment slip or paid/verifying status." },
          { status: 400 }
        );
      }

      const { error } = await auth.supabase.from("invoices").delete().in("id", invoiceIds);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    // Manually attach the real receiving account to a payment recorded before
    // payment_method_snapshot existed (or otherwise never resolved), when the
    // admin actually knows which account it went to — e.g. checking an old
    // bank statement. Same permission as recording the payment in the first
    // place: this is correcting an existing record, not creating a new one.
    // Applies to every allocation in the batch, since one transfer only ever
    // lands in one account regardless of how many invoices it settled.
    if (action === "assign_payment_batch_method") {
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const paymentBatchId = String(body?.paymentBatchId ?? "");
      const methodId = String(body?.methodId ?? "");
      if (!paymentBatchId || !methodId) {
        return NextResponse.json(
          { error: "Missing paymentBatchId or methodId." },
          { status: 400 },
        );
      }

      const { data: methodRow, error: methodError } = await auth.supabase
        .from("payment_methods")
        .select("id,label,bank_name,account_name,account_number,qr_url")
        .eq("id", methodId)
        .maybeSingle();
      if (methodError) return NextResponse.json({ error: methodError.message }, { status: 500 });
      if (!methodRow) {
        return NextResponse.json({ error: "Payment method not found." }, { status: 404 });
      }

      const resolved = snapshotFromPaymentMethodRow(methodRow as any);

      const { error: batchError } = await auth.supabase
        .from("payment_batches")
        .update({
          payment_method_id: resolved.id,
          payment_method_snapshot: resolved.snapshot,
        })
        .eq("id", paymentBatchId);
      if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 });

      const { error: allocationError } = await auth.supabase
        .from("invoice_payment_allocations")
        .update({
          payment_method_id: resolved.id,
          payment_method_snapshot: resolved.snapshot,
        })
        .eq("payment_batch_id", paymentBatchId);
      if (allocationError) {
        return NextResponse.json({ error: allocationError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, paymentMethod: resolved });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error." },
      { status: 500 }
    );
  }
}
