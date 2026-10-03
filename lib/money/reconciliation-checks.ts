import { isPaidWithCarriedIn, settledCarriedInAmount, type CarryInLink } from "@/lib/money/carry-in";
/**
 * Money reconciliation checks - pure functions over plain row arrays.
 *
 * REPORT ONLY. Nothing here talks to a database, and nothing returns a "fix"
 * that a caller is expected to apply: each finding carries a human-readable
 * explanation and a suggested next step for a person to review. See CLAUDE.md
 * (the fake-receipt incident) and the forward-fix-not-retroactive rule: an
 * automated job that "repairs" what it finds is the same failure mode again.
 *
 * Amounts are compared in whole satang (integers) so sums never drift.
 * A difference of less than one satang is treated as equal.
 */

export type Severity = "high" | "medium" | "low";

export type CheckName =
  | "batch_vs_allocations"
  | "invoice_paid_vs_allocations"
  | "orphan_allocation"
  | "batch_without_allocations"
  | "payment_history_mismatch"
  | "status_vs_balance"
  | "carry_forward"
  | "missing_money_event"
  | "missing_account_snapshot";

export type ReconciliationFinding = {
  id: string;
  check: CheckName;
  severity: Severity;
  /** The size of the discrepancy in baht (absolute), or the amount at stake. */
  amount: number;
  tenantId?: string;
  roomId?: string;
  invoiceId?: string;
  batchId?: string;
  explanation: string;
  suggestedNextStep: string;
};

export type InvoiceRow = {
  id: string;
  tenant_id?: string | null;
  room_id?: string | null;
  status?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  locked_late_fee_amount?: number | string | null;
  /** JSON array (or its string form) of display-cache payment entries. */
  payment_history?: unknown;
};

export type BatchRow = {
  id: string;
  tenant_id?: string | null;
  room_id?: string | null;
  amount_received?: number | string | null;
  amount_allocated?: number | string | null;
  paid_at?: string | null;
  voided_at?: string | null;
  payment_method_snapshot?: unknown;
};

export type AllocationRow = {
  id: string;
  payment_batch_id?: string | null;
  invoice_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  /** Negative rows are void reversals. */
  amount?: number | string | null;
  reverses_allocation_id?: string | null;
  paid_at?: string | null;
  payment_method_snapshot?: unknown;
};

export type CarryForwardRow = {
  id?: string;
  source_invoice_id: string;
  target_invoice_id: string;
  amount?: number | string | null;
  carried_amount?: number | string | null;
};

export type MoneyEventRow = {
  id?: string;
  invoice_id?: string | null;
  batch_id?: string | null;
  payment_batch_id?: string | null;
};

export type ReconciliationInput = {
  invoices: InvoiceRow[];
  batches: BatchRow[];
  allocations: AllocationRow[];
  carryForwards: CarryForwardRow[];
  /** Omit to skip the audit-trail check (it cannot be judged without the log). */
  moneyEvents?: MoneyEventRow[];
};

const toSatang = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const baht = (satang: number) => Math.abs(satang) / 100;
const fmt = (satang: number) => (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hasValue = (v: unknown) => v !== null && v !== undefined && v !== "";
const isBlankSnapshot = (v: unknown) =>
  v === null || v === undefined || (typeof v === "object" && Object.keys(v as object).length === 0);

function parseHistory(raw: unknown): Array<Record<string, unknown>> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((e): e is Record<string, unknown> => !!e && typeof e === "object") : [];
}

