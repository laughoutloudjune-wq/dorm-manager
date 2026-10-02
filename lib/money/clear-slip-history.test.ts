import { describe, it, expect } from "vitest";
import { clearSlipUrlsFromHistory } from "./clear-slip-history";

describe("clearSlipUrlsFromHistory", () => {
  it("clears slip_url but keeps other fields and untouched entries", () => {
    const a = { amount: 5, slip_url: "x" };
    const b = { amount: 7, slip_url: null };
    const out = clearSlipUrlsFromHistory([a, b]);
    expect(out[0]).toEqual({ amount: 5, slip_url: null });
    expect(out[1]).toBe(b);
    expect(a.slip_url).toBe("x");
  });
});
