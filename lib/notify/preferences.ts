import { formatInTimeZone } from "date-fns-tz";

import { NOTIFICATION_CHANNELS, getEvent, type NotificationChannel } from "@/lib/notify/events";

/**
 * Pure rules for "should this person be told, and how?". No database, no clock: callers pass the stored
 * preference rows and `now`, so every branch is unit-tested.
 *
 * Storage model (notification_preferences):
 *   event = '<key>'  one row per event and channel: on or off.
 *   event = '*'      the channel master switch for that person, and their quiet hours for that channel.
 */

export type PrefRow = {
  event: string;
  channel: string;
  enabled: boolean;
  quiet_start?: string | null; // Postgres `time`: "22:00:00"
  quiet_end?: string | null;
};

export type Delivery = Record<NotificationChannel, boolean>;

export type DeliveryDecision = {
  deliver: Delivery;
  /** Why a channel the person would normally get was held back. Never contains content. */
  held: Partial<
    Record<NotificationChannel, "master_off" | "event_off" | "quiet_hours" | "not_offered">
  >;
};

/** "22:30" or "22:30:00" → minutes after midnight, or null when malformed. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Is the wall-clock time in `timezone` inside [start, end)? The window may cross midnight; start = end means never. */
export function inQuietHours(
  now: Date,
  timezone: string,
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === null || e === null || s === e) return false;
  let local: number | null;
  try {
    local = timeToMinutes(formatInTimeZone(now, timezone, "HH:mm"));
  } catch {
    // Unknown timezone name: do not silence anything because of bad data.
    return false;
  }
  if (local === null) return false;
  return s < e ? local >= s && local < e : local >= s || local < e;
}

/** Channels that quiet hours silence. In-app is the record, so it is never held back. */
const QUIET_CHANNELS: readonly NotificationChannel[] = ["email", "push"];

export function resolveDelivery(input: {
  event: string;
  prefs: readonly PrefRow[];
  now: Date;
  timezone: string;
}): DeliveryDecision {
  const def = getEvent(input.event);
  const deliver: Delivery = { in_app: false, email: false, push: false };
  const held: DeliveryDecision["held"] = {};
  // An event we do not know is not delivered anywhere: fail closed.
  if (!def) return { deliver, held };

  for (const channel of NOTIFICATION_CHANNELS) {
    if (!def.channels.includes(channel)) {
      held[channel] = "not_offered";
      continue;
    }
    const master = input.prefs.find((p) => p.event === "*" && p.channel === channel);
    if (master && !master.enabled) {
      held[channel] = "master_off";
      continue;
    }
    const own = input.prefs.find((p) => p.event === input.event && p.channel === channel);
    const on = own ? own.enabled : def.defaults[channel];
    if (!on) {
      held[channel] = "event_off";
      continue;
    }
    if (
      QUIET_CHANNELS.includes(channel) &&
      !def.urgent &&
      master &&
      inQuietHours(input.now, input.timezone, master.quiet_start, master.quiet_end)
    ) {
      held[channel] = "quiet_hours";
      continue;
    }
    deliver[channel] = true;
  }
  return { deliver, held };
}

/** The preference value shown in the settings form for one event and channel. */
export function effectiveSetting(
  event: string,
  channel: NotificationChannel,
  prefs: readonly PrefRow[],
): boolean {
  const own = prefs.find((p) => p.event === event && p.channel === channel);
  if (own) return own.enabled;
  return getEvent(event)?.defaults[channel] ?? false;
}
