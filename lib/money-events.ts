import type { SupabaseClient } from "@supabase/supabase-js";

export type MoneyEventInput = {
  /** Short stable name, e.g. "payment.void", "invoice.delete", "tenant.delete". */
  action: string;
  actorUserId?: string | null;
  tenantId?: string | null;
  invoiceId?: string | null;
  paymentBatchId?: string | null;
  roomId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Where it came from, e.g. "admin_webapp" or "admin_liff". */
  source?: string | null;
};

/**
 * Append one row to money_events (the audit log). Best-effort: a logging
 * failure is reported to the server console but never fails or reverses the
 * action it describes — the action already happened.
 */
export async function recordMoneyEvent(
  supabase: SupabaseClient,
  event: MoneyEventInput,
): Promise<void> {
  try {
    const { error } = await supabase.from("money_events").insert({
      action: event.action,
      actor_user_id: event.actorUserId ?? null,
      tenant_id: event.tenantId ?? null,
      invoice_id: event.invoiceId ?? null,
      payment_batch_id: event.paymentBatchId ?? null,
      room_id: event.roomId ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
      reason: event.reason ?? null,
      source: event.source ?? null,
    });
    if (error) console.error("[money_events] insert failed:", event.action, error.message);
  } catch (err) {
    console.error("[money_events] insert threw:", event.action, err);
  }
}
