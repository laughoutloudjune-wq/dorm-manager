import { describe, it, expect } from "vitest";
import { diffMoneyColumns, invoicesBlockedFromDelete } from "./money-diff";

describe("diffMoneyColumns", () => {
  it("returns null when nothing money-related changes", () => {
    expect(diffMoneyColumns({ total_amount: 100, status: "draft" }, { total_amount: "100", note: "x" })).toBeNull();
  });
  it("returns only changed money columns", () => {
    const d = diffMoneyColumns(
      { total_amount: 100, paid_amount: 0, status: "draft" },
      { total_amount: 150, paid_amount: 0, status: "paid", memo: "z" },
    );
    expect(d).toEqual({
      before: { total_amount: 100, status: "draft" },
      after: { total_amount: 150, status: "paid" },
    });
  });
  it("treats null -> value as a change", () => {
    expect(diffMoneyColumns({ locked_late_fee_amount: null }, { locked_late_fee_amount: 0 })).not.toBeNull();
  });
});

describe("invoicesBlockedFromDelete", () => {
  it("blocks paid, allocated and batch-triggering invoices; allows unpaid drafts", () => {
    expect(
      invoicesBlockedFromDelete([
        { id: "a", paid_amount: 0 },
        { id: "b", paid_amount: 10 },
        { id: "c", paid_amount: 0, hasAllocation: true },
        { id: "d", paid_amount: null, hasBatchTrigger: true },
      ]),
    ).toEqual(["b", "c", "d"]);
  });
});
