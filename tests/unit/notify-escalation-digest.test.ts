import { describe, expect, it } from "vitest";

import { digestDue, digestWindow, renderDigest } from "@/lib/notify/digest";
import {
  DEFAULT_ESCALATION,
  escalationDedupeKey,
  escalationPayload,
  escalationSettingsSchema,
  planEscalation,
  readEscalationSettings,
  validateEscalation,
  writeEscalationSettings,
  type EscalationSettings,
} from "@/lib/notify/escalation";
import { SNOOZE_PRESETS, isSnoozePreset, isSnoozed, snoozeUntil } from "@/lib/notify/snooze";
import {
  MANAGEMENT_KPIS,
  headlineKpis,
  pickKpis,
  summarySections,
  type ManagementSummary,
} from "@/lib/reports/management";
import type { ReportResult } from "@/lib/reports/types";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ONCALL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "22222222-2222-4222-8222-222222222222";

const on: EscalationSettings = {
  enabled: true,
  lead_after_minutes: 10,
  on_call_after_minutes: 25,
  on_call_user_ids: [ONCALL],
};
const open = { status: "open", assignee_user_id: null as string | null, escalation_level: 0 };

describe("escalation ladder", () => {
  it("rung 1 tells the team lead and schedules rung 2 after the gap", () => {
    expect(
      planEscalation({
        level: 1,
        conversation: open,
        settings: on,
        teamLeadId: LEAD,
        adminIds: [ADMIN],
      }),
    ).toEqual({
      action: "notify",
      level: 1,
      recipients: [LEAD],
      next: { level: 2, delayMinutes: 15 },
    });
  });

  it("rung 1 without a lead tells nobody but still lets rung 2 happen", () => {
    const plan = planEscalation({
      level: 1,
      conversation: open,
      settings: on,
      teamLeadId: null,
      adminIds: [],
    });
    expect(plan).toMatchObject({ action: "notify", recipients: [], next: { level: 2 } });
  });

  it("rung 2 tells the on-call list, or administrators when the list is empty, and ends the ladder", () => {
    expect(
      planEscalation({
        level: 2,
        conversation: { ...open, escalation_level: 1 },
        settings: on,
        teamLeadId: LEAD,
        adminIds: [ADMIN],
      }),
    ).toEqual({
      action: "notify",
      level: 2,
      recipients: [ONCALL],
      next: null,
    });
    const noList = planEscalation({
      level: 2,
      conversation: { ...open, escalation_level: 1 },
      settings: { ...on, on_call_user_ids: [] },
      teamLeadId: null,
      adminIds: [ADMIN, ADMIN],
    });
    expect(noList).toMatchObject({ recipients: [ADMIN] });
  });

  it("stands down as soon as someone owns the conversation, it closes, or the rung already fired", () => {
    const plan = (conversation: typeof open, settings = on, level: 1 | 2 = 1) =>
      planEscalation({ level, conversation, settings, teamLeadId: LEAD, adminIds: [] });
    expect(plan({ ...open, assignee_user_id: LEAD })).toEqual({
      action: "skip",
      reason: "assigned",
    });
    expect(plan({ ...open, status: "closed" })).toEqual({ action: "skip", reason: "closed" });
    expect(plan({ ...open, escalation_level: 1 })).toEqual({
      action: "skip",
      reason: "already_escalated",
    });
    expect(plan({ ...open, escalation_level: 2 }, on, 2)).toEqual({
      action: "skip",
      reason: "already_escalated",
    });
    expect(plan(open, { ...on, enabled: false })).toEqual({ action: "skip", reason: "disabled" });
  });

  it("is off by default and reads settings tolerantly", () => {
    expect(DEFAULT_ESCALATION.enabled).toBe(false);
    expect(readEscalationSettings(undefined)).toEqual(DEFAULT_ESCALATION);
    expect(
      readEscalationSettings({
        escalation: { enabled: true, lead_after_minutes: 5, on_call_after_minutes: 15 },
      }),
    ).toMatchObject({ enabled: true, lead_after_minutes: 5 });
    // A rung 2 earlier than rung 1 is invalid data: fall back to defaults rather than escalate in a strange order.
    expect(
      readEscalationSettings({
        escalation: { enabled: true, lead_after_minutes: 30, on_call_after_minutes: 10 },
      }),
    ).toEqual(DEFAULT_ESCALATION);
    expect(validateEscalation({ ...on, on_call_after_minutes: 5 })).toMatch(/after/);
    expect(escalationSettingsSchema.safeParse({ lead_after_minutes: 0 }).success).toBe(false);
    expect(escalationSettingsSchema.safeParse({ on_call_user_ids: ["not-a-uuid"] }).success).toBe(
      false,
    );
  });

  it("writes settings without disturbing the rest of org.settings", () => {
    expect(writeEscalationSettings({ inbox: { x: 1 } }, on)).toEqual({
      inbox: { x: 1 },
      escalation: on,
    });
    expect(writeEscalationSettings(null, on)).toEqual({ escalation: on });
  });

  it("keys one pending job per conversation and rung, and validates the job payload", () => {
    expect(escalationDedupeKey(CONV, 1)).toBe(`inbox.escalate:${CONV}:1`);
    expect(escalationDedupeKey(CONV, 2)).not.toBe(escalationDedupeKey(CONV, 1));
    expect(escalationPayload.safeParse({ conversation_id: CONV, level: 2 }).success).toBe(true);
    expect(escalationPayload.safeParse({ conversation_id: CONV, level: 3 }).success).toBe(false);
  });
});

