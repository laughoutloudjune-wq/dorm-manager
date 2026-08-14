import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveInvoiceStatus } from "@/lib/invoice-ledger";

/**
 * Declining a payment slip during verification.
 *
 * The mirror image of approving one: where approval runs through
 * applyInvoicePaymentAllocation and records money received, declining records
 * that nothing was received and puts the invoice back where it was before the
 * tenant uploaded. Deliberately NOT modelled as a payment — nothing is written
 * to payment_history, because that array drives isPaymentOnTime()
 * (lib/points-ledger.ts), the receipt's payment date, and the ledger's
 * allocation math. A rejection goes to its own `slip_rejections` column.
 *
 * The slip image itself is left in the payment_slips bucket on purpose. Only
 * the invoice's `slip_url`/`slip_uploaded_at` are cleared, so the tenant's LIFF
 * upload flow sees a slip-less invoice and can submit a new one, while the
 * rejected image stays reachable through slip_rejections if the payment is ever
 * disputed. (The separate "ลบสลิป" button is what actually deletes files.)
 */

const toNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export type DeclineSlipOptions = {
  invoiceId: string;
  reason: string;
  reviewedBy: string | null;
};

export type DeclineSlipResult = {
  invoiceId: string;
  tenantId: string | null;
  previousStatus: string;
  nextStatus: string;
  reason: string;
  rejectedSlipUrl: string | null;
  updatedInvoice: any;
};

/** Statuses a slip can be declined from — anything else has no pending slip to review. */
const DECLINABLE_STATUSES = ["verifying"];

export async function declinePaymentSlip(
  supabase: SupabaseClient,
  options: DeclineSlipOptions,
): Promise<DeclineSlipResult> {
  const { invoiceId, reviewedBy } = options;
  const reason = String(options.reason ?? "").trim();
  if (!reason) throw new Error("Please give a reason for declining the slip.");

  const { data: invoice, error: fetchError } = await supabase
    .from("invoices")
    .select(
      "id,tenant_id,status,slip_url,slip_uploaded_at,total_amount,paid_amount,due_date,slip_rejections",
    )
    .eq("id", invoiceId)
    .single();
  if (fetchError || !invoice) {
    throw new Error(fetchError?.message ?? "Invoice not found.");
  }

  const previousStatus = String((invoice as any).status ?? "");
  if (!DECLINABLE_STATUSES.includes(previousStatus)) {
    throw new Error("This invoice has no payment slip awaiting verification.");
  }

  // Put the invoice back where it belongs given what's actually been paid so
  // far — an invoice with a partial payment returns to `partial`, an unpaid one
  // past its due date returns to `overdue`, not a blanket `pending`.
  const todayText = new Date().toISOString().slice(0, 10);
  const nextStatus = resolveInvoiceStatus(
    {
      total_amount: toNumber((invoice as any).total_amount),
      paid_amount: toNumber((invoice as any).paid_amount),
      due_date: (invoice as any).due_date,
    },
    todayText,
  );

  const existingRejections = Array.isArray((invoice as any).slip_rejections)
    ? (invoice as any).slip_rejections
    : [];
  const rejectedSlipUrl = ((invoice as any).slip_url as string | null) ?? null;
  const nextRejections = [
    ...existingRejections,
    {
      rejected_at: new Date().toISOString(),
      reason,
      reviewed_by: reviewedBy,
      slip_url: rejectedSlipUrl,
      slip_uploaded_at: (invoice as any).slip_uploaded_at ?? null,
      previous_status: previousStatus,
    },
  ];

  const { data: updatedInvoice, error: updateError } = await supabase
    .from("invoices")
    .update({
      status: nextStatus,
      slip_url: null,
      slip_uploaded_at: null,
      slip_rejections: nextRejections,
    })
    .eq("id", invoiceId)
    .select("*")
    .single();
  if (updateError) throw new Error(updateError.message);

  return {
    invoiceId,
    tenantId: ((invoice as any).tenant_id as string | null) ?? null,
    previousStatus,
    nextStatus,
    reason,
    rejectedSlipUrl,
    updatedInvoice,
  };
}
