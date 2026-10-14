/**
 * Presence auto-away (Phase 20c, pure). The browser shell sends a heartbeat while the person is actually using Pulse
 * (components/shell/shell-data.tsx); the database treats an online member with no heartbeat for the org's
 * `inbox.auto_away_minutes` as away (app.presence_is_online, mirrored here) and an every-minute pg_cron sweep marks them
 * away. No in-memory timers decide anything on the server.
 */

export type Presence = "online" | "away" | "offline";

/** How often the shell may send a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** Input within this window counts as "using Pulse" for the next heartbeat. */
export const ACTIVITY_WINDOW_MS = 2 * 60_000;

/** Window event the shell fires with the presence the heartbeat returned (the user menu repaints its dot). */
export const PRESENCE_EVENT = "pulse:presence-changed";

export function isPresence(value: unknown): value is Presence {
  return value === "online" || value === "away" || value === "offline";
}

export const AUTO_AWAY_MIN_MINUTES = 5;
export const AUTO_AWAY_MAX_MINUTES = 480;

/** Mirror of app.presence_is_online(): online, and (with auto-away on) seen within the idle window. */
export function isPresenceOnline(
  presence: Presence,
  seenAt: Date | null,
  idleMinutes: number | null,
  now: Date,
): boolean {
  if (presence !== "online") return false;
  if (idleMinutes === null) return true;
  if (!seenAt) return false;
  return now.getTime() - seenAt.getTime() <= idleMinutes * 60_000;
}

/**
 * Should the shell send a heartbeat now? Only while the tab is visible, the person did something recently, and the
 * last heartbeat is at least one interval old. The first heartbeat of a page load goes out at once.
 */
export function heartbeatDue(input: {
  now: number;
  visible: boolean;
  lastActivityAt: number | null;
  lastSentAt: number | null;
}): boolean {
  if (!input.visible) return false;
  if (input.lastActivityAt === null || input.now - input.lastActivityAt > ACTIVITY_WINDOW_MS)
    return false;
  if (input.lastSentAt === null) return true;
  return input.now - input.lastSentAt >= HEARTBEAT_INTERVAL_MS;
}
