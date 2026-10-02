import { describe, expect, it } from "vitest";
import { composeMoneySource } from "./money-events";

describe("composeMoneySource", () => {
  it("appends the actor label", () => {
    expect(composeMoneySource("admin_liff", "line:U1")).toBe("admin_liff:line:U1");
  });
  it("handles missing parts", () => {
    expect(composeMoneySource("admin_webapp", null)).toBe("admin_webapp");
    expect(composeMoneySource(null, null)).toBeNull();
  });
});
