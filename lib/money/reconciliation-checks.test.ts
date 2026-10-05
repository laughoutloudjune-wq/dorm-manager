import { describe, expect, it } from "vitest";
import {
  findingsToCsv,
  FINDING_CSV_COLUMNS,
  runReconciliation,
  type ReconciliationInput,
} from "./reconciliation-checks";

const SNAP = { id: "pm1", bank: "KBank" };

function clean(): ReconciliationInput {
  return {
    invoices: [
      { id: "A", tenant_id: "t1", room_id: "r1", status: "paid", total_amount: 3000, paid_amount: 3000,
        payment_history: [{ payment_batch_id: "b1", amount: 3000 }] },
      { id: "B", tenant_id: "t1", room_id: "r1", status: "partial", total_amount: 3000, paid_amount: 1000 },
      { id: "C", tenant_id: "t2", room_id: "r2", status: "pending", total_amount: 500, paid_amount: 0 },
      { id: "D", tenant_id: "t3", room_id: "r3", status: "pending", total_amount: 2000, paid_amount: 0 },
    ],
    batches: [
      { id: "b1", tenant_id: "t1", room_id: "r1", amount_received: 3000, amount_allocated: 3000, voided_at: null },
      { id: "b2", tenant_id: "t1", room_id: "r1", amount_received: 1500, amount_allocated: 1000, voided_at: null }, // 500 credit
      { id: "b3", tenant_id: "t2", room_id: "r2", amount_received: 500, amount_allocated: 500, voided_at: "2026-09-01" },
    ],
    allocations: [
      { id: "a1", payment_batch_id: "b1", invoice_id: "A", amount: 3000, payment_method_snapshot: SNAP },
      { id: "a2", payment_batch_id: "b2", invoice_id: "B", amount: 1000, payment_method_snapshot: SNAP },
      { id: "a3", payment_batch_id: "b3", invoice_id: "C", amount: 500, payment_method_snapshot: SNAP },
      { id: "a3r", payment_batch_id: "b3", invoice_id: "C", amount: -500, reverses_allocation_id: "a3", payment_method_snapshot: null },
    ],
    carryForwards: [{ id: "cf1", source_invoice_id: "D", target_invoice_id: "A", amount: 1400 }],
    moneyEvents: [
      { invoice_id: "A" },
      { batch_id: "b2" },
    ],
  };
}

const run = (mutate: (i: ReconciliationInput) => void) => {
  const input = clean();
  mutate(input);
  return runReconciliation(input);
};
const only = (f: ReturnType<typeof runReconciliation>, check: string) => f.filter((x) => x.check === check);

