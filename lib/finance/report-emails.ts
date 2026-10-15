import { createHash } from "node:crypto";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";

import { can, type MemberLike } from "@/lib/auth/can";
import {
  financeAccessDecision,
  isNamedTimeZone,
  restrictedAreasFor,
  type StoredFinanceAccess,
} from "@/lib/security/finance-access";

/**
 * Scheduled report e-mails (Phase G, pure): the daily flash and the monthly summary, e-mailed to chosen members.
 *
 * - When: each schedule has a local send time in the organisation's timezone (and, for the monthly summary, a day of the
 *   month from 1 to 28). `dueReport` gives the latest occurrence at or before now and the period it reports on: the day
 *   before for the flash, the month before for the summary. Nothing falls due before the schedule was switched on, and a
 *   monthly occurrence more than MAX_MONTHLY_LATE_DAYS old is not sent late.
 * - Once: the job claims each (schedule, period) in SQL (fin_report_schedule_claim) before it queues anything; a claim
 *   that comes back empty means another run has it, so nothing is queued twice.
 * - To whom: members only (user ids, never typed addresses). At send time each one must still be an active member, hold
 *   the report's own permission and be inside the finance access window, worked out exactly as a request would be
 *   (`financeAccessDecision` then `can()`, which honours `restrictedAreas`); there is no client address in a job, so an
 *   organisation that limits finance to listed addresses sends nothing (the e-mail would take the figures off-site).
 */

export const REPORT_EMAIL_KINDS = ["daily_flash", "monthly_summary"] as const;
export type ReportEmailKind = (typeof REPORT_EMAIL_KINDS)[number];

export const REPORT_EMAILS_MANAGE = "finance.report_emails.manage";

/** Each report's own key: the one its page checks. A recipient must hold it at send time. */
export const REPORT_EMAIL_PERMISSION: Record<ReportEmailKind, string> = {
  daily_flash: "finance.flash.view",
  monthly_summary: "finance.view",
};

export const REPORT_EMAIL_LABEL: Record<ReportEmailKind, string> = {
  daily_flash: "Daily flash",
  monthly_summary: "Monthly summary",
};

export const MAX_RECIPIENTS = 25;
export const MAX_MONTHLY_LATE_DAYS = 7;
const DEFAULT_TIME = "07:00";

export type ScheduleTiming = {
  kind: ReportEmailKind;
  enabled: boolean;
  /** HH:MM or HH:MM:SS, local time in the organisation's timezone. */
  sendTime: string;
  /** 1..28 for the monthly summary; ignored for the flash. */
  dayOfMonth: number | null;
  /** When it was last switched on (ISO). */
  enabledAt: string | null;
};

