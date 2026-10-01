import { describe, expect, it } from "vitest";
import { refundMethodLabel, refundPaidAtIso, summarizeRefunds, toRefundView } from "./refunds";

describe("toRefundView", () => {
  it("reads tenant and room through the embedded move-out bill", () => {
    const view = toRefundView({
      id: "r1",
      tenant_id: "t1",
      amount: "1234.5",
      status: "paid",
      paid_at: "2026-10-01T05:00:00Z",
      method: "bank_transfer",
      payment_method_snapshot: { label: "KBank หลัก", bank_name: "KBank" },
      tenants: { full_name: "สมชาย" },
      invoice: { room_id: "x", rooms: [{ room_number: "212/2", buildings: { name: "A" } }] },
    });
    expect(view).toMatchObject({
      tenantName: "สมชาย",
      room: "212/2",
      building: "A",
      amount: 1234.5,
      status: "paid",
      accountLabel: "KBank หลัก",
    });
  });

  it("treats anything but paid as pending and leaves a missing account null", () => {
    const view = toRefundView({ id: "r2", amount: 10, status: "pending", payment_method_snapshot: null });
    expect(view.status).toBe("pending");
    expect(view.accountLabel).toBeNull();
    expect(view.room).toBe("-");
  });
});

describe("summarizeRefunds", () => {
  it("counts and totals one status in whole cents", () => {
    const rows = [
      toRefundView({ id: "a", amount: 0.1, status: "paid" }),
      toRefundView({ id: "b", amount: 0.2, status: "paid" }),
      toRefundView({ id: "c", amount: 500, status: "pending" }),
    ];
    expect(summarizeRefunds(rows, "paid")).toEqual({ count: 2, total: 0.3 });
    expect(summarizeRefunds(rows, "pending")).toEqual({ count: 1, total: 500 });
  });
});

describe("refundPaidAtIso", () => {
  it("uses now for today so the time is never in the future", () => {
    const now = new Date("2026-10-01T02:00:00Z");
    expect(refundPaidAtIso("2026-10-01", "2026-10-01", now)).toBe(now.toISOString());
  });

  it("uses noon Bangkok for an earlier day", () => {
    expect(refundPaidAtIso("2026-09-28", "2026-10-01")).toBe("2026-09-28T05:00:00.000Z");
  });
});

describe("refundMethodLabel", () => {
  it("labels known methods and passes others through", () => {
    expect(refundMethodLabel("cash")).toBe("เงินสด");
    expect(refundMethodLabel("พร้อมเพย์")).toBe("พร้อมเพย์");
    expect(refundMethodLabel(null)).toBe("-");
  });
});
