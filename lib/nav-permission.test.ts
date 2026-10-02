import { describe, expect, it } from "vitest";
import { filterNavByPermission } from "../components/admin-nav";

const items = [{ href: "/a" }, { href: "/b", permission: "reconciliation.view" as const }];

describe("filterNavByPermission", () => {
  it("shows everything while loading", () => {
    expect(filterNavByPermission(items, () => false, true)).toHaveLength(2);
  });
  it("hides items lacking permission once loaded", () => {
    expect(filterNavByPermission(items, () => false, false).map((i) => i.href)).toEqual(["/a"]);
    expect(filterNavByPermission(items, () => true, false)).toHaveLength(2);
  });
});
