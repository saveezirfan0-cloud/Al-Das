/**
 * Phase F pure helpers (docs/34_CLINIC_OS_PLAN.md): first-response time, snooze, recurrence, checklists, the enquiry
 * CSV import (synthetic file only), the Patient 360 history merge, the replying indicator, task status sync, who may
 * open a task, and the new notification events.
 */
import { describe, expect, it } from "vitest";

import { mergeHistory, historyCursor, parseHistoryCursor, type HistoryItem } from "@/lib/contacts/history";
import { parseCsv } from "@/lib/csv";
import {
  guessMapping,
  mappingProblem,
  naturalKey,
  parseImportDate,
  prepareEnquiryImport,
  type ImportPipeline,
} from "@/lib/enquiries/csv-import";
import { matchesFolder, type FolderContext } from "@/lib/inbox/folders";
import { composingSentence, othersComposing } from "@/lib/inbox/presence";
import { readInboxSettings } from "@/lib/inbox/settings";
import { firstResponse, formatWaiting, normaliseThresholds, waitingSince } from "@/lib/inbox/sla";
import { isSnoozed, snoozePresetTime, snoozeProblem, unsnoozeDedupeKey } from "@/lib/inbox/snooze";
import { getEvent } from "@/lib/notify/events";
import { notificationHref } from "@/lib/notify/links";
import { buildPushPayload, genericEmail } from "@/lib/notify/push-payload";
import {
  checklistLinesProblem,
  checklistProgress,
  normaliseTime,
  parseChecklistLines,
  templateTimesProblem,
} from "@/lib/tasks/checklist";
import { nextOccurrence, recurrenceDedupeKey } from "@/lib/tasks/recurrence";
import { compareForBoard, syncStatus } from "@/lib/tasks/status";
import { memberCanSeeTask } from "@/lib/tasks/visibility";

const TZ = "Asia/Dubai";
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("first-response time", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  const conv = (inbound: string | null, outbound: string | null, status = "open") => ({
    status,
    last_inbound_at: inbound,
    last_outbound_at: outbound,
  });

  it("waits from the patient's last message until someone replies", () => {
    expect(waitingSince(conv("2026-10-14T09:48:00Z", null))?.toISOString()).toBe("2026-10-14T09:48:00.000Z");
    expect(waitingSince(conv("2026-10-14T09:48:00Z", "2026-10-14T09:30:00Z"))).not.toBeNull();
    expect(waitingSince(conv("2026-10-14T09:48:00Z", "2026-10-14T09:50:00Z"))).toBeNull();
    expect(waitingSince(conv("2026-10-14T09:48:00Z", "2026-10-14T09:48:00Z"))).toBeNull();
    expect(waitingSince(conv(null, null))).toBeNull();
    expect(waitingSince(conv("2026-10-14T09:48:00Z", null, "closed"))).toBeNull();
    expect(waitingSince(conv("not a date", null))).toBeNull();
  });

  it("colours by the workspace thresholds, with sane defaults", () => {
    const t = { amberMinutes: 10, redMinutes: 30 };
    expect(firstResponse(conv("2026-10-14T09:52:00Z", null), now, t)).toEqual({ waitingMs: 8 * 60_000, level: "ok" });
    expect(firstResponse(conv("2026-10-14T09:48:00Z", null), now, t)?.level).toBe("amber");
    expect(firstResponse(conv("2026-10-14T09:30:00Z", null), now, t)?.level).toBe("red");
    expect(firstResponse(conv("2026-10-14T09:30:00Z", "2026-10-14T09:31:00Z"), now, t)).toBeNull();
    // A pair that makes no sense falls back to 15 / 60.
    expect(normaliseThresholds({ amberMinutes: 60, redMinutes: 15 })).toEqual({ amberMinutes: 15, redMinutes: 60 });
    expect(normaliseThresholds({ amberMinutes: 0, redMinutes: 5 })).toEqual({ amberMinutes: 15, redMinutes: 60 });
    expect(normaliseThresholds(null)).toEqual({ amberMinutes: 15, redMinutes: 60 });
    // The inbox settings carry the defaults and keep an org's choice.
    expect(readInboxSettings({}).first_response_amber_minutes).toBe(15);
    expect(readInboxSettings({ inbox: { first_response_red_minutes: 120 } }).first_response_red_minutes).toBe(120);
  });

  it("reads like 'waiting 12 m'", () => {
    expect(formatWaiting(5_000)).toBe("1 m");
    expect(formatWaiting(12 * 60_000 + 59_000)).toBe("12 m");
    expect(formatWaiting(3 * 3600_000)).toBe("3 h");
    expect(formatWaiting(47 * 3600_000)).toBe("47 h");
    expect(formatWaiting(50 * 3600_000)).toBe("2 d");
  });
});

