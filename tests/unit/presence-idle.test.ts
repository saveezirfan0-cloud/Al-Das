import { describe, expect, it } from "vitest";

import {
  ACTIVITY_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  heartbeatDue,
  isPresence,
  isPresenceOnline,
} from "@/lib/presence/idle";

const NOW = new Date("2026-10-12T10:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

describe("isPresenceOnline (mirror of app.presence_is_online)", () => {
  it("is plain presence when auto-away is off", () => {
    expect(isPresenceOnline("online", null, null, NOW)).toBe(true);
    expect(isPresenceOnline("away", ago(0), null, NOW)).toBe(false);
    expect(isPresenceOnline("offline", ago(0), null, NOW)).toBe(false);
  });

  it("needs a recent heartbeat when auto-away is on", () => {
    expect(isPresenceOnline("online", ago(14), 15, NOW)).toBe(true);
    expect(isPresenceOnline("online", ago(15), 15, NOW)).toBe(true);
    expect(isPresenceOnline("online", ago(16), 15, NOW)).toBe(false);
    expect(isPresenceOnline("online", null, 15, NOW)).toBe(false);
    expect(isPresenceOnline("away", ago(1), 15, NOW)).toBe(false);
  });
});

describe("heartbeatDue", () => {
  const t = NOW.getTime();
  it("sends at once on load while the person is active and the tab visible", () => {
    expect(heartbeatDue({ now: t, visible: true, lastActivityAt: t, lastSentAt: null })).toBe(true);
  });
  it("never sends from a hidden tab or an idle person", () => {
    expect(heartbeatDue({ now: t, visible: false, lastActivityAt: t, lastSentAt: null })).toBe(
      false,
    );
    expect(
      heartbeatDue({
        now: t,
        visible: true,
        lastActivityAt: t - ACTIVITY_WINDOW_MS - 1,
        lastSentAt: null,
      }),
    ).toBe(false);
    expect(heartbeatDue({ now: t, visible: true, lastActivityAt: null, lastSentAt: null })).toBe(
      false,
    );
  });
  it("sends at most once per interval", () => {
    expect(
      heartbeatDue({
        now: t,
        visible: true,
        lastActivityAt: t,
        lastSentAt: t - HEARTBEAT_INTERVAL_MS + 1,
      }),
    ).toBe(false);
    expect(
      heartbeatDue({
        now: t,
        visible: true,
        lastActivityAt: t,
        lastSentAt: t - HEARTBEAT_INTERVAL_MS,
      }),
    ).toBe(true);
  });
  it("recognises presence values", () => {
    expect(["online", "away", "offline", "busy", null].map(isPresence)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});
