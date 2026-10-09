/**
 * The clinical Airtable importers against the real Phase 6 schema (plain Postgres, no PostgREST).
 * The earlier mappers were only ever checked against Airtable field ids, so every column and enum
 * slug they write is verified here against `information_schema` and the live enum types, then the
 * whole chain is run for real: rows, fail-closed classes, open vs closed follow-ups, dedupe keys,
 * terminal message-log statuses, idempotent re-runs, dry-run isolation and staff-work protection.
 * Synthetic records only. Runs only with TEST_DATABASE_URL.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runImport } from "../../scripts/import/orchestrator";
import { entityMap, REGISTRY } from "../../scripts/import/registry";
import type { AirtableSource } from "../../scripts/import/results";
import {
  mapCallStatus,
  mapFeedbackStage,
  mapOutcome,
  mapPriority,
  mapTriggerCategory,
} from "../../scripts/import/tables/clinical";
import { CLINICAL_CHAIN, CLINICAL_DATA } from "../fixtures/airtable-clinical";
import {
  asServiceRole,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";
import { PgStore, pgTypes } from "./pg-store";

const source = (): AirtableSource => ({
  async tableFields() {
    return [];
  },
  async *records(base, table) {
    for (const r of CLINICAL_DATA[`${base}.${table}`] ?? []) yield r;
  },
});

// patients are imported by their own mappers (covered elsewhere); this chain starts from refs
const CHAIN = CLINICAL_CHAIN.filter((k) => !k.endsWith("patients"));
const CLINICAL_TABLES = [
  "specialists",
  "visits",
  "prescriptions",
  "clinical_followups",
  "clinical_feedback",
  "clinical_message_log",
  "clinical_call_scripts",
];

describe.skipIf(!TEST_DATABASE_URL)("clinical Airtable importers against the real schema", () => {
  let c: pg.Client;
  let orgA: string;
  let orgB: string;
  let store: PgStore;
  let contactId: string;
  const noop = { dryRun: false, includeTest: false } as const;

  const run = (dryRun: boolean, s: PgStore = store) =>
    asServiceRole(c, () =>
      runImport({ store: s, source: source() }, { ...noop, dryRun, only: CHAIN }),
    );
  const rowCounts = async () =>
    JSON.stringify(
      (
        await c.query(
          `select ${CLINICAL_TABLES.map((t) => `(select count(*) from public.${t}) as ${t}`).join(", ")},
                  (select count(*) from external_refs) as refs`,
        )
      ).rows,
    );
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

  beforeAll(async () => {
    c = new pg.Client({ connectionString: TEST_DATABASE_URL, types: pgTypes });
    await c.connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner@example.test");
    const ownerB = await createAuthUser(c, "ownerb@example.test");
    orgA = await createOrg(c, "Org A", "org-a", owner);
    orgB = await createOrg(c, "Org B", "org-b", ownerB);
    store = new PgStore(c, orgA);

    await asServiceRole(c, async () => {
      for (const o of [orgA, orgB]) await c.query("select public.seed_clinical_settings($1)", [o]);
      contactId = (
        await one(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1,'Test','+971500000011') returning id",
          [orgA],
        )
      ).id;
      // the patient chain would have recorded these; the clinical tables resolve links through them
      const entities = entityMap();
      for (const k of ["unite.patients", "acute.patients"])
        await store.upsertRef({
          entity: entities.get(k)!,
          externalId: "recP1",
          localTable: "contacts",
          localId: contactId,
        });
      await c.query("insert into public.teams (org_id, name) values ($1,'Nurse')", [orgA]);
      await c.query("insert into public.departments (org_id, name) values ($1,'Dermatology')", [
        orgA,
      ]);
      await c.query(
        "insert into public.ref_medication_classes (org_id, unite_local_code, class) values ($1,'D-100','antibiotic')",
        [orgA],
      );
    });
  });
  afterAll(async () => {
    await c.end();
  });

  describe("schema drift guard", () => {
    const readyTables = REGISTRY.flatMap((e) =>
      e.type === "table" && e.mapper.status === "ready" ? [e.mapper] : [],
    );

    it("every column a ready mapper maps exists on its target table", async () => {
      const bad: string[] = [];
      for (const m of readyTables) {
        const { rows } = await c.query(
          "select column_name from information_schema.columns where table_schema='public' and table_name=$1",
          [m.target],
        );
        const cols = new Set(rows.map((r) => r.column_name));
        expect(cols.size, `${m.key}: target table ${m.target} exists`).toBeGreaterThan(0);
        const wanted = [
          ...m.fields.map((f) => f.column),
          ...(m.links ?? []).flatMap((l) => (l.column ? [l.column] : [])),
          ...m.naturalKey,
        ];
        for (const col of wanted) if (!cols.has(col)) bad.push(`${m.key}: ${m.target}.${col}`);
      }
      expect(bad).toEqual([]);
    });

    it("every enum value the tolerant mappers can produce is a real enum label", async () => {
      const labels = async (type: string) =>
        new Set(
          (
            await c.query(
              "select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname=$1",
              [type],
            )
          ).rows.map((r) => r.enumlabel as string),
        );
      const probes = [
        "Pending",
        "Open",
        "Completed",
        "Done",
        "Escalated",
        "No answer",
        "High",
        "Medium",
        "Improving",
        "Same",
        "Worse",
        "Bleeding",
        "Vitals",
        "Infection labs",
        "Post procedure",
        "Clinical check",
        "Paediatric high concern",
        "During antibiotics (day 3)",
        "After Antibiotics",
        "After Probiotics",
        "Post-procedure",
        "???",
        "",
        null,
      ];
      const warn = () => {};
      const cases: [string, (v: unknown, w: () => void) => string | null][] = [
        ["trigger_category", mapTriggerCategory],
        ["followup_priority", mapPriority],
        ["call_status", mapCallStatus],
        ["followup_outcome", mapOutcome],
        ["feedback_stage", mapFeedbackStage],
      ];
      for (const [type, fn] of cases) {
        const allowed = await labels(type);
        expect(allowed.size, type).toBeGreaterThan(0);
        for (const p of probes) {
          const out = fn(p, warn);
          if (out !== null) expect(allowed.has(out), `${type} ← ${String(p)} → ${out}`).toBe(true);
        }
      }
    });
  });

  it("a dry run of the chain writes nothing", async () => {
    const before = await rowCounts();
    const r = await run(true);
    expect(await rowCounts()).toBe(before);
    expect(r.results.find((x) => x.key === "acute.prescriptions")?.counters.created).toBe(2);
  });

  it("imports every clinical table into the real columns", async () => {
    const r = await run(false);
    const by = Object.fromEntries(r.results.map((x) => [x.key, x]));
    for (const k of CHAIN) expect(by[k].counters.failed, k).toBe(0);

    const doc = await one("select id, department_id from specialists where org_id=$1", [orgA]);
    expect(doc.department_id).not.toBeNull();

    const visits = (await c.query("select * from visits where org_id=$1", [orgA])).rows;
    expect(visits).toHaveLength(2);
    const v1 = visits.find((v) => v.external_id === "recMRD1");
    expect(v1).toMatchObject({
      source: "airtable",
      contact_id: contactId,
      specialist_id: doc.id,
      bp_systolic: 92,
      bp_diastolic: 61,
      department_mapped: "paediatrics",
      pap_result: "not_available",
    });
    expect(Number(v1.temp_c)).toBe(38.2);

    const rx = (
      await c.query(
        "select external_key, class, source, visit_id from prescriptions where org_id=$1",
        [orgA],
      )
    ).rows;
    expect(rx).toHaveLength(2);
    expect(rx.find((r) => r.external_key === "recMRD1-1")).toMatchObject({
      class: "antibiotic",
      source: "airtable_acute",
      visit_id: v1.id,
    });
    // fail closed: a code that is not in ref_medication_classes is never classified from Airtable text
    expect(rx.find((r) => r.external_key === "recMRD1-2")?.class).toBe("unclassified");

    const fu = (
      await c.query(
        "select ref, source, dedupe_key, call_status, closed_at, closed_reason, priority from clinical_followups where org_id=$1 order by ref",
        [orgA],
      )
    ).rows;
    expect(fu[0]).toMatchObject({
      ref: "FU-1",
      source: "airtable_acute",
      dedupe_key: "recMRD1-vitals",
      call_status: "pending",
      closed_at: null,
      priority: "high",
    });
    expect(fu[1]).toMatchObject({
      ref: "FU-2",
      dedupe_key: "recMRD1-bleeding",
      closed_reason: "airtable_history",
    });
    expect(fu[1].closed_at).not.toBeNull();

    const fb = await one("select stage, score from clinical_feedback where org_id=$1", [orgA]);
    expect(fb).toMatchObject({ stage: "after_antibiotics", score: 8 });

    const log = (
      await c.query(
        "select status, send_mode, idempotency_key from clinical_message_log where org_id=$1",
        [orgA],
      )
    ).rows;
    expect(log).toEqual([
      { status: "sent", send_mode: "live", idempotency_key: "recMRD1-1:ABX_DAY3" },
    ]);

    const scripts = (
      await c.query("select key, clinical_approval from clinical_call_scripts where org_id=$1", [
        orgA,
      ])
    ).rows;
    expect(scripts).toEqual([{ key: "FU_PAED_1", clinical_approval: "awaiting" }]);
  });

  it("imported follow-ups are never picked up as engine rows and cannot be duplicated by it", async () => {
    // the engine's dedupe unique index is on open rows with a non-null key: a second open row for the
    // same visit+category (what the engine would create) is rejected while the imported one is open
    const v = await one("select id from visits where org_id=$1 and external_id='recMRD1'", [orgA]);
    await expect(
      c.query(
        "insert into clinical_followups (org_id, visit_id, contact_id, trigger_category, dedupe_key, priority, source) values ($1,$2,$3,'vitals','recMRD1-vitals','high','engine')",
        [orgA, v.id, contactId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a second run is idempotent: nothing created or updated, counts stable", async () => {
    const before = await rowCounts();
    const r = await run(false);
    expect(await rowCounts()).toBe(before);
    for (const t of r.results.filter((x) => CHAIN.includes(x.key))) {
      expect(t.counters.created, t.key).toBe(0);
      expect(t.counters.updated, t.key).toBe(0);
      expect(t.counters.failed, t.key).toBe(0);
    }
  });

  it("never reverts a follow-up that staff worked in Pulse", async () => {
    await c.query(
      "update clinical_followups set call_status='completed', notes='Called, improving', closed_at=now(), closed_reason='completed' where org_id=$1 and ref='FU-1'",
      [orgA],
    );
    await run(false);
    expect(
      await one(
        "select call_status, notes, closed_reason from clinical_followups where org_id=$1 and ref='FU-1'",
        [orgA],
      ),
    ).toMatchObject({
      call_status: "completed",
      notes: "Called, improving",
      closed_reason: "completed",
    });
  });

  it("keeps other orgs untouched", async () => {
    for (const t of CLINICAL_TABLES)
      expect(await count(c, `select 1 from public.${t} where org_id=$1`, [orgB]), t).toBe(0);
    expect(
      await count(c, "select 1 from public.external_refs where org_id=$1 and source='airtable'", [
        orgB,
      ]),
    ).toBe(0);
  });
});