describe("snooze", () => {
  const now = new Date("2026-10-14T15:20:00Z"); // 19:20 in Dubai, a Wednesday

  it("turns presets into times in the workspace timezone", () => {
    expect(snoozePresetTime("1h", now, TZ).toISOString()).toBe("2026-10-14T16:20:00.000Z");
    expect(snoozePresetTime("3h", now, TZ).toISOString()).toBe("2026-10-14T18:20:00.000Z");
    // Tomorrow 09:00 Dubai = 05:00Z.
    expect(snoozePresetTime("tomorrow", now, TZ).toISOString()).toBe("2026-10-15T05:00:00.000Z");
    // Next Monday 09:00 Dubai.
    expect(snoozePresetTime("next_week", now, TZ).toISOString()).toBe("2026-10-19T05:00:00.000Z");
    // Just before midnight Dubai, "tomorrow" is the next local day, not the next UTC day.
    const late = new Date("2026-10-14T19:59:00Z"); // 23:59 Dubai
    expect(snoozePresetTime("tomorrow", late, TZ).toISOString()).toBe("2026-10-15T05:00:00.000Z");
  });

  it("refuses the past, a moment from now and more than 90 days", () => {
    expect(snoozeProblem(new Date(now.getTime() - 1000), now)).toMatch(/future/);
    expect(snoozeProblem(new Date(now.getTime() + 30_000), now)).toMatch(/future/);
    expect(snoozeProblem(new Date(now.getTime() + 91 * 86_400_000), now)).toMatch(/90 days/);
    expect(snoozeProblem(new Date("nope"), now)).toMatch(/date/);
    expect(snoozeProblem(new Date(now.getTime() + 3600_000), now)).toBeNull();
  });

  it("keys the wake-up job by conversation and time, and knows when a chat is snoozed", () => {
    const until = new Date("2026-10-15T05:00:00Z");
    expect(unsnoozeDedupeKey(UUID(1), until)).toBe(`inbox_unsnooze:${UUID(1)}:${until.getTime()}`);
    expect(isSnoozed({ snoozed_until: until.toISOString() }, now)).toBe(true);
    expect(isSnoozed({ snoozed_until: "2026-10-14T15:00:00Z" }, now)).toBe(false);
    expect(isSnoozed({ snoozed_until: null }, now)).toBe(false);
  });

  it("moves snoozed chats out of the working folders into Snoozed", () => {
    const ctx: FolderContext = { userId: UUID(9), teamIds: [UUID(8)] };
    const base = {
      id: UUID(2),
      status: "open",
      assignee_user_id: UUID(9),
      assignee_team_id: null,
      bot_active: false,
      unread_count: 2,
      channel_id: UUID(3),
    };
    const snoozed = { ...base, snoozed_until: "2026-10-15T05:00:00Z" };
    for (const f of ["open", "mine", "assigned_me", "unread"] as const) {
      expect(matchesFolder(base, f, null, ctx), f).toBe(true);
      expect(matchesFolder(snoozed, f, null, ctx), f).toBe(false);
    }
    expect(matchesFolder(snoozed, "snoozed", null, ctx)).toBe(true);
    expect(matchesFolder(base, "snoozed", null, ctx)).toBe(false);
    expect(matchesFolder({ ...snoozed, status: "waiting" }, "waiting", null, ctx)).toBe(false);
    expect(matchesFolder({ ...snoozed, assignee_team_id: UUID(8) }, "open", UUID(8), ctx)).toBe(false);
    // A closed chat is never "snoozed".
    expect(matchesFolder({ ...snoozed, status: "closed" }, "snoozed", null, ctx)).toBe(false);
  });
});

