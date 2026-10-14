/**
 * Phase 20c routing rules (pure). The routing itself (pick + fallback + capacity) runs in SQL inside
 * public.route_conversation() so it is race-safe; this file parses its answer and decides the team auto-reply.
 */
import { z } from "zod";

import {
  DAYS,
  isWithinOfficeHours,
  officeHoursSchema,
  type OfficeHours,
} from "@/lib/flow-engine/office-hours";

export const AUTO_REPLY_MAX_LENGTH = 1024;
/** WhatsApp customer-service window: free-form text only within 24 h of the patient's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RouteOutcome = {
  teamId: string | null;
  userId: string | null;
  /** The conversation went to the team's fallback team. */
  fallback: boolean;
  /** Someone in the team it landed in is online (idle-aware). */
  teamOnline: boolean;
  autoReplyText: string | null;
  officeHours: OfficeHours | null;
};

const uuid = z.string().uuid();

/**
 * Phase B: the team a new conversation is routed to. The number's own team (channels.default_team_id, a branch's desk)
 * comes first, then the workspace default (Settings, Inbox); null = no routing. public.route_conversation() applies the
 * same order in SQL (it re-reads the channel), so a stale value here can only pick the team the database would.
 */
export function routingTeamId(
  channelTeamId: string | null | undefined,
  orgDefaultTeamId: string | null | undefined,
): string | null {
  return channelTeamId || orgDefaultTeamId || null;
}

/** Office hours as stored on teams.office_hours: null (always open) or a valid schedule; anything else is null. */
export function parseOfficeHours(raw: unknown): OfficeHours | null {
  if (raw === null || raw === undefined) return null;
  const parsed = officeHoursSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Reads public.route_conversation()'s jsonb answer; malformed input yields null (treated as "not routed"). */
export function parseRouteOutcome(raw: unknown): RouteOutcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) => (uuid.safeParse(v).success ? (v as string) : null);
  const text = typeof r.auto_reply_text === "string" ? r.auto_reply_text.trim() : "";
  return {
    teamId: id(r.team_id),
    userId: id(r.user_id),
    fallback: r.fallback === true,
    teamOnline: r.team_online === true,
    autoReplyText: text ? text.slice(0, AUTO_REPLY_MAX_LENGTH) : null,
    officeHours: parseOfficeHours(r.office_hours),
  };
}

export type AutoReplyDecision =
  | { send: true; reason: "outside_hours" | "nobody_online"; text: string }
  | {
      send: false;
      reason: "no_team" | "no_text" | "already_sent" | "window_closed" | "staffed";
    };

/**
 * Whether a newly routed conversation gets its team's auto-reply: once per conversation, only inside the 24 h window,
 * and only when the team is outside its office hours or nobody in it is online.
 */
export function autoReplyDecision(input: {
  outcome: RouteOutcome | null;
  alreadySentAt: string | null;
  lastInboundAt: Date | null;
  now: Date;
}): AutoReplyDecision {
  const { outcome, now } = input;
  if (!outcome?.teamId) return { send: false, reason: "no_team" };
  if (!outcome.autoReplyText) return { send: false, reason: "no_text" };
  if (input.alreadySentAt) return { send: false, reason: "already_sent" };
  const last = input.lastInboundAt;
  if (
    !last ||
    now.getTime() - last.getTime() >= SERVICE_WINDOW_MS ||
    last.getTime() > now.getTime() + 60_000
  )
    return { send: false, reason: "window_closed" };
  if (outcome.officeHours && !isWithinOfficeHours(outcome.officeHours, now))
    return { send: true, reason: "outside_hours", text: outcome.autoReplyText };
  if (!outcome.teamOnline)
    return { send: true, reason: "nobody_online", text: outcome.autoReplyText };
  return { send: false, reason: "staffed" };
}

/** Builds teams.office_hours from the settings form: the same hours on the chosen weekdays; no days = always open. */
export function officeHoursFromForm(input: {
  days: string[];
  start: string;
  end: string;
  timezone: string;
}): OfficeHours | null {
  const days = DAYS.filter((d) => input.days.includes(d));
  if (days.length === 0) return null;
  const parsed = officeHoursSchema.safeParse({
    timezone: input.timezone,
    schedule: Object.fromEntries(days.map((d) => [d, [{ start: input.start, end: input.end }]])),
  });
  if (!parsed.success) return null;
  return parsed.data;
}

/** The settings form's view of stored office hours (first slot of the first open day; defaults 08:00 to 20:00). */
export function officeHoursToForm(raw: unknown): { days: string[]; start: string; end: string } {
  const oh = parseOfficeHours(raw);
  if (!oh) return { days: [], start: "08:00", end: "20:00" };
  const days = DAYS.filter((d) => (oh.schedule[d] ?? []).length > 0);
  const first = days.length ? oh.schedule[days[0]]?.[0] : undefined;
  return { days: [...days], start: first?.start ?? "08:00", end: first?.end ?? "20:00" };
}
