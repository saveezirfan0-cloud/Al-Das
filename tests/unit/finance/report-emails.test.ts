/**
 * Phase G: scheduled report e-mails (pure). When a schedule falls due in the organisation's timezone, who may receive it
 * at send time (the report's own key, with the finance access window applied as a request would), and the run over fake
 * ports: each (schedule, period) is claimed once, so a retry or a second run never queues the same report again.
 * Synthetic ids and addresses only.
 */
import { describe, expect, it } from "vitest";

import {
  dueReport,
  filterRecipients,
  lockLabel,
  MAX_RECIPIENTS,
  nextEnabledAt,
  nextSend,
  recipientDecision,
  reportRequestId,
  runScheduledReports,
  scheduleInput,
  type OrgContext,
  type QueuedReport,
  type RecipientCandidate,
  type ReportRunPorts,
  type ScheduleRow,
  type ScheduleTiming,
} from "@/lib/finance/report-emails";
import { readFinanceAccess } from "@/lib/security/finance-access";

const TZ = "Asia/Dubai"; // UTC+4, no daylight saving
const ORG = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const flash = (over: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  kind: "daily_flash",
  enabled: true,
  sendTime: "07:00",
  dayOfMonth: null,
  enabledAt: "2026-01-01T00:00:00Z",
  ...over,
});
const monthly = (over: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  kind: "monthly_summary",
  enabled: true,
  sendTime: "07:00:00",
  dayOfMonth: 3,
  enabledAt: "2026-01-01T00:00:00Z",
  ...over,
});
const at = (iso: string) => new Date(iso);

describe("when a schedule is due (organisation timezone)", () => {
  it("sends yesterday's flash from the local send time onwards", () => {
    // 06:59 in Dubai on 14 Oct: today's 07:00 has not come, so the latest send was 13 Oct (for the 12th)
    expect(dueReport(flash(), at("2026-10-14T02:59:00Z"), TZ)).toEqual({
      periodKey: "2026-10-12",
      occurrence: at("2026-10-13T03:00:00Z"),
    });
    // 07:00 in Dubai: the 14 Oct send, for the 13th
    expect(dueReport(flash(), at("2026-10-14T03:00:00Z"), TZ)?.periodKey).toBe("2026-10-13");
    // 23:30 UTC on 13 Oct is already 03:30 on the 14th in Dubai, before the send time
    expect(dueReport(flash(), at("2026-10-13T23:30:00Z"), TZ)?.periodKey).toBe("2026-10-12");
  });

  it("crosses month and year ends, and follows daylight saving where the zone has it", () => {
    expect(dueReport(flash(), at("2027-01-01T05:00:00Z"), TZ)?.periodKey).toBe("2026-12-31");
    // London moves to BST on 29 Mar 2026: 07:00 local is 06:00 UTC that day
    const london = dueReport(flash(), at("2026-03-29T06:30:00Z"), "Europe/London");
    expect(london).toEqual({ periodKey: "2026-03-28", occurrence: at("2026-03-29T06:00:00Z") });
  });

  it("sends last month's summary on the chosen day, late by a few days at most", () => {
    expect(dueReport(monthly(), at("2026-10-03T03:05:00Z"), TZ)?.periodKey).toBe("2026-09");
    // 2 Oct: the latest occurrence was 3 Sep (for August), a month late: not sent
    expect(dueReport(monthly(), at("2026-10-02T12:00:00Z"), TZ)).toBeNull();
    // six days late is still fine (the job may have been down)
    expect(dueReport(monthly(), at("2026-10-09T02:00:00Z"), TZ)?.periodKey).toBe("2026-09");
    expect(dueReport(monthly(), at("2026-10-11T03:00:00Z"), TZ)).toBeNull();
    expect(dueReport(monthly(), at("2027-01-03T03:00:00Z"), TZ)?.periodKey).toBe("2026-12");
  });

  it("never sends a period that fell due before the switch-on, nor when off or unreadable", () => {
    const now = at("2026-10-14T06:00:00Z"); // 10:00 Dubai
    expect(dueReport(flash({ enabledAt: "2026-10-14T05:00:00Z" }), now, TZ)).toBeNull();
    expect(dueReport(flash({ enabledAt: "2026-10-14T02:00:00Z" }), now, TZ)?.periodKey).toBe(
      "2026-10-13",
    );
    expect(dueReport(flash({ enabled: false }), now, TZ)).toBeNull();
    expect(dueReport(flash({ enabledAt: null }), now, TZ)).toBeNull();
    expect(dueReport(flash({ sendTime: "25:00" }), now, TZ)).toBeNull();
    expect(dueReport(flash(), now, "UTC+4")).toBeNull();
    expect(dueReport(flash(), now, "Not/AZone")).toBeNull();
    expect(dueReport(monthly({ dayOfMonth: 31 }), now, TZ)).toBeNull();
    expect(dueReport(monthly({ dayOfMonth: null }), now, TZ)).toBeNull();
  });

  it("shows the next send time", () => {
    expect(nextSend(flash(), at("2026-10-14T02:00:00Z"), TZ)).toEqual(at("2026-10-14T03:00:00Z"));
    expect(nextSend(flash(), at("2026-10-14T04:00:00Z"), TZ)).toEqual(at("2026-10-15T03:00:00Z"));
    expect(nextSend(monthly(), at("2026-10-14T04:00:00Z"), TZ)).toEqual(at("2026-11-03T03:00:00Z"));
    expect(nextSend(flash({ enabled: false }), at("2026-10-14T04:00:00Z"), TZ)).toBeNull();
  });
});