describe("recurring tasks", () => {
  it("keeps the local time and moves by a day, a week or a month", () => {
    const due = new Date("2026-10-14T05:00:00Z"); // 09:00 Dubai
    expect(nextOccurrence(due, "daily", TZ).toISOString()).toBe("2026-10-15T05:00:00.000Z");
    expect(nextOccurrence(due, "weekly", TZ).toISOString()).toBe("2026-10-21T05:00:00.000Z");
    expect(nextOccurrence(due, "monthly", TZ).toISOString()).toBe("2026-11-14T05:00:00.000Z");
  });

  it("keeps 09:00 across a daylight-saving change", () => {
    // London: 09:00 BST on Sat 24 Oct 2026 is 08:00Z; the next day (GMT) 09:00 is 09:00Z.
    const due = new Date("2026-10-24T08:00:00Z");
    expect(nextOccurrence(due, "daily", "Europe/London").toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("uses the last day of a shorter month", () => {
    const due = new Date("2026-01-31T05:00:00Z");
    expect(nextOccurrence(due, "monthly", TZ).toISOString()).toBe("2026-02-28T05:00:00.000Z");
  });

  it("catches up with today instead of making every missed day", () => {
    const due = new Date("2026-10-01T05:00:00Z");
    const now = new Date("2026-10-14T07:00:00Z");
    expect(nextOccurrence(due, "daily", TZ, now).toISOString()).toBe("2026-10-15T05:00:00.000Z");
    expect(nextOccurrence(due, "weekly", TZ, now).toISOString()).toBe("2026-10-15T05:00:00.000Z");
    // A future due time is not affected by "now".
    expect(nextOccurrence(new Date("2026-10-20T05:00:00Z"), "daily", TZ, now).toISOString()).toBe(
      "2026-10-21T05:00:00.000Z",
    );
  });

  it("keys the job by task and due time", () => {
    const due = new Date("2026-10-14T05:00:00Z");
    expect(recurrenceDedupeKey(UUID(4), due)).toBe(`task_recur:${UUID(4)}:${due.getTime()}`);
  });
});

describe("task status", () => {
  it("mirrors the database rule for status and done", () => {
    expect(syncStatus({ status: "todo", done: false }, { status: "done" })).toEqual({ status: "done", done: true });
    expect(syncStatus({ status: "done", done: true }, { status: "blocked" })).toEqual({ status: "blocked", done: false });
    expect(syncStatus({ status: "in_progress", done: false }, { done: true })).toEqual({ status: "done", done: true });
    expect(syncStatus({ status: "done", done: true }, { done: false })).toEqual({ status: "todo", done: false });
    expect(syncStatus({ status: "blocked", done: false }, {})).toEqual({ status: "blocked", done: false });
    // A status change wins over a conflicting done flag.
    expect(syncStatus({ status: "todo", done: false }, { status: "in_progress", done: true })).toEqual({
      status: "in_progress",
      done: false,
    });
  });

  it("orders the board by priority, then due time", () => {
    const rows = [
      { priority: "normal", due_at: "2026-10-14T08:00:00Z" },
      { priority: "urgent", due_at: "2026-10-16T08:00:00Z" },
      { priority: "normal", due_at: "2026-10-13T08:00:00Z" },
      { priority: "low", due_at: "2026-10-01T08:00:00Z" },
    ];
    expect([...rows].sort(compareForBoard).map((r) => `${r.priority}@${r.due_at.slice(8, 10)}`)).toEqual([
      "urgent@16",
      "normal@13",
      "normal@14",
      "low@01",
    ]);
  });

  it("only tells people who could open the task", () => {
    const m = (permissions: unknown[], scope: string | null, locations: string[] = []) => ({
      user_id: UUID(5),
      permissions,
      branch_scope: scope,
      locations,
    });
    expect(memberCanSeeTask(m(["tasks.view"], "all"), UUID(6))).toBe(true);
    expect(memberCanSeeTask(m(["*"], null), UUID(6))).toBe(true);
    expect(memberCanSeeTask(m(["inbox.send"], "all"), null)).toBe(false);
    expect(memberCanSeeTask(m(["tasks.view"], "selected", [UUID(7)]), UUID(6))).toBe(false);
    expect(memberCanSeeTask(m(["tasks.view"], "selected", [UUID(6)]), UUID(6))).toBe(true);
    expect(memberCanSeeTask(m(["tasks.view"], "selected", [UUID(7)]), null)).toBe(true);
  });
});

describe("daily checklists", () => {
  it("reads one item per line, without bullets, blanks or repeats", () => {
    expect(parseChecklistLines("- Lights on\n\n* Lights on\n2. Fridge temperature\r\n[ ] Cash float\n  •  Lock the door  ")).toEqual([
      "Lights on",
      "Fridge temperature",
      "Cash float",
      "Lock the door",
    ]);
  });

  it("checks the number and length of items and the two times", () => {
    expect(checklistLinesProblem([])).toMatch(/at least one/);
    expect(checklistLinesProblem(Array.from({ length: 51 }, (_, i) => `Item ${i}`))).toMatch(/50/);
    expect(checklistLinesProblem(["x".repeat(201)])).toMatch(/200/);
    expect(checklistLinesProblem(["Lights on"])).toBeNull();
    expect(normaliseTime("06:30:00")).toBe("06:30");
    expect(normaliseTime("6:30")).toBeNull();
    expect(normaliseTime("24:00")).toBeNull();
    expect(templateTimesProblem("06:00", "09:00")).toBeNull();
    expect(templateTimesProblem("09:00", "06:00")).toMatch(/after/);
    expect(templateTimesProblem("soon", "09:00")).toMatch(/06:30/);
  });

  it("counts progress", () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, complete: false });
    expect(checklistProgress([{ done: true }, { done: false }])).toEqual({ done: 1, total: 2, complete: false });
    expect(checklistProgress([{ done: true }, { done: true }])).toEqual({ done: 2, total: 2, complete: true });
  });
});

