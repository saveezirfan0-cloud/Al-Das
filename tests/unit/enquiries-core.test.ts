import { describe, expect, it } from "vitest";

import { decideAssignment } from "@/lib/enquiries/assignment";
import {
  CARD_FIELDS,
  ENQUIRY_COLUMNS,
  isCardField,
  isSortable,
  SORTABLE_COLUMNS,
} from "@/lib/enquiries/columns";
import { DEFAULT_PIPELINES, isStageColor } from "@/lib/enquiries/defaults";
import {
  activityCsv,
  describeActivity,
  enquiriesCsv,
  type ExportRow,
} from "@/lib/enquiries/export";
import {
  applyClauses,
  enquiryFilterSchema,
  filterToClauses,
  searchExpression,
  searchTerm,
  type Clause,
} from "@/lib/enquiries/filter";
import { moveById, nextSort, sameIdSet, sortValues } from "@/lib/enquiries/ordering";
import {
  DEFAULT_ENQUIRY_SETTINGS,
  enquirySettingsSchema,
  readEnquirySettings,
  writeEnquirySettings,
} from "@/lib/enquiries/settings";
import { formatSlaRemaining, isSlaBreached, needsSlaAlert, slaDueAt } from "@/lib/enquiries/sla";
import { isClosed, isEnquiryStatus, validateStatusChange } from "@/lib/enquiries/status";

describe("validateStatusChange", () => {
  it("requires a reason for lost and disqualified and drops it otherwise", () => {
    expect(validateStatusChange("open", "lost", "")).toEqual({
      ok: false,
      error: "Say why this enquiry is lost.",
    });
    expect(validateStatusChange("open", "disqualified", "   ").ok).toBe(false);
    expect(validateStatusChange("open", "lost", "x".repeat(301)).ok).toBe(false);
    expect(validateStatusChange("open", "lost", " Chose another clinic ")).toMatchObject({
      ok: true,
      status: "lost",
      reason: "Chose another clinic",
      closes: true,
      reopens: false,
      changed: true,
    });
    expect(validateStatusChange("open", "won", "ignored")).toMatchObject({
      ok: true,
      reason: null,
      closes: true,
    });
  });
  it("reopens and detects no-ops", () => {
    expect(validateStatusChange("won", "open", null)).toMatchObject({
      ok: true,
      reopens: true,
      closes: false,
      reason: null,
    });
    expect(validateStatusChange("lost", "lost", "same", "same")).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(validateStatusChange("lost", "lost", "new reason", "same")).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(validateStatusChange("won", "lost", "x")).toMatchObject({
      closes: false,
      reopens: false,
    });
  });
  it("classifies statuses", () => {
    expect(isEnquiryStatus("won")).toBe(true);
    expect(isEnquiryStatus("closed")).toBe(false);
    expect(isClosed("open")).toBe(false);
    expect(isClosed("disqualified")).toBe(true);
  });
});

