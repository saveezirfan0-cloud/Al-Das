import { describe, expect, it } from "vitest";

import { countsAsFirstTouch } from "@/lib/enquiries/touch";

const human = { sent_by_user_id: "u1", campaign_recipient_id: null };

describe("countsAsFirstTouch", () => {
  it("counts a person's own message", () => {
    expect(countsAsFirstTouch(human, "text")).toBe(true);
    expect(countsAsFirstTouch(human, "template")).toBe(true);
  });

  it("ignores bots and flows (no sender), campaigns and reactions", () => {
    expect(countsAsFirstTouch({ sent_by_user_id: null, campaign_recipient_id: null }, "text")).toBe(false);
    expect(countsAsFirstTouch({ sent_by_user_id: "u1", campaign_recipient_id: "r1" }, "template")).toBe(false);
    expect(countsAsFirstTouch(human, "reaction")).toBe(false);
  });
});
