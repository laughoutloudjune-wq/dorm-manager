import { describe, expect, it } from "vitest";
import type { ReconciliationFinding } from "@/lib/money/reconciliation-checks";
import {
  ReadOnlyViolation,
  categorise,
  categoryStats,
  createReadOnlyClient,
  hostOf,
  isReadOnlyConfirmed,
  parseArgs,
  redactFindings,
  renderProposedRepairs,
  renderSummary,
} from "@/lib/money/discrepancy-report";

const f = (over: Partial<ReconciliationFinding>): ReconciliationFinding => ({
  id: "x",
  check: "status_vs_balance",
  severity: "low",
  amount: 1,
  explanation: "e",
  suggestedNextStep: "s",
  ...over,
});

describe("categorise", () => {
  it("flags paid_amount with no allocation as legacy", () => {
    const c = categorise(
      f({ check: "invoice_paid_vs_allocations", severity: "high", explanation: "paid_amount is 5,000.00 but allocations (net of voids) total 0.00. Money is shown..." })
    );
    expect(c.legacy).toBe("legacy_paid_no_allocation");
  });
  it("does not flag real drift with allocations as legacy", () => {
    const c = categorise(
      f({ check: "invoice_paid_vs_allocations", explanation: "paid_amount is 5,000.00 but allocations (net of voids) total 3,000.00." })
    );
    expect(c.legacy).toBeNull();
  });
  it("flags zero-allocated batches, missing snapshots and missing events as legacy", () => {
    expect(categorise(f({ check: "batch_vs_allocations", id: "batch_vs_allocations:b:stored", explanation: "Batch says 0.00 was allocated, but" })).legacy).toBe("legacy_batch_zero_allocated");
    expect(categorise(f({ check: "batch_vs_allocations", id: "batch_vs_allocations:b:stored", explanation: "Batch says 500.00 was allocated, but" })).legacy).toBeNull();
    expect(categorise(f({ check: "missing_account_snapshot" })).legacy).toBe("legacy_no_account_snapshot");
    expect(categorise(f({ check: "missing_money_event" })).legacy).toBe("legacy_no_audit_trail");
  });
  it("never marks orphan allocations as legacy", () => {
    expect(categorise(f({ check: "orphan_allocation", severity: "high" })).legacy).toBeNull();
  });
});

describe("stats and rendering", () => {
  const findings = [
    f({ id: "1", check: "orphan_allocation", severity: "high", amount: 100.5, roomId: "R1" }),
    f({ id: "2", check: "orphan_allocation", severity: "low", amount: 0.25, roomId: "R1" }),
    f({ id: "3", check: "missing_account_snapshot", amount: 40, roomId: "R2" }),
  ];
  it("sums per category and severity", () => {
    const s = categoryStats(findings).find((x) => x.check === "orphan_allocation")!;
    expect(s.count).toBe(2);
    expect(s.amount).toBe(100.75);
    expect(s.bySeverity.high.count).toBe(1);
  });
  it("summary lists legacy findings and proposed repairs state nothing applied", () => {
    const md = renderSummary(findings, { generatedAt: "t", host: "h.example", redacted: false });
    expect(md).toContain("legacy, receiving account unknown");
    expect(md).toContain("h.example");
    const repairs = renderProposedRepairs(findings);
    expect(repairs).toContain("NOT APPLIED");
    expect(repairs).toContain("## orphan_allocation");
    expect(repairs).not.toContain("## carry_forward");
    expect(repairs).toMatch(/Do NOT infer missing receipts/);
  });
});

describe("redactFindings", () => {
  it("gives stable T-001 style pseudonyms and scrubs names and phones", () => {
    const findings = [
      f({ id: "1", tenantId: "tenant-b", explanation: "Somchai Jaidee paid via 081-234-5678 (tenant-b)" }),
      f({ id: "2", tenantId: "tenant-a" }),
      f({ id: "3", tenantId: "tenant-b" }),
    ];
    const r = redactFindings(findings, { tenants: [{ id: "tenant-b", name: "Somchai Jaidee", phone: "081-234-5678" }] });
    expect(r.findings[1].tenantId).toBe("T-001");
    expect(r.findings[0].tenantId).toBe("T-002");
    expect(r.findings[2].tenantId).toBe("T-002");
    const text = r.findings[0].explanation;
    expect(text).not.toContain("Somchai");
    expect(text).not.toContain("081");
    expect(text).not.toContain("tenant-b");
    // Deterministic across runs.
    expect(redactFindings(findings).findings[0].tenantId).toBe("T-002");
  });
  it("scrubs phone-shaped text without a tenant list", () => {
    const r = redactFindings([f({ explanation: "call 0812345678 or +66 81 234 5678; paid 1,400.00" })]);
    expect(r.findings[0].explanation).toBe("call [phone] or [phone]; paid 1,400.00");
  });
});

describe("read-only guard", () => {
  const makeBuilder = (log: string[]) => {
    const b: any = {};
    for (const m of ["select", "order", "range", "insert", "update", "upsert", "delete", "eq"]) {
      b[m] = (...a: unknown[]) => {
        log.push(m);
        return b;
      };
    }
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(res({ data: [], error: null }));
    return b;
  };
  const makeClient = (log: string[]) => ({
    from: () => makeBuilder(log),
    rpc: () => {
      log.push("rpc");
    },
    auth: {},
  });

  it("allows select chains and awaiting", async () => {
    const log: string[] = [];
    const c = createReadOnlyClient(makeClient(log));
    const res = await (c as any).from("invoices").select("id").order("id").range(0, 9);
    expect(res.data).toEqual([]);
    expect(log).toEqual(["select", "order", "range"]);
  });
  it("throws on insert, update, upsert, delete and rpc", () => {
    const log: string[] = [];
    const c: any = createReadOnlyClient(makeClient(log));
    for (const m of ["insert", "update", "upsert", "delete"]) {
      expect(() => c.from("invoices")[m]({})).toThrow(ReadOnlyViolation);
    }
    expect(() => c.from("invoices").select("id").delete()).toThrow(ReadOnlyViolation);
    expect(() => c.rpc("anything")).toThrow(ReadOnlyViolation);
    expect(() => c.auth).toThrow(ReadOnlyViolation);
    expect(log).toEqual(["select"]);
  });
});

describe("cli helpers", () => {
  it("parses args", () => {
    expect(parseArgs(["--redact", "--out", "x"])).toEqual({ redact: true, out: "x" });
    expect(parseArgs(["--out=y"])).toEqual({ redact: false, out: "y" });
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["--out"])).toThrow();
  });
  it("requires the exact confirmation value", () => {
    expect(isReadOnlyConfirmed({})).toBe(false);
    expect(isReadOnlyConfirmed({ DISCREPANCY_CONFIRM_READONLY: "true" })).toBe(false);
    expect(isReadOnlyConfirmed({ DISCREPANCY_CONFIRM_READONLY: "yes" })).toBe(true);
  });
  it("extracts the host only", () => {
    expect(hostOf("https://abc.supabase.co/rest/v1")).toBe("abc.supabase.co");
    expect(hostOf(undefined)).toBe("(unset)");
  });
});
