import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  checkAttestation,
  classifyUser,
  daysBetween,
  isValidPeriod,
  latestOf,
  quarterOf,
  reviewSignature,
  undecided,
  type ReviewEntry,
  type ReviewUser,
} from "@/lib/security/access-review";

const NOW = new Date("2026-10-12T09:00:00Z");
const user = (over: Partial<ReviewUser> = {}): ReviewUser => ({
  userId: "u1",
  membershipId: "m1",
  name: "Amal Khan",
  email: "amal@example.test",
  roleName: "Receptionist",
  rolePermissions: ["inbox.send"],
  status: "active",
  lastActiveAt: "2026-10-10T09:00:00Z",
  joinedAt: "2026-01-01T09:00:00Z",
  apiKeys: [],
  mfaRequired: false,
  ...over,
});

describe("quarters", () => {
  it("names the UTC calendar quarter", () => {
    expect(quarterOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-Q1");
    expect(quarterOf(new Date("2026-03-31T23:59:59Z"))).toBe("2026-Q1");
    expect(quarterOf(new Date("2026-04-01T00:00:00Z"))).toBe("2026-Q2");
    expect(quarterOf(NOW)).toBe("2026-Q4");
    expect(quarterOf(new Date("2026-12-31T12:00:00Z"))).toBe("2026-Q4");
  });
  it("validates period strings", () => {
    expect(isValidPeriod("2026-Q4")).toBe(true);
    for (const bad of ["2026-Q5", "2026Q1", "26-Q1", "", "2026-q1"])
      expect(isValidPeriod(bad), bad).toBe(false);
  });
});

describe("dormancy", () => {
  it("counts whole days and flips at the threshold", () => {
    expect(daysBetween(new Date("2026-09-12T09:00:00Z"), NOW)).toBe(30);
    expect(classifyUser(user({ lastActiveAt: "2026-09-12T09:00:00Z" }), NOW).dormant).toBe(true);
    expect(classifyUser(user({ lastActiveAt: "2026-09-13T09:00:00Z" }), NOW).idleDays).toBe(29);
    expect(classifyUser(user({ lastActiveAt: "2026-09-13T09:00:01Z" }), NOW).dormant).toBe(false);
  });
  it("measures a never-seen person from the day they joined", () => {
    expect(
      classifyUser(user({ lastActiveAt: null, joinedAt: "2026-10-01T09:00:00Z" }), NOW).dormant,
    ).toBe(false);
    expect(
      classifyUser(user({ lastActiveAt: null, joinedAt: "2026-06-01T09:00:00Z" }), NOW).dormant,
    ).toBe(true);
  });
  it("never calls a suspended account dormant, and honours a custom threshold", () => {
    expect(
      classifyUser(user({ status: "suspended", lastActiveAt: "2025-01-01T00:00:00Z" }), NOW)
        .dormant,
    ).toBe(false);
    expect(classifyUser(user({ lastActiveAt: "2026-10-02T09:00:00Z" }), NOW, 7).dormant).toBe(true);
  });
  it("flags full-access roles", () => {
    expect(classifyUser(user({ rolePermissions: ["*"] }), NOW).fullAccess).toBe(true);
    expect(classifyUser(user(), NOW).fullAccess).toBe(false);
  });
});

describe("snapshot and attestation", () => {
  const snapshot = buildSnapshot(
    [
      user({ userId: "b", name: "Bea" }),
      user({ userId: "a", name: "Ann", lastActiveAt: "2026-01-01T00:00:00Z" }),
      user({ userId: "s", name: "Sam", status: "suspended" }),
    ],
    NOW,
  );

  it("lists dormant people first, then by name", () => {
    expect(snapshot.map((e) => e.userId)).toEqual(["a", "b", "s"]);
  });

  it("needs a decision for every active person, not for suspended ones", () => {
    expect(undecided(snapshot).map((e) => e.userId)).toEqual(["a", "b"]);
    const decided = snapshot.map((e) => ({ ...e, decision: "keep" as const }));
    expect(undecided(decided)).toEqual([]);
  });

  const signer = { signerName: "Dr. Noor  Ali", signerEmail: "noor@example.test" };
  const decided: ReviewEntry[] = snapshot.map((e) => ({
    ...e,
    decision: e.status === "active" ? "keep" : null,
  }));

  it("accepts the signer's own name or e-mail, case and spacing aside", () => {
    expect(
      checkAttestation({
        ...signer,
        typedName: "dr. noor ali",
        snapshot: decided,
        confirmed: true,
      }),
    ).toEqual({ ok: true });
    expect(
      checkAttestation({
        ...signer,
        typedName: "NOOR@example.test",
        snapshot: decided,
        confirmed: true,
      }),
    ).toEqual({ ok: true });
  });
  it("refuses a wrong name, a missing tick or an incomplete review", () => {
    expect(
      checkAttestation({ ...signer, typedName: "Someone Else", snapshot: decided, confirmed: true })
        .ok,
    ).toBe(false);
    expect(
      checkAttestation({ ...signer, typedName: "", snapshot: decided, confirmed: true }).ok,
    ).toBe(false);
    expect(
      checkAttestation({
        ...signer,
        typedName: "Dr. Noor Ali",
        snapshot: decided,
        confirmed: false,
      }).ok,
    ).toBe(false);
    const result = checkAttestation({
      ...signer,
      typedName: "Dr. Noor Ali",
      snapshot,
      confirmed: true,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("2 users have no decision");
  });

  it("signs deterministically and changes when any decision, signer or time changes", () => {
    const base = {
      orgId: "o",
      period: "2026-Q4",
      snapshot: decided,
      signerId: "s1",
      attestedAt: "2026-10-12T10:00:00Z",
    };
    const sig = reviewSignature(base);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewSignature({ ...base, snapshot: [...decided].reverse() })).toBe(sig); // order does not matter
    expect(reviewSignature({ ...base, signerId: "s2" })).not.toBe(sig);
    expect(reviewSignature({ ...base, attestedAt: "2026-10-12T10:00:01Z" })).not.toBe(sig);
    const flipped = decided.map((e, i) => (i === 0 ? { ...e, decision: "revoke" as const } : e));
    expect(reviewSignature({ ...base, snapshot: flipped })).not.toBe(sig);
  });
});

describe("latestOf", () => {
  it("picks the newest timestamp and ignores gaps", () => {
    expect(latestOf(null, "2026-01-01T00:00:00Z", undefined, "2026-02-01T00:00:00Z")).toBe(
      "2026-02-01T00:00:00Z",
    );
    expect(latestOf(null, undefined)).toBeNull();
  });
});