describe("enquiries CSV import (synthetic file)", () => {
  const pipelines: ImportPipeline[] = [
    { id: UUID(10), name: "New patients", stages: [{ id: UUID(11), name: "New" }, { id: UUID(12), name: "Contacted" }] },
    { id: UUID(20), name: "Dermatology", stages: [{ id: UUID(21), name: "Lead" }] },
  ];
  const branches = [{ id: UUID(30), name: "Jumeirah" }];
  const file = [
    "Name,Mobile,Title,Pipeline,Stage,Branch,Value,Appointment date,Notes",
    "Layla Demo-01,0501234567,Laser consult,,,,1500,14/10/2026,ignored",
    "Omar Demo-02,+44 7700 900002,,Dermatology,Lead,Jumeirah,,2026-11-01,ignored",
    "Sara Demo-03,12,Check-up,,,,,,",
    "Layla Demo-01,+971 50 123 4567,laser  CONSULT,,,,,,",
    "Nour Demo-04,+447700900004,Follow-up,Unknown pipeline,,,abc,31/02/2026,",
    ",,,,,,,,",
    "Hana Demo-05,+447700900005,Teeth,,Nowhere,Elsewhere,,,",
  ].join("\n");

  it("guesses the mapping and refuses one that cannot be re-run safely", () => {
    const csv = parseCsv(file);
    const m = guessMapping(csv.headers);
    expect(m).toMatchObject({
      Name: "full_name",
      Mobile: "phone",
      Title: "title",
      Pipeline: "pipeline",
      Stage: "stage",
      Branch: "branch",
      Value: "est_value",
      "Appointment date": "appt_date",
      Notes: null,
    });
    expect(mappingProblem(m)).toBeNull();
    expect(mappingProblem({ Name: "full_name" })).toMatch(/Phone/);
    expect(mappingProblem({ Mobile: "phone" })).toMatch(/Title/);
    expect(mappingProblem({ Mobile: "phone", A: "title", B: "title" })).toMatch(/same field/);
  });

  it("validates each row, phones to E.164, and finds repeats in the file", () => {
    const csv = parseCsv(file);
    const { rows, summary } = prepareEnquiryImport(csv.headers, csv.rows, {
      mapping: guessMapping(csv.headers),
      pipelines,
      defaultPipelineId: UUID(10),
      branches,
    });
    expect(summary).toEqual({ total: 7, ok: 2, invalid: 4, duplicates: 1 });
    expect(rows[0].status).toBe("ok");
    expect(rows[0].enquiry).toMatchObject({
      title: "Laser consult",
      firstName: "Layla",
      lastName: "Demo-01",
      phone: "+971501234567",
      pipelineId: UUID(10),
      stageId: null,
      estValue: 1500,
      apptDate: "2026-10-14",
    });
    expect(rows[1].enquiry).toMatchObject({
      title: "Enquiry from Omar Demo-02",
      phone: "+447700900002",
      pipelineId: UUID(20),
      stageId: UUID(21),
      locationId: UUID(30),
      apptDate: "2026-11-01",
    });
    expect(rows[2].errors).toEqual(["The phone number is not valid."]);
    // Same phone, same title (case and spaces ignored), same pipeline: a repeat of line 1.
    expect(rows[3]).toMatchObject({ status: "duplicate", duplicateOf: 1 });
    expect(rows[4].errors).toEqual([
      "Unknown pipeline.",
      "The estimated value is not a number.",
      "The appointment date is not a date (use 2026-10-14 or 14/10/2026).",
    ]);
    expect(rows[5].errors).toEqual(["The row is empty."]);
    expect(rows[6].errors).toEqual(["Unknown stage for this pipeline.", "Unknown branch."]);
    // Errors never repeat a cell's value.
    for (const r of rows) for (const e of r.errors) expect(e).not.toMatch(/Demo-|\+44|0501/);
  });

  it("reads only the mapped columns", () => {
    const csv = parseCsv("Phone,Secret\n+447700900006,do not read\n");
    const { rows } = prepareEnquiryImport(csv.headers, csv.rows, {
      mapping: { Phone: "phone", Secret: null },
      pipelines,
      defaultPipelineId: UUID(10),
      branches,
    });
    expect(rows[0].errors).toEqual(["Missing title or patient name."]);
    expect(JSON.stringify(rows)).not.toContain("do not read");
  });

  it("keys a row by your own ID, else phone, title and pipeline", () => {
    expect(naturalKey({ externalId: "A-1", phone: "+447700900007", title: "X", pipelineId: UUID(10) })).toBe("ext:A-1");
    expect(naturalKey({ externalId: null, phone: "+447700900007", title: " Laser  Consult ", pipelineId: UUID(10) })).toBe(
      `nat:+447700900007|laser consult|${UUID(10)}`,
    );
    expect(naturalKey({ externalId: null, phone: null, title: "X", pipelineId: UUID(10) })).toBeNull();
  });

  it("parses ISO and day-first dates and refuses impossible ones", () => {
    expect(parseImportDate("2026-10-14")).toBe("2026-10-14");
    expect(parseImportDate("14.10.2026")).toBe("2026-10-14");
    expect(parseImportDate("1/2/2026")).toBe("2026-02-01");
    expect(parseImportDate("2026-02-30")).toBe("bad");
    expect(parseImportDate("10/14/2026")).toBe("bad");
    expect(parseImportDate("")).toBeNull();
  });
});