describe("who receives it", () => {
  const off = readFinanceAccess({});
  const ctx = { orgId: ORG, now: at("2026-10-14T03:00:00Z"), timezone: TZ, financeAccess: off };
  const person = (over: Partial<RecipientCandidate> = {}): RecipientCandidate => ({
    userId: A,
    membership: { roleId: "r-fin", status: "active", permissions: ["finance.flash.view"] },
    email: "fin.one@clinic.example.test",
    name: null,
    ...over,
  });

  it("needs the report's own key, an active membership and an address", () => {
    expect(recipientDecision("daily_flash", person(), ctx)).toEqual({
      ok: true,
      email: "fin.one@clinic.example.test",
    });
    // the flash key does not open the monthly summary (finance.view)
    expect(recipientDecision("monthly_summary", person(), ctx)).toEqual({
      ok: false,
      reason: "no_permission",
    });
    expect(
      recipientDecision(
        "monthly_summary",
        person({
          membership: { roleId: "r", status: "active", permissions: ["finance.*"] },
        }),
        ctx,
      ).ok,
    ).toBe(true);
    expect(recipientDecision("daily_flash", person({ membership: null }), ctx)).toEqual({
      ok: false,
      reason: "not_member",
    });
    expect(
      recipientDecision(
        "daily_flash",
        person({
          membership: { roleId: "r", status: "suspended", permissions: ["finance.flash.view"] },
        }),
        ctx,
      ).ok,
    ).toBe(false);
    expect(recipientDecision("daily_flash", person({ email: "nope" }), ctx)).toEqual({
      ok: false,
      reason: "no_email",
    });
  });

  it("applies the finance access window the way a request does (restrictedAreas), never to Admin", () => {
    const window = readFinanceAccess({
      finance_access: {
        enabled: true,
        limit_hours: true,
        days: [1, 2, 3, 4, 5],
        start: "08:00",
        end: "18:00",
      },
    });
    // 07:00 on a Wednesday in Dubai: before the window opens
    const early = { ...ctx, financeAccess: window };
    expect(recipientDecision("daily_flash", person(), early)).toEqual({
      ok: false,
      reason: "finance_window",
    });
    const admin = person({ membership: { roleId: "r-admin", status: "active", permissions: ["*"] } });
    expect(recipientDecision("daily_flash", admin, early).ok).toBe(true);
    // inside the window
    expect(
      recipientDecision("daily_flash", person(), { ...early, now: at("2026-10-14T06:00:00Z") }).ok,
    ).toBe(true);
    // an address list cannot be satisfied by a job (no client address): nobody but Admin receives it
    const listed = readFinanceAccess({
      finance_access: { enabled: true, limit_hours: false, ip_allowlist: ["10.0.0.0/8"] },
    });
    expect(recipientDecision("daily_flash", person(), { ...ctx, financeAccess: listed })).toEqual({
      ok: false,
      reason: "finance_window",
    });
    // an unreadable setting fails closed
    const broken = readFinanceAccess({ finance_access: { enabled: true, days: "every" } });
    expect(recipientDecision("daily_flash", person(), { ...ctx, financeAccess: broken }).ok).toBe(
      false,
    );
  });

  it("filters the chosen list, counting why people were skipped (duplicates once)", () => {
    const res = filterRecipients(
      "daily_flash",
      [A, B, C, A],
      [
        person(),
        person({ userId: B, membership: { roleId: "r", status: "active", permissions: ["finance.view"] } }),
      ],
      ctx,
    );
    expect(res.send).toEqual([{ userId: A, email: "fin.one@clinic.example.test", name: null }]);
    expect(res.skipped).toEqual({ no_permission: 1, not_member: 1 });
  });
});

