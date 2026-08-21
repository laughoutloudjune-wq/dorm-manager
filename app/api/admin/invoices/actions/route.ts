import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  applyInvoicePaymentAllocation,
  syncInvoiceLedger,
  snapshotFromPaymentMethodRow,
  getPaymentChainOutstanding,
  calculateLateFeeAmount,
  resolveFullyPaidAtDate,
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
          .select("id,status,total_amount,paid_amount,slip_url,slip_uploaded_at")
          .eq("id", invoiceId)
          .single();
        if (invoiceError || !invoice) {
          return NextResponse.json({ error: invoiceError?.message ?? "Invoice not found." }, { status: 404 });
        }

        // Setting an invoice back to "paid" after it was flipped to some other
        // status is a correction, not a new payment. The earlier flip never
        // reversed `paid_amount`, so the money is still on record and there is
        // nothing left to allocate — going through the allocation path here
        // would throw "This invoice chain is already fully paid". Just restore
        // the status.
        const chainOutstanding = await getPaymentChainOutstanding(auth.supabase, invoiceId);
        if (chainOutstanding <= 0) {
          const statusPayload: Record<string, unknown> = { status: "paid" };

          // Re-freeze the late fee if it is currently unfrozen. Flipping an
          // invoice away from paid clears `locked_late_fee_amount`, which puts
          // the fee back on a live ฿/day calculation; leaving it unfrozen here
          // would let an old invoice's fee keep growing from its original due
          // date. `syncInvoiceLedger` normally does this on the transition to
          // paid, but it skips invoices already marked paid, so it cannot
          // recover it once this branch has run.
          const { data: feeRow } = await auth.supabase
            .from("invoices")
            .select(
              "locked_late_fee_amount,late_fee_start_date,late_fee_per_day,waived_late_fee_amount,payment_history,slip_uploaded_at",
            )
            .eq("id", invoiceId)
            .maybeSingle();
          if (feeRow && (feeRow as any).locked_late_fee_amount == null) {
            statusPayload.locked_late_fee_amount = calculateLateFeeAmount(
              feeRow as any,
              resolveFullyPaidAtDate(
                feeRow as any,
                new Date().toISOString().slice(0, 10),
              ),
            );
          }

          const { error: statusError } = await auth.supabase
            .from("invoices")
            .update(statusPayload)
            .eq("id", invoiceId);
          if (statusError) {
            return NextResponse.json({ error: statusError.message }, { status: 500 });
          }
          await syncPointsAfterPayment(auth.supabase, invoiceId);
          return NextResponse.json({ success: true, alreadySettled: true });
        }

        // SAFEGUARD: the status dropdown may only turn a REVIEWED slip into a
        // recorded payment — it must never fabricate one for whatever is still
        // outstanding. This is exactly how the ledger accumulated fake
        // batches: an admin picked "paid" from the dropdown as a shortcut on
        // an invoice with no slip (or a real partial payment already on it),
        // and the remaining balance got recorded as if cash had arrived, with
        // no evidence behind it. `status === "verifying"` is set only when a
        // tenant has actually uploaded a slip pending review, so it plus a
        // non-empty `slip_url` is the one legitimate case for creating money
        // from this endpoint. Anything else must go through the Payments tab,
        // where an amount and (optionally) a slip are entered explicitly.
        if (
          String((invoice as any).status ?? "") !== "verifying" ||
          !(invoice as any).slip_url
        ) {
          return NextResponse.json(
            {
              error:
                "ไม่สามารถเปลี่ยนสถานะเป็นชำระแล้วได้ เนื่องจากยังไม่มีสลิปที่รอตรวจสอบ กรุณาบันทึกการชำระเงินผ่านแท็บการชำระเงินแทน",
            },
            { status: 400 },
          );
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

      // NOT re-deriving allocations here yet. `reallocatePaymentsForInvoice`
      // treats each invoice's `total_amount` as its capacity, but a
      // carry-forward target's total already BUNDLES its source's debt (206/1
      // March: total 11,753 = own charge 7,942 + 3,811 carried from February).
      // Replaying against the bundled figure counts the source payment twice.
      // Enabling this needs the capacity model switched to each invoice's own
      // charge — and `paid_amount` is not consistent about which of the two it
      // means across existing rows, so that has to be settled first.
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

    if (action === "delete_payment_batch") {
      // Lets an admin remove a payment_batches row directly from the invoice's
      // Payments tab — the manual-review counterpart to everything this
      // session's cleanup did by hand in SQL. Same permission as recording a
      // payment: deleting a bad record needs the same authority as creating a
      // good one.
      //
      // Deliberately does NOT touch invoices.paid_amount/status/payment_history
      // beyond stripping the matching payment_history entries (a display cache
      // — leaving a stale entry there is what made 101/2 briefly look
      // inconsistent even after its batch was gone). Recomputing paid_amount
      // from what remains is NOT done here: for a carry-forward invoice,
      // total_amount already bundles an earlier invoice's debt, so naively
      // resetting paid_amount to "whatever allocations remain" double-counts
      // exactly the way `reallocatePaymentsForInvoice` was found to (see the
      // comment on the withdrawn auto-replay above). If the invoice's own
      // paid_amount no longer matches its remaining allocations after this
      // delete, that mismatch is reported back so the admin can adjust the
      // invoice amount directly, the same way 101/2 was fixed.
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const paymentBatchId = String(body?.paymentBatchId ?? "");
      if (!paymentBatchId) {
        return NextResponse.json({ error: "Missing paymentBatchId." }, { status: 400 });
      }

      const { data: allocRows, error: allocFetchError } = await auth.supabase
        .from("invoice_payment_allocations")
        .select("invoice_id")
        .eq("payment_batch_id", paymentBatchId);
      if (allocFetchError) {
        return NextResponse.json({ error: allocFetchError.message }, { status: 500 });
      }
      const touchedInvoiceIds = [
        ...new Set((allocRows ?? []).map((row: any) => String(row.invoice_id))),
      ];
      if (touchedInvoiceIds.length === 0) {
        return NextResponse.json(
          { error: "ไม่พบรายการชำระเงินนี้ในระบบแล้ว (อาจถูกลบไปก่อนหน้านี้)" },
          { status: 404 },
        );
      }

      const { error: deleteAllocError } = await auth.supabase
        .from("invoice_payment_allocations")
        .delete()
        .eq("payment_batch_id", paymentBatchId);
      if (deleteAllocError) {
        return NextResponse.json({ error: deleteAllocError.message }, { status: 500 });
      }

      const { error: deleteBatchError } = await auth.supabase
        .from("payment_batches")
        .delete()
        .eq("id", paymentBatchId);
      if (deleteBatchError) {
        return NextResponse.json({ error: deleteBatchError.message }, { status: 500 });
      }

      // Strip the matching payment_history entries and collect mismatch
      // warnings, per touched invoice.
      const mismatches: { invoiceId: string; paidAmount: number; allocationSum: number }[] = [];
      for (const invoiceId of touchedInvoiceIds) {
        const [{ data: invRow }, { data: remainingAllocs }] = await Promise.all([
          auth.supabase
            .from("invoices")
            .select("paid_amount,payment_history")
            .eq("id", invoiceId)
            .maybeSingle(),
          auth.supabase
            .from("invoice_payment_allocations")
            .select("amount")
            .eq("invoice_id", invoiceId),
        ]);

        const history = Array.isArray((invRow as any)?.payment_history)
          ? (invRow as any).payment_history
          : [];
        const filteredHistory = history.filter(
          (entry: any) => String(entry?.payment_batch_id ?? "") !== paymentBatchId,
        );
        if (filteredHistory.length !== history.length) {
          const { error: historyError } = await auth.supabase
            .from("invoices")
            .update({ payment_history: filteredHistory })
            .eq("id", invoiceId);
          if (historyError) {
            console.error(
              "[delete_payment_batch] Failed to strip payment_history entry:",
              invoiceId,
              historyError,
            );
          }
        }

        const paidAmount = Number((invRow as any)?.paid_amount ?? 0);
        const allocationSum = (remainingAllocs ?? []).reduce(
          (sum: number, row: any) => sum + Number(row.amount ?? 0),
          0,
        );
        if (Math.abs(paidAmount - allocationSum) > 0.005) {
          mismatches.push({ invoiceId, paidAmount, allocationSum });
        }
      }

      return NextResponse.json({
        success: true,
        touchedInvoiceIds,
        mismatches,
      });
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
