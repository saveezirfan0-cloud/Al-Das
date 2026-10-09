import { describe, expect, it } from "vitest";

import { isClosed, resolveStatusChange } from "@/lib/enquiries/status";

describe("resolveStatusChange", () => {
  it("requires a reason for lost and disqualified", () => {
    for (const to of ["lost", "disqualified"] as const) {
      const res = resolveStatusChange({ from: "open", to });
      expect(res.ok).toBe(false);
      expect(resolveStatusChange({ from: "open", to, reason: "   " }).ok).toBe(false);
      expect(resolveStatusChange({ from: "open", to, reason: null }).ok).toBe(false);
    }
  });

  it("trims the reason and closes the enquiry", () => {
    const res = resolveStatusChange({ from: "open", to: "lost", reason: "  Too expensive " });
    expect(res).toEqual({
      ok: true,
      status: "lost",
      lostReason: "Too expensive",
      closed: true,
      reopened: false,
    });
  });

  it("rejects over-long reasons", () => {
    expect(resolveStatusChange({ from: "open", to: "lost", reason: "x".repeat(501) }).ok).toBe(false);
    expect(resolveStatusChange({ from: "open", to: "lost", reason: "x".repeat(500) }).ok).toBe(true);
  });

  it("drops the reason for won and open, and flags reopening", () => {
    expect(resolveStatusChange({ from: "open", to: "won", reason: "ignored" })).toEqual({
      ok: true,
      status: "won",
      lostReason: null,
      closed: true,
      reopened: false,
    });
    expect(resolveStatusChange({ from: "lost", to: "open" })).toEqual({
      ok: true,
      status: "open",
      lostReason: null,
      closed: false,
      reopened: true,
    });
    expect(resolveStatusChange({ from: "open", to: "open" })).toMatchObject({ reopened: false });
  });

  it("treats everything but open as closed", () => {
    expect(isClosed("open")).toBe(false);
    for (const s of ["won", "lost", "disqualified"] as const) expect(isClosed(s)).toBe(true);
  });
});