export function runReconciliation(input: ReconciliationInput): ReconciliationFinding[] {
  const { invoices, batches, allocations, carryForwards, moneyEvents } = input;
  const findings: ReconciliationFinding[] = [];

  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const batchById = new Map(batches.map((b) => [b.id, b]));

  // Net and gross allocation sums, indexed once.
  const netByBatch = new Map<string, number>();
  const countByBatch = new Map<string, number>();
  const netByInvoice = new Map<string, number>();
  const grossByBatchInvoice = new Map<string, number>();
  for (const a of allocations) {
    const amt = toSatang(a.amount);
    if (a.payment_batch_id) {
      netByBatch.set(a.payment_batch_id, (netByBatch.get(a.payment_batch_id) ?? 0) + amt);
      countByBatch.set(a.payment_batch_id, (countByBatch.get(a.payment_batch_id) ?? 0) + 1);
      if (a.invoice_id && amt > 0 && !a.reverses_allocation_id) {
        const k = `${a.payment_batch_id}|${a.invoice_id}`;
        grossByBatchInvoice.set(k, (grossByBatchInvoice.get(k) ?? 0) + amt);
      }
    }
    if (a.invoice_id) netByInvoice.set(a.invoice_id, (netByInvoice.get(a.invoice_id) ?? 0) + amt);
  }

  // (1) batch received vs allocations; a voided batch must net to zero
  for (const b of batches) {
    const received = toSatang(b.amount_received);
    const net = netByBatch.get(b.id) ?? 0;
    const common = { tenantId: b.tenant_id ?? undefined, roomId: b.room_id ?? undefined, batchId: b.id };

    if (hasValue(b.voided_at)) {
      if (net !== 0) {
        findings.push({
          id: `batch_vs_allocations:${b.id}:void`,
          check: "batch_vs_allocations",
          severity: "high",
          amount: baht(net),
          ...common,
          explanation: `Batch is voided but its allocations net to ${fmt(net)} instead of 0, so the void reversed ${net > 0 ? "too little" : "too much"}.`,
          suggestedNextStep: "Review the batch's allocation rows and its void event; a voided batch must be fully reversed.",
        });
      }
      continue;
    }

    if (net > received) {
      findings.push({
        id: `batch_vs_allocations:${b.id}:over`,
        check: "batch_vs_allocations",
        severity: "high",
        amount: baht(net - received),
        ...common,
        explanation: `Allocations total ${fmt(net)} but only ${fmt(received)} was received; ${fmt(net - received)} was applied that no one paid.`,
        suggestedNextStep: "Compare against the slip and bank statement, then review which allocation rows are unbacked.",
      });
    } else if (hasValue(b.amount_allocated) && toSatang(b.amount_allocated) !== net) {
      const stored = toSatang(b.amount_allocated);
      findings.push({
        id: `batch_vs_allocations:${b.id}:stored`,
        check: "batch_vs_allocations",
        severity: "medium",
        amount: baht(stored - net),
        ...common,
        explanation: `Batch says ${fmt(stored)} was allocated, but its allocation rows sum to ${fmt(net)} (received ${fmt(received)}, so unapplied credit by rows is ${fmt(received - net)}).`,
        suggestedNextStep: "Decide whether the batch total or the allocation rows is correct before anything is changed.",
      });
    }
  }

  // (2) invoice paid_amount vs allocations
  for (const inv of invoices) {
    const paid = toSatang(inv.paid_amount);
    const net = netByInvoice.get(inv.id) ?? 0;
    if (paid === net) continue;
    findings.push({
      id: `invoice_paid_vs_allocations:${inv.id}`,
      check: "invoice_paid_vs_allocations",
      severity: paid > net ? "high" : "medium",
      amount: baht(paid - net),
      tenantId: inv.tenant_id ?? undefined,
      roomId: inv.room_id ?? undefined,
      invoiceId: inv.id,
      explanation: `paid_amount is ${fmt(paid)} but allocations (net of voids) total ${fmt(net)}.${
        paid > net ? " Money is shown as received with no recorded payment behind it." : " Recorded payments are not reflected on the invoice."
      }`,
      suggestedNextStep: "Check whether this is a pre-ledger legacy payment or a real drift; confirm with slips and bank statements.",
    });
  }

  // (3) orphans
  for (const a of allocations) {
    if (a.payment_batch_id && batchById.has(a.payment_batch_id)) continue;
    const inv = a.invoice_id ? invoiceById.get(a.invoice_id) : undefined;
    findings.push({
      id: `orphan_allocation:${a.id}`,
      check: "orphan_allocation",
      severity: "high",
      amount: baht(toSatang(a.amount)),
      tenantId: a.tenant_id ?? inv?.tenant_id ?? undefined,
      roomId: a.room_id ?? inv?.room_id ?? undefined,
      invoiceId: a.invoice_id ?? undefined,
      batchId: a.payment_batch_id ?? undefined,
      explanation: a.payment_batch_id
        ? `Allocation points at batch ${a.payment_batch_id}, which does not exist.`
        : "Allocation has no payment batch, so there is no receipt behind it.",
      suggestedNextStep: "Find the original payment (slip / bank line) and decide whether the allocation is real before touching it.",
    });
  }
  for (const b of batches) {
    if ((countByBatch.get(b.id) ?? 0) > 0 || hasValue(b.voided_at)) continue;
    const allocated = toSatang(b.amount_allocated);
    findings.push({
      id: `batch_without_allocations:${b.id}`,
      check: "batch_without_allocations",
      severity: allocated > 0 ? "medium" : "low",
      amount: baht(allocated > 0 ? allocated : toSatang(b.amount_received)),
      tenantId: b.tenant_id ?? undefined,
      roomId: b.room_id ?? undefined,
      batchId: b.id,
      explanation:
        allocated > 0
          ? `Batch claims ${fmt(allocated)} allocated but has no allocation rows.`
          : `Batch received ${fmt(toSatang(b.amount_received))} but nothing was applied to any invoice (held entirely as unapplied credit).`,
      suggestedNextStep: "Confirm whether the money should be applied to an invoice or is intentionally held as credit.",
    });
  }

  // (4) payment_history entries vs batches
  for (const inv of invoices) {
    for (const [idx, entry] of parseHistory(inv.payment_history).entries()) {
      const batchId = (entry.payment_batch_id ?? entry.batch_id) as string | null | undefined;
      if (!batchId) continue; // legacy entry written before batches existed
      const base = {
        tenantId: inv.tenant_id ?? undefined,
        roomId: inv.room_id ?? undefined,
        invoiceId: inv.id,
        batchId: String(batchId),
      };
      const entryAmt = toSatang(entry.amount);
      if (!batchById.has(String(batchId))) {
        findings.push({
          id: `payment_history_mismatch:${inv.id}:${idx}:missing`,
          check: "payment_history_mismatch",
          severity: "high",
          amount: baht(entryAmt),
          ...base,
          explanation: `Payment history entry ${idx + 1} references batch ${batchId}, which does not exist.`,
          suggestedNextStep: "The history is a display cache; find out whether the batch was deleted or the entry was never backed by one.",
        });
        continue;
      }
      const gross = grossByBatchInvoice.get(`${batchId}|${inv.id}`) ?? 0;
      if (gross !== entryAmt) {
        findings.push({
          id: `payment_history_mismatch:${inv.id}:${idx}:amount`,
          check: "payment_history_mismatch",
          severity: "medium",
          amount: baht(entryAmt - gross),
          ...base,
          explanation: `Payment history entry ${idx + 1} says ${fmt(entryAmt)} but batch ${batchId} allocated ${fmt(gross)} to this invoice.`,
          suggestedNextStep: "Treat the allocation row as the record; decide whether the cached history entry needs regenerating.",
        });
      }
    }
  }

  // (5) status vs balance
  // A carry-forward target counts as paid when its own paid amount plus the carried-in
  // amount whose SOURCE invoice is fully settled covers the total (same rule as
  // record_payment_batch / money_derive_invoice_status_cf; see lib/money/carry-in.ts).
  const carryLinksByTarget = new Map<string, CarryInLink[]>();
  for (const c of carryForwards) {
    const list = carryLinksByTarget.get(c.target_invoice_id) ?? [];
    list.push({ source_invoice_id: c.source_invoice_id, amount: Number(c.amount ?? c.carried_amount ?? 0) });
    carryLinksByTarget.set(c.target_invoice_id, list);
  }
  const carrySources = new Map(
    invoices.map((i) => [i.id, { id: i.id, total_amount: i.total_amount, paid_amount: i.paid_amount, status: i.status }]),
  );
  for (const inv of invoices) {
    const status = String(inv.status ?? "").toLowerCase();
    const total = toSatang(inv.total_amount);
    const paid = toSatang(inv.paid_amount);
    const carriedIn = settledCarriedInAmount(carryLinksByTarget.get(inv.id) ?? [], carrySources);
    const paidByCarry = paid < total && isPaidWithCarriedIn(inv.total_amount, inv.paid_amount, carriedIn);
    let problem: { sev: Severity; text: string } | null = null;
    if (status === "paid" && paid < total && !paidByCarry) {
      problem = { sev: "high", text: `Status is paid but only ${fmt(paid)} of ${fmt(total)} is recorded as paid.` };
    } else if (status === "partial" && paid <= 0) {
      problem = { sev: "medium", text: `Status is partial but nothing (${fmt(paid)}) has been paid.` };
    } else if (paidByCarry && ["pending", "overdue", "partial"].includes(status)) {
      problem = {
        sev: "medium",
        text: `Status is ${status} but paid ${fmt(paid)} plus ${fmt(toSatang(carriedIn))} carried in from settled invoices already covers the total ${fmt(total)}.`,
      };
    } else if ((status === "pending" || status === "overdue") && total > 0 && paid >= total) {
      problem = { sev: "medium", text: `Status is ${status} but paid ${fmt(paid)} already covers the total ${fmt(total)}.` };
    }
    if (!problem) continue;
    findings.push({
      id: `status_vs_balance:${inv.id}`,
      check: "status_vs_balance",
      severity: problem.sev,
      amount: baht(total - paid),
      tenantId: inv.tenant_id ?? undefined,
      roomId: inv.room_id ?? undefined,
      invoiceId: inv.id,
      explanation: problem.text,
      suggestedNextStep: "Status never moves money (see CLAUDE.md); confirm the real balance from payments, then decide which of status or paid_amount is wrong.",
    });
  }

  // (6) carry-forwards
  const cfAmount = (c: CarryForwardRow) => toSatang(c.amount ?? c.carried_amount);
  const seenPair = new Map<string, number>();
  const bySource = new Map<string, CarryForwardRow[]>();
  for (const c of carryForwards) {
    const key = `${c.source_invoice_id}|${c.target_invoice_id}`;
    seenPair.set(key, (seenPair.get(key) ?? 0) + 1);
    bySource.set(c.source_invoice_id, [...(bySource.get(c.source_invoice_id) ?? []), c]);
  }
  for (const [key, n] of seenPair) {
    if (n < 2) continue;
    const [source, target] = key.split("|");
    const src = invoiceById.get(source);
    findings.push({
      id: `carry_forward:dup:${source}:${target}`,
      check: "carry_forward",
      severity: "high",
      amount: baht(
        carryForwards
          .filter((c) => c.source_invoice_id === source && c.target_invoice_id === target)
          .slice(1)
          .reduce((s, c) => s + cfAmount(c), 0)
      ),
      tenantId: src?.tenant_id ?? undefined,
      roomId: src?.room_id ?? undefined,
      invoiceId: source,
      explanation: `Invoice ${source} is carried into ${target} ${n} times, so the debt can be billed more than once.`,
      suggestedNextStep: "Check target invoice's carry-forward line and total; do not delete rows until the correct one is identified.",
    });
  }
  for (const [source, rows] of bySource) {
    const src = invoiceById.get(source);
    if (!src) continue;
    const carried = rows.reduce((s, c) => s + cfAmount(c), 0);
    const outstanding = Math.max(0, toSatang(src.total_amount) - toSatang(src.paid_amount));
    if (carried <= outstanding) continue;
    findings.push({
      id: `carry_forward:exceeds:${source}`,
      check: "carry_forward",
      severity: "medium",
      amount: baht(carried - outstanding),
      tenantId: src.tenant_id ?? undefined,
      roomId: src.room_id ?? undefined,
      invoiceId: source,
      explanation: `${fmt(carried)} is carried forward from this invoice but it only has ${fmt(outstanding)} outstanding. If it was paid after being carried, the target may still bill the old debt.`,
      suggestedNextStep: "Compare the target invoice's carried line to the source's current balance and decide which is authoritative.",
    });
  }

  // (7) money_events audit trail (only when the log was supplied)
  if (moneyEvents) {
    const eventInvoices = new Set<string>();
    const eventBatches = new Set<string>();
    for (const e of moneyEvents) {
      if (e.invoice_id) eventInvoices.add(e.invoice_id);
      const b = e.batch_id ?? e.payment_batch_id;
      if (b) eventBatches.add(b);
    }
    const batchesByInvoice = new Map<string, Set<string>>();
    for (const a of allocations) {
      if (!a.invoice_id || !a.payment_batch_id) continue;
      if (!batchesByInvoice.has(a.invoice_id)) batchesByInvoice.set(a.invoice_id, new Set());
      batchesByInvoice.get(a.invoice_id)!.add(a.payment_batch_id);
    }
    for (const inv of invoices) {
      const paid = toSatang(inv.paid_amount);
      if (paid <= 0) continue; // total-only drift cannot be judged from a log alone
      if (eventInvoices.has(inv.id)) continue;
      if ([...(batchesByInvoice.get(inv.id) ?? [])].some((b) => eventBatches.has(b))) continue;
      findings.push({
        id: `missing_money_event:${inv.id}`,
        check: "missing_money_event",
        severity: "low",
        amount: baht(paid),
        tenantId: inv.tenant_id ?? undefined,
        roomId: inv.room_id ?? undefined,
        invoiceId: inv.id,
        explanation: `Invoice shows ${fmt(paid)} paid but no money_events row mentions it or any batch that paid it, so the change has no audit trail.`,
        suggestedNextStep: "Likely pre-audit-log history; if the payment is recent, find which route wrote it without logging.",
      });
    }
  }

  // (8) allocations with no frozen account
  for (const a of allocations) {
    const amt = toSatang(a.amount);
    if (amt <= 0 || a.reverses_allocation_id || !isBlankSnapshot(a.payment_method_snapshot)) continue;
    const inv = a.invoice_id ? invoiceById.get(a.invoice_id) : undefined;
    findings.push({
      id: `missing_account_snapshot:${a.id}`,
      check: "missing_account_snapshot",
      severity: "low",
      amount: baht(amt),
      tenantId: a.tenant_id ?? inv?.tenant_id ?? undefined,
      roomId: a.room_id ?? inv?.room_id ?? undefined,
      invoiceId: a.invoice_id ?? undefined,
      batchId: a.payment_batch_id ?? undefined,
      explanation: "Allocation has no payment_method_snapshot; the receiving account is unknown and cannot be recovered from current settings.",
      suggestedNextStep: "Report as 'unknown account'. Only the bank statement can say where this money landed; do not infer it from the tenant's current account.",
    });
  }

  return findings;
}

export const FINDING_CSV_COLUMNS = [
  "id",
  "check",
  "severity",
  "amount",
  "tenantId",
  "roomId",
  "invoiceId",
  "batchId",
  "explanation",
  "suggestedNextStep",
] as const;

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let s = String(value);
  // Neutralise spreadsheet formula injection on text cells (numbers stay as-is).
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function findingsToCsv(findings: ReconciliationFinding[]): string {
  const lines: string[] = [FINDING_CSV_COLUMNS.join(",")];
  for (const f of findings) {
    lines.push(FINDING_CSV_COLUMNS.map((c) => csvCell(f[c])).join(","));
  }
  return lines.join("\r\n");
}
