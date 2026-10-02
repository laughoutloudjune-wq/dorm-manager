import { describe, expect, it } from "vitest";
import { addDaysToDate, bangkokDayStartIso, toBangkokDate, toBangkokMonth } from "./bangkok-date";

describe("toBangkokDate / toBangkokMonth", () => {
  it("rolls 17:30Z on 30 Sep into 1 Oct Bangkok", () => {
    expect(toBangkokDate("2026-09-30T17:30:00Z")).toBe("2026-10-01");
    expect(toBangkokMonth("2026-09-30T17:30:00Z")).toBe("2026-10");
  });
  it("keeps 16:59:59Z on 30 Sep in September", () => {
    expect(toBangkokMonth("2026-09-30T16:59:59Z")).toBe("2026-09");
  });
  it("exact boundary 17:00:00Z is next day", () => {
    expect(toBangkokDate("2026-09-30T17:00:00Z")).toBe("2026-10-01");
  });
  it("year rollover", () => {
    expect(toBangkokDate("2026-12-31T20:00:00+00:00")).toBe("2027-01-01");
    expect(toBangkokMonth("2026-12-31T20:00:00.000Z")).toBe("2027-01");
  });
  it("handles offset timestamps", () => {
    expect(toBangkokDate("2026-10-01T00:30:00+07:00")).toBe("2026-10-01");
    expect(toBangkokDate("2026-09-30T23:59:00-05:00")).toBe("2026-10-01");
  });
  it("leap day", () => {
    expect(toBangkokDate("2028-02-28T17:00:00Z")).toBe("2028-02-29");
  });
  it("passes date-only strings through", () => {
    expect(toBangkokDate("2026-10-01")).toBe("2026-10-01");
    expect(toBangkokMonth("2026-10-01")).toBe("2026-10");
  });
  it("returns empty for null/invalid", () => {
    expect(toBangkokDate(null)).toBe("");
    expect(toBangkokDate(undefined)).toBe("");
    expect(toBangkokMonth("garbage")).toBe("");
  });
});

describe("bangkokDayStartIso / addDaysToDate", () => {
  it("converts a Bangkok midnight to UTC", () => {
    expect(bangkokDayStartIso("2026-10-01")).toBe("2026-09-30T17:00:00.000Z");
  });
  it("leaves non date-only values untouched", () => {
    expect(bangkokDayStartIso("2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00Z");
  });
  it("adds days across month ends", () => {
    expect(addDaysToDate("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
  });
});
