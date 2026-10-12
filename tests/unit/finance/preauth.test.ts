import { describe, expect, it } from "vitest";

import {
  canTransition,
  dueForExpiryTask,
  nextStatuses,
  pastExpiry,
  PREAUTH_STATUSES,
  preauthExpiry,
  taskDueAt,
  validateApproval,
  type PreauthStatus,
} from "@/lib/finance/preauth";

describe("pre-authorisation workflow", () => {
  it("only allows the documented transitions", () => {
    expect(canTransition("draft", "requested")).toBe(true);
    expect(canTransition("requested", "approved")).toBe(true);
    expect(canTransition("requested", "used")).toBe(false);
    expect(canTransition("approved", "used")).toBe(true);
    expect(canTransition("denied", "requested")).toBe(true);
    for (const s of ["expired", "cancelled", "used"] as PreauthStatus[])
      expect(nextStatuses(s)).toEqual([]);
    for (const a of PREAUTH_STATUSES) expect(canTransition(a, a)).toBe(false);
  });

  it("refuses an approval without the payer's reference or an expiry date", () => {
    expect(validateApproval({ authNumber: "", expiresOn: "2026-12-01", validFrom: null })).toMatch(
      /authorisation number/,
    );
    expect(validateApproval({ authNumber: "A-1", expiresOn: null, validFrom: null })).toMatch(
      /expires/,
    );
    expect(
      validateApproval({ authNumber: "A-1", expiresOn: "2026-11-01", validFrom: "2026-12-01" }),
    ).toMatch(/before the start/);
    expect(
      validateApproval({ authNumber: "A-1", expiresOn: "2026-12-01", validFrom: "2026-11-01" }),
    ).toBeNull();
  });

  it("classifies the expiry of an approved authorisation against the lead time", () => {
    expect(preauthExpiry("approved", "2026-10-30", "2026-10-20", 7)).toEqual({
      state: "valid",
      daysLeft: 10,
    });
    expect(preauthExpiry("approved", "2026-10-27", "2026-10-20", 7)).toEqual({
      state: "expiring",
      daysLeft: 7,
    });
    expect(preauthExpiry("partially_approved", "2026-10-19", "2026-10-20", 7)).toEqual({
      state: "expired",
      daysLeft: -1,
    });
    expect(preauthExpiry("requested", "2026-10-30", "2026-10-20", 7)).toEqual({
      state: "none",
      daysLeft: null,
    });
    expect(preauthExpiry("approved", null, "2026-10-20", 7).state).toBe("none");
  });

  const rows = [
    { id: "a", status: "approved", expires_on: "2026-10-22", expiry_notified_at: null },
    {
      id: "b",
      status: "approved",
      expires_on: "2026-10-22",
      expiry_notified_at: "2026-10-19T00:00:00Z",
    },
    { id: "c", status: "approved", expires_on: "2026-12-22", expiry_notified_at: null },
    { id: "d", status: "requested", expires_on: "2026-10-22", expiry_notified_at: null },
    { id: "e", status: "approved", expires_on: "2026-10-10", expiry_notified_at: null },
    { id: "f", status: "partially_approved", expires_on: "2026-10-20", expiry_notified_at: null },
  ];

  it("picks the ones to remind: approved, inside the window, not yet reminded, not already past", () => {
    expect(dueForExpiryTask(rows, "2026-10-20", 7).map((r) => r.id)).toEqual(["a", "f"]);
  });

  it("picks the ones to mark expired", () => {
    expect(pastExpiry(rows, "2026-10-20").map((r) => r.id)).toEqual(["e"]);
  });

  it("is idempotent: once claimed (expiry_notified_at set) a row is never picked again", () => {
    const claimed = rows.map((r) =>
      r.id === "a" ? { ...r, expiry_notified_at: "2026-10-20T03:50:00Z" } : r,
    );
    expect(dueForExpiryTask(claimed, "2026-10-20", 7).map((r) => r.id)).toEqual(["f"]);
  });

  it("places the task two days before expiry, or now when that has passed", () => {
    const now = new Date("2026-10-20T04:00:00Z");
    expect(taskDueAt("2026-10-30", now).toISOString()).toBe("2026-10-28T06:00:00.000Z");
    expect(taskDueAt("2026-10-21", now)).toBe(now);
  });
});
