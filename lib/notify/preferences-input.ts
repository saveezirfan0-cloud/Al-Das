import { z } from "zod";

import { NOTIFICATION_CHANNELS, getEvent, type NotificationChannel } from "@/lib/notify/events";

/**
 * What the settings form sends, and the rows it becomes. Pure: the server action validates with this and
 * the unit tests drive it directly. Anything outside the catalogue is dropped, never stored.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const preferencesInput = z.object({
  /** One entry per event and channel the person changed or confirmed. */
  toggles: z
    .array(
      z.object({
        event: z.string().min(1).max(64),
        channel: z.enum(NOTIFICATION_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .max(60),
  /** Channel master switch and quiet hours (quiet hours exist for e-mail and push only). */
  channels: z
    .array(
      z.object({
        channel: z.enum(NOTIFICATION_CHANNELS),
        enabled: z.boolean(),
        quiet_start: hhmm.nullable().default(null),
        quiet_end: hhmm.nullable().default(null),
      }),
    )
    .max(3),
});
export type PreferencesInput = z.infer<typeof preferencesInput>;

export type PreferenceRow = {
  org_id: string;
  user_id: string;
  event: string;
  channel: NotificationChannel;
  enabled: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
};

export function buildPreferenceRows(args: {
  orgId: string;
  userId: string;
  input: PreferencesInput;
  /** Permission check for events that need one (the digests need reports.view). */
  canDo: (permission: string) => boolean;
}): { rows: PreferenceRow[]; error: string | null } {
  const rows = new Map<string, PreferenceRow>();
  for (const t of args.input.toggles) {
    const def = getEvent(t.event);
    if (!def || !def.channels.includes(t.channel)) continue;
    if (def.permission && !args.canDo(def.permission)) continue;
    rows.set(`${t.event}:${t.channel}`, {
      org_id: args.orgId,
      user_id: args.userId,
      event: t.event,
      channel: t.channel,
      enabled: t.enabled,
      quiet_start: null,
      quiet_end: null,
    });
  }
  for (const c of args.input.channels) {
    const quietAllowed = c.channel !== "in_app";
    const start = quietAllowed ? c.quiet_start : null;
    const end = quietAllowed ? c.quiet_end : null;
    if ((start === null) !== (end === null))
      return { rows: [], error: "Set both a start and an end time for quiet hours, or neither." };
    if (start !== null && start === end)
      return { rows: [], error: "Quiet hours cannot start and end at the same time." };
    rows.set(`*:${c.channel}`, {
      org_id: args.orgId,
      user_id: args.userId,
      event: "*",
      channel: c.channel,
      enabled: c.enabled,
      quiet_start: start,
      quiet_end: end,
    });
  }
  return { rows: [...rows.values()], error: null };
}
