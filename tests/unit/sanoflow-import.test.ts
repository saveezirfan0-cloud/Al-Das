/**
 * Phase 20a: the Sanoflow importers on synthetic exports only (CLAUDE.md rule 10). Pure parsing,
 * header mapping, file discovery, and each step against an in-memory store: idempotent re-runs,
 * dry runs, review routing and the counts the reconcile step relies on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { remindersAllowed } from "@/lib/appointments/reminders";
import { evaluateData } from "@/lib/cutover/preflight";
import { parseCsv, toCsv } from "@/lib/csv";
import { findPii, reconcile, type DbSnapshot } from "@/lib/migration/reconcile";
import { sanoflowReviewActions } from "@/lib/migration/sanoflow-review";

import { classifyFiles, sourceCounts } from "../../scripts/import/sanoflow/all";
import { parseConfig, parseNames, type SanoflowConfig } from "../../scripts/import/sanoflow/config";
import { mapHeaders } from "../../scripts/import/sanoflow/mapping";
import type {
  BookInput,
  ContactMatch,
  RefRow,
  RefTable,
  SanoflowPorts,
} from "../../scripts/import/sanoflow/ports";
import { DryRunPorts } from "../../scripts/import/sanoflow/ports";
import { renderReport, toSummaries } from "../../scripts/import/sanoflow/report";
import { outcomes, type RunContext } from "../../scripts/import/sanoflow/run";
import { ACTIVITY_EVENT_TYPE, runActivity } from "../../scripts/import/sanoflow/run-activity";
import { runAppointments } from "../../scripts/import/sanoflow/run-appointments";
import {
  campaignNameFromFile,
  runCampaignHistory,
} from "../../scripts/import/sanoflow/run-campaigns";
import { runConfig } from "../../scripts/import/sanoflow/run-config";
import { runEnquiries } from "../../scripts/import/sanoflow/run-enquiries";
import { runList, runQuickReplies } from "../../scripts/import/sanoflow/run-lists";
import { readDynamicSegments, runStaticSegments } from "../../scripts/import/sanoflow/run-segments";
import {
  mapAppointmentStatus,
  mapLostReason,
  mapRecipientStatus,
  mapStatus,
  parseClock,
  parseDay,
  parseDurationMin,
  parseLocalDateTime,
  parseMoney,
  stableId,
  statusRank,
  toShortcut,
} from "../../scripts/import/sanoflow/values";
import { MemoryStore } from "../../scripts/import/store";

// ---------------------------------------------------------------------------
// In-memory ports
// ---------------------------------------------------------------------------

class MemoryPorts extends MemoryStore implements SanoflowPorts {
  members = new Set<string>();
  reviews = new Map<string, { reason: string; status: string }>();
  sources: string[] = ["WhatsApp"];
  emails = new Map<string, string>([["agent.one@example.test", "user-1"]]);
  refRows: Record<RefTable, RefRow[]> = {
    locations: [{ id: "loc-1", name: "Branch A", department_id: null, duration_min: null }],
    specialists: [
      { id: "spec-1", name: "Dr Example One", department_id: "dep-1", duration_min: null },
    ],
    services: [
      { id: "svc-1", name: "General consultation", department_id: "dep-2", duration_min: 20 },
    ],
  };
  /** busy intervals per specialist, ms */
  busy: Array<{ specialistId: string; start: number; end: number }> = [];

  addContact(id: string, phone: string | null, extra: Record<string, unknown> = {}) {
    this.rows("contacts").push({
      id,
      org_id: this.orgId,
      phone_e164: phone,
      deleted_at: null,
      merged_into_id: null,
      ...extra,
    });
  }
  async liveContact(id: string) {
    let cur: string | null = id;
    for (let i = 0; cur && i < 5; i++) {
      const c = this.rows("contacts").find((r) => r.id === cur);
      if (!c) return null;
      if (!c.deleted_at) return c.id;
      cur = (c.merged_into_id as string | null) ?? null;
    }
    return null;
  }
  async matchContactByPhone(e164: string): Promise<ContactMatch> {
    const hits = this.rows("contacts").filter((c) => c.phone_e164 === e164 && !c.deleted_at);
    if (hits.length === 1) return { kind: "match", id: hits[0].id };
    if (hits.length > 1)
      return {
        kind: "ambiguous",
        candidates: hits.map((h) => ({ contact_id: h.id, matched_on: "phone" })),
      };
    return { kind: "none" };
  }
  async memberIdByEmail(email: string) {
    return this.emails.get(email.toLowerCase()) ?? null;
  }
  async findByName(table: RefTable, name: string) {
    return (
      this.refRows[table].find((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ?? null
    );
  }
  async hasSegmentMember(s: string, c: string) {
    return this.members.has(`${s}|${c}`);
  }
  async addSegmentMember(s: string, c: string) {
    this.members.add(`${s}|${c}`);
    return {};
  }
  async refreshSegmentCount(segmentId: string) {
    const n = [...this.members].filter((m) => m.startsWith(`${segmentId}|`)).length;
    await this.updateRow("segments", segmentId, { member_count: n });
  }
  enquiryTags = new Set<string>();
  async addEnquiryTag(enquiryId: string, tagId: string) {
    this.enquiryTags.add(`${enquiryId}|${tagId}`);
    return {};
  }
  async findAppointment(m: { contactId: string; specialistId: string; startsAt: string }) {
    const hit = this.rows("appointments").find(
      (a) =>
        a.contact_id === m.contactId &&
        a.specialist_id === m.specialistId &&
        Date.parse(String(a.starts_at)) === Date.parse(m.startsAt) &&
        a.status !== "cancelled",
    );
    return hit?.id ?? null;
  }
  async bookAppointment(b: BookInput) {
    const s = Date.parse(b.startsAt);
    const e = Date.parse(b.endsAt);
    const taken =
      this.busy.some((x) => x.specialistId === b.specialistId && x.start < e && x.end > s) ||
      this.rows("appointments").some(
        (a) =>
          a.specialist_id === b.specialistId &&
          a.status !== "cancelled" &&
          Date.parse(String(a.starts_at)) < e &&
          Date.parse(String(a.ends_at)) > s,
      );
    if (taken) return { error: "slot_taken" };
    return this.insertRow("appointments", {
      contact_id: b.contactId,
      location_id: b.locationId,
      specialist_id: b.specialistId,
      service_id: b.serviceId,
      department_id: b.departmentId,
      starts_at: b.startsAt,
      ends_at: b.endsAt,
      status: b.status,
      notes: b.notes,
      source: "import",
    });
  }
  async queueReview(r: { entity: string; externalId: string; reason: string }) {
    if (this.reviews.get(`${r.entity}|${r.externalId}`)?.status === "dismissed") return;
    this.reviews.set(`${r.entity}|${r.externalId}`, { reason: r.reason, status: "open" });
  }
  async resolveReview(entity: string, externalId: string) {
    const r = this.reviews.get(`${entity}|${externalId}`);
    if (r && r.status === "open") r.status = "resolved";
  }
  async customFieldDefs() {
    return this.rows("custom_fields")
      .filter((f) => f.entity === "enquiry")
      .map((f) => ({
        key: String(f.key),
        label: String(f.label),
        type: f.type as "text",
        options: [],
        required: false,
      }));
  }
  lostReasons: string[] = [];
  async enquiryList(key: "sources" | "lost_reasons") {
    return key === "sources" ? [...this.sources] : [...this.lostReasons];
  }
  async setEnquiryList(key: "sources" | "lost_reasons", values: string[]) {
    if (key === "sources") this.sources = [...values];
    else this.lostReasons = [...values];
    return {};
  }
}

const CONFIG: SanoflowConfig = parseConfig({
  version: 1,
  pipelines: [
    {
      name: "New patients",
      sanoflow_name: "Leads",
      is_default: true,
      stages: [
        { name: "New" },
        { name: "Contacted", sanoflow_name: "In conversation" },
        { name: "Booked" },
      ],
    },
  ],
  statuses: { "Appointment booked": "won" },
  lost_reasons: { price: "Price too high" },
  enquiry_custom_fields: [{ key: "utm_source", label: "UTM source", type: "text" }],
  sources: ["Ad"],
});
const NAMES = parseNames({
  version: 1,
  locations: { "Main Branch": "Branch A" },
  specialists: {},
  services: { Consult: "General consultation" },
});
const NOW = new Date("2026-10-13T08:00:00Z");

function ctxFor(ports: SanoflowPorts, over: Partial<RunContext> = {}): RunContext {
  return {
    ports,
    config: CONFIG,
    names: NAMES,
    timezone: "Asia/Dubai",
    now: NOW,
    mode: "update",
    ...over,
  };
}
const csv = (headers: string[], rows: string[][]) => parseCsv(toCsv(headers, rows));
const file = (name: string, headers: string[], rows: string[][]) => ({
  file: name,
  csv: csv(headers, rows),
});

// Synthetic people: numbers in the reserved +44 7700 900xxx range only.
const P1 = "+447700900101";
const P2 = "+447700900102";

async function seeded() {
  const ports = new MemoryPorts();
  ports.addContact("c-1", P1);
  ports.addContact("c-2", P2);
  await ports.upsertRef({
    entity: "contact",
    externalId: "SF-C1",
    localTable: "contacts",
    localId: "c-1",
  });
  await runConfig(ctxFor(ports));
  return ports;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe("values", () => {
  it("reads day-first, ISO and month-name dates; rejects impossible ones", () => {
    expect(parseDay("04/03/2026")).toBe("2026-03-04");
    expect(parseDay("04/03/2026", "mdy")).toBe("2026-04-03");
    expect(parseDay("2026-3-4")).toBe("2026-03-04");
    expect(parseDay("4 Mar 2026")).toBe("2026-03-04");
    expect(parseDay("March 4, 2026")).toBe("2026-03-04");
    expect(parseDay("31/02/2026")).toBeNull();
    expect(parseDay("hello")).toBeNull();
  });
  it("reads 12 and 24 hour clocks", () => {
    expect(parseClock("2:05 PM")).toBe("14:05:00");
    expect(parseClock("12:00 am")).toBe("00:00:00");
    expect(parseClock("09:30")).toBe("09:30:00");
    expect(parseClock("2pm")).toBe("14:00:00");
    expect(parseClock("14")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
  });
  it("turns clinic-local times into UTC (Dubai is UTC+4, no DST)", () => {
    expect(parseLocalDateTime("20/10/2026", "10:00", "Asia/Dubai")?.toISOString()).toBe(
      "2026-10-20T06:00:00.000Z",
    );
    expect(parseLocalDateTime("2026-10-20 10:00", null, "Asia/Dubai")?.toISOString()).toBe(
      "2026-10-20T06:00:00.000Z",
    );
    expect(parseLocalDateTime("2026-10-20T10:00:00Z", null, "Asia/Dubai")?.toISOString()).toBe(
      "2026-10-20T10:00:00.000Z",
    );
    expect(parseLocalDateTime("20/10/2026", "nonsense", "Asia/Dubai")).toBeNull();
    expect(parseLocalDateTime("", null, "Asia/Dubai")).toBeNull();
  });
  it("parses money and durations", () => {
    expect(parseMoney("AED 1,250.50")).toBe(1250.5);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("-5")).toBeUndefined();
    expect(parseMoney("abc")).toBeUndefined();
    expect(parseDurationMin("45 min")).toBe(45);
    expect(parseDurationMin("1h")).toBe(60);
    expect(parseDurationMin("1:30")).toBe(90);
    expect(parseDurationMin("soon")).toBeNull();
  });
  it("maps statuses through the config first, then built-in words; unknown stays unknown", () => {
    expect(mapStatus("Appointment booked", CONFIG)).toBe("won");
    expect(mapStatus("closed_lost", CONFIG)).toBe("lost");
    expect(mapStatus("", CONFIG)).toBe("open");
    expect(mapStatus("maybe later", CONFIG)).toBeNull();
    expect(mapLostReason("PRICE", CONFIG)).toBe("Price too high");
    expect(mapLostReason("", CONFIG)).toBe("Not recorded in Sanoflow");
    expect(mapLostReason("x".repeat(900), CONFIG)).toHaveLength(500);
  });
  it("decides what to do with an appointment status", () => {
    expect(mapAppointmentStatus("Booked")).toBe("awaiting");
    expect(mapAppointmentStatus("")).toBe("awaiting");
    expect(mapAppointmentStatus("Confirmed")).toBe("confirmed");
    expect(mapAppointmentStatus("Cancelled by patient")).toBe("skip_cancelled");
    expect(mapAppointmentStatus("No show")).toBe("skip_done");
    expect(mapAppointmentStatus("weird")).toBeNull();
  });
  it("builds Pulse-valid shortcuts and stable ids", () => {
    expect(toShortcut("/Clinic Hours!")).toBe("clinic-hours");
    expect(toShortcut("Café timings")).toBe("cafe-timings");
    expect(toShortcut("مرحبا")).toBeNull();
    expect(toShortcut("a".repeat(60))).toHaveLength(40);
    expect(stableId(["a", "b"])).toBe(stableId([" a", "b "]));
    expect(stableId(["a", "b"])).not.toBe(stableId(["ab", ""]));
  });
});

// ---------------------------------------------------------------------------
// Mapping, config, files
// ---------------------------------------------------------------------------

describe("header mapping", () => {
  it("prefers the specific alias, keeps unknown columns out and reports missing ones", () => {
    const h = mapHeaders("enquiry", [
      "ID",
      "Enquiry ID",
      "Pipeline",
      "Stage",
      "Favourite colour",
      "UTM_Source",
    ]);
    expect(h.mapping["Enquiry ID"]).toBe("id");
    expect(h.mapping["ID"]).toBeNull();
    expect(h.mapping["UTM_Source"]).toBe("utm_source");
    expect(h.unknown).toEqual(["ID", "Favourite colour"]);
    expect(h.missing).toEqual([]);
    expect(mapHeaders("appointment", ["Appointment ID", "Doctor"]).missing).toEqual([
      "contact_id|phone",
      "location",
      "date|start",
    ]);
  });
  it("matches enquiry custom fields by key or label and honours an override file", () => {
    const h = mapHeaders(
      "enquiry",
      ["Enquiry ID", "Pipeline", "Stage", "Referral partner", "Branch"],
      {
        customFields: [{ key: "referral", label: "Referral partner" }],
        override: { Branch: null },
      },
    );
    expect(h.mapping["Referral partner"]).toBe("custom.referral");
    expect(h.mapping.Branch).toBeNull();
  });
});

describe("config files", () => {
  it("rejects unknown keys, duplicate stages and two defaults", () => {
    expect(() => parseConfig({ version: 1, pipelines: [], typo: 1 })).toThrow(/not valid/);
    expect(() =>
      parseConfig({
        version: 1,
        pipelines: [{ name: "A", stages: [{ name: "X" }, { name: "x" }] }],
      }),
    ).toThrow(/listed twice/);
    expect(() =>
      parseConfig({
        version: 1,
        pipelines: [
          { name: "A", is_default: true, stages: [{ name: "X" }] },
          { name: "B", is_default: true, stages: [{ name: "X" }] },
        ],
      }),
    ).toThrow(/default/);
  });
  it("the shipped examples are valid", () => {
    const dir = path.join(process.cwd(), "docs/audit");
    expect(() =>
      parseConfig(
        JSON.parse(fs.readFileSync(path.join(dir, "sanoflow-config.example.json"), "utf8")),
      ),
    ).not.toThrow();
    expect(() =>
      parseNames(
        JSON.parse(fs.readFileSync(path.join(dir, "sanoflow-names.example.json"), "utf8")),
      ),
    ).not.toThrow();
  });
});

describe("file discovery", () => {
  it("assigns each export to one step", () => {
    const { byStep, unknown } = classifyFiles([
      "contacts.csv",
      "enquiries-leads.csv",
      "enquiries-all.csv",
      "enquiry-activity.csv",
      "appointments.csv",
      "tags.csv",
      "labels.csv",
      "conversation-categories.csv",
      "quick-replies.csv",
      "segment-vip.csv",
      "segments-dynamic.csv",
      "notes.txt",
      "random.csv",
    ]);
    expect(byStep.enquiry).toEqual(["enquiries-all.csv", "enquiries-leads.csv"]);
    expect(byStep.enquiry_activity).toEqual(["enquiry-activity.csv"]);
    expect(byStep.segment_member).toEqual(["segment-vip.csv"]);
    expect(byStep.segment_dynamic).toEqual(["segments-dynamic.csv"]);
    expect(byStep.conv_category).toEqual(["conversation-categories.csv"]);
    expect(unknown).toEqual(["random.csv"]);
  });
  it("counts distinct records across overlapping exports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sanoflow-"));
    const H = ["Enquiry ID", "Pipeline", "Stage"];
    fs.writeFileSync(
      path.join(dir, "enquiries-all.csv"),
      toCsv(H, [
        ["E1", "Leads", "New"],
        ["E2", "Leads", "New"],
      ]),
    );
    fs.writeFileSync(path.join(dir, "enquiries-leads.csv"), toCsv(H, [["E1", "Leads", "New"]]));
    fs.writeFileSync(path.join(dir, "contacts.csv"), toCsv(["Phone"], [[P1], [P2]]));
    const { byStep } = classifyFiles(fs.readdirSync(dir));
    expect(sourceCounts(dir, byStep)).toMatchObject({ enquiry: 2, contact: 2, appointment: 0 });
  });
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

describe("config step", () => {
  it("creates pipelines, stages, fields and sources once, and adopts existing ones", async () => {
    const ports = new MemoryPorts();
    ports
      .rows("pipelines")
      .push({ id: "p-existing", org_id: ports.orgId, name: "New patients", is_default: false });
    const first = await runConfig(ctxFor(ports));
    const [pipes, stages, fields, sources] = first;
    expect(pipes.counters).toMatchObject({ read: 1, adopted: 1, created: 0 });
    expect(stages.counters).toMatchObject({ read: 3, created: 3 });
    expect(fields.counters.created).toBe(1);
    expect(sources.counters.created).toBe(1);
    expect(ports.sources).toEqual(["WhatsApp", "Ad"]);
    // the config's lost-reason wording becomes the Settings → Enquiries pick-list
    expect(ports.lostReasons).toEqual(["Price too high"]);

    const again = await runConfig(ctxFor(ports));
    expect(again[0].counters).toMatchObject({ unchanged: 1, created: 0 });
    expect(again[1].counters).toMatchObject({ unchanged: 3, created: 0 });
    expect(again[2].counters).toMatchObject({ adopted: 1, created: 0 });
    expect(ports.rows("stages")).toHaveLength(3);
    for (const r of [...first, ...again]) expect(outcomes(r.counters)).toBe(r.counters.read);
  });
});

describe("enquiries step", () => {
  const H = [
    "Enquiry ID",
    "Contact ID",
    "Phone",
    "Pipeline",
    "Stage",
    "Status",
    "Disqualify Reason",
    "Value",
    "Source",
    "Assignee Email",
    "Location",
    "Created At",
    "UTM Source",
    "Secret column",
  ];
  const rows = [
    [
      "E1",
      "SF-C1",
      "",
      "Leads",
      "In conversation",
      "Open",
      "",
      "AED 300",
      "Ad",
      "agent.one@example.test",
      "Main Branch",
      "01/09/2026 10:00",
      "google",
      "x",
    ],
    [
      "E2",
      "",
      "+44 7700 900102",
      "Leads",
      "Booked",
      "Not interested",
      "",
      "",
      "Walk-in",
      "nobody@example.test",
      "",
      "",
      "",
      "x",
    ],
    ["E3", "", "", "Leads", "Nowhere", "Open", "", "", "", "", "", "", "", "x"],
    [
      "E1",
      "SF-C1",
      "",
      "Leads",
      "In conversation",
      "Open",
      "",
      "AED 300",
      "Ad",
      "",
      "",
      "",
      "",
      "x",
    ],
    ["", "", "", "Leads", "New", "", "", "", "", "", "", "", "", "x"],
  ];

  it("imports, links and accounts for every row; a re-run is a no-op", async () => {
    const ports = await seeded();
    const ctx = ctxFor(ports, {
      config: { ...CONFIG, statuses: { ...CONFIG.statuses, "not interested": "lost" } },
    });
    const run = await runEnquiries(ctx, [file("enquiries-all.csv", H, rows)]);
    expect(run.counters).toMatchObject({
      read: 5,
      created: 2,
      invalid: 2,
      duplicates: 1,
      failed: 0,
    });
    expect(outcomes(run.counters)).toBe(run.counters.read);
    expect(run.unknownHeaders).toEqual(["Secret column"]);
    expect(run.unmatchedNames.stage).toEqual(["Leads / Nowhere"]);
    expect(run.warnings.assignee_not_member).toBe(1);

    const [e1, e2] = ports.rows("enquiries");
    expect(e1).toMatchObject({
      contact_id: "c-1",
      status: "open",
      lost_reason: null,
      est_value: 300,
      assignee_id: "user-1",
      location_id: "loc-1",
      source: "Ad",
      custom: { utm_source: "google" },
      created_at: "2026-09-01T06:00:00.000Z",
    });
    expect(e1.sla_due_at).toBeUndefined(); // history never starts an SLA timer
    expect(e2).toMatchObject({
      contact_id: "c-2",
      status: "lost",
      lost_reason: "Not recorded in Sanoflow",
    });
    expect(e2.closed_at).toBe(NOW.toISOString());
    expect(ports.sources).toEqual(expect.arrayContaining(["Walk-in"]));

    const again = await runEnquiries(ctx, [file("enquiries-all.csv", H, rows)]);
    expect(again.counters).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(ports.rows("enquiries")).toHaveLength(2);
  });

  it("updates a changed stage on re-run, keeps links Pulse made, and --mode=skip changes nothing", async () => {
    const ports = await seeded();
    await runEnquiries(ctxFor(ports), [file("e.csv", H, [rows[0]])]);
    const moved = [...rows[0]];
    moved[4] = "Booked";
    moved[1] = "";
    moved[9] = "";
    const skip = await runEnquiries(ctxFor(ports, { mode: "skip" }), [file("e.csv", H, [moved])]);
    expect(skip.counters.unchanged).toBe(1);
    const upd = await runEnquiries(ctxFor(ports), [file("e.csv", H, [moved])]);
    expect(upd.counters.updated).toBe(1);
    const e = ports.rows("enquiries")[0];
    expect(e.stage_id).toBe(ports.rows("stages").find((s) => s.name === "Booked")!.id);
    expect(e.contact_id).toBe("c-1");
    expect(e.assignee_id).toBe("user-1");
  });

  it("stops before reading rows when a required column is missing", async () => {
    const ports = await seeded();
    const run = await runEnquiries(ctxFor(ports), [
      file("e.csv", ["Pipeline", "Stage"], [["Leads", "New"]]),
    ]);
    expect(run.fatal).toMatch(/id/);
    expect(ports.rows("enquiries")).toHaveLength(0);
  });
});

describe("activity step", () => {
  it("attaches history to imported enquiries without duplicates", async () => {
    const ports = await seeded();
    await runEnquiries(ctxFor(ports), [
      file(
        "e.csv",
        ["Enquiry ID", "Contact ID", "Pipeline", "Stage"],
        [["E1", "SF-C1", "Leads", "New"]],
      ),
    ]);
    const H = ["Enquiry ID", "Activity", "Description", "User", "Date"];
    const rows = [
      ["E1", "Stage changed", "New → Contacted", "Agent One", "02/09/2026 09:15"],
      ["E1", "Stage changed", "New → Contacted", "Agent One", "02/09/2026 09:15"],
      ["E9", "Note", "orphan", "", "02/09/2026"],
      ["E1", "Note", "x", "", "not a date"],
    ];
    const run = await runActivity(ctxFor(ports), [file("enquiry-activity.csv", H, rows)]);
    expect(run.counters).toMatchObject({ read: 4, created: 1, duplicates: 1, invalid: 2 });
    const ev = ports.rows("timeline_events")[0];
    expect(ev).toMatchObject({
      type: ACTIVITY_EVENT_TYPE,
      actor_type: "system",
      contact_id: "c-1",
      at: "2026-09-02T05:15:00.000Z",
      payload: { source: "sanoflow", kind: "Stage changed", by: "Agent One" },
    });
    const again = await runActivity(ctxFor(ports), [file("enquiry-activity.csv", H, rows)]);
    expect(again.counters.created).toBe(0);
    expect(again.counters.unchanged).toBe(1);
    expect(ports.rows("timeline_events")).toHaveLength(1);
  });
});

describe("appointments step", () => {
  const H = [
    "Appointment ID",
    "Contact ID",
    "Phone",
    "Location",
    "Specialist",
    "Service",
    "Date",
    "Start Time",
    "End Time",
    "Status",
    "Notes",
  ];
  const row = (
    id: string,
    date: string,
    start: string,
    extra: Partial<Record<string, string>> = {},
  ) => [
    id,
    extra.contact ?? "SF-C1",
    extra.phone ?? "",
    extra.location ?? "Main Branch",
    extra.specialist ?? "Dr Example One",
    extra.service ?? "Consult",
    date,
    start,
    extra.end ?? "",
    extra.status ?? "Booked",
    "",
  ];

  it("books future visits through the guarded path, skips the past and cancelled, routes clashes to review", async () => {
    const ports = await seeded();
    const rows = [
      row("A1", "20/10/2026", "10:00"),
      row("A2", "01/10/2026", "10:00"), // past
      row("A3", "21/10/2026", "10:00", { status: "Cancelled" }),
      row("A4", "20/10/2026", "10:10", { contact: "", phone: P2 }), // overlaps A1 (20 min service)
      row("A5", "22/10/2026", "11:00", { contact: "", phone: "+447700900999" }), // unknown patient
      row("A6", "22/10/2026", "11:00", { specialist: "Dr Nobody" }),
      row("A7", "23/10/2026", "09:00", { end: "09:45", status: "Confirmed" }),
    ];
    const run = await runAppointments(ctxFor(ports), [file("appointments.csv", H, rows)]);
    expect(run.counters).toMatchObject({ read: 7, created: 2, skipped: 2, review: 2, invalid: 1 });
    expect(outcomes(run.counters)).toBe(run.counters.read);
    expect(run.skippedByDesign).toBe(true);
    const [a1, a7] = ports.rows("appointments");
    expect(a1).toMatchObject({
      starts_at: "2026-10-20T06:00:00.000Z",
      ends_at: "2026-10-20T06:20:00.000Z", // service duration
      status: "awaiting",
      source: "import",
      department_id: "dep-2",
    });
    expect(a7).toMatchObject({ ends_at: "2026-10-23T05:45:00.000Z", status: "confirmed" });
    expect(ports.reviews.get("appointment|A4")?.reason).toBe("appointment_slot_taken");
    expect(ports.reviews.get("appointment|A5")?.reason).toBe("appointment_contact_not_found");
    expect(run.unmatchedNames.specialist).toEqual(["Dr Nobody"]);
  });

  it("adopts a booking that already exists (e.g. from Unite) and resolves the review on re-run", async () => {
    const ports = await seeded();
    ports.busy.push({
      specialistId: "spec-1",
      start: Date.parse("2026-10-20T06:00:00Z"),
      end: Date.parse("2026-10-20T07:00:00Z"),
    });
    const rows = [row("A1", "20/10/2026", "10:00")];
    const first = await runAppointments(ctxFor(ports), [file("a.csv", H, rows)]);
    expect(first.counters.review).toBe(1);
    // staff book it by hand, then re-run
    ports.busy = [];
    ports.rows("appointments").push({
      id: "manual-1",
      org_id: ports.orgId,
      contact_id: "c-1",
      specialist_id: "spec-1",
      starts_at: "2026-10-20T06:00:00+00:00",
      ends_at: "2026-10-20T06:30:00+00:00",
      status: "confirmed",
    });
    const second = await runAppointments(ctxFor(ports), [file("a.csv", H, rows)]);
    expect(second.counters.adopted).toBe(1);
    expect(ports.reviews.get("appointment|A1")?.status).toBe("resolved");
    const third = await runAppointments(ctxFor(ports), [file("a.csv", H, rows)]);
    expect(third.counters.unchanged).toBe(1);
    expect(ports.rows("appointments")).toHaveLength(1);
  });

  it("a dry run predicts clashes inside the file and writes nothing", async () => {
    const real = await seeded();
    const dry = new DryRunPorts(real, async () => false);
    const rows = [
      row("A1", "20/10/2026", "10:00"),
      row("A2", "20/10/2026", "10:05", { contact: "", phone: P2 }),
    ];
    const run = await runAppointments(ctxFor(dry), [file("a.csv", H, rows)]);
    expect(run.counters).toMatchObject({ created: 1, review: 1 });
    expect(real.rows("appointments")).toHaveLength(0);
    expect(real.reviews.size).toBe(0);
    expect(real.refs.has("appointment|A1")).toBe(false);
  });
});

describe("lists and segments", () => {
  it("imports tags, labels and categories once; adopts by name", async () => {
    const ports = new MemoryPorts();
    ports.rows("tags").push({ id: "t-old", org_id: ports.orgId, name: "VIP", scope: "contact" });
    const tags = await runList(
      ctxFor(ports),
      "tag",
      csv(
        ["Tag Name", "Colour"],
        [
          ["VIP", "red"],
          ["Recall", "green"],
          ["recall", ""],
          ["", "blue"],
        ],
      ),
      "tags.csv",
    );
    expect(tags.counters).toMatchObject({
      read: 4,
      adopted: 1,
      created: 1,
      duplicates: 1,
      invalid: 1,
    });
    expect(ports.rows("tags").find((t) => t.name === "Recall")).toMatchObject({
      scope: "contact",
      color: "green",
    });
    const labels = await runList(ctxFor(ports), "label", csv(["Label"], [["VIP"]]), "labels.csv");
    expect(labels.counters.created).toBe(1); // a conversation label is a different scope
    const again = await runList(
      ctxFor(ports),
      "tag",
      csv(["Tag Name"], [["VIP"], ["Recall"]]),
      "tags.csv",
    );
    expect(again.counters.unchanged).toBe(2);
  });

  it("quick replies get valid, unique shortcuts and update on re-run", async () => {
    const ports = new MemoryPorts();
    ports
      .rows("quick_replies")
      .push({ id: "q-old", org_id: ports.orgId, shortcut: "hours", text: "Pulse text" });
    const H = ["ID", "Name", "Message", "Message Arabic"];
    const run = await runQuickReplies(
      ctxFor(ports),
      csv(H, [
        ["Q1", "Hours", "We open at 9.", "نفتح الساعة ٩"],
        ["Q2", "", "no name", ""],
      ]),
      "quick-replies.csv",
    );
    expect(run.counters).toMatchObject({ created: 1, invalid: 1 });
    expect(ports.rows("quick_replies")[1]).toMatchObject({
      shortcut: "hours-2",
      label: "Hours",
      text_ar: "نفتح الساعة ٩",
    });
    expect(run.warnings.shortcut_renamed).toBe(1);
    const upd = await runQuickReplies(
      ctxFor(ports),
      csv(H, [["Q1", "Hours", "We open at 8.", ""]]),
      "quick-replies.csv",
    );
    expect(upd.counters.updated).toBe(1);
    expect(ports.rows("quick_replies")[1]).toMatchObject({
      shortcut: "hours-2",
      text: "We open at 8.",
      text_ar: null,
    });
  });

  it("static segments keep their members; dynamic ones are only reported", async () => {
    const ports = await seeded();
    const res = await runStaticSegments(ctxFor(ports), [
      file(
        "segment-vip-patients.csv",
        ["Contact ID", "Phone"],
        [
          ["SF-C1", ""],
          ["", P2],
          ["", "+447700900998"],
        ],
      ),
    ]);
    expect(res.segments.counters.created).toBe(1);
    expect(res.members.counters).toMatchObject({ read: 3, created: 2, invalid: 1 });
    const seg = ports.rows("segments")[0];
    expect(seg).toMatchObject({ name: "vip patients", kind: "static", member_count: 2 });
    const again = await runStaticSegments(ctxFor(ports), [
      file(
        "segment-vip-patients.csv",
        ["Contact ID", "Phone"],
        [
          ["SF-C1", ""],
          ["", P2],
        ],
      ),
    ]);
    expect(again.members.counters.unchanged).toBe(2);
    expect(again.segments.counters.unchanged).toBe(1);

    const dyn = readDynamicSegments(
      csv(
        ["Segment Name", "Filter"],
        [
          ["Lapsed", "last_visit > 180d"],
          ["", "x"],
        ],
      ),
      "segments-dynamic.csv",
    );
    expect(dyn.segments).toEqual([{ name: "Lapsed", filter: "last_visit > 180d" }]);
    expect(dyn.run.counters).toMatchObject({ skipped: 1, invalid: 1 });
  });
});

// ---------------------------------------------------------------------------
// Report, reconcile, preflight
// ---------------------------------------------------------------------------

describe("report and sign-off wiring", () => {
  it("writes counts and codes, never the patient values it read", async () => {
    const ports = await seeded();
    const run = await runEnquiries(ctxFor(ports), [
      file(
        "e.csv",
        ["Enquiry ID", "Phone", "Pipeline", "Stage", "Notes field"],
        [["E1", P1, "Leads", "Nowhere", "private text"]],
      ),
    ]);
    const md = renderReport({
      orgSlug: "demo",
      at: NOW.toISOString(),
      dryRun: false,
      dir: "exports",
      runs: [run],
      dynamicSegments: [],
      notes: [],
    });
    expect(md).not.toContain(P1);
    expect(md).not.toContain("private text");
    expect(md).toContain("unknown_stage");
    expect(findPii(md)).toEqual([]);
  });

  it("summaries let reconcile account for past appointments and dry-run steps", async () => {
    const ports = await seeded();
    const run = await runAppointments(ctxFor(ports), [
      file(
        "a.csv",
        ["Appointment ID", "Contact ID", "Location", "Specialist", "Date", "Start Time"],
        [
          ["A1", "SF-C1", "Main Branch", "Dr Example One", "20/10/2026", "10:00"],
          ["A2", "SF-C1", "Main Branch", "Dr Example One", "01/01/2026", "10:00"],
        ],
      ),
    ]);
    const [summary] = toSummaries([run], { dryRun: false, at: NOW.toISOString() });
    expect(summary).toMatchObject({
      entity: "appointment",
      skippedByDesign: true,
      counters: { read: 2, created: 1, skipped: 1 },
    });
    const db: DbSnapshot = {
      refs: { "sanoflow/appointment": 1 },
      reviews_open: {},
      reviews_dismissed: {},
      reviews_resolved: {},
      orphan_refs: 0,
      orphan_refs_other: 0,
      refs_to_deleted_contacts: 0,
      contacts_live: 2,
      contacts_imported: 2,
      contacts_without_identifier: 0,
      duplicate_alternate_phones: 0,
      alternate_phone_is_other_primary: 0,
      merge_chains_over_1: 0,
    };
    const res = reconcile(
      [{ source: "sanoflow", entity: "appointment", label: "Appointments", total: 2 }],
      db,
      [summary],
      {
        freezeAt: "2026-01-01T00:00:00Z",
      },
    );
    expect(res.rows[0].unaccounted).toBe(0);
    expect(res.checks.find((c) => c.id === "orphan-refs-other")?.ok).toBe(true);

    run.dryRun = true;
    expect(toSummaries([run], { dryRun: false, at: NOW.toISOString() })[0].dryRun).toBe(true);
  });

  it("preflight warns until Sanoflow enquiries and appointments have come over", () => {
    const base = {
      openReviews: 0,
      contactsLive: 10,
      loadTestContacts: 0,
      adminMembers: 1,
      outboundFailed24h: 0,
    };
    const warnIds = (d: Parameters<typeof evaluateData>[0]) =>
      evaluateData(d)
        .filter((c) => !c.ok)
        .map((c) => c.id);
    expect(warnIds(base)).toEqual([]);
    expect(warnIds({ ...base, sanoflowRefs: { contact: 10 } })).toEqual([
      "data:sanoflow-enquiries",
      "data:sanoflow-appointments",
    ]);
    expect(
      warnIds({
        ...base,
        sanoflowRefs: { contact: 10, enquiry: 3, appointment: 1 },
        orphanRefsOther: 2,
      }),
    ).toEqual(["data:orphan-refs"]);
  });
});

// ---------------------------------------------------------------------------
// Follow-ups: reminder hold, review actions, enquiry tags, campaign history
// ---------------------------------------------------------------------------

describe("follow-up rules", () => {
  it("holds reminders for imported appointments until the switch is on", () => {
    expect(remindersAllowed("import", { import_reminders_enabled: false })).toBe(false);
    expect(remindersAllowed("import", { import_reminders_enabled: true })).toBe(true);
    for (const s of ["portal", "unite", "bot", null, undefined])
      expect(remindersAllowed(s, { import_reminders_enabled: false })).toBe(true);
  });
  it("Sanoflow reviews: contacts can be linked, everything can be dismissed", () => {
    expect(sanoflowReviewActions("contact")).toEqual(["link", "dismiss"]);
    expect(sanoflowReviewActions("appointment")).toEqual(["dismiss"]);
  });
  it("maps campaign statuses and keeps the furthest one", () => {
    expect(mapRecipientStatus("Delivered")).toBe("delivered");
    expect(mapRecipientStatus("seen")).toBe("read");
    expect(mapRecipientStatus("Not delivered")).toBe("failed");
    expect(mapRecipientStatus("weird")).toBe("other");
    expect(statusRank("replied")).toBeGreaterThan(statusRank("read"));
    expect(statusRank("sent")).toBeGreaterThan(statusRank("failed"));
    expect(campaignNameFromFile("campaign-report-Ramadan_offer.csv")).toBe("Ramadan offer");
    expect(
      classifyFiles(["campaign-report-a.csv", "campaigns-history.csv"]).byStep.campaign_recipient,
    ).toEqual(["campaign-report-a.csv", "campaigns-history.csv"]);
  });
  it("a dismissed appointment review is never reopened by a later run", async () => {
    const ports = await seeded();
    ports.busy.push({
      specialistId: "spec-1",
      start: Date.parse("2026-10-20T06:00:00Z"),
      end: Date.parse("2026-10-20T07:00:00Z"),
    });
    const H = ["Appointment ID", "Contact ID", "Location", "Specialist", "Date", "Start Time"];
    const rows = [["A1", "SF-C1", "Main Branch", "Dr Example One", "20/10/2026", "10:00"]];
    await runAppointments(ctxFor(ports), [file("a.csv", H, rows)]);
    ports.reviews.get("appointment|A1")!.status = "dismissed";
    await runAppointments(ctxFor(ports), [file("a.csv", H, rows)]);
    expect(ports.reviews.get("appointment|A1")?.status).toBe("dismissed");
  });
});

describe("enquiry tags from the export", () => {
  it("creates enquiry-scoped tags once and links them; re-runs add nothing twice", async () => {
    const ports = await seeded();
    ports.rows("tags").push({ id: "t-c", org_id: ports.orgId, name: "VIP", scope: "contact" });
    const H = ["Enquiry ID", "Contact ID", "Pipeline", "Stage", "Tags"];
    const rows = [
      ["E1", "SF-C1", "Leads", "New", "VIP; Ramadan, vip"],
      ["E2", "SF-C1", "Leads", "New", "Ramadan"],
    ];
    const run = await runEnquiries(ctxFor(ports), [file("enquiries.csv", H, rows)]);
    expect(run.counters.created).toBe(2);
    const tags = ports.rows("tags").filter((t) => t.scope === "enquiry");
    expect(tags.map((t) => t.name).sort()).toEqual(["Ramadan", "VIP"]); // contact tag "VIP" is not reused
    expect(ports.enquiryTags.size).toBe(3);
    await runEnquiries(ctxFor(ports), [file("enquiries.csv", H, rows)]);
    expect(ports.rows("tags").filter((t) => t.scope === "enquiry")).toHaveLength(2);
    expect(ports.enquiryTags.size).toBe(3);
  });
});

describe("campaign history step", () => {
  const H = ["Contact ID", "Phone", "Template Name", "Status", "Sent At", "Read At"];
  it("archives totals from every row, keeps matched patients only, and collapses retry rounds", async () => {
    const ports = await seeded();
    const res = await runCampaignHistory(ctxFor(ports), [
      file("campaign-report-Ramadan offer.csv", H, [
        ["SF-C1", "", "ramadan_v2", "Sent", "01/03/2026 09:00", ""],
        ["SF-C1", "", "ramadan_v2", "Read", "01/03/2026 09:00", "01/03/2026 10:00"], // retry row
        ["", P2, "ramadan_v2", "Failed", "01/03/2026 09:01", ""],
        ["", "+447700900997", "ramadan_v2", "Delivered", "01/03/2026 09:02", ""], // not in Pulse
      ]),
    ]);
    expect(res.campaigns.counters).toMatchObject({ read: 1, created: 1 });
    expect(res.recipients.counters).toMatchObject({
      read: 4,
      duplicates: 1,
      created: 2,
      invalid: 1,
    });
    expect(outcomes(res.recipients.counters)).toBe(4);
    const [archive] = ports.rows("campaign_archive");
    expect(archive).toMatchObject({
      source: "sanoflow",
      name: "Ramadan offer",
      template_name: "ramadan_v2",
      sent_at: "2026-03-01T05:00:00.000Z",
      totals: { recipients: 3, read: 1, failed: 1, delivered: 1 },
    });
    const c1 = ports.rows("campaign_archive_recipients").find((r) => r.contact_id === "c-1");
    expect(c1).toMatchObject({ status: "read", read_at: "2026-03-01T06:00:00.000Z" });
    expect(JSON.stringify(ports.rows("campaign_archive_recipients"))).not.toContain("+44");

    const again = await runCampaignHistory(ctxFor(ports), [
      file("campaign-report-Ramadan offer.csv", H, [
        ["SF-C1", "", "ramadan_v2", "Read", "01/03/2026 09:00", "01/03/2026 10:00"],
        ["", P2, "ramadan_v2", "Replied", "01/03/2026 09:01", ""], // a later export knows more
      ]),
    ]);
    expect(again.campaigns.counters.updated).toBe(1); // totals changed
    expect(again.recipients.counters).toMatchObject({ unchanged: 1, updated: 1 });
    expect(ports.rows("campaign_archive")).toHaveLength(1);
    expect(
      ports.rows("campaign_archive_recipients").find((r) => r.contact_id === "c-2")?.status,
    ).toBe("replied");
  });
});
