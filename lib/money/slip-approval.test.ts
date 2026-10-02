import { describe, expect, it } from "vitest";
import { parseSlipApproval } from "./slip-approval";

const now = new Date("2026-10-03T00:00:00Z");
describe("parseSlipApproval", () => {
  it("rejects missing/zero/negative/NaN amount", () => {
    for (const a of [undefined, "", 0, -5, "abc", null]) {
      expect(parseSlipApproval({ amount: a, paidAt: "2026-10-01" }, now).ok).toBe(false);
    }
  });
  it("rejects missing or invalid date and far-future date", () => {
    expect(parseSlipApproval({ amount: 100, paidAt: "" }, now).ok).toBe(false);
    expect(parseSlipApproval({ amount: 100, paidAt: "nope" }, now).ok).toBe(false);
    expect(parseSlipApproval({ amount: 100, paidAt: "2027-01-01" }, now).ok).toBe(false);
  });
  it("accepts amount strings with commas and ISO datetimes", () => {
    const r = parseSlipApproval({ amount: "1,234.567", paidAt: "2026-10-01T08:30:00+07:00" }, now);
    expect(r).toMatchObject({ ok: true, amount: 1234.57 });
  });
});
