import { NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-api-auth";
import {
  applyInvoicePaymentAllocation,
  applyManualInvoicePaymentAllocation,
  autoBillUnbilledLateFees,
  syncInvoiceLedger,
  getCarryForwardCandidatesForTarget,
  snapshotFromPaymentMethodRow,
  calculateLateFeeAmount,
  resolveFullyPaidAtDate,
  OPEN_INVOICE_STATUSES,
} from "@/lib/invoice-ledger";
import { isLateFeeBreakdownRow, isInvoiceDetailEditable, buildRuleBreakdown } from "@/lib/invoice-utils";
import { chargesFromInvoiceRow, computeInvoiceTotal } from "@/lib/invoice-total";
import { toLocalDateString, toNumber } from "@/lib/format";
import { generateInvoicesForPeriod } from "@/lib/invoice-generation";
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
        .select("status,tenant_id")
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
      } else if (!["verifying", "cancelled"].includes(status)) {
        // Leaving paid must clear the freeze, same as `save_details` below —
        // otherwise a fee frozen (even at 0) by an earlier accidental "paid"
        // flip stays stuck forever: `applyInvoicePaymentAllocation` and this
        // same "paid" branch both treat any non-null value as "already
        // frozen, don't touch," so a later real payment's actual date never
        // gets a chance to recompute it.
        updatePayload.locked_late_fee_amount = null;
      }

      const { error } = await auth.supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoiceId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // A freshly-frozen, still-unbilled late fee should land on the
      // tenant's next invoice right away, not wait for someone to notice it
      // in a checklist. No-ops when this invoice wasn't actually the "paid"
      // branch above, or had nothing new to bill.
      if (status === "paid") {
        const tenantId = String((beforeRow as any)?.tenant_id ?? "");
        if (tenantId) {
          await autoBillUnbilledLateFees(auth.supabase, tenantId, [invoiceId]);
        }
      }

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

    if (action === "record_split_payment") {
      // Same money-recording path as record_payment, except the admin picks
      // exactly which invoices this payment goes to and how much for each,
      // instead of the server auto-splitting one amount oldest-first across
      // a single invoice's carry-forward chain. Built for a tenant catching
      // up on real arrears in a lump sum or installments that don't
      // necessarily resolve oldest-first.
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const payment = body?.payment ?? null;
      const allocations = Array.isArray(body?.allocations) ? body.allocations : [];
      if (!tenantId || !payment || typeof payment !== "object" || allocations.length === 0) {
        return NextResponse.json({ error: "Invalid split payment payload." }, { status: 400 });
      }
      const result = await applyManualInvoicePaymentAllocation(auth.supabase, {
        tenantId,
        allocations: allocations.map((row: any) => ({
          invoiceId: String(row?.invoiceId ?? ""),
          amount: Number(row?.amount ?? 0),
        })),
        paidAt: String((payment as any).paid_at ?? new Date().toISOString()),
        slipUrl: ((payment as any).slip_url as string | null | undefined) ?? null,
        mode: String((payment as any).mode ?? "partial"),
        source: String((payment as any).source ?? "admin_webapp"),
        idempotencyKey: (payment as any).idempotency_key
          ? String((payment as any).idempotency_key)
          : null,
        createdBy: auth.user.id,
      });
      const triggerInvoiceId = result.allocationBreakdown[0]?.invoiceId;
      if (triggerInvoiceId) {
        await syncPointsAfterPayment(auth.supabase, triggerInvoiceId);
      }
      return NextResponse.json({ success: true, ...result });
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

    if (action === "sync_period_statuses") {
      // Same two transitions the invoice list used to write directly from the
      // browser with the anon key (docs/audit/2026-09-29-system-audit-detailed.md
      // finding C1, sites use-invoices-state.ts:292/309). Gated on
      // "tenant.view" — the lowest permission every role has by default —
      // because this ran unconditionally for every viewer who opened the
      // list; a narrower gate here would silently stop viewers from ever
      // seeing these transitions, which is a regression, not a relocation.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const periodStart = String(body?.periodStart ?? "");
      const periodEnd = String(body?.periodEnd ?? "");
      if (!periodStart || !periodEnd) {
        return NextResponse.json({ error: "Missing periodStart or periodEnd." }, { status: 400 });
      }
      // Same toLocalDateString(new Date()) call this replaces used in the
      // browser, where it read the admin's own clock. Here it reads the
      // server's — the same not-yet-fixed UTC-vs-Bangkok gap CLAUDE.md
      // documents in ~38 other places already (finding M10), not introduced
      // by this move.
      const today = toLocalDateString(new Date());

      const { error: overdueError } = await auth.supabase
        .from("invoices")
        .update({ status: "overdue" })
        .eq("status", "pending")
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .is("slip_url", null)
        .lt("due_date", today);
      if (overdueError) return NextResponse.json({ error: overdueError.message }, { status: 500 });

      const { error: verifyingError } = await auth.supabase
        .from("invoices")
        .update({ status: "verifying" })
        .in("status", ["pending", "overdue"])
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .eq("paid_amount", 0)
        .not("slip_url", "is", null);
      if (verifyingError) return NextResponse.json({ error: verifyingError.message }, { status: 500 });

      return NextResponse.json({ success: true });
    }

    if (action === "sync_period_discounts") {
      // Recalculates each invoice's discount/total against the current
      // discount rules — moved server-side from
      // lib/hooks/use-invoices-state.ts's syncMonthInvoicesWithSettings
      // (finding C1, site use-invoices-state.ts:430). Same "tenant.view"
      // gate as sync_period_statuses, same reason: ran for every viewer
      // unconditionally before.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const year = Number(body?.year);
      const month = Number(body?.month);
      if (!year || !month) {
        return NextResponse.json({ error: "Missing year or month." }, { status: 400 });
      }

      const periodStart = toLocalDateString(new Date(year, month - 1, 1));
      const periodEnd = toLocalDateString(new Date(year, month, 0));
      const monthKey = toLocalDateString(new Date(year, month - 1, 1));

      const { data: settingsRow } = await auth.supabase
        .from("settings")
        .select("additional_discounts")
        .eq("id", 1)
        .maybeSingle();
      const discountRules = Array.isArray((settingsRow as any)?.additional_discounts)
        ? ((settingsRow as any).additional_discounts as any[])
        : [];

      const { data: invoicesInMonth, error: invoiceError } = await auth.supabase
        .from("invoices")
        .select(
          "id,room_id,status,rent_amount,water_bill,electricity_bill,common_fee,late_fee_amount,carry_forward_amount,additional_fees_total,additional_fees_breakdown,discount_amount,discount_breakdown,total_amount"
        )
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd);

      if (invoiceError) return NextResponse.json({ error: invoiceError.message }, { status: 500 });
      if (!invoicesInMonth || invoicesInMonth.length === 0) {
        return NextResponse.json({ success: true, updated: 0 });
      }

      const roomIds = [...new Set(invoicesInMonth.map((row: any) => row.room_id).filter(Boolean))];
      const { data: readings } = await auth.supabase
        .from("meter_readings")
        .select("room_id,electricity_usage,water_usage,usage")
        .eq("reading_month", monthKey)
        .in("room_id", roomIds.length > 0 ? roomIds : ["00000000-0000-0000-0000-000000000000"]);
      const readingMap = new Map((readings ?? []).map((row: any) => [row.room_id, row]));

      const updates = (invoicesInMonth as any[])
        .map((invoice) => {
          if (!isInvoiceDetailEditable(String(invoice.status ?? ""))) return null;
          const reading = readingMap.get(invoice.room_id) ?? {};
          const elecUnits = toNumber(reading.electricity_usage);
          const waterUnits = toNumber(reading.water_usage ?? reading.usage);
          const freshRuleItems = buildRuleBreakdown(discountRules, elecUnits, waterUnits);
          const existingBreakdown = Array.isArray(invoice.discount_breakdown)
            ? (invoice.discount_breakdown as any[])
            : [];
          const preservedItems = existingBreakdown.filter((item: any) => item?.source !== "rule");
          const discountBreakdown = [...freshRuleItems, ...preservedItems];
          const discountAmount = discountBreakdown.reduce(
            (sum, fee: any) => sum + toNumber(fee.amount ?? fee.total_amount),
            0
          );
          const totalAmount = computeInvoiceTotal({
            ...chargesFromInvoiceRow(invoice as any),
            discount: discountAmount,
          });

          const currentDiscount = toNumber(invoice.discount_amount);
          const currentTotal = toNumber(invoice.total_amount);
          if (
            Math.abs(currentDiscount - discountAmount) < 0.0001 &&
            Math.abs(currentTotal - totalAmount) < 0.0001
          ) {
            return null;
          }

          return {
            id: invoice.id as string,
            discount_amount: discountAmount,
            discount_breakdown: discountBreakdown,
            total_amount: totalAmount,
          };
        })
        .filter(Boolean) as { id: string; discount_amount: number; discount_breakdown: any[]; total_amount: number }[];

      for (const update of updates) {
        const { error: updateError } = await auth.supabase
          .from("invoices")
          .update({
            discount_amount: update.discount_amount,
            discount_breakdown: update.discount_breakdown,
            total_amount: update.total_amount,
          })
          .eq("id", update.id);
        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, updated: updates.length });
    }

    if (action === "get_assignable_payment_methods") {
      // Powers InvoiceDetailModal.tsx's "attach an account to an old
      // payment" picker, which used to read payment_methods directly from
      // the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("payment_methods")
        .select("id,label,bank_name,account_name,account_number")
        .order("label", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ methods: data ?? [] });
    }

    if (action === "get_payment_chains") {
      // Powers InvoiceDetailModal.tsx's Payments tab, which used to read
      // invoice_payment_allocations and payment_batches directly from the
      // browser with the anon key (finding C1). The FK hint is required —
      // invoice_payment_allocations has two foreign keys to invoices
      // (invoice_id and trigger_invoice_id), so a bare embed is ambiguous.
      // Returns the same raw shape the client used to fetch directly; the
      // grouping-into-chains logic stays client-side, unchanged.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });

      const { data: mine, error: mineError } = await auth.supabase
        .from("invoice_payment_allocations")
        .select("payment_batch_id")
        .eq("invoice_id", invoiceId);
      if (mineError) return NextResponse.json({ error: mineError.message }, { status: 500 });

      const batchIds = [...new Set((mine ?? []).map((row: any) => String(row.payment_batch_id ?? "")).filter(Boolean))];
      if (batchIds.length === 0) {
        return NextResponse.json({ allocations: [], batches: [] });
      }

      const [allocationsRes, batchesRes] = await Promise.all([
        auth.supabase
          .from("invoice_payment_allocations")
          .select(
            "id,payment_batch_id,invoice_id,amount,paid_at,slip_url,payment_method_snapshot," +
              "invoice:invoices!invoice_payment_allocations_invoice_id_fkey(id,start_date,rooms(room_number))"
          )
          .in("payment_batch_id", batchIds),
        auth.supabase
          .from("payment_batches")
          .select("id,amount_received,paid_at,slip_url,source,trigger_invoice_id,payment_method_snapshot")
          .in("id", batchIds),
      ]);
      if (allocationsRes.error) return NextResponse.json({ error: allocationsRes.error.message }, { status: 500 });
      if (batchesRes.error) return NextResponse.json({ error: batchesRes.error.message }, { status: 500 });

      return NextResponse.json({ allocations: allocationsRes.data ?? [], batches: batchesRes.data ?? [] });
    }

    if (action === "get_overdue_invoices") {
      // Powers OverdueRoomsTab.tsx, which used to read every open invoice
      // directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select(
          "id,tenant_id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date,move_out_date,status),rooms(room_number,price_month,buildings(name))"
        )
        .in("status", ["pending", "partial", "overdue", "verifying"])
        .order("start_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_invoice_activity_snapshot") {
      // Powers useRealtimeInvoices (lib/hooks/use-realtime-invoices.ts,
      // mounted app-wide from AdminShell.tsx) — a lightweight snapshot
      // polled on an interval to detect "slip just uploaded" / "just
      // entered verifying" and pop a toast, replacing a Realtime
      // subscription that connected straight to the database with the
      // admin's own browser session (finding C1). Same status list as
      // get_overdue_invoices above — those are the only statuses either
      // transition is possible from.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("id,room_id,slip_url,status")
        .in("status", ["pending", "partial", "overdue", "verifying"]);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_carry_forward_candidates") {
      // Powers the "older unpaid bills" list shown when opening an invoice's
      // detail, and when recalculating its carry-forward lines. Moved
      // server-side because getCarryForwardCandidatesForTarget has a write
      // side effect (it calls syncInvoiceLedger internally) that used to run
      // against `invoices` with the browser's anon-key client (finding C1,
      // use-invoices-state.ts:1502/1980). Same "tenant.view" gate as the two
      // sync actions above, for the same reason.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      const beforeStartDate = String(body?.beforeStartDate ?? "");
      const targetInvoiceId = body?.targetInvoiceId ? String(body.targetInvoiceId) : null;
      const valuationDate = body?.valuationDate ? String(body.valuationDate) : null;
      if (!tenantId || !beforeStartDate) {
        return NextResponse.json({ error: "Missing tenantId or beforeStartDate." }, { status: 400 });
      }
      try {
        const candidates = await getCarryForwardCandidatesForTarget(
          auth.supabase,
          tenantId,
          beforeStartDate,
          targetInvoiceId,
          valuationDate
        );
        return NextResponse.json({ candidates });
      } catch (error: any) {
        return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
      }
    }

    if (action === "get_latest_invoice_month") {
      // Powers use-invoices-state.ts's initial month selection, which used
      // to read directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("start_date")
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ startDate: (data as any)?.start_date ?? null });
    }

    if (action === "get_invoices_for_period") {
      // Powers loadInvoices in use-invoices-state.ts — the main invoice
      // list query, the "does this tenant have an earlier invoice" check
      // used for the "new tenant" badge, and the slip-recovery fallback
      // (list the storage folder when slip_url is empty) all used to run
      // directly from the browser with the anon key (finding C1). Every
      // query/filter is copied verbatim; the client's own normalize/sort/
      // badge logic is unchanged.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const periodStart = String(body?.periodStart ?? "");
      const periodEnd = String(body?.periodEnd ?? "");
      if (!periodStart || !periodEnd) {
        return NextResponse.json({ error: "Missing periodStart or periodEnd." }, { status: 400 });
      }

      const { data, error: fetchError } = await auth.supabase
        .from("invoices")
        .select(
          "id,tenant_id,room_id,status,total_amount,paid_amount,payment_history,issue_date,due_date,start_date,end_date,rent_amount,water_bill,electricity_bill,common_fee,discount_amount,discount_breakdown,late_fee_amount,late_fee_per_day,late_fee_start_date,carry_forward_amount,additional_fees_total,additional_fees_breakdown,notes,public_token,slip_url,slip_rejections,opened_count,first_opened_at,last_opened_at,tenants(full_name,phone_number,line_user_id,custom_payment_method,move_in_date,move_out_date,status),rooms(room_number,price_month,buildings(name))"
        )
        .eq("start_date", periodStart)
        .eq("end_date", periodEnd)
        .order("issue_date", { ascending: false });
      if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });

      const invoices = data ?? [];
      const tenantIds = [...new Set(invoices.map((row: any) => String(row.tenant_id)))];
      const { data: allTenantInvoices, error: tenantInvoicesError } =
        tenantIds.length > 0
          ? await auth.supabase
              .from("invoices")
              .select("tenant_id,start_date")
              .in("tenant_id", tenantIds)
              .neq("status", "cancelled")
          : { data: [] as any[], error: null as any };
      if (tenantInvoicesError) {
        return NextResponse.json({ error: tenantInvoicesError.message }, { status: 500 });
      }

      const recoveredSlipUrlById: Record<string, string> = {};
      await Promise.all(
        invoices
          .filter((row: any) => !row.slip_url)
          .map(async (row: any) => {
            const { data: files } = await auth.supabase.storage
              .from("payment_slips")
              .list(String(row.id), { limit: 1, sortBy: { column: "name", order: "desc" } });
            if (!files || files.length === 0) return;
            const latest = files[0];
            const { data: publicData } = auth.supabase.storage
              .from("payment_slips")
              .getPublicUrl(`${row.id}/${latest.name}`);
            recoveredSlipUrlById[String(row.id)] = publicData.publicUrl;
          })
      );

      return NextResponse.json({
        invoices,
        tenantInvoicesForNewCheck: allTenantInvoices ?? [],
        recoveredSlipUrls: recoveredSlipUrlById,
      });
    }

    if (action === "get_print_config") {
      // Powers loadPrintConfig in use-invoices-state.ts, which used to read
      // settings and payment_methods directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const [settingsRes, paymentRes] = await Promise.all([
        auth.supabase
          .from("settings")
          .select(
            "dorm_name,dorm_address,water_rate,electricity_rate,water_min_units,water_min_price,billing_day,due_day,late_fee_start_day,additional_discounts"
          )
          .eq("id", 1)
          .maybeSingle(),
        auth.supabase
          .from("payment_methods")
          .select("label,bank_name,account_name,account_number,qr_url")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      if (settingsRes.error) return NextResponse.json({ error: settingsRes.error.message }, { status: 500 });
      if (paymentRes.error) return NextResponse.json({ error: paymentRes.error.message }, { status: 500 });
      return NextResponse.json({
        settings: settingsRes.data ?? null,
        defaultPaymentMethod: paymentRes.data ?? null,
      });
    }

    if (action === "get_move_out_warnings") {
      // Powers loadMoveOutWarnings in use-invoices-state.ts, which used to
      // read move_out_requests directly from the browser with the anon key
      // (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const monthStart = String(body?.monthStart ?? "");
      const monthEnd = String(body?.monthEnd ?? "");
      if (!monthStart || !monthEnd) {
        return NextResponse.json({ error: "Missing monthStart or monthEnd." }, { status: 400 });
      }
      const { data, error } = await auth.supabase
        .from("move_out_requests")
        .select("id,tenant_id,requested_move_out_date,status,tenants(full_name,rooms(room_number))")
        .in("status", ["requested", "approved"])
        .gte("requested_move_out_date", monthStart)
        .lte("requested_move_out_date", monthEnd)
        .order("requested_move_out_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ warnings: data ?? [] });
    }

    if (action === "get_pending_move_out_count") {
      // Powers the pending-move-out badge in use-invoices-state.ts, which
      // used to read move_out_requests and tenants directly from the
      // browser with the anon key (finding C1) — and, until now, kept
      // doing so live via a Supabase Realtime subscription; this is polled
      // instead now.
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const [requestsRes, tenantsRes] = await Promise.all([
        auth.supabase.from("move_out_requests").select("tenant_id").eq("status", "requested"),
        auth.supabase.from("tenants").select("id").not("move_out_date", "is", null).eq("status", "active"),
      ]);
      if (requestsRes.error) return NextResponse.json({ error: requestsRes.error.message }, { status: 500 });
      if (tenantsRes.error) return NextResponse.json({ error: tenantsRes.error.message }, { status: 500 });
      const ids = new Set<string>();
      for (const row of requestsRes.data ?? []) {
        const id = String((row as any).tenant_id ?? "");
        if (id) ids.add(id);
      }
      for (const row of tenantsRes.data ?? []) {
        const id = String((row as any).id ?? "");
        if (id) ids.add(id);
      }
      return NextResponse.json({ count: ids.size });
    }

    if (action === "get_open_invoices_for_tenant") {
      // Powers openSplitPaymentModal in use-invoices-state.ts, which used
      // to read directly from the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const tenantId = String(body?.tenantId ?? "");
      if (!tenantId) return NextResponse.json({ error: "Missing tenantId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("invoices")
        .select("id,start_date,total_amount,paid_amount,status")
        .eq("tenant_id", tenantId)
        .in("status", OPEN_INVOICE_STATUSES as unknown as string[])
        .order("start_date", { ascending: true });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoices: data ?? [] });
    }

    if (action === "get_invoice_snapshot") {
      // Powers submitSplitPayment's post-payment refresh of the active
      // invoice in use-invoices-state.ts, which used to read directly from
      // the browser with the anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      const { data, error } = await auth.supabase
        .from("invoices")
        .select(
          "id,paid_amount,status,total_amount,carry_forward_amount,additional_fees_total,additional_fees_breakdown,payment_history"
        )
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ invoice: data ?? null });
    }

    if (action === "get_invoice_reading_and_arrears") {
      // Powers both the invoice-detail modal's meter/arrears hydration and
      // getInvoicePrintDetail in use-invoices-state.ts — two identical
      // reads that used to run directly from the browser with the anon key
      // (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      const roomId = String(body?.roomId ?? "");
      const readingMonth = String(body?.readingMonth ?? "");
      if (!invoiceId || !roomId || !readingMonth) {
        return NextResponse.json({ error: "Missing invoiceId, roomId, or readingMonth." }, { status: 400 });
      }
      const [readingRes, snapshotRes] = await Promise.all([
        auth.supabase
          .from("meter_readings")
          .select(
            "electricity_usage,water_usage,usage,previous_electricity,current_electricity,previous_water,current_water,previous_reading,current_reading"
          )
          .eq("room_id", roomId)
          .eq("reading_month", readingMonth)
          .maybeSingle(),
        auth.supabase
          .from("invoice_arrears_snapshots")
          .select("id,source_invoice_id,snapshot_as_of,principal_amount,late_fee_amount,days_overdue,daily_rate")
          .eq("target_invoice_id", invoiceId)
          .order("created_at", { ascending: true }),
      ]);
      if (readingRes.error) return NextResponse.json({ error: readingRes.error.message }, { status: 500 });
      if (snapshotRes.error) return NextResponse.json({ error: snapshotRes.error.message }, { status: 500 });
      return NextResponse.json({
        reading: readingRes.data ?? null,
        arrearsSnapshots: snapshotRes.data ?? [],
      });
    }

    if (action === "get_transfer_recalc_data") {
      // Powers recalculateTransferBreakdown in use-invoices-state.ts, which
      // used to run 3 sequential reads directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "tenant.view");
      if ("error" in auth) return auth.error;
      const roomId = String(body?.roomId ?? "");
      const billingMonth = String(body?.billingMonth ?? "");
      const transferDate = String(body?.transferDate ?? "");
      if (!roomId || !billingMonth || !transferDate) {
        return NextResponse.json(
          { error: "Missing roomId, billingMonth, or transferDate." },
          { status: 400 }
        );
      }
      const { data: transferRows, error: transferError } = await auth.supabase
        .from("tenant_room_transfers")
        .select(
          "from_room_id,to_room_id,transfer_date,billing_month,old_electric_usage,old_water_usage,new_prev_electricity,new_prev_water"
        )
        .eq("to_room_id", roomId)
        .eq("billing_month", billingMonth)
        .eq("transfer_date", transferDate)
        .order("transfer_date", { ascending: false })
        .limit(1);
      if (transferError) return NextResponse.json({ error: transferError.message }, { status: 500 });

      const transferRow = (transferRows ?? [])[0] ?? null;
      if (!transferRow) {
        return NextResponse.json({ transferRow: null, roomRows: [], reading: null });
      }

      const roomIds = [(transferRow as any).from_room_id, (transferRow as any).to_room_id];
      const [roomsRes, readingRes] = await Promise.all([
        auth.supabase.from("rooms").select("id,price_month").in("id", roomIds),
        auth.supabase
          .from("meter_readings")
          .select("current_electricity,current_water,electricity_usage,water_usage")
          .eq("room_id", roomId)
          .eq("billing_month", billingMonth)
          .limit(1),
      ]);
      if (roomsRes.error) return NextResponse.json({ error: roomsRes.error.message }, { status: 500 });

      return NextResponse.json({
        transferRow,
        roomRows: roomsRes.data ?? [],
        reading: (readingRes.data ?? [])[0] ?? null,
      });
    }

    if (action === "delete_payment_slip_files") {
      // Powers deletePaymentSlip in use-invoices-state.ts, which used to
      // list and remove storage objects directly from the browser with the
      // anon key (finding C1).
      const auth = await requireAdminPermission(req, "invoice.payment.record");
      if ("error" in auth) return auth.error;
      const invoiceId = String(body?.invoiceId ?? "");
      if (!invoiceId) return NextResponse.json({ error: "Missing invoiceId." }, { status: 400 });
      const { data: files, error: listError } = await auth.supabase.storage
        .from("payment_slips")
        .list(invoiceId, { limit: 1000 });
      if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
      const paths = (files ?? []).map((file) => `${invoiceId}/${file.name}`);
      if (paths.length > 0) {
        const { error: removeError } = await auth.supabase.storage.from("payment_slips").remove(paths);
        if (removeError) return NextResponse.json({ error: removeError.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, removedCount: paths.length });
    }

    if (action === "generate_invoices") {
      // The full implementation lives in lib/invoice-generation.ts,
      // specifically so it can also be called directly (service-role
      // client, dryRun: true) from a verification script without needing a
      // real admin session — see that file's own header comment. This is
      // the last remaining C1 item
      // (docs/audit/2026-09-29-system-audit-detailed.md): monthly invoice
      // generation had no server-side version at all before this.
      const auth = await requireAdminPermission(req, "invoice.create");
      if ("error" in auth) return auth.error;

      const year = Number(body?.year);
      const month = Number(body?.month);
      try {
        const result = await generateInvoicesForPeriod(auth.supabase, {
          year,
          month,
          dryRun: Boolean(body?.dryRun),
          dryRunIncludeExisting: Boolean(body?.dryRunIncludeExisting),
        });
        return NextResponse.json(result);
      } catch (error: any) {
        return NextResponse.json({ error: error?.message ?? "Unexpected server error." }, { status: 500 });
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
