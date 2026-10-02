import { describe, it, expect, vi } from "vitest";
import { recordMoneyEvents, toMoneyEventRow } from "./money-events";

describe("recordMoneyEvents", () => {
  it("is a no-op for an empty list", async () => {
    const from = vi.fn();
    await recordMoneyEvents({ from } as any, []);
    expect(from).not.toHaveBeenCalled();
  });
  it("inserts all rows in one call with composed source", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    await recordMoneyEvents({ from } as any, [
      { action: "a", invoiceId: "1", source: "s", actorLabel: "l" },
      { action: "b" },
    ]);
    expect(from).toHaveBeenCalledWith("money_events");
    expect(insert).toHaveBeenCalledTimes(1);
    const rows = insert.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "a", invoice_id: "1", source: "s:l" });
    expect(rows[1].source).toBeNull();
  });
  it("never throws on insert failure", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordMoneyEvents({ from: () => ({ insert }) } as any, [{ action: "a" }])).resolves.toBeUndefined();
    spy.mockRestore();
  });
  it("toMoneyEventRow defaults nulls", () => {
    expect(toMoneyEventRow({ action: "x" }).before).toBeNull();
  });
});
