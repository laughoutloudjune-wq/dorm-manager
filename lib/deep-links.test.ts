import { describe, expect, it } from "vitest";
import { invoiceDeepLink, monthFromStartDate, parseDeepLinkId, tenantDeepLink } from "./deep-links";

describe("deep links", () => {
  it("builds encoded links", () => {
    expect(invoiceDeepLink("a b")).toBe("/invoices?invoice=a%20b");
    expect(tenantDeepLink("t1")).toBe("/tenants?tenant=t1");
  });
  it("parses ids", () => {
    expect(parseDeepLinkId(" x ")).toBe("x");
    expect(parseDeepLinkId("")).toBeNull();
    expect(parseDeepLinkId(null)).toBeNull();
    expect(parseDeepLinkId("a".repeat(65))).toBeNull();
  });
  it("extracts month", () => {
    expect(monthFromStartDate("2026-07-01")).toBe("2026-07");
    expect(monthFromStartDate("2026-07-01T00:00:00Z")).toBe("2026-07");
    expect(monthFromStartDate("bad")).toBeNull();
    expect(monthFromStartDate(null)).toBeNull();
  });
});
