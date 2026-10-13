import { describe, expect, it } from "vitest";

import { dayBoundaries, parsePresencePayload, presenceDurations } from "@/lib/reports/presence";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TZ = "Asia/Dubai"; // UTC+4, no DST
const H = 3600;

describe("dayBoundaries", () => {
  it("starts each org-local day at local midnight", () => {
    const b = dayBoundaries("2026-10-12", "2026-10-13", TZ);
    expect(b.map((x) => x.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(new Date(b[0].start).toISOString()).toBe("2026-10-11T20:00:00.000Z");
    expect(b[1].start - b[0].start).toBe(24 * H * 1000);
  });
});

describe("presenceDurations", () => {
  const later = new Date("2026-10-20T00:00:00Z");

  it("splits a member's time by state and by local day, across midnight", () => {
    // A: online from the start (seed), away at 22:00 local on the 12th (18:00Z), online at 02:00 local on the 13th (22:00Z),
    // offline at 06:00 local on the 13th (02:00Z on the 13th).
    const res = presenceDurations({
      seed: [{ user_id: A, presence: "online" }],
      events: [
        { user_id: A, presence: "away", at: "2026-10-12T18:00:00Z" },
        { user_id: A, presence: "online", at: "2026-10-12T22:00:00Z" },
        { user_id: A, presence: "offline", at: "2026-10-13T02:00:00Z" },
      ],
      fromDay: "2026-10-12",
      toDay: "2026-10-13",
      timezone: TZ,
      now: later,
    });
    const a = res.get(A)!;
    expect(a.get("2026-10-12")).toEqual({ online: 22 * H, away: 2 * H, offline: 0 });
    expect(a.get("2026-10-13")).toEqual({ online: 4 * H, away: 2 * H, offline: 18 * H });
    for (const d of a.values()) expect(d.online + d.away + d.offline).toBe(24 * H);
  });

  it("uses the seed for the whole window when nothing changed, offline when unknown", () => {
    const res = presenceDurations({
      seed: [
        { user_id: A, presence: "away" },
        { user_id: B, presence: "offline" },
      ],
      events: [],
      fromDay: "2026-10-12",
      toDay: "2026-10-12",
      timezone: TZ,
      now: later,
    });
    expect(res.get(A)?.get("2026-10-12")).toEqual({ online: 0, away: 24 * H, offline: 0 });
    expect(res.get(B)?.get("2026-10-12")).toEqual({ online: 0, away: 0, offline: 24 * H });
    // A member that only appears in events starts offline.
    const only = presenceDurations({
      seed: [],
      events: [{ user_id: B, presence: "online", at: "2026-10-12T08:00:00Z" }],
      fromDay: "2026-10-12",
      toDay: "2026-10-12",
      timezone: TZ,
      now: later,
    });
    expect(only.get(B)?.get("2026-10-12")).toEqual({ online: 12 * H, away: 0, offline: 12 * H });
  });

  it("never counts time after now, and ignores changes outside the window", () => {
    const now = new Date("2026-10-12T08:00:00Z"); // 12:00 local
    const res = presenceDurations({
      seed: [{ user_id: A, presence: "online" }],
      events: [
        { user_id: A, presence: "away", at: "2026-10-01T00:00:00Z" },
        { user_id: A, presence: "away", at: "2026-10-12T09:00:00Z" },
      ],
      fromDay: "2026-10-12",
      toDay: "2026-10-13",
      timezone: TZ,
      now,
    });
    expect(res.get(A)?.get("2026-10-12")).toEqual({ online: 12 * H, away: 0, offline: 0 });
    expect(res.get(A)?.has("2026-10-13")).toBe(false);
  });

  it("returns nothing for a window entirely in the future", () => {
    const res = presenceDurations({
      seed: [{ user_id: A, presence: "online" }],
      events: [],
      fromDay: "2026-10-12",
      toDay: "2026-10-12",
      timezone: TZ,
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(res.size).toBe(0);
  });
});

describe("parsePresencePayload", () => {
  it("keeps well-formed rows only", () => {
    expect(
      parsePresencePayload({
        seed: [{ user_id: A, presence: "online" }, { user_id: B, presence: "busy" }, null],
        events: [
          { user_id: A, presence: "away", at: "2026-10-12T00:00:00Z" },
          { user_id: A, presence: "away", at: "not a date" },
          { presence: "away", at: "2026-10-12T00:00:00Z" },
        ],
        truncated: true,
      }),
    ).toEqual({
      seed: [{ user_id: A, presence: "online" }],
      events: [{ user_id: A, presence: "away", at: "2026-10-12T00:00:00Z" }],
      truncated: true,
    });
    expect(parsePresencePayload(null)).toEqual({ seed: [], events: [], truncated: false });
  });
});
