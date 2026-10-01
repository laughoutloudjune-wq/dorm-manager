import { describe, expect, it } from "vitest";
import { moveOutIssueText } from "./move-out-messages";

describe("moveOutIssueText", () => {
  it("explains a known blocker in Thai with what to do", () => {
    expect(moveOutIssueText({ code: "slip_pending", message: "A payment slip is waiting" })).toContain("สลิป");
    expect(moveOutIssueText({ code: "unsent_monthly_draft" })).toContain("ฉบับร่าง");
  });

  it("keeps the server detail for bad_request", () => {
    expect(moveOutIssueText({ code: "bad_request", message: "handover date is in the future" })).toContain(
      "handover date is in the future",
    );
  });

  it("falls back to the server message for an unknown code", () => {
    expect(moveOutIssueText({ code: "something_new", message: "raw text" })).toBe("raw text");
    expect(moveOutIssueText({ code: "" })).toBe("เกิดข้อผิดพลาด");
  });
});
