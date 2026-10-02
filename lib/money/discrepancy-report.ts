/**
 * Pure parts of the read-only historical discrepancy report (Phase 9.1-9.3).
 *
 * Nothing here touches a database or the filesystem. The runnable wrapper is
 * scripts/discrepancy-report.ts. REPORT ONLY: nothing in this file (or the
 * report it renders) repairs, infers or applies anything. Missing receipts,
 * receiving accounts and refunds are never inferred.
 */
import type { CheckName, ReconciliationFinding, Severity } from "@/lib/money/reconciliation-checks";

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

/** Builder methods that read or shape a SELECT. Anything else on a builder is refused. */
const ALLOWED_BUILDER_METHODS = new Set([
  "select", "order", "range", "limit", "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike",
  "is", "in", "not", "or", "filter", "match", "contains", "containedBy", "single", "maybeSingle",
  "abortSignal", "csv", "then", "catch", "finally",
]);

/** Client-level members that are allowed. Everything else (rpc, auth, storage, functions...) is refused. */
const ALLOWED_CLIENT_METHODS = new Set(["from"]);

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`READ-ONLY GUARD: "${what}" is not allowed. This tool only issues SELECT queries.`);
    this.name = "ReadOnlyViolation";
  }
}

function guardBuilder(builder: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop === "symbol" || typeof value !== "function") return value;
      if (!ALLOWED_BUILDER_METHODS.has(prop)) throw new ReadOnlyViolation(prop);
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        // Wrap chained builders; leave promises (from then/catch/finally) alone.
        if (prop === "then" || prop === "catch" || prop === "finally") return result;
        return result && typeof result === "object" ? guardBuilder(result) : result;
      };
    },
  });
}

/** Wrap a supabase-js client so only `from(...).select(...)`-style reads can ever run. */
export function createReadOnlyClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop === "symbol") return value;
      if (!ALLOWED_CLIENT_METHODS.has(prop)) throw new ReadOnlyViolation(prop);
      return (...args: unknown[]) => guardBuilder(Reflect.apply(value as any, target, args));
    },
  }) as T;
}

// ---------------------------------------------------------------------------
// CLI / env helpers
// ---------------------------------------------------------------------------

export type ReportArgs = { out?: string; redact: boolean };

export function parseArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { redact: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--redact") args.redact = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--out needs a directory");
      args.out = v;
    } else if (a.startsWith("--out=")) args.out = a.slice(6);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

export const defaultOutDir = (date: Date) => `./discrepancy-report-${date.toISOString().slice(0, 10)}`;

export function isReadOnlyConfirmed(env: Record<string, string | undefined>): boolean {
  return env.DISCREPANCY_CONFIRM_READONLY === "yes";
}

export function hostOf(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable url)";
  }
}

// ---------------------------------------------------------------------------
// Categorisation
// ---------------------------------------------------------------------------

export type LegacyKind =
  | "legacy_paid_no_allocation"
  | "legacy_batch_zero_allocated"
  | "legacy_no_account_snapshot"
  | "legacy_no_audit_trail";

export const LEGACY_LABELS: Record<LegacyKind, string> = {
  legacy_paid_no_allocation: "legacy, no receipt record (paid_amount with no allocation at all)",
  legacy_batch_zero_allocated: "legacy batch (amount_allocated recorded as 0 while allocation rows exist)",
  legacy_no_account_snapshot: "legacy, receiving account unknown (no payment_method_snapshot)",
  legacy_no_audit_trail: "legacy, no audit-log row (pre money_events)",
};

export type Categorised = { check: CheckName; severity: Severity; legacy: LegacyKind | null };

/**
 * Category is the check that produced the finding. Separately, findings that
 * are the *expected* shape of pre-ledger data are flagged legacy. Legacy means
 * "an old record from before receipts existed" - never "a missing receipt to
 * be created".
 */
export function categorise(f: ReconciliationFinding): Categorised {
  let legacy: LegacyKind | null = null;
  if (f.check === "invoice_paid_vs_allocations" && /allocations \(net of voids\) total 0\.00\./.test(f.explanation)) {
    legacy = "legacy_paid_no_allocation";
  } else if (f.check === "batch_vs_allocations" && f.id.endsWith(":stored") && /^Batch says 0\.00 was allocated/.test(f.explanation)) {
    legacy = "legacy_batch_zero_allocated";
  } else if (f.check === "missing_account_snapshot") {
    legacy = "legacy_no_account_snapshot";
  } else if (f.check === "missing_money_event") {
    legacy = "legacy_no_audit_trail";
  }
  return { check: f.check, severity: f.severity, legacy };
}

