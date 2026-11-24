import { describe, expect, it } from "vitest";
import { deriveFrozenLateFeeDays } from "./move-out-settlement-input";

describe("deriveFrozenLateFeeDays", () => {
  it("recovers the days from a frozen amount (6 days x 50 = 300)", () => {
    expect(deriveFrozenLateFeeDays(300, 0, 50)).toBe(6);
  });
  it("adds the waived amount back", () => {
    expect(deriveFrozenLateFeeDays(250, 50, 50)).toBe(6);
  });
  it("returns null when it is not a whole number of days", () => {
    expect(deriveFrozenLateFeeDays(310, 0, 50)).toBeNull();
  });
  it("returns null without a rate or amount", () => {
    expect(deriveFrozenLateFeeDays(300, 0, 0)).toBeNull();
    expect(deriveFrozenLateFeeDays(0, 0, 50)).toBeNull();
  });
});
