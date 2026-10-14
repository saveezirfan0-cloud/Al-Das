import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import { localDay, type AlertDraft } from "@/lib/security/anomaly";
import { ipAllowed, parseIpRange, type ParsedIp } from "@/lib/security/client-ip";

/**
 * Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md). An organisation can limit when, and from which
 * addresses, members reach finance and accounting. Stored in orgs.settings->'finance_access'; OFF by default.
 *
 * The decision is pure: the server (lib/auth/session.ts) feeds it the clock, the org timezone, the stored setting, the
 * request's client address and the member's role, once per request. The database repeats the days-and-hours part in
 * app.finance_window_reason (RLS through app.has_perm / app.has_perm_wild), parity-tested with
 * tests/unit/finance/fixtures/finance-access-window.synthetic.json; the address list is enforced here only. A denied member keeps every other permission;
 * only permissions in RESTRICTED_AREAS stop matching (lib/auth/can.ts). Admin ("*") is never restricted, so a wrong
 * setting can always be put right.
 */

/** Permission areas the window covers: the first segment of a permission key. */
export const RESTRICTED_AREAS = ["finance", "accounting"] as const;

/** ISO weekdays, 1 = Monday ... 7 = Sunday. */
export const WEEKDAYS = [
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
  { day: 7, short: "Sun", label: "Sunday" },
] as const;

export const MAX_ALLOWLIST_ENTRIES = 50;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const financeAccessSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Limit to the days and hours below. Off means any time (an address list can still apply). */
    limit_hours: z.boolean().default(true),
    days: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .default([1, 2, 3, 4, 5, 6])
      .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
    /** Org timezone. start > end is an overnight window; start = end is the whole day. */
    start: hhmm.default("07:00"),
    end: hhmm.default("21:00"),
    /** IPv4/IPv6 addresses and CIDR ranges. Empty means any location. Stored in canonical form. */
    ip_allowlist: z
      .array(z.string().max(64))
      .max(MAX_ALLOWLIST_ENTRIES, `At most ${MAX_ALLOWLIST_ENTRIES} addresses or ranges.`)
      .default([])
      .transform((list, ctx) => {
        const out: string[] = [];
        for (const raw of list) {
          if (!raw.trim()) continue;
          const r = parseIpRange(raw);
          if (!r.ok) {
            ctx.addIssue({ code: "custom", message: r.error });
            return z.NEVER;
          }
          if (!out.includes(r.text)) out.push(r.text);
        }
        return out;
      }),
    /** Every role holding a finance or accounting permission, or only the roles listed. */
    scope: z.enum(["finance_roles", "selected_roles"]).default("finance_roles"),
    role_ids: z.array(z.string().uuid()).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    // Only a window that is switched on has to be complete; a switched-off draft can be saved half-filled.
    // supabase/migrations/20261121000100_finance_access_window.sql (app.finance_window_reason) repeats these rules.
    if (!v.enabled) return;
    if (v.limit_hours && v.days.length === 0)
      ctx.addIssue({ code: "custom", message: "Choose at least one day." });
    if (!v.limit_hours && v.ip_allowlist.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Limit the days and hours, add an address, or leave the window off.",
      });
    if (v.scope === "selected_roles" && v.role_ids.length === 0)
      ctx.addIssue({ code: "custom", message: "Choose at least one role." });
  });

export type FinanceAccessSettings = z.output<typeof financeAccessSchema>;
export type FinanceAccessInput = z.input<typeof financeAccessSchema>;

export const DEFAULT_FINANCE_ACCESS: FinanceAccessSettings = financeAccessSchema.parse({});

/**
 * The stored setting, or `ok: false` when something is stored but does not validate: the decision then fails closed,
 * unless the stored value plainly says `enabled: false` (`disabled`), which is honoured before full validation.
 */
export type StoredFinanceAccess =
  { ok: true; settings: FinanceAccessSettings } | { ok: false; settings: null; disabled: boolean };

export function readFinanceAccess(orgSettings: unknown): StoredFinanceAccess {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).finance_access
      : undefined;
  if (raw === undefined || raw === null) return { ok: true, settings: DEFAULT_FINANCE_ACCESS };
  const parsed = financeAccessSchema.safeParse(raw);
  if (parsed.success) return { ok: true, settings: parsed.data };
  const disabled =
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { enabled?: unknown }).enabled === false;
  return { ok: false, settings: null, disabled };
}

