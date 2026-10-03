import { describe, expect, it } from "vitest";
import {
  guardSaveDetailsPayload,
  isSaveDetailsLockedStatus,
  recomputeSaveDetailsPayload,
} from "./save-details-guard";

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

describe("save_details protected lines and recompute (finding 158)", () => {
  const approvedLine = {
    item_type: "late_fee_line",
    source_invoice_id: "apr",
    late_fee_charge_id: "chg-1",
    policy_version: 1,
    covered_from: "2026-05-06",
    covered_to: "2026-05-20",
    posted_by: "admin-1",
    detail: "ค่าปรับ",
    label: "ค่าปรับ",
    days_overdue: 14,
    total_amount: 700,
    amount: 700,
    original_amount: 700,
    waived_amount: 0,
  };
  const redemption = {
    source: "rewards_redemption",
    label: "แลกแต้ม",
    detail: "แลกแต้ม",
    redemption_id: "r1",
    total_amount: 100,
    amount: 100,
  };
  const before = {
    status: "pending",
    rent_amount: 4000,
    water_bill: 100,
    electricity_bill: 500,
    common_fee: 0,
    late_fee_amount: 700,
    additional_fees_total: 900, // 200 cleaning + 700 approved line
    carry_forward_amount: 0,
    discount_amount: 100,
    total_amount: 6000,
    additional_fees_breakdown: [{ detail: "ทำความสะอาด", total_amount: 200, amount: 200 }, approvedLine],
    discount_breakdown: [redemption],
  };

  it("locks paid, verifying and cancelled invoices", () => {
    expect(isSaveDetailsLockedStatus("paid")).toBe(true);
    expect(isSaveDetailsLockedStatus("verifying")).toBe(true);
    expect(isSaveDetailsLockedStatus("cancelled")).toBe(true);
    expect(isSaveDetailsLockedStatus("pending")).toBe(false);
    expect(isSaveDetailsLockedStatus("draft")).toBe(false);
  });

  it("restores the approved line verbatim when the client sends a lossy, re-priced copy", () => {
    const lossy = { item_type: "late_fee_line", source_invoice_id: "apr", detail: "ค่าปรับ", total_amount: 50, amount: 50 };
    const r = recomputeSaveDetailsPayload(before, {
      rent_amount: 4000,
      late_fee_amount: 50, // client: no own fee + its 50 line
      additional_fees_total: 250,
      total_amount: 1, // forged
      additional_fees_breakdown: [{ detail: "ทำความสะอาด", total_amount: 200, amount: 200 }, lossy],
      discount_breakdown: [{ source: "rewards_redemption", detail: "แลกแต้ม", total_amount: 100 }],
    });
    const rows = r.payload.additional_fees_breakdown as any[];
    expect(rows).toContainEqual(approvedLine);
    expect(rows.some((x) => x.total_amount === 50)).toBe(false);
    expect(r.payload.discount_breakdown).toEqual([redemption]);
    expect(r.columns).toEqual({
      total_amount: 4000 + 100 + 500 + 200 + 700 - 100,
      late_fee_amount: 700,
      additional_fees_total: 900,
      carry_forward_amount: 0,
      discount_amount: 100,
    });
    expect(r.payload.total_amount).toBe(5400);
    expect(r.ignored).toEqual([{ kind: "late_fee_line", key: "chg-1", reason: "edited" }]);
  });

  it("re-inserts protected lines the client removed", () => {
    const r = recomputeSaveDetailsPayload(before, {
      late_fee_amount: 0,
      additional_fees_breakdown: [],
      discount_breakdown: [],
    });
    expect(r.payload.additional_fees_breakdown).toEqual([approvedLine]);
    expect(r.payload.discount_breakdown).toEqual([redemption]);
    expect(r.columns.total_amount).toBe(4000 + 100 + 500 + 700 - 100);
    expect(r.ignored.map((i) => i.reason)).toEqual(["removed", "removed"]);
  });

  it("keeps a move-out credit discount through a recompute", () => {
    const credit = { source: "move_out_credit", detail: "หักเงินประกัน", total_amount: 3000, amount: 3000 };
    const r = recomputeSaveDetailsPayload(
      { ...before, discount_amount: 3000, discount_breakdown: [credit] },
      { discount_breakdown: [{ detail: "ส่วนลด", total_amount: 50 }] },
    );
    expect(r.payload.discount_breakdown).toEqual([{ detail: "ส่วนลด", total_amount: 50 }, credit]);
    expect(r.columns.discount_amount).toBe(3050);
  });

  it("refuses a client-invented approved line", () => {
    const fake = { ...approvedLine, late_fee_charge_id: "forged", source_invoice_id: "mar" };
    const r = recomputeSaveDetailsPayload(
      { ...before, additional_fees_breakdown: [], late_fee_amount: 0, additional_fees_total: 0 },
      { additional_fees_breakdown: [fake] },
    );
    expect(r.payload.additional_fees_breakdown).toEqual([]);
    expect(r.ignored).toEqual([{ kind: "late_fee_line", key: "forged", reason: "added" }]);
  });

  it("recomputes every column from the engine on ordinary edits", () => {
    const r = recomputeSaveDetailsPayload(
      {
        ...before,
        additional_fees_breakdown: [],
        discount_breakdown: [],
        late_fee_amount: 0,
        additional_fees_total: 0,
        discount_amount: 0,
      },
      {
        rent_amount: 3500,
        late_fee_amount: 120,
        total_amount: 99999,
        additional_fees_breakdown: [
          { item_type: "carry_forward", source_invoice_id: "x", detail: "ยอดยกมา", total_amount: 1400 },
          { detail: "ซ่อม", total_amount: 300 },
        ],
        discount_breakdown: [{ detail: "ส่วนลด", total_amount: 20 }],
      },
    );
    expect(r.columns).toEqual({
      total_amount: 3500 + 100 + 500 + 120 + 300 + 1400 - 20,
      late_fee_amount: 120,
      additional_fees_total: 300,
      carry_forward_amount: 1400,
      discount_amount: 20,
    });
  });
});
