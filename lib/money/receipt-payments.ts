/**
 * Display-only split of an invoice's payment_history cache into payments that
 * count as received and payments that were reversed (voided). A void appends a
 * `type: "void"` entry pointing at the batch (payment_batch_id); the original
 * entry stays in the list, so it must be recognised and NOT counted.
 */
export type ReceiptHistoryEntry = Record<string, any>;

export type ClassifiedReceiptPayments = {
  active: ReceiptHistoryEntry[];
  reversed: Array<ReceiptHistoryEntry & { reversedReason: string | null }>;
  /** paid_at of the latest payment that still counts, or null. */
  lastActivePaidAt: string | null;
};

export function classifyReceiptPayments(history: unknown): ClassifiedReceiptPayments {
  const list: ReceiptHistoryEntry[] = Array.isArray(history) ? history : [];
  const voidedBatches = new Map<string, string | null>();
  for (const e of list) {
    if (String(e?.type ?? "") === "void" && e.payment_batch_id) {
      voidedBatches.set(String(e.payment_batch_id), e.reason ?? null);
    }
  }
  const active: ReceiptHistoryEntry[] = [];
  const reversed: ClassifiedReceiptPayments["reversed"] = [];
  for (const e of list) {
    if (String(e?.type ?? "") === "void") continue;
    const batch = e?.payment_batch_id ? String(e.payment_batch_id) : null;
    const isReversed = !!e?.reversed_at || (batch != null && voidedBatches.has(batch));
    if (isReversed) {
      reversed.push({ ...e, reversedReason: (batch != null ? voidedBatches.get(batch) : null) ?? e?.reversal_reason ?? null });
    } else {
      active.push(e);
    }
  }
  const last = active[active.length - 1];
  return { active, reversed, lastActivePaidAt: last?.paid_at ?? null };
}