describe("digest scheduling", () => {
  const TZ = "Asia/Dubai"; // UTC+4
  const utc = (s: string) => new Date(`${s}Z`);

  it("is due from 07:00 local for four hours, and weekly only on Mondays", () => {
    // Tue 13 Oct 2026 03:30Z = 07:30 Dubai
    expect(digestDue("daily", utc("2026-10-13T03:30:00"), TZ)).toBe(true);
    expect(digestDue("daily", utc("2026-10-13T02:30:00"), TZ)).toBe(false); // 06:30 local
    expect(digestDue("daily", utc("2026-10-13T07:30:00"), TZ)).toBe(false); // 11:30 local: window closed
    expect(digestDue("weekly", utc("2026-10-13T03:30:00"), TZ)).toBe(false); // Tuesday
    expect(digestDue("weekly", utc("2026-10-12T03:30:00"), TZ)).toBe(true); // Monday
  });

  it("uses the org's own clock, not UTC", () => {
    // 03:30Z is still the previous evening in Los Angeles
    expect(digestDue("daily", utc("2026-10-13T03:30:00"), "America/Los_Angeles")).toBe(false);
    expect(digestDue("daily", utc("2026-10-13T14:30:00"), "America/Los_Angeles")).toBe(true); // 07:30 PDT
    expect(digestDue("daily", utc("2026-10-13T03:30:00"), "Not/AZone")).toBe(false);
  });

  it("reports yesterday for the daily digest and last Monday to Sunday for the weekly one", () => {
    const tue = digestWindow("daily", utc("2026-10-13T03:30:00"), TZ);
    expect(tue).toMatchObject({
      kind: "daily",
      periodKey: "2026-10-12",
      fromDay: "2026-10-12",
      toDay: "2026-10-12",
    });
    const mon = digestWindow("weekly", utc("2026-10-12T03:30:00"), TZ);
    expect(mon).toMatchObject({
      fromDay: "2026-10-05",
      toDay: "2026-10-11",
      periodKey: "2026-W41",
    });
    // Tuesday still names last week (a late tick must not report a different period).
    expect(digestWindow("weekly", utc("2026-10-13T03:30:00"), TZ).periodKey).toBe("2026-W41");
  });

  it("gets ISO weeks right across a year boundary", () => {
    // Mon 4 Jan 2027 reports the week of Mon 28 Dec 2026, which is ISO week 53 of 2026.
    expect(digestWindow("weekly", utc("2027-01-04T03:30:00"), TZ).periodKey).toBe("2026-W53");
    // Thu 1 Jan 2026 puts 29 Dec 2025 to 4 Jan 2026 in ISO week 1 of 2026.
    expect(digestWindow("weekly", utc("2026-01-05T03:30:00"), TZ).periodKey).toBe("2026-W01");
    expect(digestWindow("weekly", utc("2025-12-29T03:30:00"), TZ).periodKey).toBe("2025-W52");
  });
});

const report = (kpis: ReportResult["kpis"]): ReportResult => ({
  kpis,
  charts: [],
  table: { columns: [], rows: [] },
  notes: [],
});
const k = (
  key: string,
  value: number | null,
  format: "number" | "percent" | "duration" = "number",
) => ({ key, label: key.toUpperCase(), value, format });