export const ALL_CHECKS: CheckName[] = [
  "batch_vs_allocations",
  "invoice_paid_vs_allocations",
  "orphan_allocation",
  "batch_without_allocations",
  "payment_history_mismatch",
  "status_vs_balance",
  "carry_forward",
  "missing_money_event",
  "missing_account_snapshot",
];

const SEVERITIES: Severity[] = ["high", "medium", "low"];
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type CategoryStats = {
  check: CheckName;
  count: number;
  amount: number;
  bySeverity: Record<Severity, { count: number; amount: number }>;
};

const emptyStats = (check: CheckName): CategoryStats => ({
  check,
  count: 0,
  amount: 0,
  bySeverity: { high: { count: 0, amount: 0 }, medium: { count: 0, amount: 0 }, low: { count: 0, amount: 0 } },
});

export function categoryStats(findings: ReconciliationFinding[]): CategoryStats[] {
  const map = new Map<CheckName, CategoryStats>(ALL_CHECKS.map((c) => [c, emptyStats(c)]));
  for (const f of findings) {
    let s = map.get(f.check);
    if (!s) {
      s = emptyStats(f.check);
      map.set(f.check, s);
    }
    s.count++;
    s.amount = round2(s.amount + f.amount);
    s.bySeverity[f.severity].count++;
    s.bySeverity[f.severity].amount = round2(s.bySeverity[f.severity].amount + f.amount);
  }
  return [...map.values()];
}

