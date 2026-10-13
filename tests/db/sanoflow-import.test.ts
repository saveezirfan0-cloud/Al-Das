/**
 * Phase 20a: the Sanoflow importers against the real schema. Config, lists, segments, enquiries,
 * activity and future appointments write through the same ports the CLI uses (over raw pg here):
 * column names, check constraints, triggers, book_appointment's overlap guard and source 'import',
 * idempotent re-runs, org isolation and the reconcile snapshot. Synthetic data only.
 * Runs only with TEST_DATABASE_URL.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCsv, toCsv } from "@/lib/csv";

import { parseConfig, parseNames } from "../../scripts/import/sanoflow/config";
import type { RunContext } from "../../scripts/import/sanoflow/run";
import { outcomes } from "../../scripts/import/sanoflow/run";
import { runActivity } from "../../scripts/import/sanoflow/run-activity";
import { runAppointments } from "../../scripts/import/sanoflow/run-appointments";
import { runCampaignHistory } from "../../scripts/import/sanoflow/run-campaigns";
import { runConfig } from "../../scripts/import/sanoflow/run-config";
import { runEnquiries } from "../../scripts/import/sanoflow/run-enquiries";
import { runList, runQuickReplies } from "../../scripts/import/sanoflow/run-lists";
import { runStaticSegments } from "../../scripts/import/sanoflow/run-segments";
import { asUser, count, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";
import { PgSanoflowPorts, pgTypes } from "./pg-store";

const CONFIG = parseConfig({
  version: 1,
  pipelines: [
    {
      name: "New patients",
      sanoflow_name: "Leads",
      stages: [{ name: "New" }, { name: "Booked", color: "green" }],
    },
  ],
  statuses: { "Not interested": "lost" },
  enquiry_custom_fields: [{ key: "utm_source", label: "UTM source", type: "text" }],
  sources: ["Ad"],
});
const NAMES = parseNames({ version: 1, locations: {}, specialists: {}, services: {} });
const NOW = new Date("2026-10-13T08:00:00Z");
const f = (file: string, headers: string[], rows: string[][]) => ({
  file,
  csv: parseCsv(toCsv(headers, rows)),
});

describe.skipIf(!TEST_DATABASE_URL)("Sanoflow importers against the real schema", () => {
  let c: pg.Client;
  let orgA: string;
  let orgB: string;
  let ports: PgSanoflowPorts;
  let ctx: RunContext;
  let contactA: string;
  let specialist: string;
  let ownerId: string;
  let bobId: string;

  beforeAll(async () => {
    c = new pg.Client({ connectionString: TEST_DATABASE_URL, types: pgTypes });
    await c.connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner.sanoflow@example.test");
    await c.query("update public.profiles set email = $1 where id = $2", [
      "owner.sanoflow@example.test",
      owner,
    ]);
    orgA = await createOrg(c, "Org A", "org-a-sano", owner);
    ownerId = owner;
    bobId = await createAuthUser(c, "bob.sanoflow@example.test");
    orgB = await createOrg(c, "Org B", "org-b-sano", bobId);
    const ins = async (sql: string, params: unknown[]) =>
      (await c.query(sql, params)).rows[0].id as string;
    contactA = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164, source) values ($1,'Layla Demo-01','+447700900201','import_sanoflow') returning id",
      [orgA],
    );
    await ins(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1,'Omar Demo-02','+447700900202') returning id",
      [orgA],
    );
    const loc = await ins(
      "insert into public.locations (org_id, name) values ($1,'Branch A') returning id",
      [orgA],
    );
    specialist = await ins(
      "insert into public.specialists (org_id, name) values ($1,'Dr Example One') returning id",
      [orgA],
    );
    await c.query(
      "insert into public.specialist_locations (org_id, specialist_id, location_id) values ($1,$2,$3)",
      [orgA, specialist, loc],
    );
    await c.query(
      "insert into public.services (org_id, name, duration_min) values ($1,'General consultation', 20)",
      [orgA],
    );
    ports = new PgSanoflowPorts(c, orgA);
    await ports.upsertRef({
      entity: "contact",
      externalId: "SF-C1",
      localTable: "contacts",
      localId: contactA,
    });
    ctx = { ports, config: CONFIG, names: NAMES, timezone: "Asia/Dubai", now: NOW, mode: "update" };
  });

  afterAll(async () => {
    await c?.end();
  });

  it("config, lists and quick replies satisfy the schema and re-run cleanly", async () => {
    const runs = await runConfig(ctx);
    for (const r of runs)
      expect([r.label, r.counters.failed, r.problems]).toEqual([r.label, 0, []]);
    expect(await count(c, "select 1 from public.stages where org_id=$1", [orgA])).toBe(2);
    expect(
      await count(c, "select 1 from public.custom_fields where org_id=$1 and entity='enquiry'", [
        orgA,
      ]),
    ).toBe(1);
    const again = await runConfig(ctx);
    expect(again.every((r) => r.counters.created === 0 && r.counters.failed === 0)).toBe(true);

    const tags = await runList(
      ctx,
      "tag",
      parseCsv(toCsv(["Tag"], [["VIP"], ["Recall"]])),
      "tags.csv",
    );
    const labels = await runList(ctx, "label", parseCsv(toCsv(["Label"], [["VIP"]])), "labels.csv");
    const cats = await runList(
      ctx,
      "conv_category",
      parseCsv(toCsv(["Category"], [["Booking"]])),
      "categories.csv",
    );
    const qr = await runQuickReplies(
      ctx,
      parseCsv(toCsv(["ID", "Name", "Message"], [["Q1", "Opening hours", "We open at 9."]])),
      "quick-replies.csv",
    );
    for (const r of [tags, labels, cats, qr])
      expect(r.counters).toMatchObject({ failed: 0, invalid: 0 });
    expect(qr.counters.created).toBe(1);
    const { rows } = await c.query("select shortcut from public.quick_replies where org_id=$1", [
      orgA,
    ]);
    expect(rows[0].shortcut).toBe("opening-hours");
  });

  it("enquiries and their activity land with valid statuses, links and history; nothing leaks to org B", async () => {
    const H = [
      "Enquiry ID",
      "Contact ID",
      "Phone",
      "Pipeline",
      "Stage",
      "Status",
      "Disqualify Reason",
      "Value",
      "Assignee Email",
      "Created At",
      "UTM Source",
    ];
    const rows = [
      [
        "E1",
        "SF-C1",
        "",
        "Leads",
        "New",
        "Open",
        "",
        "250",
        "owner.sanoflow@example.test",
        "01/09/2026 10:00",
        "google",
      ],
      ["E2", "", "+447700900202", "Leads", "Booked", "Not interested", "too far", "", "", "", ""],
    ];
    const run = await runEnquiries(ctx, [f("enquiries-all.csv", H, rows)]);
    expect(run.counters).toMatchObject({ read: 2, created: 2, failed: 0 });
    const { rows: e } = await c.query(
      "select number, status, lost_reason, closed_at, assignee_id, custom, created_at, sla_due_at, contact_id from public.enquiries where org_id=$1 order by number",
      [orgA],
    );
    expect(e[0]).toMatchObject({
      status: "open",
      lost_reason: null,
      closed_at: null,
      custom: { utm_source: "google" },
      sla_due_at: null,
      contact_id: contactA,
    });
    expect(e[0].assignee_id).not.toBeNull();
    expect(e[0].created_at.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    expect(e[1]).toMatchObject({ status: "lost", lost_reason: "too far" });
    expect(e[1].closed_at).not.toBeNull();
    expect(e.map((x) => x.number)).toEqual([1, 2]);

    const again = await runEnquiries(ctx, [f("enquiries-all.csv", H, rows)]);
    expect(again.counters).toMatchObject({ created: 0, unchanged: 2, failed: 0 });

    const act = await runActivity(ctx, [
      f(
        "enquiry-activity.csv",
        ["Enquiry ID", "Activity", "Description", "Date"],
        [
          ["E1", "Note", "Called back", "02/09/2026 09:00"],
          ["E2", "Status", "Lost", "03/09/2026 09:00"],
        ],
      ),
    ]);
    expect(act.counters).toMatchObject({ created: 2, failed: 0 });
    // E2's patient came from the phone match; activity sits on the enquiry and that patient
    expect(
      await count(
        c,
        "select 1 from public.timeline_events where org_id=$1 and type='import.sanoflow_activity' and enquiry_id is not null",
        [orgA],
      ),
    ).toBe(2);
    expect(await count(c, "select 1 from public.enquiries where org_id=$1", [orgB])).toBe(0);
  });

  it("future appointments go through book_appointment with source 'import'; clashes go to review", async () => {
    const H = [
      "Appointment ID",
      "Contact ID",
      "Phone",
      "Location",
      "Specialist",
      "Service",
      "Date",
      "Start Time",
      "Status",
    ];
    const rows = [
      [
        "A1",
        "SF-C1",
        "",
        "Branch A",
        "Dr Example One",
        "General consultation",
        "20/10/2026",
        "10:00",
        "Booked",
      ],
      [
        "A2",
        "",
        "+447700900202",
        "Branch A",
        "Dr Example One",
        "",
        "20/10/2026",
        "10:10",
        "Booked",
      ],
      ["A3", "SF-C1", "", "Branch A", "Dr Example One", "", "01/01/2026", "10:00", "Booked"],
    ];
    const run = await runAppointments(ctx, [f("appointments.csv", H, rows)]);
    expect(run.counters).toMatchObject({ read: 3, created: 1, review: 1, skipped: 1, failed: 0 });
    expect(outcomes(run.counters)).toBe(3);
    const { rows: a } = await c.query(
      "select source, status, starts_at, ends_at, notify_early, created_by from public.appointments where org_id=$1",
      [orgA],
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      source: "import",
      status: "awaiting",
      notify_early: false,
      created_by: null,
    });
    expect(a[0].starts_at.toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(a[0].ends_at.toISOString()).toBe("2026-10-20T06:20:00.000Z");
    expect(
      await count(
        c,
        "select 1 from public.sync_reviews where org_id=$1 and source='sanoflow' and entity='appointment' and status='open'",
        [orgA],
      ),
    ).toBe(1);
    const again = await runAppointments(ctx, [f("appointments.csv", H, rows)]);
    expect(again.counters).toMatchObject({ created: 0, unchanged: 1, review: 1 });
    expect(await count(c, "select 1 from public.appointments where org_id=$1", [orgA])).toBe(1);
  });

  it("static segments and the reconcile snapshot (orphan refs other than contacts)", async () => {
    const res = await runStaticSegments(ctx, [
      f(
        "segment-vip.csv",
        ["Contact ID", "Phone"],
        [
          ["SF-C1", ""],
          ["", "+447700900202"],
        ],
      ),
    ]);
    expect(res.members.counters).toMatchObject({ created: 2, failed: 0 });
    const { rows } = await c.query(
      "select kind, member_count from public.segments where org_id=$1",
      [orgA],
    );
    expect(rows[0]).toMatchObject({ kind: "static", member_count: 2 });

    const snap = async () =>
      (await c.query("select public.reconcile_snapshot($1) as s", [orgA])).rows[0].s as {
        refs: Record<string, number>;
        orphan_refs_other: number;
      };
    const before = await snap();
    expect(before.refs).toMatchObject({
      "sanoflow/enquiry": 2,
      "sanoflow/appointment": 1,
      "sanoflow/segment_member": 2,
    });
    expect(before.orphan_refs_other).toBe(0);
    await c.query("delete from public.quick_replies where org_id=$1", [orgA]);
    expect((await snap()).orphan_refs_other).toBe(1);
  });

  it("enquiry tags: imported with scope 'enquiry', a contact tag is refused, org B sees none", async () => {
    const run = await runEnquiries(ctx, [
      f(
        "enquiries-tags.csv",
        ["Enquiry ID", "Contact ID", "Pipeline", "Stage", "Tags"],
        [["E9", "SF-C1", "Leads", "New", "Ramadan; VIP"]],
      ),
    ]);
    expect(run.counters).toMatchObject({ created: 1, failed: 0 });
    expect(
      await count(
        c,
        "select 1 from public.enquiry_tags et join public.tags t on t.id = et.tag_id where et.org_id = $1 and t.scope = 'enquiry'",
        [orgA],
      ),
    ).toBe(2);
    const { rows: ct } = await c.query(
      "insert into public.tags (org_id, name, scope) values ($1, 'Contact only', 'contact') returning id",
      [orgA],
    );
    const { rows: enq } = await c.query(
      "select id from public.enquiries where org_id = $1 limit 1",
      [orgA],
    );
    await expect(
      c.query("insert into public.enquiry_tags (org_id, enquiry_id, tag_id) values ($1, $2, $3)", [
        orgA,
        enq[0].id,
        ct[0].id,
      ]),
    ).rejects.toThrow(/not an enquiry tag/);
    await asUser(c, ownerId, async () => {
      expect(await count(c, "select 1 from public.enquiry_tags where org_id = $1", [orgA])).toBe(2);
    });
    await asUser(c, bobId, async () => {
      expect(await count(c, "select 1 from public.enquiry_tags")).toBe(0);
      expect(await count(c, "select 1 from public.campaign_archive")).toBe(0);
    });
  });

  it("campaign history lands in the archive; erase and merge follow the patient", async () => {
    const H = ["Contact ID", "Phone", "Status", "Sent At"];
    const res = await runCampaignHistory(ctx, [
      f("campaign-report-Spring.csv", H, [
        ["SF-C1", "", "Read", "01/03/2026 09:00"],
        ["", "+447700900202", "Delivered", "01/03/2026 09:00"],
      ]),
    ]);
    expect(res.campaigns.counters).toMatchObject({ created: 1, failed: 0 });
    expect(res.recipients.counters).toMatchObject({ created: 2, failed: 0 });
    const { rows: arch } = await c.query(
      "select totals, sent_at from public.campaign_archive where org_id = $1",
      [orgA],
    );
    expect(arch[0].totals).toEqual({ recipients: 2, read: 1, delivered: 1 });

    // merge: Omar Demo-02 into Layla Demo-01; Layla already has a row for this campaign, so Omar's goes
    const { rows: omar } = await c.query(
      "select id from public.contacts where org_id = $1 and phone_e164 = '+447700900202'",
      [orgA],
    );
    await c.query(
      "update public.contacts set merged_into_id = $2, deleted_at = now() where id = $1",
      [omar[0].id, contactA],
    );
    expect(
      await count(c, "select 1 from public.campaign_archive_recipients where org_id = $1", [orgA]),
    ).toBe(1);
    expect(
      await count(c, "select 1 from public.campaign_archive_recipients where contact_id = $1", [
        contactA,
      ]),
    ).toBe(1);

    // erase: the patient's archived rows and their enquiries' tags go
    await c.query("set role service_role");
    await c.query("select public.erase_contact($1, $2, null)", [orgA, contactA]);
    await c.query("reset role");
    expect(
      await count(c, "select 1 from public.campaign_archive_recipients where contact_id = $1", [
        contactA,
      ]),
    ).toBe(0);
    expect(
      await count(
        c,
        "select 1 from public.enquiry_tags et join public.enquiries e on e.id = et.enquiry_id where e.contact_id = $1",
        [contactA],
      ),
    ).toBe(0);
    const snap = (await c.query("select public.reconcile_snapshot($1) as s", [orgA])).rows[0].s;
    expect(snap.orphan_refs_other).toBeGreaterThan(0); // the recipient refs now point at removed rows
  });
});
