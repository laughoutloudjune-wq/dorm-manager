import { describe, expect, it } from "vitest";
import {
  V2_FEE_MODEL_CUTOVER_DATE,
  feeModelForCreationDate,
  lateFeeActionBlockReason,
  nextCachedV2Status,
  resolveGenerationFeeModel,
  rowToBalanceInvoice,
  v2MonthlyMoneyColumns,
  validatePauseRequest,
  validateWaiverRequest,
} from "./fee-model-v2";
import { getInvoiceBalance, type BalanceTenant } from "./invoice-balance";
import { computeInvoiceTotal } from "./invoice-total";

const living: BalanceTenant = { status: "active", handover_date: null, tenancy_end_date: null };

describe("cut-over date", () => {
  it("is the 25 Oct 2026 billing cycle", () => {
    expect(V2_FEE_MODEL_CUTOVER_DATE).toBe("2026-10-25");
  });

  it("bills created before the cut-over stay legacy, from it on are v2", () => {
    expect(feeModelForCreationDate("2026-09-25")).toBe("legacy");
    expect(feeModelForCreationDate("2026-10-24")).toBe("legacy");
    expect(feeModelForCreationDate("2026-10-25")).toBe("v2");
    expect(feeModelForCreationDate("2026-11-25")).toBe("v2");
    expect(feeModelForCreationDate("2027-01-01")).toBe("v2");
  });

  it("rejects a date that is not YYYY-MM-DD rather than guessing", () => {
    expect(() => feeModelForCreationDate("25/10/2026")).toThrow();
    expect(() => feeModelForCreationDate("")).toThrow();
  });
});

describe("resolveGenerationFeeModel", () => {
  it("decides by the run date when nothing is forced", () => {
    expect(resolveGenerationFeeModel({ todayBangkok: "2026-10-01", dryRun: false })).toBe("legacy");
    expect(resolveGenerationFeeModel({ todayBangkok: "2026-10-25", dryRun: false })).toBe("v2");
    expect(resolveGenerationFeeModel({ todayBangkok: "2026-10-01", dryRun: true })).toBe("legacy");
  });

  it("honours a forced model on a DRY RUN only", () => {
    expect(
      resolveGenerationFeeModel({ todayBangkok: "2026-10-01", dryRun: true, forceFeeModel: "v2" }),
    ).toBe("v2");
    expect(
      resolveGenerationFeeModel({ todayBangkok: "2026-11-01", dryRun: true, forceFeeModel: "legacy" }),
    ).toBe("legacy");
  });

  it("ignores a forced model on a real run, so nothing writes v2 before the cut-over", () => {
    expect(
      resolveGenerationFeeModel({ todayBangkok: "2026-10-01", dryRun: false, forceFeeModel: "v2" }),
    ).toBe("legacy");
    expect(
      resolveGenerationFeeModel({ todayBangkok: "2026-11-01", dryRun: false, forceFeeModel: "legacy" }),
    ).toBe("v2");
  });
});

describe("v2MonthlyMoneyColumns", () => {
  const parts = { rent: 3500, water: 170, electricity: 7 * 112, commonFee: 20, fees: 50, discount: 100 };

  it("is the bill's own charges only, through the one totals engine", () => {
    const cols = v2MonthlyMoneyColumns(parts);
    expect(cols.total_amount).toBe(3500 + 170 + 784 + 20 + 50 - 100);
    expect(cols.total_amount).toBe(
      computeInvoiceTotal({
        ...parts,
        nativeLateFee: 0,
        lateFeeItems: 0,
        carryForward: 0,
      }),
    );
  });

  it("never stores a late fee or a carried amount", () => {
    const cols = v2MonthlyMoneyColumns(parts);
    expect(cols.late_fee_amount).toBe(0);
    expect(cols.carry_forward_amount).toBe(0);
    expect(cols.additional_fees_total).toBe(50);
    expect(cols.discount_amount).toBe(100);
  });
});

describe("rowToBalanceInvoice", () => {
  const v2Row = {
    id: "a",
    tenant_id: "t",
    status: "pending",
    fee_model: "v2",
    kind: "monthly",
    total_amount: "3000",
    carry_forward_amount: 0,
    paid_amount: 0,
    due_date: "2026-11-10",
    late_fee_start_date: "2026-11-11",
    late_fee_per_day: "100",
    late_fee_paused_from: null,
    locked_late_fee_amount: null,
    late_fee_billed_at: null,
  };

  it("maps a v2 row so the engine grows the fee from late_fee_start_date", () => {
    const invoice = rowToBalanceInvoice(v2Row, living);
    const balance = getInvoiceBalance(invoice, [], [], "2026-11-15");
    expect(balance.feeDays).toBe(5);
    expect(balance.feeAccrued).toBe(500);
    expect(balance.amountDue).toBe(3500);
    expect(balance.status).toBe("overdue");
  });

  it("maps a stored manual status and the slip flag", () => {
    expect(rowToBalanceInvoice({ ...v2Row, status: "draft" }, living).manual_status).toBe("draft");
    expect(rowToBalanceInvoice({ ...v2Row, status: "verifying" }, living).is_verifying).toBe(true);
    expect(rowToBalanceInvoice({ ...v2Row, status: "overdue" }, living).manual_status).toBeNull();
  });

  it("maps a legacy row through the read-only adapter fields", () => {
    const invoice = rowToBalanceInvoice(
      { ...v2Row, fee_model: "legacy", total_amount: 5758, carry_forward_amount: 2850 },
      living,
    );
    expect(invoice.fee_model).toBe("legacy");
    expect(getInvoiceBalance(invoice, [], [], "2026-11-15").charges).toBe(2908);
  });

  it("refuses an unknown fee model or kind instead of guessing", () => {
    expect(() => rowToBalanceInvoice({ ...v2Row, fee_model: null }, living)).toThrow();
    expect(() => rowToBalanceInvoice({ ...v2Row, kind: "weird" }, living)).toThrow();
  });
});