export function topRooms(findings: ReconciliationFinding[], limit = 10) {
  const rooms = new Map<string, { roomId: string; count: number; amount: number; high: number }>();
  for (const f of findings) {
    const key = f.roomId ?? "(no room)";
    const r = rooms.get(key) ?? { roomId: key, count: 0, amount: 0, high: 0 };
    r.count++;
    r.amount = round2(r.amount + f.amount);
    if (f.severity === "high") r.high++;
    rooms.set(key, r);
  }
  const all = [...rooms.values()];
  return {
    byAmount: [...all].sort((a, b) => b.amount - a.amount || a.roomId.localeCompare(b.roomId)).slice(0, limit),
    byCount: [...all].sort((a, b) => b.count - a.count || a.roomId.localeCompare(b.roomId)).slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export type RedactOptions = {
  /** Optional known tenants; their names and phones are scrubbed from free text. */
  tenants?: Array<{ id: string; name?: string | null; phone?: string | null }>;
};

const THAI_PHONE = /(?<!\d)(?:\+66|0)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}(?!\d)/g;

/**
 * Replace tenant identifiers with stable pseudonyms (T-001...), assigned by
 * sorted tenant id so the same data always yields the same mapping. Known
 * names/phones (if supplied) and anything phone-shaped in free text are scrubbed.
 */
export function redactFindings(findings: ReconciliationFinding[], opts: RedactOptions = {}) {
  const ids = new Set<string>();
  for (const f of findings) if (f.tenantId) ids.add(f.tenantId);
  for (const t of opts.tenants ?? []) ids.add(t.id);
  const pseudonyms = new Map([...ids].sort().map((id, i) => [id, `T-${String(i + 1).padStart(3, "0")}`] as const));

  const literals: Array<[string, string]> = [];
  for (const t of opts.tenants ?? []) {
    const p = pseudonyms.get(t.id)!;
    if (t.name && t.name.trim().length >= 2) literals.push([t.name.trim(), p]);
    if (t.phone && t.phone.trim().length >= 5) literals.push([t.phone.trim(), `[phone ${p}]`]);
  }
  literals.sort((a, b) => b[0].length - a[0].length);

  const scrub = (text: string) => {
    let out = text;
    for (const [lit, rep] of literals) out = out.split(lit).join(rep);
    for (const [id, p] of pseudonyms) out = out.split(id).join(p);
    return out.replace(THAI_PHONE, "[phone]");
  };

  const redacted: ReconciliationFinding[] = findings.map((f) => ({
    ...f,
    tenantId: f.tenantId ? pseudonyms.get(f.tenantId) : undefined,
    explanation: scrub(f.explanation),
    suggestedNextStep: scrub(f.suggestedNextStep),
  }));
  return { findings: redacted, pseudonyms, scrub };
}

// ---------------------------------------------------------------------------
// summary.md
// ---------------------------------------------------------------------------

export type SummaryContext = { generatedAt: string; host: string; redacted: boolean };

export function renderSummary(findings: ReconciliationFinding[], ctx: SummaryContext): string {
  const stats = categoryStats(findings);
  const lines: string[] = [];
  lines.push("# Discrepancy report - summary", "");
  lines.push(`- Generated: ${ctx.generatedAt}`);
  lines.push(`- Source database host: ${ctx.host}`);
  lines.push(`- Redacted: ${ctx.redacted ? "yes (tenant identifiers replaced with T-001...)" : "NO - contains real tenant data"}`);
  lines.push(`- Total findings: ${findings.length}`);
  lines.push(
    "",
    "**Read-only.** Nothing was changed. Amounts are in baht. A finding is a question for a person, not proof of a missing or wrong payment.",
    ""
  );

  lines.push("## Counts and amounts by severity", "", "| Severity | Findings | Amount at stake |", "|---|---:|---:|");
  for (const sev of SEVERITIES) {
    const subset = findings.filter((f) => f.severity === sev);
    lines.push(`| ${sev} | ${subset.length} | ${money(round2(subset.reduce((s, f) => s + f.amount, 0)))} |`);
  }

  lines.push("", "## Counts and amounts by category", "", "| Category | High | Medium | Low | Total | Amount at stake |", "|---|---:|---:|---:|---:|---:|");
  for (const s of stats) {
    lines.push(`| ${s.check} | ${s.bySeverity.high.count} | ${s.bySeverity.medium.count} | ${s.bySeverity.low.count} | ${s.count} | ${money(s.amount)} |`);
  }

  const tops = topRooms(findings);
  const roomTable = (rows: ReturnType<typeof topRooms>["byAmount"]) => {
    const out = ["| Room | Findings | High | Amount at stake |", "|---|---:|---:|---:|"];
    for (const r of rows) out.push(`| ${r.roomId} | ${r.count} | ${r.high} | ${money(r.amount)} |`);
    return out;
  };
  lines.push("", "## Top rooms by amount at stake", "", ...roomTable(tops.byAmount));
  lines.push("", "## Top rooms by number of findings", "", ...roomTable(tops.byCount));

  lines.push(
    "",
    "## Legacy-category findings",
    "",
    "These are the expected shape of data from before receipts, account snapshots or the audit log existed. They are reported as **legacy** and are never inferred to be missing receipts, unknown deposits or refunds owed. The real account / receipt, if it exists, lives only on paper slips and bank statements.",
    ""
  );
  const LIST_CAP = 200;
  let anyLegacy = false;
  for (const kind of Object.keys(LEGACY_LABELS) as LegacyKind[]) {
    const subset = findings.filter((f) => categorise(f).legacy === kind);
    if (subset.length === 0) continue;
    anyLegacy = true;
    lines.push(
      `### ${LEGACY_LABELS[kind]}`,
      "",
      `${subset.length} finding(s), ${money(round2(subset.reduce((s, f) => s + f.amount, 0)))} baht.`,
      "",
      "| Finding id | Room | Invoice | Amount |",
      "|---|---|---|---:|"
    );
    for (const f of subset.slice(0, LIST_CAP)) lines.push(`| ${f.id} | ${f.roomId ?? ""} | ${f.invoiceId ?? ""} | ${money(f.amount)} |`);
    if (subset.length > LIST_CAP) lines.push("", `(${subset.length - LIST_CAP} more in findings.csv)`);
    lines.push("");
  }
  if (!anyLegacy) lines.push("None.", "");

  const nonLegacyHigh = findings.filter((f) => f.severity === "high" && !categorise(f).legacy);
  lines.push("## High-severity findings that are NOT legacy", "", `${nonLegacyHigh.length} finding(s). These deserve a human look first; see findings.csv.`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// proposed-repairs.md
// ---------------------------------------------------------------------------

type RepairSpec = { what: string; preview: string; risk: string };

export const REPAIRS: Record<CheckName, RepairSpec> = {
  batch_vs_allocations: {
    what:
      "Per affected batch, a human decides which side is right (batch totals vs allocation rows) from the slip and bank statement. If the batch header is wrong, correct amount_allocated to the allocation sum; if the rows are wrong, add a reversing allocation row. Voided batches that do not net to zero get a balancing reversal row. No row is deleted.",
    preview: `select b.id, b.tenant_id, b.amount_received, b.amount_allocated, b.voided_at,
       coalesce(sum(a.amount), 0) as allocations_net
from payment_batches b
left join invoice_payment_allocations a on a.payment_batch_id = b.id
group by b.id
having (b.voided_at is not null and round(coalesce(sum(a.amount), 0), 2) <> 0)
    or (b.voided_at is null and (round(coalesce(sum(a.amount), 0), 2) > round(b.amount_received, 2)
        or (b.amount_allocated is not null and round(b.amount_allocated, 2) <> round(coalesce(sum(a.amount), 0), 2))));`,
    risk: "Medium. Fixing in the wrong direction invents or erases money. Legacy batches with amount_allocated = 0 are a separate, expected group; do not bulk-fix them.",
  },
  invoice_paid_vs_allocations: {
    what:
      "Where paid_amount exceeds allocations and there is NO allocation at all, label the invoice as legacy (no receipt record) in a new annotation; do not create a batch or allocation, and do not lower paid_amount. Where allocations exceed paid_amount, recompute paid_amount from net allocations after review. Nothing is created that looks like a receipt.",
    preview: `select i.id, i.room_id, i.tenant_id, i.status, i.total_amount, i.paid_amount,
       coalesce(sum(a.amount), 0) as allocations_net,
       count(a.id) as allocation_rows
from invoices i
left join invoice_payment_allocations a on a.invoice_id = i.id
group by i.id
having round(coalesce(i.paid_amount, 0), 2) <> round(coalesce(sum(a.amount), 0), 2);`,
    risk: "High if done in bulk: this is exactly the shape of the fake-receipt incident. Do NOT infer missing receipts. Legacy rows may be perfectly real cash payments taken before the ledger existed.",
  },
  orphan_allocation: {
    what:
      "Locate the real payment for each orphan (slip / bank line). If real, attach it to a correct batch (a new batch row written by the audited payment path); if not backed by anything, add a reversing allocation row. No delete.",
    preview: `select a.*
from invoice_payment_allocations a
left join payment_batches b on b.id = a.payment_batch_id
where b.id is null;`,
    risk: "High. An orphan may be the only trace of a real payment, or a fabricated one. Evidence first.",
  },
  batch_without_allocations: {
    what:
      "For batches that claim an allocated amount but have no rows, decide per batch whether to apply the money to an invoice through the normal allocation path, or correct amount_allocated to 0. Batches intentionally held as credit are left alone.",
    preview: `select b.*
from payment_batches b
where b.voided_at is null
  and not exists (select 1 from invoice_payment_allocations a where a.payment_batch_id = b.id);`,
    risk: "Medium. Applying credit changes invoice balances; confirm with the tenant's statement first.",
  },
  payment_history_mismatch: {
    what:
      "payment_history is a display cache. Regenerate the affected invoices' history entries from payment_batches / allocations. Allocation rows are the record; only the cache is rewritten, no money row changes. Entries whose batch is missing are listed for review, not deleted.",
    preview: `select i.id as invoice_id, e.idx, e.entry
from invoices i,
     jsonb_array_elements(i.payment_history::jsonb) with ordinality as e(entry, idx)
where coalesce(e.entry->>'payment_batch_id', e.entry->>'batch_id') is not null
  and (
    not exists (select 1 from payment_batches b
                where b.id::text = coalesce(e.entry->>'payment_batch_id', e.entry->>'batch_id'))
    or coalesce((e.entry->>'amount')::numeric, 0) <> coalesce((
         select sum(a.amount) from invoice_payment_allocations a
         where a.invoice_id = i.id and a.amount > 0 and a.reverses_allocation_id is null
           and a.payment_batch_id::text = coalesce(e.entry->>'payment_batch_id', e.entry->>'batch_id')), 0)
  );`,
    risk: "Low. Cache only, but an entry missing its batch may indicate a deleted payment; investigate before overwriting.",
  },
  status_vs_balance: {
    what:
      "Per invoice, decide whether status or paid_amount is wrong. If paid_amount is verified, set status to match (status changes never move money). If paid_amount is unverified, leave it and fix status only after the real balance is confirmed.",
    preview: `select id, room_id, tenant_id, status, total_amount, paid_amount
from invoices
where (lower(status) = 'paid' and paid_amount < total_amount)
   or (lower(status) = 'partial' and coalesce(paid_amount, 0) <= 0)
   or (lower(status) in ('pending', 'overdue') and total_amount > 0 and paid_amount >= total_amount);`,
    risk: "Low to medium. Status-only edits are reversible, but a status that disagrees with money may be hiding a payment problem; do not just flip it to quiet the report.",
  },
  carry_forward: {
    what:
      "Duplicates: keep the carry-forward row that matches the target invoice's carried line and mark the others superseded after confirming the target total. Exceeds-outstanding: compare the source's current balance with the target's carried line and recompute the target through the invoice total engine.",
    preview: `-- duplicate source -> target pairs
select source_invoice_id, target_invoice_id, count(*) as n, sum(amount) as total_carried
from invoice_carry_forwards
group by source_invoice_id, target_invoice_id
having count(*) > 1;

-- carried more than is still outstanding on the source
select cf.source_invoice_id, sum(cf.amount) as carried,
       greatest(0, i.total_amount - i.paid_amount) as outstanding
from invoice_carry_forwards cf
join invoices i on i.id = cf.source_invoice_id
group by cf.source_invoice_id, i.total_amount, i.paid_amount
having sum(cf.amount) > greatest(0, i.total_amount - i.paid_amount);`,
    risk: "High. These rows change what a tenant is billed. Never delete until the correct row is identified.",
  },
  missing_money_event: {
    what:
      "Mostly pre-audit-log history. Proposed: no change to money rows; record a one-time 'legacy, pre audit log' annotation. Only recent invoices (after the audit log began) merit investigation for a route that wrote money without logging.",
    preview: `select i.id, i.room_id, i.paid_amount
from invoices i
where coalesce(i.paid_amount, 0) > 0
  and not exists (select 1 from money_events e where e.invoice_id = i.id)
  and not exists (
    select 1 from invoice_payment_allocations a
    join money_events e on e.payment_batch_id = a.payment_batch_id
    where a.invoice_id = i.id);`,
    risk: "Low. Do not backfill fabricated events; an invented audit trail is worse than none.",
  },
  missing_account_snapshot: {
    what:
      "No change. Report these as 'unknown account'. The receiving account is unrecoverable from system data; only the bank statement can say. Never copy the tenant's current custom_payment_method or the default payment method onto old rows.",
    preview: `select a.id, a.payment_batch_id, a.invoice_id, a.amount, a.paid_at
from invoice_payment_allocations a
where a.amount > 0
  and a.reverses_allocation_id is null
  and (a.payment_method_snapshot is null or a.payment_method_snapshot = '{}'::jsonb);`,
    risk: "Medium if 'fixed' by inference: re-attributing money to the wrong account silently rewrites history. Leave as unknown unless the owner supplies bank-statement evidence per row.",
  },
};

export function renderProposedRepairs(findings: ReconciliationFinding[]): string {
  const stats = new Map(categoryStats(findings).map((s) => [s.check, s]));
  const lines: string[] = [];
  lines.push("# Proposed repairs (PROPOSALS ONLY)", "");
  lines.push(
    "**Nothing in this document has been applied. Every item below needs the owner's explicit approval, one category at a time, before any row is touched.** This tool only ran SELECTs.",
    ""
  );
  lines.push(
    "Standing rules for every category:",
    "",
    "- Do NOT infer missing receipts. A `paid_amount` with no allocation is 'legacy, no receipt record', not a payment to be manufactured.",
    "- Do NOT infer receiving accounts. No snapshot means 'unknown'; never derive it from current tenant or default settings.",
    "- Do NOT infer refunds. Over-allocation is a question to resolve with evidence, not an amount owed back.",
    "- Prefer reversing/adjustment rows and forward fixes over editing or deleting history; take a backup table first (as was done for the 2026-08-20 cleanup).",
    ""
  );
  for (const check of ALL_CHECKS) {
    const s = stats.get(check)!;
    if (s.count === 0) continue;
    const spec = REPAIRS[check];
    lines.push(
      `## ${check}`,
      "",
      `Findings: ${s.count} (high ${s.bySeverity.high.count}, medium ${s.bySeverity.medium.count}, low ${s.bySeverity.low.count}); amount at stake ${money(s.amount)} baht.`,
      "",
      "**What would change**",
      "",
      spec.what,
      "",
      "**Preview the affected rows (read-only SELECT, run it yourself)**",
      "",
      "```sql",
      spec.preview,
      "```",
      "",
      "**Risk**",
      "",
      spec.risk,
      "",
      "**Status:** NOT APPLIED. Requires the owner's approval.",
      ""
    );
  }
  if (findings.length === 0) lines.push("No findings; nothing to propose.", "");
  return lines.join("\n");
}
