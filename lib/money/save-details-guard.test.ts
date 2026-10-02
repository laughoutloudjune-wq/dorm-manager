import { describe, expect, it } from "vitest";
import { guardSaveDetailsPayload } from "./save-details-guard";

describe("guardSaveDetailsPayload", () => {
  it("passes legitimate detail edits through", () => {
    const r = guardSaveDetailsPayload({ rent_amount: 3000, notes: "x", status: "draft" });
    expect(r).toEqual({ ok: true, payload: { rent_amount: 3000, notes: "x", status: "draft" }, stripped: {} });
  });
  it("strips paid_amount and reports it", () => {
    const r = guardSaveDetailsPayload({ rent_amount: 1, paid_amount: 999 });
    expect(r).toEqual({ ok: true, payload: { rent_amount: 1 }, stripped: { paid_amount: 999 } });
  });
  it("rejects payment_history, slip fields and unknown columns", () => {
    const r = guardSaveDetailsPayload({ payment_history: [], slip_url: "u", slip_uploaded_at: "t", foo: 1 });
    expect(r).toEqual({ ok: false, blocked: ["payment_history", "slip_url", "slip_uploaded_at", "foo"] });
  });
  it("rejects status paid and partial", () => {
    expect(guardSaveDetailsPayload({ status: "paid" })).toEqual({ ok: false, blocked: ["status=paid"] });
    expect(guardSaveDetailsPayload({ status: "partial" })).toEqual({ ok: false, blocked: ["status=partial"] });
    expect(guardSaveDetailsPayload({ status: "overdue" }).ok).toBe(true);
  });
});