describe("nextCachedV2Status", () => {
  it("moves pending to overdue once the engine says so", () => {
    expect(nextCachedV2Status("pending", "overdue")).toBe("overdue");
  });

  it("moves into and out of paid (a waiver, or voiding one)", () => {
    expect(nextCachedV2Status("overdue", "paid")).toBe("paid");
    expect(nextCachedV2Status("paid", "overdue")).toBe("overdue");
  });

  it("returns null when nothing changes", () => {
    expect(nextCachedV2Status("overdue", "overdue")).toBeNull();
  });

  it("never touches a draft, a cancelled/closed bill, or one with a slip under review", () => {
    expect(nextCachedV2Status("draft", "overdue")).toBeNull();
    expect(nextCachedV2Status("cancelled", "overdue")).toBeNull();
    expect(nextCachedV2Status("closed_unpaid", "paid")).toBeNull();
    expect(nextCachedV2Status("verifying", "paid")).toBeNull();
  });

  it("never writes a manual/flag status the engine reports", () => {
    expect(nextCachedV2Status("pending", "verifying")).toBeNull();
    expect(nextCachedV2Status("pending", "draft")).toBeNull();
  });
});

describe("lateFeeActionBlockReason", () => {
  it("allows a v2 monthly bill", () => {
    expect(lateFeeActionBlockReason({ fee_model: "v2", kind: "monthly", status: "overdue" })).toBeNull();
  });

  it("refuses a legacy bill (its fee is a frozen amount)", () => {
    expect(lateFeeActionBlockReason({ fee_model: "legacy", kind: "monthly", status: "overdue" })).toMatch(
      /แบบเดิม/,
    );
  });

  it("refuses a move-out bill and a cancelled bill", () => {
    expect(lateFeeActionBlockReason({ fee_model: "v2", kind: "move_out", status: "pending" })).not.toBeNull();
    expect(lateFeeActionBlockReason({ fee_model: "v2", kind: "monthly", status: "cancelled" })).not.toBeNull();
  });
});

describe("validateWaiverRequest", () => {
  it("accepts an amount up to the fee still due, with a reason", () => {
    expect(validateWaiverRequest({ amount: 500, reason: "ลูกค้าดี", feeDue: 500 })).toBeNull();
    expect(validateWaiverRequest({ amount: 200.5, reason: "x", feeDue: 500 })).toBeNull();
  });

  it("requires amount > 0, at most 2 decimals, and a reason", () => {
    expect(validateWaiverRequest({ amount: 0, reason: "x", feeDue: 500 })).not.toBeNull();
    expect(validateWaiverRequest({ amount: -1, reason: "x", feeDue: 500 })).not.toBeNull();
    expect(validateWaiverRequest({ amount: Number.NaN, reason: "x", feeDue: 500 })).not.toBeNull();
    expect(validateWaiverRequest({ amount: 1.005, reason: "x", feeDue: 500 })).not.toBeNull();
    expect(validateWaiverRequest({ amount: 100, reason: "   ", feeDue: 500 })).not.toBeNull();
  });

  it("refuses more than the fee due, or any waiver when nothing is due", () => {
    expect(validateWaiverRequest({ amount: 500.01, reason: "x", feeDue: 500 })).not.toBeNull();
    expect(validateWaiverRequest({ amount: 1, reason: "x", feeDue: 0 })).not.toBeNull();
  });
});

describe("validatePauseRequest", () => {
  it("needs a real YYYY-MM-DD date and a reason", () => {
    expect(validatePauseRequest({ fromDate: "2026-11-20", reason: "ผ่อนชำระ" })).toBeNull();
    expect(validatePauseRequest({ fromDate: "20/11/2026", reason: "x" })).not.toBeNull();
    expect(validatePauseRequest({ fromDate: "", reason: "x" })).not.toBeNull();
    expect(validatePauseRequest({ fromDate: "2026-11-20", reason: "" })).not.toBeNull();
  });
});
