/**
 * Member status log (Phase 20c / G13, pure): online / away / offline time per member per org-local day, from the
 * presence change log (member_presence_events via public.report_presence_events). Time after `now` is never counted.
 */
import { fromZonedTime } from "date-fns-tz";

import { addDays } from "@/lib/reports/range";

export type PresenceState = "online" | "away" | "offline";
export type PresenceSeed = { user_id: string; presence: PresenceState };
export type PresenceChange = { user_id: string; presence: PresenceState; at: string };
export type Durations = { online: number; away: number; offline: number };
export type PresencePayload = {
  seed: PresenceSeed[];
  events: PresenceChange[];
  truncated: boolean;
};

const STATES = new Set<string>(["online", "away", "offline"]);
const isState = (v: unknown): v is PresenceState => typeof v === "string" && STATES.has(v);

/** Reads the report function's jsonb; anything malformed is dropped, never guessed. */
export function parsePresencePayload(raw: unknown): PresencePayload {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const seed = (Array.isArray(obj.seed) ? obj.seed : []).flatMap((s): PresenceSeed[] => {
    const r = s as Record<string, unknown>;
    return typeof r?.user_id === "string" && isState(r.presence)
      ? [{ user_id: r.user_id, presence: r.presence }]
      : [];
  });
  const events = (Array.isArray(obj.events) ? obj.events : []).flatMap((e): PresenceChange[] => {
    const r = e as Record<string, unknown>;
    return typeof r?.user_id === "string" &&
      isState(r.presence) &&
      typeof r.at === "string" &&
      !Number.isNaN(Date.parse(r.at))
      ? [{ user_id: r.user_id, presence: r.presence, at: r.at }]
      : [];
  });
  return { seed, events, truncated: obj.truncated === true };
}

/** The org-local days [fromDay, toDay] with each day's UTC start; the last entry is the exclusive end. */
export function dayBoundaries(
  fromDay: string,
  toDay: string,
  timezone: string,
): Array<{ day: string; start: number }> {
  const out: Array<{ day: string; start: number }> = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1))
    out.push({ day: d, start: fromZonedTime(`${d}T00:00:00`, timezone).getTime() });
  out.push({
    day: addDays(toDay, 1),
    start: fromZonedTime(`${addDays(toDay, 1)}T00:00:00`, timezone).getTime(),
  });
  return out;
}

/**
 * Seconds in each state per member per day. A member's state at the start of the window comes from `seed` (offline when
 * unknown); each change switches it from its timestamp on. Changes outside the window are ignored.
 */
export function presenceDurations(input: {
  seed: PresenceSeed[];
  events: PresenceChange[];
  fromDay: string;
  toDay: string;
  timezone: string;
  now: Date;
}): Map<string, Map<string, Durations>> {
  const bounds = dayBoundaries(input.fromDay, input.toDay, input.timezone);
  const windowStart = bounds[0].start;
  const windowEnd = Math.min(bounds[bounds.length - 1].start, input.now.getTime());
  const result = new Map<string, Map<string, Durations>>();
  if (windowEnd <= windowStart) return result;

  const byUser = new Map<string, PresenceChange[]>();
  for (const s of input.seed) byUser.set(s.user_id, byUser.get(s.user_id) ?? []);
  for (const e of input.events) byUser.set(e.user_id, [...(byUser.get(e.user_id) ?? []), e]);
  const seedOf = new Map(input.seed.map((s) => [s.user_id, s.presence]));

  const add = (user: string, state: PresenceState, from: number, to: number) => {
    let days = result.get(user);
    if (!days) result.set(user, (days = new Map()));
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = Math.max(from, bounds[i].start);
      const b = Math.min(to, bounds[i + 1].start);
      if (b <= a) continue;
      const d = days.get(bounds[i].day) ?? { online: 0, away: 0, offline: 0 };
      d[state] += (b - a) / 1000;
      days.set(bounds[i].day, d);
    }
  };

  for (const [user, changes] of byUser) {
    const sorted = changes
      .map((c) => ({ ...c, t: Date.parse(c.at) }))
      .filter((c) => c.t >= windowStart && c.t < windowEnd)
      .sort((a, b) => a.t - b.t);
    let state: PresenceState = seedOf.get(user) ?? "offline";
    let cursor = windowStart;
    for (const c of sorted) {
      add(user, state, cursor, c.t);
      state = c.presence;
      cursor = c.t;
    }
    add(user, state, cursor, windowEnd);
  }
  for (const days of result.values())
    for (const d of days.values()) {
      d.online = Math.round(d.online);
      d.away = Math.round(d.away);
      d.offline = Math.round(d.offline);
    }
  return result;
}