describe("runReconciliation", () => {
  it("returns zero findings for a clean dataset (credit and clean void included)", () => {
    expect(runReconciliation(clean())).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = clean();
    const snapshot = JSON.stringify(input);
    runReconciliation(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  describe("1. batch vs allocations", () => {
    it("flags allocations exceeding the amount received as high", () => {
      const f = only(run((i) => { i.allocations[0].amount = 3500; i.invoices[0].paid_amount = 3500; }), "batch_vs_allocations");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "high", amount: 500, batchId: "b1", tenantId: "t1" });
    });

    it("flags a stored amount_allocated that disagrees with the rows", () => {
      const f = only(run((i) => { i.batches[1].amount_allocated = 1200; }), "batch_vs_allocations");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "medium", amount: 200, batchId: "b2" });
    });

    it("accepts unapplied credit when amount_allocated matches", () => {
      expect(only(runReconciliation(clean()), "batch_vs_allocations")).toEqual([]);
    });

    it("flags a voided batch that does not net to zero", () => {
      const f = only(run((i) => { i.allocations = i.allocations.filter((a) => a.id !== "a3r"); i.invoices[2].paid_amount = 500; }), "batch_vs_allocations");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "high", batchId: "b3", amount: 500 });
      expect(f[0].explanation).toContain("too little");
    });

    it("flags an over-reversed voided batch", () => {
      const f = only(run((i) => { i.allocations[3].amount = -700; i.invoices[2].paid_amount = -200; }), "batch_vs_allocations");
      expect(f[0].explanation).toContain("too much");
    });

    it("accepts a voided batch with no allocations at all", () => {
      const f = run((i) => { i.allocations = i.allocations.filter((a) => a.payment_batch_id !== "b3"); });
      expect(f).toEqual([]);
    });
  });

  describe("2. invoice paid vs allocations", () => {
    it("flags paid_amount above allocations as high", () => {
      const f = only(run((i) => { i.invoices[1].paid_amount = 1800; }), "invoice_paid_vs_allocations");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "high", amount: 800, invoiceId: "B", roomId: "r1" });
    });

    it("flags allocations above paid_amount as medium", () => {
      const f = only(run((i) => { i.invoices[0].paid_amount = 2500; i.invoices[0].status = "partial"; }), "invoice_paid_vs_allocations");
      expect(f[0]).toMatchObject({ severity: "medium", amount: 500 });
    });

    it("nets void reversals", () => {
      // Invoice C has +500 and -500 and paid 0: clean.
      expect(only(runReconciliation(clean()), "invoice_paid_vs_allocations")).toEqual([]);
    });

    it("flags paid_amount with no allocations at all (legacy / fabricated)", () => {
      const f = only(run((i) => { i.invoices[3].paid_amount = 2000; i.invoices[3].status = "paid"; }), "invoice_paid_vs_allocations");
      expect(f[0]).toMatchObject({ invoiceId: "D", severity: "high", amount: 2000 });
    });

    it("handles numeric strings from the database", () => {
      const f = run((i) => { i.invoices[0].paid_amount = "3000.00"; i.invoices[0].total_amount = "3000.00"; });
      expect(f).toEqual([]);
    });
  });

  describe("3. orphans", () => {
    it("flags an allocation with no batch id", () => {
      const f = only(run((i) => i.allocations.push({ id: "x", payment_batch_id: null, invoice_id: "D", amount: 100, payment_method_snapshot: SNAP })), "orphan_allocation");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "high", amount: 100, invoiceId: "D", tenantId: "t3" });
    });

    it("flags an allocation pointing at a missing batch", () => {
      const f = only(run((i) => i.allocations.push({ id: "x", payment_batch_id: "ghost", invoice_id: "D", amount: 100, payment_method_snapshot: SNAP })), "orphan_allocation");
      expect(f[0].explanation).toContain("ghost");
    });

    it("flags a batch claiming allocation with no rows as medium", () => {
      const f = only(run((i) => i.batches.push({ id: "b9", amount_received: 900, amount_allocated: 900, voided_at: null })), "batch_without_allocations");
      expect(f[0]).toMatchObject({ severity: "medium", amount: 900, batchId: "b9" });
    });

    it("reports a fully-unapplied batch as low", () => {
      const f = only(run((i) => i.batches.push({ id: "b9", amount_received: 900, amount_allocated: 0, voided_at: null })), "batch_without_allocations");
      expect(f[0]).toMatchObject({ severity: "low", amount: 900 });
    });
  });

  describe("4. payment_history", () => {
    it("flags an entry whose batch does not exist", () => {
      const f = only(run((i) => { i.invoices[0].payment_history = [{ payment_batch_id: "ghost", amount: 3000 }]; }), "payment_history_mismatch");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "high", batchId: "ghost", invoiceId: "A" });
    });

    it("flags an entry whose amount disagrees with the allocation", () => {
      const f = only(run((i) => { i.invoices[0].payment_history = [{ payment_batch_id: "b1", amount: 2500 }]; }), "payment_history_mismatch");
      expect(f[0]).toMatchObject({ severity: "medium", amount: 500 });
    });

    it("flags an entry for a batch that never touched this invoice", () => {
      const f = only(run((i) => { i.invoices[3].payment_history = [{ payment_batch_id: "b1", amount: 100 }]; }), "payment_history_mismatch");
      expect(f).toHaveLength(1);
      expect(f[0].amount).toBe(100);
    });

    it("ignores legacy entries without a batch id and parses string JSON", () => {
      expect(run((i) => { i.invoices[0].payment_history = JSON.stringify([{ amount: 3000 }, { payment_batch_id: "b1", amount: 3000 }]); })).toEqual([]);
      expect(run((i) => { i.invoices[0].payment_history = "not json"; })).toEqual([]);
    });
  });

  describe("5. status vs balance", () => {
    it("flags paid with paid < total as high", () => {
      const f = only(run((i) => { i.invoices[1].status = "paid"; }), "status_vs_balance");
      expect(f[0]).toMatchObject({ severity: "high", amount: 2000, invoiceId: "B" });
    });

    it("flags partial with nothing paid", () => {
      const f = only(run((i) => { i.invoices[3].status = "partial"; }), "status_vs_balance");
      expect(f[0]).toMatchObject({ severity: "medium", invoiceId: "D" });
    });

    it("flags pending and overdue when already fully paid", () => {
      for (const status of ["pending", "overdue"]) {
        const f = only(run((i) => { i.invoices[0].status = status; }), "status_vs_balance");
        expect(f).toHaveLength(1);
        expect(f[0].explanation).toContain(status);
      }
    });

    it("leaves draft, cancelled and verifying alone", () => {
      for (const status of ["draft", "cancelled", "verifying"]) {
        expect(only(run((i) => { i.invoices[0].status = status; }), "status_vs_balance")).toEqual([]);
      }
    });

    it("does not flag a zero-total pending invoice", () => {
      expect(only(run((i) => { i.invoices[3].total_amount = 0; }), "status_vs_balance")).toEqual([]);
    });
  });

  describe("6. carry-forward", () => {
    it("flags the same source carried into the same target twice", () => {
      const f = only(run((i) => i.carryForwards.push({ id: "cf2", source_invoice_id: "D", target_invoice_id: "A", amount: 1400 })), "carry_forward");
      const dup = f.filter((x) => x.id.startsWith("carry_forward:dup"));
      expect(dup).toHaveLength(1);
      expect(dup[0]).toMatchObject({ severity: "high", amount: 1400, invoiceId: "D" });
    });

    it("flags carried totals exceeding the source's outstanding", () => {
      const f = only(run((i) => { i.carryForwards[0].amount = 2500; }), "carry_forward");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "medium", amount: 500 });
    });

    it("does not flag exceeds when the source is fully settled", () => {
      const f = only(
        run((i) => {
          const d = i.invoices.find((x) => x.id === "D")!;
          d.status = "paid";
          d.paid_amount = 2000;
          i.carryForwards[0].amount = 2500;
        }),
        "carry_forward"
      ).filter((x) => x.id.startsWith("carry_forward:exceeds"));
      expect(f).toEqual([]);
    });

    it("sums carry rows across multiple targets", () => {
      const f = only(run((i) => i.carryForwards.push({ source_invoice_id: "D", target_invoice_id: "B", amount: 900 })), "carry_forward");
      expect(f).toHaveLength(1);
      expect(f[0].amount).toBe(300);
    });

    it("accepts carried_amount as the column name", () => {
      expect(run((i) => { i.carryForwards = [{ source_invoice_id: "D", target_invoice_id: "A", carried_amount: 2000 }]; })).toEqual([]);
    });
  });

  describe("7. money_events", () => {
    it("flags a paid invoice with no event as low", () => {
      const f = only(run((i) => { i.moneyEvents = [{ invoice_id: "A" }]; }), "missing_money_event");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "low", invoiceId: "B", amount: 1000 });
    });

    it("counts an event on the paying batch as coverage", () => {
      expect(only(runReconciliation(clean()), "missing_money_event")).toEqual([]);
    });

    it("is skipped entirely when moneyEvents is not provided", () => {
      expect(only(run((i) => { delete i.moneyEvents; }), "missing_money_event")).toEqual([]);
    });
  });

  describe("8. missing account snapshot", () => {
    it("reports null snapshots as low / unknown account", () => {
      const f = only(run((i) => { i.allocations[0].payment_method_snapshot = null; }), "missing_account_snapshot");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ severity: "low", amount: 3000, batchId: "b1", invoiceId: "A" });
      expect(f[0].explanation).toContain("unknown");
    });

    it("treats an empty object as missing, and ignores reversal rows", () => {
      const f = only(run((i) => { i.allocations[1].payment_method_snapshot = {}; }), "missing_account_snapshot");
      expect(f.map((x) => x.id)).toEqual(["missing_account_snapshot:a2"]);
    });
  });

  it("every finding is report-only data with no executable fix", () => {
    const f = run((i) => { i.invoices[1].paid_amount = 1800; i.invoices[1].status = "paid"; });
    for (const finding of f) {
      expect(typeof finding.suggestedNextStep).toBe("string");
      expect(Object.values(finding).some((v) => typeof v === "function")).toBe(false);
    }
  });
});