describe("Patient 360 history", () => {
  const item = (kind: HistoryItem["kind"], n: number, at: string): HistoryItem => ({ kind, id: UUID(n), at, title: kind });

  it("merges sources newest first and pages without losing or repeating items", () => {
    const messages = [item("message", 1, "2026-10-14T10:00:00Z"), item("message", 2, "2026-10-14T08:00:00Z")];
    const tasks = [item("task", 3, "2026-10-14T09:00:00Z"), item("task", 4, "2026-10-14T08:00:00Z")];
    const notes = [item("note", 5, "2026-10-13T08:00:00Z")];
    const page1 = mergeHistory(
      [
        { items: messages, full: false },
        { items: tasks, full: false },
        { items: notes, full: false },
      ],
      3,
      null,
    );
    expect(page1.items.map((i) => i.id)).toEqual([UUID(1), UUID(3), UUID(4)]);
    expect(page1.nextCursor).toBe(historyCursor(page1.items[2]));
    // The same instant: the key decides, so message 2 (same time as task 4) comes on the next page.
    const page2 = mergeHistory(
      [
        { items: messages, full: false },
        { items: tasks, full: false },
        { items: notes, full: false },
      ],
      3,
      page1.nextCursor,
    );
    expect(page2.items.map((i) => i.id)).toEqual([UUID(2), UUID(5)]);
    expect(page2.nextCursor).toBeNull();
  });

  it("stops a page where a full source might have older items", () => {
    const full = { items: [item("message", 1, "2026-10-14T10:00:00Z"), item("message", 2, "2026-10-14T09:00:00Z")], full: true };
    const other = { items: [item("appointment", 3, "2026-10-01T09:00:00Z")], full: false };
    const page = mergeHistory([full, other], 30, null);
    expect(page.items.map((i) => i.id)).toEqual([UUID(1), UUID(2)]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("refuses a cursor that is not ours", () => {
    expect(parseHistoryCursor("2026-10-14T10:00:00.000Z|message:" + UUID(1))).not.toBeNull();
    expect(parseHistoryCursor("2026-10-14|drop table:1")).toBeNull();
    expect(parseHistoryCursor("nonsense")).toBeNull();
    expect(parseHistoryCursor(null)).toBeNull();
  });
});

describe("someone else is replying", () => {
  const now = 1_000_000;
  it("lists other people composing, ignoring me, stale flags and junk", () => {
    const state = {
      a: [{ user_id: "me", composing: true, at: now }],
      b: [
        { user_id: "sara", composing: true, at: now - 1000 },
        { user_id: "sara", composing: false, at: now },
      ],
      c: [{ user_id: "omar", composing: true, at: now - 60_000 }],
      d: [{ user_id: "huda", composing: false, at: now }],
      e: [{ hello: "world" }, null, "x"],
    };
    expect(othersComposing(state, "me", now)).toEqual(["sara"]);
  });

  it("says it in a sentence without message text", () => {
    expect(composingSentence([])).toBeNull();
    expect(composingSentence(["Sara"])).toBe("Sara is replying to this chat");
    expect(composingSentence(["Sara", "Omar"])).toBe("Sara and Omar are replying to this chat");
    expect(composingSentence(["A", "B", "C"])).toBe("3 colleagues are replying to this chat");
  });
});

describe("task notifications", () => {
  it("are in the catalogue, gated by tasks.view, with generic push and e-mail and a deep link", () => {
    for (const key of ["task.assigned", "task.mentioned"]) {
      expect(getEvent(key)?.permission).toBe("tasks.view");
      const p = buildPushPayload(key, { task_id: UUID(40) })!;
      expect(p.url).toBe(`/tasks?task=${UUID(40)}`);
      expect(p.body).not.toMatch(/Demo|\+44/);
      expect(genericEmail(key)?.sentence).toMatch(/Open Pulse/);
      expect(notificationHref(key, { task_id: UUID(40) })).toBe(`/tasks?task=${UUID(40)}`);
    }
  });
});
