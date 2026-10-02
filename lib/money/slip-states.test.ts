import { describe, expect, it } from "vitest";
import { deriveSlipState } from "./slip-states";

const base = { total_amount: 1000, paid_amount: 0 };

describe("deriveSlipState", () => {
  it("verifying with slip is under review", () => {
    expect(deriveSlipState({ ...base, status: "verifying", slip_url: "x" })?.state).toBe("under_review");
  });
  it("slip attached but not queued is slip_submitted", () => {
    expect(deriveSlipState({ ...base, status: "pending", slip_url: "x" })?.state).toBe("slip_submitted");
  });
  it("declined after rejection and cleared slip", () => {
    expect(deriveSlipState({ ...base, status: "pending", slip_url: null, slip_rejections: [{}] })?.state).toBe("declined");
  });
  it("paid with one payment is approved", () => {
    expect(
      deriveSlipState({ total_amount: 1000, paid_amount: 1000, status: "paid", slip_url: "x", allocations: [{ amount: 1000 }] })?.state,
    ).toBe("approved");
  });
  it("paid after two payments is balance_settled; reversed ones do not count", () => {
    const a = [{ amount: 400 }, { amount: 600 }];
    expect(deriveSlipState({ total_amount: 1000, paid_amount: 1000, status: "paid", allocations: a })?.state).toBe("balance_settled");
    expect(
      deriveSlipState({ total_amount: 1000, paid_amount: 1000, status: "paid", allocations: [{ amount: 400, reversed_at: "x" }, { amount: 600 }] })?.state,
    ).toBe("approved");
  });
  it("partial payment is partially_allocated", () => {
    expect(deriveSlipState({ total_amount: 1000, paid_amount: 300, status: "partial", allocations: [{ amount: 300 }] })?.state).toBe("partially_allocated");
  });
  it("no evidence returns null; paid with no evidence returns null", () => {
    expect(deriveSlipState({ ...base, status: "pending" })).toBeNull();
    expect(deriveSlipState({ total_amount: 1000, paid_amount: 1000, status: "paid" })).toBeNull();
  });
  it("has Thai label and next action", () => {
    const s = deriveSlipState({ ...base, status: "verifying", slip_url: "x" })!;
    expect(s.label).toMatch(/[ก-๙]/);
    expect(s.nextAction).toMatch(/[ก-๙]/);
  });
});