describe("findingsToCsv", () => {
  it("emits a header using the finding field names", () => {
    expect(findingsToCsv([]).split("\r\n")[0]).toBe(FINDING_CSV_COLUMNS.join(","));
    expect(FINDING_CSV_COLUMNS).toEqual(["id", "check", "severity", "amount", "tenantId", "roomId", "invoiceId", "batchId", "explanation", "suggestedNextStep"]);
  });

  it("escapes commas, quotes and newlines and leaves optional fields blank", () => {
    const csv = findingsToCsv([
      { id: "x", check: "status_vs_balance", severity: "low", amount: 12.5, invoiceId: "A", explanation: 'say "hi", ok\nnext', suggestedNextStep: "go" },
    ]);
    expect(csv.split("\r\n")[1]).toBe('x,status_vs_balance,low,12.5,,,A,,"say ""hi"", ok\nnext",go');
  });

  it("neutralises spreadsheet formula injection in text cells", () => {
    const csv = findingsToCsv([
      { id: "x", check: "status_vs_balance", severity: "low", amount: 1, explanation: "=HYPERLINK(1)", suggestedNextStep: "-x" },
    ]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain(",'-x");
  });

  it("round-trips real findings", () => {
    const f = run((i) => { i.invoices[1].paid_amount = 1800; });
    expect(findingsToCsv(f).split("\r\n").length).toBeGreaterThan(1);
  });
});