describe("the settings form", () => {
  const base = {
    kind: "monthly_summary",
    enabled: true,
    sendTime: "07:30",
    dayOfMonth: 3,
    recipientIds: [A, A, B],
  };
  it("checks the time, the day and the list, and removes duplicates", () => {
    expect(scheduleInput.parse(base)).toMatchObject({ recipientIds: [A, B], dayOfMonth: 3 });
    expect(scheduleInput.safeParse({ ...base, dayOfMonth: null }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, dayOfMonth: 29 }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, sendTime: "7:30" }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, recipientIds: [] }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, enabled: false, recipientIds: [] }).success).toBe(true);
    expect(scheduleInput.safeParse({ ...base, recipientIds: ["x@y.test"] }).success).toBe(false);
    const many = Array.from(
      { length: MAX_RECIPIENTS + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(scheduleInput.safeParse({ ...base, recipientIds: many }).success).toBe(false);
    // the flash has no day of the month
    expect(scheduleInput.parse({ ...base, kind: "daily_flash" }).dayOfMonth).toBeNull();
  });

  it("keeps the switch-on time while it stays on", () => {
    const now = at("2026-10-14T10:00:00Z");
    expect(nextEnabledAt(null, true, now)).toBe(now.toISOString());
    expect(nextEnabledAt({ enabled: true, enabledAt: "2026-09-01T00:00:00Z" }, true, now)).toBe(
      "2026-09-01T00:00:00Z",
    );
    expect(nextEnabledAt({ enabled: false, enabledAt: null }, true, now)).toBe(now.toISOString());
    expect(nextEnabledAt({ enabled: true, enabledAt: "2026-09-01T00:00:00Z" }, false, now)).toBeNull();
  });

  it("labels a report Provisional until every month in it is locked", () => {
    expect(lockLabel(new Set(), ["2026-09"])).toMatch(/^Provisional/);
    expect(lockLabel(new Set(["2026-09"]), ["2026-09"])).toMatch(/^Final/);
    expect(lockLabel(new Set(["2026-09"]), ["2026-08", "2026-09"])).toMatch(/^Provisional/);
  });
});

