import { describe, expect, it } from "vitest";
import type { ReconciliationFinding } from "./reconciliation-checks";
import {
  COLUMN_LABELS,
  filterFindings,
  findingsToLabelledCsv,
  sortFindings,
  summarizeFindings,
} from "./reconciliation-view";

const f = (over: Partial<ReconciliationFinding>): ReconciliationFinding => ({
  id: "x",
  check: "status_vs_balance",
  severity: "low",
  amount: 1,
  explanation: "e",
  suggestedNextStep: "s",
  ...over,
});

const sample = [
  f({ id: "a", severity: "low", check: "missing_money_event", amount: 5 }),
  f({ id: "b", severity: "high", check: "orphan_allocation", amount: 100 }),
  f({ id: "c", severity: "high", check: "status_vs_balance", amount: 300 }),
  f({ id: "d", severity: "medium", check: "status_vs_balance", amount: 50 }),
];

describe("reconciliation view helpers", () => {
  it("filters by severity and check; 'all' and undefined are no-ops", () => {
    expect(filterFindings(sample, {})).toHaveLength(4);
    expect(filterFindings(sample, { severity: "all", check: "all" })).toHaveLength(4);
    expect(filterFindings(sample, { severity: "high" }).map((x) => x.id)).toEqual(["b", "c"]);
    expect(filterFindings(sample, { severity: "high", check: "status_vs_balance" }).map((x) => x.id)).toEqual(["c"]);
  });

  it("summarizes counts by severity and check", () => {
    const s = summarizeFindings(sample);
    expect(s.total).toBe(4);
    expect(s.bySeverity).toEqual({ high: 2, medium: 1, low: 1 });
    expect(s.byCheck.status_vs_balance).toBe(2);
    expect(s.byCheck.carry_forward).toBeUndefined();
    expect(summarizeFindings([]).bySeverity).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("sorts most severe then largest first without mutating input", () => {
    const before = sample.map((x) => x.id);
    expect(sortFindings(sample).map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
    expect(sample.map((x) => x.id)).toEqual(before);
  });

  it("CSV uses on-screen labels for the header and keeps rows intact", () => {
    const csv = findingsToLabelledCsv([f({ id: "r1", explanation: 'has "quote",\nnewline' })]);
    const [header] = csv.split("\r\n");
    expect(header.split(",")).toEqual(Object.values(COLUMN_LABELS));
    expect(csv).toContain('"has ""quote"",\nnewline"');
    expect(findingsToLabelledCsv([])).toBe(Object.values(COLUMN_LABELS).join(","));
  });
});
