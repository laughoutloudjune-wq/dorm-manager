import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  applyInvoicePaymentAllocation,
  syncInvoiceLedger,
  snapshotFromPaymentMethodRow,
  calculateLateFeeAmount,
  resolveFullyPaidAtDate,
} from "@/lib/invoice-ledger";
import { isLateFeeBreakdownRow } from "@/lib/invoice-utils";
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

      // Changing status NEVER creates a payment — not even to "paid", and not
      // even when a slip is sitting there awaiting review. Status is a
      // bookkeeping label; money is recorded only through the Payments tab
      // (`record_payment`), where an admin enters a real amount, or by
      // confirming a tenant's slip in that same tab.
      //
      // This endpoint used to call applyInvoicePaymentAllocation with the
      // entire outstanding balance whenever someone picked "paid", inventing a
      // payment_batches row for money nobody had received and copying the
      // invoice's existing slip image onto it so it looked evidenced. That
      // produced ฿150,000+ of fake receipts before it was found. Every status
      // is now freely selectable and none of them move money.

      // Needed to detect a PAID -> not-paid transition below, so rewards
      // points earned for this invoice get revoked, not just awarded.
      const { data: beforeRow } = await auth.supabase
        .from("invoices")
        .select("status")
        .eq("id", invoiceId)
        .maybeSingle();
      const wasPaid = String((beforeRow as any)?.status ?? "") === "paid";

      const updatePayload: Record<string, unknown> = { status };

      if (status === "paid") {
        // Re-freeze the late fee if it is currently unfrozen. Flipping an
        // invoice away from paid clears `locked_late_fee_amount`, which puts
        // the fee back on a live ฿/day calculation; leaving it unfrozen would
        // let an old invoice's fee keep growing from its original due date.
        // `syncInvoiceLedger` normally freezes it on the transition to paid,
        // but it skips invoices already marked paid, so it cannot recover this
        // afterwards. Freezing a fee is bookkeeping, not a payment.
        const { data: feeRow } = await auth.supabase
          .from("invoices")
          .select(
            "locked_late_fee_amount,late_fee_start_date,late_fee_per_day,waived_late_fee_amount,payment_history,slip_uploaded_at",
          )
          .eq("id", invoiceId)
          .maybeSingle();
        if (feeRow && (feeRow as any).locked_late_fee_amount == null) {
          updatePayload.locked_late_fee_amount = calculateLateFeeAmount(
            feeRow as any,
            resolveFullyPaidAtDate(
              feeRow as any,
              new Date().toISOString().slice(0, 10),
            ),
          );
        }
      }

      const { error } = await auth.supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Rewards points are derived entirely from invoice status
      // (syncPointsForTenant reads status='paid' to award on-time/streak
      // points, and revokes anything no longer justified). Re-sync on BOTH
      // directions: becoming paid awards; LEAVING paid must revoke, or a
      // tenant keeps points for a bill the system no longer calls settled.
      // Room 119/2's July invoice sat as `draft` while still holding 32
      // "on-time rent" points from when it was briefly marked paid, because
      // this used to only fire on the -> paid direction.
      if (status === "paid" || wasPaid) {
        await syncPointsAfterPayment(auth.supabase, invoiceId);
      }

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
      let wasPaidBeforeSave = false;
      if ("status" in payload) {
        const authStatus = await requireAdminPermission(req, "invoice.status.update");
        if ("error" in authStatus) return authStatus.error;
        if (!["paid", "verifying", "cancelled"].includes(String(payload.status))) {
          payload.locked_late_fee_amount = null;
        }
        const { data: beforeRow } = await authEdit.supabase
          .from("invoices")
          .select("status")
          .eq("id", invoiceId)
          .maybeSingle();
        wasPaidBeforeSave = String((beforeRow as any)?.status ?? "") === "paid";
      }
      const { error } = await authEdit.supabase.from("invoices").update(payload).eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Same rewards-revocation gap as update_status: this form can also move
      // status away from "paid" (or into it), and points must follow.
      if (
        "status" in payload &&
        (String(payload.status) === "paid" || wasPaidBeforeSave)
      ) {
        await syncPointsAfterPayment(authEdit.supabase, invoiceId);
      }
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

        // Every source invoice whose late fee just became a real line item on
        // THIS invoice is now billed — mark it so a later invoice generation
        // (or another recalculate) can never pick the same fee up again. This
        // is what actually gets a late fee billed for a tenant who paid a bit
        // late and settled their invoice before the next monthly cycle ever
        // looked at it: recalculating here (after the payment) is what first
        // makes the now-eligible paid invoice show up as a candidate at all.
        const lateFeeSourceIds = [
          ...new Set(
            rows
              .filter(
                (row) =>
                  isLateFeeBreakdownRow(row) &&
                  Number(row?.total_amount ?? row?.amount ?? 0) > 0 &&
                  row?.source_invoice_id
              )
              .map((row) => String(row.source_invoice_id))
          ),
        ];
        if (lateFeeSourceIds.length > 0) {
          const { error: markBilledError } = await authEdit.supabase
            .from("invoices")
            .update({ late_fee_billed_at: new Date().toISOString() })
            .in("id", lateFeeSourceIds)
            .is("late_fee_billed_at", null);
          if (markBilledError) {
            return NextResponse.json({ error: markBilledError.message }, { status: 500 });
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
      const paymentBatchId = body?.paymentBatchId ? String(body.paymentBatchId) : null;
      // Alternative entry point for a payment recorded BEFORE payment_batches
      // existed: it has a payment_history entry but no batch/allocation row at
      // all, so there is nothing for the paymentBatchId path to update. Room
      // 210/1's March invoice is exactly this — paid via slip in March, before
      // the ledger tables were introduced, so it has no source and no way to
      // attach a receiving account.
      const invoiceId = body?.invoiceId ? String(body.invoiceId) : null;
      const methodId = String(body?.methodId ?? "");
      if ((!paymentBatchId && !invoiceId) || !methodId) {
        return NextResponse.json(
          { error: "Missing paymentBatchId (or invoiceId) or methodId." },
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

      if (paymentBatchId) {
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

      // Backfill path: build a real payment_batches row (and one allocation)
      // for every payment_history entry that predates the ledger, then attach
      // the chosen account to each. This is the only place a batch is created
      // retroactively for money that was NEVER unaccounted for — the
      // invoice's own paid_amount already reflects it; only the batch/
      // allocation/source records were missing. Source defaults to
      // "admin_webapp" when the entry predates that field existing, since
      // every pre-ledger entry inspected so far was in fact recorded that way.
      const { data: invoiceRow, error: invoiceError } = await auth.supabase
        .from("invoices")
        .select("id,tenant_id,payment_history")
        .eq("id", invoiceId as string)
        .maybeSingle();
      if (invoiceError) return NextResponse.json({ error: invoiceError.message }, { status: 500 });
      if (!invoiceRow) {
        return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
      }

      const history = Array.isArray((invoiceRow as any).payment_history)
        ? [...(invoiceRow as any).payment_history]
        : [];
      const legacyIndexes = history
        .map((entry: any, index: number) => ({ entry, index }))
        .filter(({ entry }) => !entry?.payment_batch_id);

      if (legacyIndexes.length === 0) {
        return NextResponse.json(
          { error: "ไม่พบรายการชำระเงินที่ยังไม่มีบันทึกการโอนสำหรับใบแจ้งหนี้นี้" },
          { status: 404 },
        );
      }

      const newBatchIds: string[] = [];
      for (const { entry, index } of legacyIndexes) {
        const amount = Number(entry?.amount ?? 0);
        if (!(amount > 0)) continue;
        const paidAt = String(entry?.paid_at ?? entry?.created_at ?? new Date().toISOString());
        const source = entry?.source ? String(entry.source) : "admin_webapp";
        const slipUrl = entry?.slip_url ? String(entry.slip_url) : null;
        const newBatchId = crypto.randomUUID();

        const { error: insertBatchError } = await auth.supabase
          .from("payment_batches")
          .insert({
            id: newBatchId,
            tenant_id: (invoiceRow as any).tenant_id ?? null,
            trigger_invoice_id: invoiceId,
            amount_received: amount,
            amount_allocated: amount,
            paid_at: paidAt,
            mode: entry?.mode ?? "full",
            source,
            slip_url: slipUrl,
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
            created_at: entry?.created_at ?? new Date().toISOString(),
          });
        if (insertBatchError) {
          return NextResponse.json({ error: insertBatchError.message }, { status: 500 });
        }

        const { error: insertAllocError } = await auth.supabase
          .from("invoice_payment_allocations")
          .insert({
            payment_batch_id: newBatchId,
            trigger_invoice_id: invoiceId,
            invoice_id: invoiceId,
            amount,
            paid_at: paidAt,
            slip_url: slipUrl,
            source,
            payment_method_id: resolved.id,
            payment_method_snapshot: resolved.snapshot,
            created_at: new Date().toISOString(),
          });
        if (insertAllocError) {
          return NextResponse.json({ error: insertAllocError.message }, { status: 500 });
        }

        history[index] = {
          ...entry,
          source,
          payment_batch_id: newBatchId,
          trigger_invoice_id: invoiceId,
          payment_method: resolved.snapshot,
          payment_method_id: resolved.id,
        };
        newBatchIds.push(newBatchId);
      }

      const { error: historyError } = await auth.supabase
        .from("invoices")
        .update({ payment_history: history })
        .eq("id", invoiceId as string);
      if (historyError) {
        return NextResponse.json({ error: historyError.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        paymentMethod: resolved,
        backfilledBatchIds: newBatchIds,
      });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unexpected server error." },
      { status: 500 }
    );
  }
}