describe("the run: claim once, then queue", () => {
  function harness(over: { org?: Partial<OrgContext>; schedules?: ScheduleRow[] } = {}) {
    const claims = new Map<string, string>(); // `${schedule}|${period}` -> run id, like the unique index
    const queued: QueuedReport[] = [];
    const finished: Array<{ runId: string; status: string; recipients: number; skipped: number; reason: string | null }> = [];
    let failEnqueueAfter = Infinity;
    const schedules: ScheduleRow[] = over.schedules ?? [
      {
        ...flash(),
        id: "s-flash",
        orgId: ORG,
        recipientIds: [A, B],
        ownerId: C,
      },
    ];
    const ports: ReportRunPorts = {
      schedules: async () => schedules,
      org: async () => ({
        timezone: TZ,
        isTraining: false,
        financeAccess: readFinanceAccess({}),
        ...over.org,
      }),
      claim: async (scheduleId, period) => {
        const key = `${scheduleId}|${period}`;
        if (claims.has(key)) return null;
        const id = `run-${claims.size + 1}`;
        claims.set(key, id);
        return id;
      },
      candidates: async (_org, ids) =>
        ids.map((id) => ({
          userId: id,
          membership: {
            roleId: "r",
            status: "active",
            permissions: id === A ? ["finance.flash.view"] : ["contacts.view"],
          },
          email: `${id.slice(0, 4)}@clinic.example.test`,
          name: null,
        })),
      enqueue: async (job) => {
        if (queued.length >= failEnqueueAfter) throw new Error("queue down");
        queued.push(job);
      },
      finish: async (runId, r) => {
        finished.push({ runId, ...r });
      },
    };
    return {
      ports,
      claims,
      queued,
      finished,
      failAfter(n: number) {
        failEnqueueAfter = n;
      },
    };
  }
  const NOW = at("2026-10-14T03:10:00Z");

  it("queues one e-mail per allowed recipient, and nothing on a second run for the same period", async () => {
    const h = harness();
    const first = await runScheduledReports(h.ports, NOW);
    expect(first).toMatchObject({ due: 1, claimed: 1, queued: 1, skipped_recipients: 1 });
    expect(h.queued).toEqual([
      {
        requestId: reportRequestId("run-1", A),
        orgId: ORG,
        scheduleId: "s-flash",
        runId: "run-1",
        kind: "daily_flash",
        periodKey: "2026-10-13",
        recipientUserId: A,
        recipientEmail: "aaaa@clinic.example.test",
        requestedBy: C,
      },
    ]);
    expect(h.finished).toEqual([
      { runId: "run-1", status: "queued", recipients: 1, skipped: 1, reason: null },
    ]);
    // the cron fires again ten minutes later (or a retry, or a second server): the claim is taken, nothing is queued
    const second = await runScheduledReports(h.ports, at("2026-10-14T03:20:00Z"));
    expect(second).toMatchObject({ due: 1, claimed: 0, queued: 0 });
    expect(h.queued).toHaveLength(1);
    // the next day is a new period
    await runScheduledReports(h.ports, at("2026-10-15T03:10:00Z"));
    expect(h.queued.map((q) => q.periodKey)).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("gives the same request id for the same run and recipient (a duplicate is the same e-mail)", () => {
    expect(reportRequestId("run-1", A)).toBe(reportRequestId("run-1", A));
    expect(reportRequestId("run-1", A)).not.toBe(reportRequestId("run-2", A));
    expect(reportRequestId("run-1", A)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sends nothing from a training workspace and claims nothing", async () => {
    const h = harness({ org: { isTraining: true } });
    expect(await runScheduledReports(h.ports, NOW)).toMatchObject({ training: 1, claimed: 0 });
    expect(h.claims.size).toBe(0);
    expect(h.queued).toEqual([]);
  });

  it("records a period with nobody allowed as not sent, and a queue failure without sending it again", async () => {
    const nobody = harness({
      schedules: [{ ...flash(), id: "s1", orgId: ORG, recipientIds: [B], ownerId: null }],
    });
    await runScheduledReports(nobody.ports, NOW);
    expect(nobody.finished).toEqual([
      { runId: "run-1", status: "skipped", recipients: 0, skipped: 1, reason: "no_recipients" },
    ]);

    const broken = harness();
    broken.failAfter(0);
    expect(await runScheduledReports(broken.ports, NOW)).toMatchObject({ failed: 1, queued: 0 });
    expect(broken.finished[0]).toMatchObject({ status: "skipped", reason: "queue_failed" });
    broken.failAfter(Infinity);
    await runScheduledReports(broken.ports, at("2026-10-14T03:20:00Z"));
    expect(broken.queued).toEqual([]); // at most once: the period stays claimed
  });

  it("skips schedules that are off or not due yet", async () => {
    const h = harness({
      schedules: [
        { ...flash({ enabled: false }), id: "s1", orgId: ORG, recipientIds: [A], ownerId: null },
        { ...monthly(), id: "s2", orgId: ORG, recipientIds: [A], ownerId: null },
      ],
    });
    expect(await runScheduledReports(h.ports, NOW)).toMatchObject({ schedules: 1, due: 0 });
    expect(h.claims.size).toBe(0);
  });
});