export type DueReport = {
  /** yyyy-mm-dd for the flash (the day reported), yyyy-mm for the summary (the month reported). */
  periodKey: string;
  /** The moment the e-mail fell due. */
  occurrence: Date;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** HH:MM from a stored time, or null. */
export function normaliseTime(t: string | null | undefined): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::\d{2}(?:\.\d+)?)?$/.exec((t ?? "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

function shiftDay(day: string, by: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + by));
  return d.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, by: number): string {
  const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function at(day: string, time: string, timezone: string): Date {
  return fromZonedTime(`${day}T${time}:00`, timezone);
}

/**
 * The latest occurrence of a schedule at or before `now` and the period it reports on, or null when nothing is due
 * (switched off, never switched on, the occurrence came before the switch-on, an unreadable time or timezone, or a
 * monthly e-mail too late to be useful).
 */
export function dueReport(s: ScheduleTiming, now: Date, timezone: string): DueReport | null {
  if (!s.enabled || !s.enabledAt) return null;
  const enabledAt = Date.parse(s.enabledAt);
  if (Number.isNaN(enabledAt)) return null;
  const time = normaliseTime(s.sendTime);
  if (!time || !isNamedTimeZone(timezone)) return null;
  let today: string;
  try {
    today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  } catch {
    return null;
  }
  let occurrence: Date;
  let periodKey: string;
  if (s.kind === "daily_flash") {
    let sendDay = today;
    occurrence = at(sendDay, time, timezone);
    if (occurrence.getTime() > now.getTime()) {
      sendDay = shiftDay(today, -1);
      occurrence = at(sendDay, time, timezone);
    }
    periodKey = shiftDay(sendDay, -1);
  } else {
    const dom = s.dayOfMonth;
    if (!dom || !Number.isInteger(dom) || dom < 1 || dom > 28) return null;
    let sendMonth = today.slice(0, 7);
    occurrence = at(`${sendMonth}-${pad(dom)}`, time, timezone);
    if (occurrence.getTime() > now.getTime()) {
      sendMonth = shiftMonth(sendMonth, -1);
      occurrence = at(`${sendMonth}-${pad(dom)}`, time, timezone);
    }
    if (now.getTime() - occurrence.getTime() > MAX_MONTHLY_LATE_DAYS * 86_400_000) return null;
    periodKey = shiftMonth(sendMonth, -1);
  }
  if (occurrence.getTime() < enabledAt) return null;
  return { periodKey, occurrence };
}

/** The next time a schedule will send (for the settings page), or null when it is off or unreadable. */
export function nextSend(s: ScheduleTiming, now: Date, timezone: string): Date | null {
  if (!s.enabled) return null;
  const time = normaliseTime(s.sendTime);
  if (!time || !isNamedTimeZone(timezone)) return null;
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  if (s.kind === "daily_flash") {
    const t = at(today, time, timezone);
    return t.getTime() > now.getTime() ? t : at(shiftDay(today, 1), time, timezone);
  }
  const dom = s.dayOfMonth;
  if (!dom || dom < 1 || dom > 28) return null;
  const t = at(`${today.slice(0, 7)}-${pad(dom)}`, time, timezone);
  return t.getTime() > now.getTime()
    ? t
    : at(`${shiftMonth(today.slice(0, 7), 1)}-${pad(dom)}`, time, timezone);
}

// ---- recipients ----------------------------------------------------------------------------------------------------

/** What the job knows about one chosen recipient (read with the service role). */
export type RecipientCandidate = {
  userId: string;
  /** The membership in this organisation; null when they are no longer a member. */
  membership: {
    roleId: string;
    status: string;
    permissions: readonly string[];
  } | null;
  email: string | null;
  name: string | null;
};

export type SkipReason = "not_member" | "no_permission" | "finance_window" | "no_email";

export type RecipientContext = {
  orgId: string;
  now: Date;
  timezone: string;
  financeAccess: StoredFinanceAccess;
};

/** The member as a request would see them now: permissions, with the finance window's restricted areas applied. */
export function memberAtSendTime(
  c: RecipientCandidate,
  ctx: RecipientContext,
): MemberLike | null {
  const m = c.membership;
  if (!m || m.status !== "active") return null;
  const permissions = Array.isArray(m.permissions)
    ? m.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const decision = financeAccessDecision({
    now: ctx.now,
    timezone: ctx.timezone,
    stored: ctx.financeAccess,
    // a job has no client address: an organisation with an address list sends nothing (fails closed)
    ip: null,
    member: { roleId: m.roleId, permissions },
  });
  return {
    userId: c.userId,
    orgId: ctx.orgId,
    roleId: m.roleId,
    status: "active",
    permissions,
    restrictedAreas: restrictedAreasFor(decision),
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** May this person receive this report now? The reason when not. */
export function recipientDecision(
  kind: ReportEmailKind,
  c: RecipientCandidate,
  ctx: RecipientContext,
): { ok: true; email: string } | { ok: false; reason: SkipReason } {
  const member = memberAtSendTime(c, ctx);
  if (!member) return { ok: false, reason: "not_member" };
  const perm = REPORT_EMAIL_PERMISSION[kind];
  if (!can(member, perm))
    return {
      ok: false,
      reason: can({ ...member, restrictedAreas: [] }, perm) ? "finance_window" : "no_permission",
    };
  const email = c.email?.trim() ?? "";
  if (!email || email.length > 200 || !EMAIL.test(email)) return { ok: false, reason: "no_email" };
  return { ok: true, email };
}

/** Splits the chosen recipients into those the report goes to and those skipped, with a count per reason. */
export function filterRecipients(
  kind: ReportEmailKind,
  chosen: readonly string[],
  candidates: readonly RecipientCandidate[],
  ctx: RecipientContext,
): {
  send: Array<{ userId: string; email: string; name: string | null }>;
  skipped: Partial<Record<SkipReason, number>>;
} {
  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const send: Array<{ userId: string; email: string; name: string | null }> = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const id of [...new Set(chosen)]) {
    const c = byId.get(id) ?? { userId: id, membership: null, email: null, name: null };
    const d = recipientDecision(kind, c, ctx);
    if (d.ok) send.push({ userId: id, email: d.email, name: c.name });
    else skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
  }
  return { send, skipped };
}

// ---- settings form -------------------------------------------------------------------------------------------------

export const scheduleInput = z
  .object({
    kind: z.enum(REPORT_EMAIL_KINDS),
    enabled: z.boolean(),
    sendTime: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time (HH:MM, 24-hour)."),
    dayOfMonth: z.number().int().min(1).max(28).nullable(),
    recipientIds: z
      .array(z.string().uuid())
      .max(MAX_RECIPIENTS, `Choose at most ${MAX_RECIPIENTS} people.`)
      .transform((ids) => [...new Set(ids)]),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "monthly_summary" && v.dayOfMonth === null)
      ctx.addIssue({ code: "custom", message: "Choose the day of the month (1 to 28)." });
    if (v.enabled && v.recipientIds.length === 0)
      ctx.addIssue({ code: "custom", message: "Choose at least one person before switching it on." });
  })
  .transform((v) => ({ ...v, dayOfMonth: v.kind === "monthly_summary" ? v.dayOfMonth : null }));
export type ScheduleInput = z.infer<typeof scheduleInput>;

export const DEFAULT_SCHEDULE: Record<ReportEmailKind, Omit<ScheduleTiming, "kind">> = {
  daily_flash: { enabled: false, sendTime: DEFAULT_TIME, dayOfMonth: null, enabledAt: null },
  monthly_summary: { enabled: false, sendTime: DEFAULT_TIME, dayOfMonth: 3, enabledAt: null },
};

/** enabled_at after a save: kept while it stays on, set now when it is switched on, cleared when switched off. */
export function nextEnabledAt(
  before: { enabled: boolean; enabledAt: string | null } | null,
  enabled: boolean,
  now: Date,
): string | null {
  if (!enabled) return null;
  if (before?.enabled && before.enabledAt) return before.enabledAt;
  return now.toISOString();
}

// ---- the run (ports, so the order and the once-only claim are tested without a database) ---------------------------

export type ScheduleRow = ScheduleTiming & {
  id: string;
  orgId: string;
  recipientIds: readonly string[];
  /** Who last saved it (told when a send is refused); null when they left. */
  ownerId: string | null;
};

export type OrgContext = {
  timezone: string;
  isTraining: boolean;
  financeAccess: StoredFinanceAccess;
};

export type QueuedReport = {
  requestId: string;
  orgId: string;
  scheduleId: string;
  runId: string;
  kind: ReportEmailKind;
  periodKey: string;
  recipientUserId: string;
  recipientEmail: string;
  requestedBy: string;
};

export type ReportRunPorts = {
  schedules(): Promise<ScheduleRow[]>;
  org(orgId: string): Promise<OrgContext | null>;
  /** fin_report_schedule_claim: the new run's id, or null when another run has this period. */
  claim(scheduleId: string, periodKey: string): Promise<string | null>;
  candidates(orgId: string, userIds: readonly string[]): Promise<RecipientCandidate[]>;
  enqueue(job: QueuedReport): Promise<void>;
  finish(
    runId: string,
    result: {
      status: "queued" | "skipped";
      recipients: number;
      skipped: number;
      reason: "no_recipients" | "queue_failed" | null;
    },
  ): Promise<void>;
};

export type ReportRunTotals = {
  schedules: number;
  due: number;
  claimed: number;
  queued: number;
  skipped_recipients: number;
  training: number;
  failed: number;
};

/** A request id that is the same for the same run and recipient (so a duplicate is the same e-mail to Resend). */
export function reportRequestId(runId: string, userId: string): string {
  const h = createHash("sha256").update(`report-email:${runId}:${userId}`).digest("hex");
  // RFC 4122 shape (version 5 style, variant 10xx)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * One pass: for each enabled schedule, work out what is due in its organisation's timezone, claim it once, then queue
 * one e-mail per recipient who may receive it now. A training workspace sends nothing. Counts only come back.
 */
export async function runScheduledReports(
  ports: ReportRunPorts,
  now: Date,
): Promise<ReportRunTotals> {
  const totals: ReportRunTotals = {
    schedules: 0,
    due: 0,
    claimed: 0,
    queued: 0,
    skipped_recipients: 0,
    training: 0,
    failed: 0,
  };
  const orgs = new Map<string, OrgContext | null>();
  for (const s of await ports.schedules()) {
    if (!s.enabled) continue;
    totals.schedules++;
    if (!orgs.has(s.orgId)) orgs.set(s.orgId, await ports.org(s.orgId));
    const org = orgs.get(s.orgId);
    if (!org) continue;
    if (org.isTraining) {
      totals.training++;
      continue;
    }
    const due = dueReport(s, now, org.timezone);
    if (!due) continue;
    totals.due++;
    const runId = await ports.claim(s.id, due.periodKey);
    if (!runId) continue;
    totals.claimed++;
    const { send, skipped } = filterRecipients(
      s.kind,
      s.recipientIds,
      await ports.candidates(s.orgId, s.recipientIds),
      { orgId: s.orgId, now, timezone: org.timezone, financeAccess: org.financeAccess },
    );
    const skippedCount = Object.values(skipped).reduce((a, n) => a + (n ?? 0), 0);
    totals.skipped_recipients += skippedCount;
    if (send.length === 0) {
      await ports.finish(runId, {
        status: "skipped",
        recipients: 0,
        skipped: skippedCount,
        reason: "no_recipients",
      });
      continue;
    }
    let queued = 0;
    try {
      for (const r of send) {
        await ports.enqueue({
          requestId: reportRequestId(runId, r.userId),
          orgId: s.orgId,
          scheduleId: s.id,
          runId,
          kind: s.kind,
          periodKey: due.periodKey,
          recipientUserId: r.userId,
          recipientEmail: r.email,
          requestedBy: s.ownerId ?? r.userId,
        });
        queued++;
      }
    } catch {
      totals.failed++;
      totals.queued += queued;
      // the claim stays: a later run never re-sends this period (at most once); the page shows the failure
      await ports
        .finish(runId, {
          status: "skipped",
          recipients: queued,
          skipped: skippedCount,
          reason: "queue_failed",
        })
        .catch(() => undefined);
      continue;
    }
    totals.queued += queued;
    await ports.finish(runId, {
      status: "queued",
      recipients: queued,
      skipped: skippedCount,
      reason: null,
    });
  }
  return totals;
}

/** "Provisional" until the CEO sign-off locks the month (the same rule the profit reports use). */
export function lockLabel(lockedMonths: ReadonlySet<string>, months: readonly string[]): string {
  if (months.length > 0 && months.every((m) => lockedMonths.has(m)))
    return months.length === 1
      ? "Final: the month is closed and locked by the CEO sign-off."
      : "Final: every month shown is closed and locked by the CEO sign-off.";
  return months.length === 1
    ? "Provisional: the month is not closed and locked yet, so the figures can still change."
    : "Provisional: not every month shown is closed and locked yet, so the figures can still change.";
}