describe("digest content", () => {
  const summary: ManagementSummary = {
    messaging: {
      conversations: report([
        k("conversations", 120),
        k("unique", 90),
        k("returning", 30),
        k("closed", 100),
      ]),
      response: report([
        k("median", 95, "duration"),
        k("answered", 0.9, "percent"),
        k("p90", 400, "duration"),
      ]),
      usage: report([k("total", 800), k("failed", 3), k("delivered", 700)]),
    },
    enquiries: report([
      k("created", 40),
      k("won", 12),
      k("lost", 5),
      k("conversion", 0.3, "percent"),
      k("booked", 10),
      k("open", 23),
      k("extra", 1),
    ]),
    appointments: report([
      k("total", 60),
      k("completed", 50),
      k("no_show", 4),
      k("rate", 0.07, "percent"),
      k("hidden", 1),
    ]),
    campaigns: null,
    reminders: null,
    recall: null,
    clinical: report([
      k("open", 4),
      k("high", 1),
      k("overdue", 2),
      k("doctor_alerts", 5),
      k("red_flags", 0),
      k("incomplete_vitals", 3),
      k("unmatched", 1),
      k("unclassified", 2),
      k("unknown_dx", 0),
    ]),
  };

  it("prints exactly the KPIs the Management dashboard shows, in the same order, from the same function", () => {
    const sections = summarySections(summary);
    expect(sections.map((s) => s.title)).toEqual([
      "Messaging",
      "Enquiries",
      "Appointments",
      "Clinical follow-up and data quality",
    ]);
    expect(sections[0].kpis).toEqual(headlineKpis(summary.messaging!));
    expect(sections[0].kpis.map((x) => x.key)).toEqual([
      "conversations",
      "unique",
      "returning",
      "median",
      "answered",
      "total",
      "failed",
    ]);
    expect(sections[1].kpis.map((x) => x.key)).toEqual([...MANAGEMENT_KPIS.enquiries]);
    expect(sections[2].kpis).toEqual(pickKpis(summary.appointments!, MANAGEMENT_KPIS.appointments));
    expect(JSON.stringify(sections)).not.toContain("hidden");
    // Phase 21: the clinical section prints exactly MANAGEMENT_KPIS.clinical (counts only)
    expect(sections[3].kpis.map((x) => x.key)).toEqual([...MANAGEMENT_KPIS.clinical]);
    expect(sections[3].kpis.map((x) => x.key)).not.toContain("doctor_alerts");
  });

  it("renders readable text and escapes HTML in the organisation name", () => {
    const out = renderDigest({
      orgName: "Al Das <script>alert(1)</script>",
      window: digestWindow("daily", new Date("2026-10-13T03:30:00Z"), "Asia/Dubai"),
      sections: summarySections(summary),
      dashboardUrl: "https://pulse.test/dashboard/management",
    });
    expect(out.subject).toContain("Daily digest");
    expect(out.subject).toContain("2026-10-12");
    expect(out.text).toContain("CONVERSATIONS: 120");
    expect(out.text).toContain("ANSWERED: 90%");
    expect(out.text).toContain("MEDIAN: 1m 35s");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain('href="https://pulse.test/dashboard/management"');
  });

  it("says so when there is no data yet", () => {
    const out = renderDigest({
      orgName: "Clinic",
      window: digestWindow("weekly", new Date("2026-10-12T03:30:00Z"), "Asia/Dubai"),
      sections: [],
      dashboardUrl: "https://pulse.test/d",
    });
    expect(out.text).toContain("No dashboard data");
    expect(out.subject).toContain("Weekly digest");
  });
});

describe("snooze", () => {
  const TZ = "Asia/Dubai";
  const now = new Date("2026-10-13T08:00:00Z"); // Tuesday 12:00 Dubai

  it("offers hours, tomorrow morning and next Monday, all in the person's timezone", () => {
    expect(SNOOZE_PRESETS).toEqual(["1h", "3h", "tomorrow", "next_week"]);
    expect(snoozeUntil("1h", now, TZ).toISOString()).toBe("2026-10-13T09:00:00.000Z");
    expect(snoozeUntil("3h", now, TZ).toISOString()).toBe("2026-10-13T11:00:00.000Z");
    expect(snoozeUntil("tomorrow", now, TZ).toISOString()).toBe("2026-10-14T04:00:00.000Z"); // 08:00 Dubai
    expect(snoozeUntil("next_week", now, TZ).toISOString()).toBe("2026-10-19T04:00:00.000Z"); // Monday 08:00 Dubai
  });

  it("'next Monday' on a Monday means a week from today, never today", () => {
    const monday = new Date("2026-10-12T08:00:00Z");
    expect(snoozeUntil("next_week", monday, TZ).toISOString()).toBe("2026-10-19T04:00:00.000Z");
  });

  it("validates presets and knows when a notification is hidden", () => {
    expect(isSnoozePreset("1h")).toBe(true);
    expect(isSnoozePreset("forever")).toBe(false);
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed("2026-10-13T09:00:00Z", now)).toBe(true);
    expect(isSnoozed("2026-10-13T07:00:00Z", now)).toBe(false);
  });
});