export function writeFinanceAccess(
  orgSettings: unknown,
  next: FinanceAccessSettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.finance_access = financeAccessSchema.parse(next);
  return base;
}

/** True when the role's permissions reach a restricted area (directly, or through a wildcard first segment). */
export function holdsRestrictedArea(permissions: readonly string[]): boolean {
  return permissions.some((p) => {
    if (typeof p !== "string" || p === "*") return false;
    const area = p.split(".")[0];
    return area === "*" || (RESTRICTED_AREAS as readonly string[]).includes(area);
  });
}

export type FinanceAccessAllowReason = "admin" | "off" | "not_in_scope" | "inside";
export type FinanceAccessDenyReason =
  "invalid_settings" | "ip_unknown" | "ip_not_allowed" | "day_not_allowed" | "outside_hours";

export type FinanceAccessDecision =
  | { allowed: true; reason: FinanceAccessAllowReason }
  | { allowed: false; reason: FinanceAccessDenyReason };

function minutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * A named IANA zone ("Asia/Dubai", "UTC", "Etc/GMT+4"), not an offset ("+04:00", "UTC+4", "GMT-3"). Offsets are
 * refused because Postgres reads them POSIX-style (sign reversed) while the app reads them ISO-style; the database
 * refuses them too when the window is switched on (app.finance_access_problem).
 */
export function isNamedTimeZone(timeZone: string): boolean {
  return (
    typeof timeZone === "string" &&
    /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone) &&
    !/^(UTC|GMT)[+-]/i.test(timeZone) &&
    !/^(posix|right)\//i.test(timeZone) &&
    !["posixrules", "Factory", "localtime"].includes(timeZone)
  );
}

/** Local ISO weekday (1-7) and minutes since midnight in the timezone; null when the timezone is not valid. */
export function localClock(now: Date, timeZone: string): { day: number; minute: number } | null {
  if (!isNamedTimeZone(timeZone)) return null;
  try {
    const [day, time] = formatInTimeZone(now, timeZone, "i HH:mm").split(" ");
    return { day: Number(day), minute: minutes(time) };
  } catch {
    return null;
  }
}

/**
 * Inside the days and hours? A window that wraps midnight (22:00-02:00) belongs to the day it starts on: 01:00 on
 * Tuesday is inside when Monday is allowed. start = end means the whole of each allowed day.
 */
export function insideHours(
  clock: { day: number; minute: number },
  s: Pick<FinanceAccessSettings, "days" | "start" | "end">,
): { inside: true } | { inside: false; reason: "day_not_allowed" | "outside_hours" } {
  const start = minutes(s.start);
  const end = minutes(s.end);
  const today = s.days.includes(clock.day);
  const yesterday = s.days.includes(clock.day === 1 ? 7 : clock.day - 1);
  if (start === end) return today ? { inside: true } : { inside: false, reason: "day_not_allowed" };
  if (start < end) {
    if (!today) return { inside: false, reason: "day_not_allowed" };
    return clock.minute >= start && clock.minute < end
      ? { inside: true }
      : { inside: false, reason: "outside_hours" };
  }
  // overnight
  if (clock.minute >= start) {
    return today ? { inside: true } : { inside: false, reason: "day_not_allowed" };
  }
  if (clock.minute < end) {
    return yesterday ? { inside: true } : { inside: false, reason: "day_not_allowed" };
  }
  return { inside: false, reason: today || yesterday ? "outside_hours" : "day_not_allowed" };
}

export type FinanceAccessDecisionInput = {
  now: Date;
  timezone: string;
  stored: StoredFinanceAccess;
  /** The request's client address from the platform headers; null when missing or not an address. */
  ip: ParsedIp | null;
  member: { roleId: string; permissions: readonly string[] };
};

/**
 * Allow or deny finance and accounting for this request. Order: Admin bypass, members with nothing to restrict, an
 * unreadable setting (deny), switched off, role scope, address list (a missing address is denied only when a list is
 * set), then days and hours.
 */
