import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_MIN_INTERVAL_MS,
  ledgerLoadKey,
  paymentHistorySignature,
  shouldLoadAssignableMethods,
  shouldPoll,
  shouldRefreshOnVisible,
  shouldRunMaintenance,
} from "./invoice-load-policy";

describe("shouldRunMaintenance", () => {
  const base = { period: "2026-10", lastPeriod: "2026-10", lastRunAt: 1_000, now: 1_000 + 20_000 };
  it("always runs on an explicit load", () => {
    expect(shouldRunMaintenance({ ...base, silent: false })).toBe(true);
  });
  it("skips a background refresh shortly after the last run", () => {
    expect(shouldRunMaintenance({ ...base, silent: true })).toBe(false);
  });
  it("runs a background refresh once the interval has passed", () => {
    expect(shouldRunMaintenance({ ...base, silent: true, now: 1_000 + MAINTENANCE_MIN_INTERVAL_MS })).toBe(true);
  });
  it("runs for a period that has not been maintained yet", () => {
    expect(shouldRunMaintenance({ ...base, silent: true, lastPeriod: "2026-09" })).toBe(true);
    expect(shouldRunMaintenance({ ...base, silent: true, lastRunAt: null })).toBe(true);
  });
});

describe("polling visibility", () => {
  it("pauses while hidden", () => {
    expect(shouldPoll(true)).toBe(false);
    expect(shouldPoll(false)).toBe(true);
  });
  it("refreshes on return only if a poll was missed", () => {
    expect(shouldRefreshOnVisible({ lastPollAt: 100_000, now: 105_000 })).toBe(false);
    expect(shouldRefreshOnVisible({ lastPollAt: 100_000, now: 125_000 })).toBe(true);
    expect(shouldRefreshOnVisible({ lastPollAt: null, now: 1 })).toBe(true);
  });
});

describe("ledgerLoadKey", () => {
  const history = [{ id: "a", amount: 100, paid_at: "2026-10-01" }];
  const args = { invoiceId: "inv1", tab: "payments", historySignature: paymentHistorySignature(history), reloadToken: 0 };

  it("does not load off the Payments tab or without an invoice", () => {
    expect(ledgerLoadKey({ ...args, tab: "preview" })).toBeNull();
    expect(ledgerLoadKey({ ...args, invoiceId: "" })).toBeNull();
  });
  it("is unchanged when the same history arrives as a new array (e.g. a loading flag flipped)", () => {
    const again = paymentHistorySignature(history.map((h) => ({ ...h })));
    expect(ledgerLoadKey({ ...args, historySignature: again })).toBe(ledgerLoadKey(args));
  });
  it("changes when the invoice, tab, history or reload token changes", () => {
    const k = ledgerLoadKey(args);
    expect(ledgerLoadKey({ ...args, invoiceId: "inv2" })).not.toBe(k);
    expect(ledgerLoadKey({ ...args, reloadToken: 1 })).not.toBe(k);
    const added = paymentHistorySignature([...history, { id: "b", amount: 50, paid_at: "2026-10-02" }]);
    expect(ledgerLoadKey({ ...args, historySignature: added })).not.toBe(k);
    const voided = paymentHistorySignature([{ ...history[0], voided: true }]);
    expect(ledgerLoadKey({ ...args, historySignature: voided })).not.toBe(k);
  });
});

describe("shouldLoadAssignableMethods", () => {
  it("loads only on the Payments tab of an open modal, once", () => {
    expect(shouldLoadAssignableMethods({ detailOpen: true, tab: "payments", alreadyLoaded: false })).toBe(true);
    expect(shouldLoadAssignableMethods({ detailOpen: true, tab: "payments", alreadyLoaded: true })).toBe(false);
    expect(shouldLoadAssignableMethods({ detailOpen: true, tab: "preview", alreadyLoaded: false })).toBe(false);
    expect(shouldLoadAssignableMethods({ detailOpen: false, tab: "payments", alreadyLoaded: false })).toBe(false);
  });
});