describe("ordering", () => {
  it("moves ids and numbers them", () => {
    expect(moveById(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveById(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveById(["a", "b"], "x", "b")).toEqual(["a", "b"]);
    expect(sortValues(["a", "b"])).toEqual([
      { id: "a", sort: 10 },
      { id: "b", sort: 20 },
    ]);
    expect(nextSort([])).toBe(10);
    expect(nextSort([10, 40, 20])).toBe(50);
  });
  it("rejects partial or foreign reorders", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a", "b"], ["a"])).toBe(false);
    expect(sameIdSet(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameIdSet(["a", "a"], ["a", "a"])).toBe(false);
  });
});

describe("enquiry settings", () => {
  it("has safe defaults and tolerates junk", () => {
    expect(DEFAULT_ENQUIRY_SETTINGS.sla_hours).toBeNull();
    expect(DEFAULT_ENQUIRY_SETTINGS.assignment.mode).toBe("manual");
    expect(readEnquirySettings(null)).toEqual(DEFAULT_ENQUIRY_SETTINGS);
    expect(readEnquirySettings({ enquiries: { sla_hours: 3 } })).toEqual(DEFAULT_ENQUIRY_SETTINGS);
    expect(readEnquirySettings({ enquiries: { sla_hours: 4 } }).sla_hours).toBe(4);
  });
  it("writes without touching other sections", () => {
    const next = enquirySettingsSchema.parse({ sla_hours: 2 });
    expect(writeEnquirySettings({ inbox: { a: 1 } }, next)).toEqual({
      inbox: { a: 1 },
      enquiries: next,
    });
    expect(writeEnquirySettings(undefined, next)).toEqual({ enquiries: next });
  });
});

describe("SLA", () => {
  const entered = "2026-05-01T08:00:00.000Z";
  const open = { status: "open", stage_entered_at: entered, sla_alerted_at: null };
  it("computes due time only for open enquiries with an SLA", () => {
    expect(slaDueAt(open, 4)?.toISOString()).toBe("2026-05-01T12:00:00.000Z");
    expect(slaDueAt(open, null)).toBeNull();
    expect(slaDueAt({ ...open, status: "won" }, 4)).toBeNull();
  });
  it("detects breaches and alerts once per stage visit", () => {
    const before = new Date("2026-05-01T11:59:00Z");
    const after = new Date("2026-05-01T12:00:00Z");
    expect(isSlaBreached(open, 4, before)).toBe(false);
    expect(isSlaBreached(open, 4, after)).toBe(true);
    expect(needsSlaAlert(open, 4, after)).toBe(true);
    expect(needsSlaAlert({ ...open, sla_alerted_at: "2026-05-01T12:05:00Z" }, 4, after)).toBe(
      false,
    );
    // Moved to a new stage after the last alert: alert again once it breaches.
    expect(
      needsSlaAlert(
        {
          ...open,
          stage_entered_at: "2026-05-01T13:00:00Z",
          sla_alerted_at: "2026-05-01T12:05:00Z",
        },
        1,
        new Date("2026-05-01T14:01:00Z"),
      ),
    ).toBe(true);
  });
  it("formats remaining time", () => {
    const now = new Date("2026-05-01T10:00:00Z");
    expect(formatSlaRemaining(new Date("2026-05-01T12:15:00Z"), now)).toBe("2 h 15 min left");
    expect(formatSlaRemaining(new Date("2026-05-01T09:30:00Z"), now)).toBe("30 min overdue");
    expect(formatSlaRemaining(new Date("2026-05-01T10:00:20Z"), now)).toBe("1 min left");
  });
});

describe("decideAssignment", () => {
  const base = { creatorId: "creator", pipelineTeamId: "team" };
  it("honours an explicit assignee first", () => {
    expect(decideAssignment({ ...base, requestedAssigneeId: "u1", mode: "manual" })).toEqual({
      kind: "user",
      userId: "u1",
    });
  });
  it("applies the org mode", () => {
    expect(decideAssignment({ ...base, mode: "manual" })).toEqual({ kind: "none" });
    expect(decideAssignment({ ...base, mode: "creator" })).toEqual({
      kind: "user",
      userId: "creator",
    });
    expect(decideAssignment({ ...base, mode: "round_robin" })).toEqual({
      kind: "team_round_robin",
      teamId: "team",
    });
    expect(decideAssignment({ creatorId: "c", pipelineTeamId: null, mode: "round_robin" })).toEqual(
      { kind: "none" },
    );
    expect(decideAssignment({ creatorId: null, pipelineTeamId: null, mode: "creator" })).toEqual({
      kind: "none",
    });
  });
});

describe("filter", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  const A = "22222222-2222-4222-8222-222222222222";
  const P = "33333333-3333-4333-8333-333333333333";
  const f = (o: object) => enquiryFilterSchema.parse(o);

  it("defaults to open enquiries", () => {
    expect(filterToClauses(f({}), { userId: U })).toEqual([
      { op: "eq", column: "status", value: "open" },
    ]);
    expect(filterToClauses(f({ scope: "closed" }), { userId: U })).toEqual([
      { op: "in", column: "status", value: ["won", "lost", "disqualified"] },
    ]);
    expect(filterToClauses(f({ scope: "all" }), { userId: U })).toEqual([]);
  });
  it("an explicit status list overrides the switch", () => {
    expect(filterToClauses(f({ scope: "open", status: ["won"] }), { userId: U })).toEqual([
      { op: "in", column: "status", value: ["won"] },
    ]);
  });
  it("resolves me / unassigned", () => {
    expect(filterToClauses(f({ scope: "all", assignees: ["me", A] }), { userId: U })).toEqual([
      { op: "in", column: "assignee_id", value: [U, A] },
    ]);
    expect(filterToClauses(f({ scope: "all", assignees: ["unassigned"] }), { userId: U })).toEqual([
      { op: "or", expr: "assignee_id.is.null" },
    ]);
    expect(
      filterToClauses(f({ scope: "all", assignees: ["unassigned", "me"] }), { userId: U }),
    ).toEqual([{ op: "or", expr: `assignee_id.is.null,assignee_id.in.(${U})` }]);
  });
  it("compiles ids, sources and date ranges", () => {
    const clauses = filterToClauses(
      f({
        scope: "all",
        pipeline_id: P,
        stage_ids: [A],
        sources: ["Instagram"],
        created_from: "2026-05-01",
        created_to: "2026-05-31",
      }),
      { userId: U },
    );
    expect(clauses).toEqual([
      { op: "eq", column: "pipeline_id", value: P },
      { op: "in", column: "stage_id", value: [A] },
      { op: "in", column: "source", value: ["Instagram"] },
      { op: "gte", column: "created_at", value: "2026-05-01T00:00:00.000Z" },
      { op: "lte", column: "created_at", value: "2026-05-31T23:59:59.999Z" },
    ]);
  });
  it("rejects malformed input", () => {
    expect(enquiryFilterSchema.safeParse({ pipeline_id: "nope" }).success).toBe(false);
    expect(enquiryFilterSchema.safeParse({ created_from: "yesterday" }).success).toBe(false);
    expect(enquiryFilterSchema.safeParse({ assignees: ["x"] }).success).toBe(false);
    expect(enquiryFilterSchema.safeParse({ search: "x".repeat(101) }).success).toBe(false);
  });
  it("applies clauses to a query builder in order", () => {
    const calls: string[] = [];
    type Q = {
      eq(c: string, v: string): Q;
      in(c: string, v: string[]): Q;
      gte(c: string, v: string): Q;
      lte(c: string, v: string): Q;
      or(e: string): Q;
    };
    const q: Q = {
      eq: (c, v) => (calls.push(`eq ${c} ${v}`), q),
      in: (c, v) => (calls.push(`in ${c} ${v.join("|")}`), q),
      gte: (c, v) => (calls.push(`gte ${c} ${v}`), q),
      lte: (c, v) => (calls.push(`lte ${c} ${v}`), q),
      or: (e) => (calls.push(`or ${e}`), q),
    };
    const clauses: Clause[] = [
      { op: "eq", column: "a", value: "1" },
      { op: "in", column: "b", value: ["x", "y"] },
      { op: "gte", column: "c", value: "d" },
      { op: "lte", column: "c", value: "e" },
      { op: "or", expr: "f.is.null" },
    ];
    applyClauses(q, clauses);
    expect(calls).toEqual(["eq a 1", "in b x|y", "gte c d", "lte c e", "or f.is.null"]);
  });
  it("builds a safe search expression", () => {
    expect(searchExpression("", [])).toBeNull();
    expect(searchExpression("  ", [])).toBeNull();
    expect(searchExpression("knee", [])).toBe("title.ilike.%knee%");
    expect(searchExpression("#1042", [])).toBe("title.ilike.%#1042%,number.eq.1042");
    expect(searchExpression("ENQ-7", [])).toBe("title.ilike.%ENQ-7%,number.eq.7");
    expect(searchExpression("a", [U, "not-a-uuid"])).toBe(`title.ilike.%a%,contact_id.in.(${U})`);
    // Characters that could break out of the PostgREST expression are neutralised.
    expect(searchExpression("x),status.eq.won,(y", [])).toBe("title.ilike.%x status.eq.won y%");
    expect(searchTerm("a%b*c,d")).toBe("a b c d");
  });
});

describe("columns and defaults", () => {
  it("only allows sorting by known columns", () => {
    expect(isSortable("created_at")).toBe(true);
    expect(isSortable("created_at; drop table")).toBe(false);
    for (const c of ENQUIRY_COLUMNS) if (c.sortKey) expect(SORTABLE_COLUMNS).toContain(c.sortKey);
    expect(new Set(ENQUIRY_COLUMNS.map((c) => c.id)).size).toBe(ENQUIRY_COLUMNS.length);
    expect(isCardField("phone")).toBe(true);
    expect(isCardField("password")).toBe(false);
    expect(CARD_FIELDS.length).toBeGreaterThan(5);
  });
  it("ships the clinic queues with valid stages", () => {
    expect(DEFAULT_PIPELINES.map((p) => p.name)).toEqual([
      "Reception",
      "Awaiting patient",
      "Doctor liaison",
      "Escalation",
      "Insurance review",
      "Medical records",
      "Pharmacy",
      "Ready to close",
    ]);
    for (const p of DEFAULT_PIPELINES) {
      expect(p.stages.length).toBeGreaterThanOrEqual(2);
      for (const s of p.stages) expect(isStageColor(s.color)).toBe(true);
      for (const k of p.card_fields) expect(isCardField(k)).toBe(true);
    }
    // Pipelines must not share stage arrays (they are edited independently).
    expect(DEFAULT_PIPELINES[0].stages).not.toBe(DEFAULT_PIPELINES[1].stages);
  });
});

describe("export", () => {
  const row: ExportRow = {
    number: 12,
    title: "=HYPERLINK(1)",
    patient: "Sara Example",
    phone: "+971500000000",
    pipeline: "Reception",
    stage: "New",
    status: "open",
    reason: "",
    assignee: "A User",
    source: "Instagram",
    channel: "Main",
    location: "",
    department: "",
    specialist: "",
    service: "",
    appointment_at: "",
    est_value: "250.00",
    created_at: "2026-05-01T08:00:00.000Z",
    closed_at: "",
    created_by: "A User",
    custom: { vip: "Yes" },
  };
  it("writes headers, rows and custom fields, neutralising formulas", () => {
    const csv = enquiriesCsv([row], [{ key: "vip", label: "VIP" }]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "ID,Title,Patient,Phone,Pipeline,Stage,Status,Reason,Assigned to,Source,Channel,Location,Department,Specialist,Service,Appointment,Est. value,Created,Closed,Created by,VIP",
    );
    expect(lines[1].startsWith("12,'=HYPERLINK(1),Sara Example,")).toBe(true);
    expect(lines[1].endsWith(",Yes")).toBe(true);
  });
  it("describes activity without free-form text", () => {
    expect(
      describeActivity("enquiry.stage_changed", { from_stage: "New", to_stage: "In progress" }),
    ).toBe("New → In progress");
    expect(
      describeActivity("enquiry.status_changed", { from: "open", to: "lost", reason: "Price" }),
    ).toBe("open → lost (Price)");
    expect(describeActivity("enquiry.assigned", { assignee: "" })).toBe("Assigned to nobody");
    expect(describeActivity("note", { text: "secret" })).toBe("");
    const csv = activityCsv([
      { at: "t", enquiry_number: 3, type: "enquiry.created", actor: "A", detail: "d" },
    ]);
    expect(csv).toContain("When,Enquiry,Event,By,Detail");
    expect(csv).toContain("t,3,enquiry.created,A,d");
  });
});