export function financeAccessDecision(input: FinanceAccessDecisionInput): FinanceAccessDecision {
  const { member, stored } = input;
  const perms = Array.isArray(member.permissions) ? member.permissions : [];
  if (perms.includes("*")) return { allowed: true, reason: "admin" };
  if (!holdsRestrictedArea(perms)) return { allowed: true, reason: "not_in_scope" };
  if (!stored.ok)
    return stored.disabled
      ? { allowed: true, reason: "off" }
      : { allowed: false, reason: "invalid_settings" };
  const s = stored.settings;
  if (!s.enabled) return { allowed: true, reason: "off" };
  if (s.scope === "selected_roles" && !s.role_ids.includes(member.roleId))
    return { allowed: true, reason: "not_in_scope" };

  if (s.ip_allowlist.length > 0) {
    if (!input.ip) return { allowed: false, reason: "ip_unknown" };
    if (!ipAllowed(input.ip, s.ip_allowlist)) return { allowed: false, reason: "ip_not_allowed" };
  }

  if (s.limit_hours) {
    const clock = localClock(input.now, input.timezone);
    if (!clock) return { allowed: false, reason: "invalid_settings" };
    const h = insideHours(clock, s);
    if (!h.inside) return { allowed: false, reason: h.reason };
  }
  return { allowed: true, reason: "inside" };
}

const FINANCE_PATH_PREFIXES = ["/finance", "/accounting", "/api/finance", "/api/accounting"];

/**
 * True for the finance and accounting pages, their server actions (posted to the page's own path) and their API
 * routes. A refusal there is an access attempt worth recording; elsewhere (the menu hiding Finance on the dashboard)
 * it is not.
 */
export function isFinancePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return FINANCE_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** The areas a decision takes away for this request (none when allowed). */
export function restrictedAreasFor(decision: FinanceAccessDecision): readonly string[] {
  return decision.allowed ? [] : RESTRICTED_AREAS;
}

/** One line for the denied page and the alert summary. Never contains an address. */
export function denyReasonText(reason: FinanceAccessDenyReason): string {
  switch (reason) {
    case "invalid_settings":
      return "The finance access setting could not be read, so finance is closed until an administrator saves it again.";
    case "ip_unknown":
      return "Your network address could not be confirmed.";
    case "ip_not_allowed":
      return "You are not connected from an approved location.";
    case "day_not_allowed":
      return "Finance is closed today.";
    case "outside_hours":
      return "Finance is outside its working hours.";
  }
}

/** Time, network or settings: one alert per class per member per day, so a later address refusal is not hidden. */
export function denyReasonClass(reason: FinanceAccessDenyReason): "time" | "network" | "settings" {
  if (reason === "ip_unknown" || reason === "ip_not_allowed") return "network";
  if (reason === "invalid_settings") return "settings";
  return "time";
}

const REASON_SHORT: Record<FinanceAccessDenyReason, string> = {
  invalid_settings: "setting unreadable",
  ip_unknown: "address unknown",
  ip_not_allowed: "not an approved location",
  day_not_allowed: "closed day",
  outside_hours: "outside hours",
};

/**
 * The security alert for a refusal: one per member, reason class and local day (security_alerts is unique on org +
 * dedupe key), so a
 * person retrying all evening raises one alert. The detail carries the reason, the /24 (or /48) network and a keyed
 * hash of the address (the same hash as the login history), never the address itself.
 */
export function financeAccessAlert(input: {
  userId: string;
  reason: FinanceAccessDenyReason;
  now: Date;
  timeZone: string;
  network: string | null;
  ipHash: string | null;
}): AlertDraft {
  const day = localDay(input.now, input.timeZone);
  return {
    kind: "finance_access_denied",
    userId: input.userId,
    dedupeKey: `finance_access:${denyReasonClass(input.reason)}:${input.userId}:${day}`,
    summary: `Finance access refused by the access window (${REASON_SHORT[input.reason]})`,
    detail: {
      reason: input.reason,
      local_day: day,
      network: input.network,
      ip_hash: input.ipHash,
    },
  };
}

/** "Monday to Saturday" / "Monday, Wednesday and Friday" / "every day". */
export function describeDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "every day";
  const label = (d: number) => WEEKDAYS[d - 1]?.label ?? String(d);
  const contiguous =
    sorted.length >= 3 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous) return `${label(sorted[0])} to ${label(sorted[sorted.length - 1])}`;
  if (sorted.length === 1) return label(sorted[0]);
  return `${sorted.slice(0, -1).map(label).join(", ")} and ${label(sorted[sorted.length - 1])}`;
}

/** "Monday to Saturday, 07:00 to 21:00 (Asia/Dubai)" or "any time". */
export function describeWindow(s: FinanceAccessSettings, timezone: string): string {
  if (!s.limit_hours) return "any time";
  const hours = s.start === s.end ? "all day" : `${s.start} to ${s.end}`;
  return `${describeDays(s.days)}, ${hours} (${timezone})`;
}
