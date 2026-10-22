/**
 * Phase 21, part 1 against plain Postgres: visit diagnoses (ingest function, trigger, PHI RLS), chronic conditions
 * derived by the pure rule and written by clinical_apply_chronic_conditions (fail closed until signed; chronic recall
 * then selects patients), prescription sequences scheduled once in scheduled_jobs, the Phase 21 report functions and
 * the corrected parallel-run seed. Synthetic people only ("Layla Demo-07", +44 7700 900xxx). Runs with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deriveChronicConditions,
  toApplyRows,
  type ChronicDiagnosisFact,
} from "@/lib/clinical/chronic";
import { planSequence, sequenceSchedule } from "@/lib/clinical/sequence";
import { ClinicalSettings, type SettingRow } from "@/lib/clinical/settings";

import type { AirtableRecord } from "../../scripts/import/airtable-client";
import { runImport } from "../../scripts/import/orchestrator";
import { entityMap } from "../../scripts/import/registry";
import type { AirtableSource } from "../../scripts/import/results";
import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";
import { PgStore } from "./pg-store";

describe.skipIf(!TEST_DATABASE_URL)("phase 21 clinical gaps", () => {
  let c: Client;
  const u: Record<string, string> = {};
  const id: Record<string, string> = {};
  let orgA: string;
  let orgB: string;

  const one = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0].id;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const sign = (org: string, key: string, value: string) =>
    c.query(
      `update public.clinical_settings set approved_value = $3, sign_off_status = 'approved', signed_by = 'Test Signer', signed_at = current_date
       where org_id = $1 and key = $2`,
      [org, key, value],
    );
  const revoke = (org: string, key: string) =>
    c.query(
      "update public.clinical_settings set approved_value = null, sign_off_status = 'awaiting', signed_by = null, signed_at = null where org_id = $1 and key = $2",
      [org, key],
    );
  const settings = async (org: string) =>
    new ClinicalSettings(
      (
        await c.query<SettingRow>(
          "select key, approved_value, proposed_value, sign_off_status from public.clinical_settings where org_id = $1",
          [org],
        )
      ).rows,
    );

  /** The nightly job, step by step: facts (SQL) → the pure rule (TS) → the writer (SQL). */
  async function derive(org: string, opts: { asOrg?: string } = {}) {
    const facts = (
      await c.query<{
        contact_id: string;
        ref_diagnosis_id: string;
        chronic: boolean;
        visit_count: number;
        first_visit_date: string;
        last_visit_date: string;
      }>("select * from public.clinical_chronic_facts($1)", [org])
    ).rows.map((r): ChronicDiagnosisFact => ({
      contactId: r.contact_id,
      refDiagnosisId: r.ref_diagnosis_id,
      chronic: r.chronic,
      visitCount: r.visit_count,
      firstVisitDate: String(r.first_visit_date),
      lastVisitDate: String(r.last_visit_date),
    }));
    const d = deriveChronicConditions(facts, await settings(org));
    const { rows } = await c.query<{ r: Record<string, number> }>(
      "select public.clinical_apply_chronic_conditions($1, $2::jsonb) as r",
      [opts.asOrg ?? org, JSON.stringify(toApplyRows(d.conditions))],
    );
    return { ...rows[0].r, derived: d.conditions.length, missing: d.missingSettings };
  }

  const eligibleNames = async (org: string) =>
    (
      await c.query<{ first_name: string }>(
        `select c.first_name from public.v_chronic_recall_eligibility e join public.contacts c on c.id = e.contact_id
         where e.org_id = $1 and e.eligible order by 1`,
        [org],
      )
    ).rows.map((r) => r.first_name);

  beforeAll(async () => {
    c = await connect();
    // date columns as YYYY-MM-DD strings
    c.setTypeParser?.(1082, (v: string) => v);
    await resetDb(c);
    for (const n of ["admin", "bob", "marketing", "clinician"])
      u[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", u.admin);
    orgB = await createOrg(c, "Org B", "org-b", u.bob);

    await svc(async () => {
      for (const [user, name, perms] of [
        ["marketing", "Marketing", ["contacts.view", "campaigns.view", "reports.view"]],
        ["clinician", "Clinician", ["portal.clinical_visits.read"]],
      ] as const) {
        const role = await one(
          "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'active')",
          [orgA, u[user], role],
        );
      }
      for (const o of [orgA, orgB]) await c.query("select public.seed_phase8_defaults($1)", [o]);

      const dx = async (org: string, code: string, chronic: boolean, group: string | null) =>
        one(
          `insert into public.ref_diagnoses (org_id, code, chronic, condition_group_id)
           values ($1, $2, $3, (select id from public.ref_condition_groups where org_id = $1 and key = $4))`,
          [org, code, chronic, group],
        );
      id.htn = await dx(orgA, "I10", true, "hypertension");
      id.dep = await dx(orgA, "F32.9", true, "depression");
      id.uri = await dx(orgA, "J06.9", false, null);
      id.htnB = await dx(orgB, "I10", true, "hypertension");

      const person = async (org: string, first: string, phone: string | null, stop = false) =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, stop_marketing) values ($1, $2, 'Synthetic', $3, $4)",
          [org, first, phone, stop],
        );
      id.layla = await person(orgA, "Layla Demo-07", "+447700900007");
      id.omar = await person(orgA, "Omar Demo-08", "+447700900008", true);
      id.sara = await person(orgA, "Sara Demo-09", "+447700900009");
      id.noor = await person(orgA, "Noor Demo-10", "+447700900010");
      id.bContact = await person(orgB, "Hana Demo-11", "+447700900011");

      const visit = async (org: string, contact: string | null, ext: string, daysAgo: number) =>
        one(
          "insert into public.visits (org_id, contact_id, external_id, visit_date, source) values ($1, $2, $3, current_date - $4::int, 'unite')",
          [org, contact, ext, daysAgo],
        );
      id.v1 = await visit(orgA, id.layla, "SYN-V1", 200);
      id.v2 = await visit(orgA, id.layla, "SYN-V2", 120);
      id.v3 = await visit(orgA, id.omar, "SYN-V3", 150);
      id.v4 = await visit(orgA, id.sara, "SYN-V4", 150);
      id.v5 = await visit(orgA, id.noor, "SYN-V5", 100);
      id.v6 = await visit(orgA, null, "SYN-V6", 10);
      id.vB = await visit(orgB, id.bContact, "SYN-VB", 100);
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const store = (
    org: string,
    visit: string,
    codes: Array<{ code: string; is_primary?: boolean }>,
  ) =>
    svc(async () => {
      const { rows } = await c.query<{ r: Record<string, number> }>(
        "select public.clinical_store_visit_diagnoses($1, $2, $3::jsonb) as r",
        [org, visit, JSON.stringify(codes)],
      );
      return rows[0].r;
    });

  it("seeds the derivation threshold awaiting sign-off, next to the Phase 6 settings", async () => {
    const { rows } = await c.query(
      "select sign_off_status, approved_value, proposed_value, category from public.clinical_settings where org_id = $1 and key = 'chronic_condition_min_visits'",
      [orgA],
    );
    expect(rows).toEqual([
      {
        sign_off_status: "awaiting",
        approved_value: null,
        proposed_value: "1",
        category: "recall",
      },
    ]);
    const { rows: n } = await c.query(
      "select count(*)::int as total, count(*) filter (where sign_off_status = 'blocking')::int as blocking from public.clinical_settings where org_id = $1",
      [orgA],
    );
    expect(n[0].total).toBeGreaterThanOrEqual(66);
    expect(n[0].blocking).toBe(4);
    await svc(() => c.query("select public.seed_clinical_settings($1)", [orgA]));
    expect(await count(c, "select 1 from public.clinical_settings where org_id = $1", [orgA])).toBe(
      n[0].total,
    );
  });

  it("stores a visit's diagnosis codes idempotently, links known codes and keeps unknown ones visible", async () => {
    expect(
      await store(orgA, id.v1, [{ code: "i10", is_primary: true }, { code: "Z99.9" }]),
    ).toEqual({
      codes: 2,
      written: 2,
      removed: 0,
      unknown: 1,
    });
    expect(
      await store(orgA, id.v1, [{ code: "I10", is_primary: true }, { code: "Z99.9" }]),
    ).toMatchObject({ written: 0, removed: 0 });
    expect(await store(orgA, id.v1, [{ code: "I10", is_primary: true }])).toMatchObject({
      written: 0,
      removed: 1,
      unknown: 0,
    });
    await store(orgA, id.v2, [{ code: "I10" }]);
    await store(orgA, id.v3, [{ code: "I10" }]);
    await store(orgA, id.v4, [{ code: "F32.9" }]);
    await store(orgA, id.v5, [{ code: "J06.9" }, { code: "Z99.9" }]);
    await store(orgB, id.vB, [{ code: "I10" }]);

    const { rows } = await c.query(
      "select diagnosis_code, is_primary, ref_diagnosis_id = $2 as linked, contact_id = $3 as contact from public.visit_diagnoses where visit_id = $1",
      [id.v1, id.htn, id.layla],
    );
    expect(rows).toEqual([
      { diagnosis_code: "I10", is_primary: true, linked: true, contact: true },
    ]);
    expect(
      (
        await c.query(
          "select diagnosis_code, visit_count from public.v_unknown_diagnosis_codes where org_id = $1",
          [orgA],
        )
      ).rows,
    ).toEqual([{ diagnosis_code: "Z99.9", visit_count: 1 }]);

    // another org's visit is not found; bad input is refused
    await expect(store(orgB, id.v1, [{ code: "I10" }])).rejects.toThrow(/visit not found/);
    await expect(
      svc(() =>
        c.query("select public.clinical_store_visit_diagnoses($1, $2, '{}'::jsonb)", [orgA, id.v1]),
      ),
    ).rejects.toThrow(/JSON array/);
  });

  it("links a code that reaches the reference later, and follows a visit's patient and date", async () => {
    const z = await svc(() =>
      one("insert into public.ref_diagnoses (org_id, code) values ($1, 'Z99.9')", [orgA]),
    );
    const { rows } = await svc(() =>
      c.query("select public.clinical_resolve_visit_diagnoses($1) as n", [orgA]),
    );
    expect(rows[0].n).toBe(1);
    expect(
      await count(
        c,
        "select 1 from public.visit_diagnoses where org_id = $1 and ref_diagnosis_id is null",
        [orgA],
      ),
    ).toBe(0);
    expect(
      await count(c, "select 1 from public.visit_diagnoses where ref_diagnosis_id = $1", [z]),
    ).toBe(1);

    await svc(async () => {
      await store(orgA, id.v6, [{ code: "I10" }]);
      await c.query(
        "update public.visits set contact_id = $2, visit_date = current_date - 11 where id = $1",
        [id.v6, id.noor],
      );
      // and back: the visit is Noor's for this test only
      const { rows: vd } = await c.query(
        "select contact_id = $2 as linked, visit_date = current_date - 11 as dated from public.visit_diagnoses where visit_id = $1",
        [id.v6, id.noor],
      );
      expect(vd).toEqual([{ linked: true, dated: true }]);
      await c.query("delete from public.visit_diagnoses where visit_id = $1", [id.v6]);
      await c.query("update public.visits set contact_id = null where id = $1", [id.v6]);
    });
  });

  it("keeps diagnoses and chronic conditions behind the clinical-visits permission and the org", async () => {
    await svc(() =>
      c.query(
        // a chronic-flagged code (21B: a non-chronic one is refused); depression is not messageable
        "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id, source) values ($1, $2, $3, 'airtable')",
        [orgA, id.noor, id.dep],
      ),
    );
    const seen = async (user: string) => ({
      vd: await asUser(c, user, () => count(c, "select 1 from public.visit_diagnoses")),
      cc: await asUser(c, user, () => count(c, "select 1 from public.contact_chronic_conditions")),
    });
    expect(await seen(u.clinician)).toEqual({ vd: 6, cc: 1 });
    expect(await seen(u.admin)).toEqual({ vd: 6, cc: 1 });
    expect(await seen(u.marketing)).toEqual({ vd: 0, cc: 0 }); // contacts.view is not enough: health data
    expect(await seen(u.bob)).toEqual({ vd: 1, cc: 0 }); // only org B's own
    await asUser(c, u.clinician, async () => {
      await expect(
        c.query(
          "insert into public.visit_diagnoses (org_id, visit_id, diagnosis_code, visit_date) values ($1, $2, 'I10', current_date)",
          [orgA, id.v5],
        ),
      ).rejects.toThrow(/row-level security/);
      const del = await c.query("delete from public.contact_chronic_conditions where org_id = $1", [
        orgA,
      ]);
      expect(del.rowCount).toBe(0);
    });
    // cross-org reference is refused even for the service role
    await expect(
      svc(() =>
        c.query(
          "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id) values ($1, $2, $3)",
          [orgB, id.bContact, id.htn],
        ),
      ),
    ).rejects.toThrow(/does not belong to org/);
  });

  it("derives nothing while the rule is unsigned, so chronic recall selects nobody (fail closed)", async () => {
    await svc(() => sign(orgA, "chronic_recall_min_days", "90"));
    // The "60 days >" gate (docs/49 D2) is tested in chronic-alignment; lifted here, as these patients have no prescriptions.
    await svc(() => sign(orgA, "chronic_recall_require_long_prescription", "false"));
    const r = await svc(() => derive(orgA));
    expect(r).toMatchObject({
      derived: 0,
      inserted: 0,
      removed: 0,
      missing: ["chronic_condition_min_visits"],
    });
    expect(await svc(() => eligibleNames(orgA))).toEqual([]);
  });

  it("once signed, derives chronic conditions from visit diagnoses and chronic recall selects the right patients", async () => {
    await svc(() => sign(orgA, "chronic_condition_min_visits", "1"));
    const r = await svc(() => derive(orgA));
    // Layla (I10 x2 visits), Omar (I10), Sara (F32.9); Noor's J06.9 is not chronic and Z99.9 has no chronic flag
    expect(r).toMatchObject({ derived: 3, inserted: 3, updated: 0, removed: 0, rejected: 0 });
    const { rows } = await svc(() =>
      c.query(
        "select c.first_name, cc.source, cc.evidence_visits, cc.noted_at = current_date - 200 as first_visit from public.contact_chronic_conditions cc join public.contacts c on c.id = cc.contact_id where cc.org_id = $1 and cc.contact_id = $2",
        [orgA, id.layla],
      ),
    );
    expect(rows).toEqual([
      {
        first_name: "Layla Demo-07",
        source: "visit_diagnoses",
        evidence_visits: 2,
        first_visit: true,
      },
    ]);

    // Layla: hypertension, last visit 120 days ago ≥ 90 → eligible. Omar: stop_marketing. Sara: only a mental-health
    // group (never messaged). Noor: no messageable chronic condition.
    expect(await svc(() => eligibleNames(orgA))).toEqual(["Layla Demo-07"]);
    const { rows: e } = await svc(() =>
      c.query(
        "select primary_condition_group, days_since_last_visit from public.v_chronic_recall_eligibility where contact_id = $1",
        [id.layla],
      ),
    );
    expect(e).toEqual([{ primary_condition_group: "hypertension", days_since_last_visit: 120 }]);

    // a second night changes nothing
    expect(await svc(() => derive(orgA))).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
  });

  it("removes derived rows the rule no longer returns, never imported ones, and rejects another org's rows", async () => {
    await svc(() => sign(orgA, "chronic_condition_min_visits", "2"));
    expect(await svc(() => derive(orgA))).toMatchObject({ derived: 1, removed: 2, inserted: 0 });
    expect(await svc(() => eligibleNames(orgA))).toEqual(["Layla Demo-07"]);
    // org A's derivation handed to org B's writer: every row rejected, nothing written
    const cross = await svc(() => derive(orgA, { asOrg: orgB }));
    expect(cross).toMatchObject({ inserted: 0, rejected: 1 });
    expect(
      await count(c, "select 1 from public.contact_chronic_conditions where org_id = $1", [orgB]),
    ).toBe(0);
    // revoking the rule removes every derived row; Noor's imported row stays
    await svc(() => revoke(orgA, "chronic_condition_min_visits"));
    expect(await svc(() => derive(orgA))).toMatchObject({ derived: 0, removed: 1 });
    const { rows } = await svc(() =>
      c.query("select source from public.contact_chronic_conditions where org_id = $1", [orgA]),
    );
    expect(rows).toEqual([{ source: "airtable" }]);
    expect(await svc(() => eligibleNames(orgA))).toEqual([]);
  });

  it("plans an antibiotic sequence once, from the live feed only, with durable scheduled steps", async () => {
    await svc(async () => {
      await sign(orgA, "day3_offset_days", "2");
      await sign(orgA, "probiotic_default_days", "10");
      await c.query(
        "insert into public.ref_medication_classes (org_id, unite_local_code, class, requires_probiotics_default, classified_by) values ($1, 'SYN-ABX', 'antibiotic', true, 'test')",
        [orgA],
      );
      id.rxLive = await one(
        "insert into public.prescriptions (org_id, visit_id, contact_id, external_key, medication_code, class, duration_days, start_date, source) values ($1, $2, $3, 'SYN-V2-1', 'SYN-ABX', 'antibiotic', 7, current_date, 'unite')",
        [orgA, id.v2, id.layla],
      );
      id.rxHistory = await one(
        "insert into public.prescriptions (org_id, visit_id, contact_id, external_key, medication_code, class, duration_days, start_date, source) values ($1, $2, $3, 'SYN-V1-1', 'SYN-ABX', 'antibiotic', 7, current_date, 'airtable_acute')",
        [orgA, id.v1, id.layla],
      );
      id.rxUnknown = await one(
        "insert into public.prescriptions (org_id, visit_id, contact_id, external_key, medication_code, duration_days, start_date, source) values ($1, $2, $3, 'SYN-V2-2', 'SYN-???', 7, current_date, 'unite')",
        [orgA, id.v2, id.layla],
      );
    });
    const pending = (
      await svc(() =>
        c.query("select * from public.clinical_prescriptions_needing_sequence($1)", [orgA]),
      )
    ).rows;
    expect(pending.map((p) => p.prescription_id)).toEqual([id.rxLive]);
    expect(pending[0]).toMatchObject({ requires_probiotics: true, duration_days: 7 });

    const today = String((await c.query("select current_date::text as d")).rows[0].d);
    const plan = planSequence(
      { drugClass: "antibiotic", startDate: today, durationDays: 7, requiresProbiotics: true },
      await settings(orgA),
    );
    const { steps } = sequenceSchedule(plan, today);
    expect(steps.map((s) => s.step)).toEqual([
      "ABX_DAY3",
      "NO_REPLY_CHECK",
      "PROBIOTIC_START",
      "TREATMENT_OUTCOME",
    ]);
    const create = (rx: string) =>
      svc(
        async () =>
          (
            await c.query(
              "select public.clinical_create_sequence($1, $2, $3::jsonb, $4::jsonb) as r",
              [
                orgA,
                rx,
                JSON.stringify({
                  requires_probiotics: true,
                  antibiotic_end_date: plan.endDate,
                  day3_check_date: plan.day3CheckDate,
                  probiotic_start_date: plan.probioticStartDate,
                  probiotic_end_date: plan.probioticEndDate,
                  day3_offset_days: 2,
                  probiotic_duration_days: 10,
                }),
                JSON.stringify(steps.map((s) => ({ step: s.step, run_at: `${s.date}T06:00:00Z` }))),
              ],
            )
          ).rows[0].r,
      );
    expect(await create(id.rxLive)).toMatchObject({ created: true, scheduled: 4 });
    expect(await create(id.rxLive)).toMatchObject({ created: false, reason: "exists" });
    expect(await create(id.rxUnknown)).toEqual({ created: false, reason: "not_an_antibiotic" });

    const jobs = (
      await svc(() =>
        c.query(
          "select kind, payload->>'step' as step, dedupe_key like 'clinical-seq:%' as keyed, done_at is null as pending from public.scheduled_jobs where org_id = $1 order by run_at, payload->>'step'",
          [orgA],
        ),
      )
    ).rows;
    expect(jobs).toHaveLength(4);
    expect(new Set(jobs.map((j) => j.kind))).toEqual(new Set(["clinical.sequence_step"]));
    expect(jobs.every((j) => j.keyed && j.pending)).toBe(true);
    const { rows: seq } = await svc(() =>
      c.query(
        "select status, antibiotic_end_date = current_date + 6 as ends, step_outcomes from public.prescription_sequences where prescription_id = $1",
        [id.rxLive],
      ),
    );
    expect(seq).toEqual([{ status: "not_started", ends: true, step_outcomes: {} }]);
    expect(
      (
        await svc(() =>
          c.query("select * from public.clinical_prescriptions_needing_sequence($1)", [orgA]),
        )
      ).rows,
    ).toEqual([]);
    // the gate is still closed: nothing here is allowed to message a patient
    const { rows: gate } = await svc(() =>
      c.query("select app.clinical_messaging_enabled($1) as on", [orgA]),
    );
    expect(gate[0].on).toBe(false);
  });

  it("reports reminders per doctor, recall this week, the follow-up load and data quality (counts only)", async () => {
    await svc(async () => {
      const spec = await one(
        "insert into public.specialists (org_id, name) values ($1, 'Dr Synthetic')",
        [orgA],
      );
      const chan = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'w-p21', 'p-p21')",
        [orgA],
      );
      const conv = await one(
        "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
        [orgA, chan, id.layla],
      );
      const out = await one(
        "insert into public.messages (org_id, conversation_id, direction, kind, wa_message_id, status) values ($1, $2, 'out', 'template', 'wamid.p21.rem', 'read')",
        [orgA, conv],
      );
      await c.query(
        "insert into public.messages (org_id, conversation_id, direction, kind, wa_message_id, status, reply_to_wa_message_id) values ($1, $2, 'in', 'interactive', 'wamid.p21.reply', 'received', 'wamid.p21.rem')",
        [orgA, conv],
      );
      const appt = (status: string) =>
        one(
          "insert into public.appointments (org_id, contact_id, specialist_id, starts_at, ends_at, status) values ($1, $2, $3, now() + interval '1 hour', now() + interval '90 minutes', $4)",
          [orgA, id.layla, spec, status],
        );
      const a1 = await appt("confirmed");
      await appt("awaiting");
      await appt("cancelled");
      await c.query(
        "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, sent_at, status, message_id) values ($1, $2, 2, now(), now(), 'sent', $3)",
        [orgA, a1, out],
      );
      const prog = (
        await c.query(
          "select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'",
          [orgA],
        )
      ).rows[0].id;
      await c.query(
        "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, send_mode, status, sent_at, replied_at, booked_at) values ($1, $2, $3, 'syn-1', 'live', 'read', now(), now(), now())",
        [orgA, prog, id.layla],
      );
      await c.query(
        "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, send_mode, status, sent_at) values ($1, $2, $3, 'syn-2', 'test', 'sent', now())",
        [orgA, prog, id.sara],
      );
      await c.query(
        "insert into public.clinical_followups (org_id, trigger_category, priority, due_date, doctor_alert_required, dedupe_key) values ($1, 'vitals', 'high', current_date - 1, true, 'syn-fu-1'), ($1, 'vitals', 'medium', current_date + 1, false, 'syn-fu-2')",
        [orgA],
      );
      await c.query(
        "insert into public.clinical_followups (org_id, trigger_category, priority, due_date, dedupe_key, is_test_record) values ($1, 'bleeding', 'high', current_date - 3, 'syn-fu-test', true)",
        [orgA],
      );
    });

    const q = async (sql: string, params: unknown[]) =>
      (await svc(() => c.query(sql, params))).rows;
    const today = String(
      (await c.query("select (now() at time zone 'Asia/Dubai')::date::text as d")).rows[0].d,
    );
    const reminders = await q(
      "select * from public.report_reminder_stats_by_specialist($1, $2::date - 1, $2::date + 1)",
      [orgA, today],
    );
    expect(reminders).toEqual([
      expect.objectContaining({
        specialist_name: "Dr Synthetic",
        appointments: 2, // cancelled left out
        contacted: 1,
        reminders_sent: 1,
        reminders_delivered: 1,
        reminders_read: 1,
        reminders_replied: 1,
        reminders_failed: 0,
      }),
    ]);
    const byDay = await q(
      "select * from public.report_reminder_stats_by_day($1, $2::date, $2::date)",
      [orgA, today],
    );
    expect(byDay).toEqual([expect.objectContaining({ reminders_sent: 1, reminders_replied: 1 })]);

    const week = await q(
      "select * from public.report_recall_week($1, date_trunc('week', now() at time zone 'Asia/Dubai')::date)",
      [orgA],
    );
    expect(week.find((w) => w.send_mode === "live")).toMatchObject({
      programme_key: "chronic_90d",
      sent: 1,
      replied: 1,
      booked: 1,
    });
    expect(week.find((w) => w.send_mode === "test")).toMatchObject({ sent: 1, replied: 0 });

    const load = await q("select * from public.report_clinical_followup_load($1, current_date)", [
      orgA,
    ]);
    expect(load).toEqual([
      {
        trigger_category: "vitals",
        open_items: 2,
        high_priority: 1,
        overdue: 1,
        doctor_alerts_pending: 1,
      },
    ]);

    const dq = await q(
      "select * from public.report_clinical_data_quality($1, current_date - 365, current_date)",
      [orgA],
    );
    expect(dq).toEqual([
      {
        visits: 6,
        incomplete_vitals: 6, // synthetic visits carry no vitals at all
        unmatched_patients: 1,
        unclassified_medication_codes: 1,
        unknown_diagnosis_codes: 0,
      },
    ]);
    const flags = await q(
      "select * from public.report_clinical_red_flags($1, current_date - 1, current_date)",
      [orgA],
    );
    expect(flags).toEqual([{ replies: 0, red_flags: 0, needs_review: 0 }]);

    // service role only
    await asUser(c, u.admin, async () => {
      for (const fn of [
        "report_reminder_stats_by_specialist($1, current_date, current_date)",
        "report_clinical_data_quality($1, current_date, current_date)",
        "clinical_chronic_facts($1)",
        "clinical_prescriptions_needing_sequence($1)",
      ])
        await expect(c.query(`select * from public.${fn}`, [orgA]), fn).rejects.toThrow(
          /permission denied/,
        );
    });
  });

  it("the parallel-run seed no longer cites phases that are built", async () => {
    const { rows } = await c.query(
      "select scenario_key, native_built, blocked_reason from public.parallel_run_scenarios where org_id = $1 and scenario_key in ('token', 'mrd_sync', 'chronic_recall') order by 1",
      [orgA],
    );
    expect(rows.map((r) => [r.scenario_key, r.native_built])).toEqual([
      ["chronic_recall", true],
      ["mrd_sync", false],
      ["token", true],
    ]);
    for (const r of rows)
      expect(r.blocked_reason).not.toMatch(/\(Phase 6\)|Phase 6 clinical engine/);
    expect(rows.find((r) => r.scenario_key === "mrd_sync")!.blocked_reason).toMatch(/visits/);
  });

  it("the Airtable junction importers write the real tables, adopt the Unite rows and re-run idempotently", async () => {
    // Org B: the visit already has I10 from the Unite ingest; the MRD record links the same diagnosis (adopted),
    // and the patient's Chronic Diagnosis list becomes a source 'airtable' chronic condition.
    const store = new PgStore(c, orgB);
    const e = entityMap();
    await svc(async () => {
      await store.upsertRef({
        entity: e.get("unite.diagnosis")!,
        externalId: "recDB",
        localTable: "ref_diagnoses",
        localId: id.htnB,
      });
      await store.upsertRef({
        entity: e.get("unite.medical_records")!,
        externalId: "recVB",
        localTable: "visits",
        localId: id.vB,
      });
      await store.upsertRef({
        entity: e.get("unite.patients")!,
        externalId: "recPB",
        localTable: "contacts",
        localId: id.bContact,
      });
    });
    const data: Record<string, AirtableRecord[]> = {
      "app7QJ2pvhADHQeBP.tblllKPKIY9qvMoEU": [
        {
          id: "recVB",
          createdTime: "2026-01-01T00:00:00.000Z",
          fields: { fldsrglawqYEoNqZu: ["recDB"], fldDJcDJYLqffQ5A0: ["recDB"] },
        },
      ],
      "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB": [
        {
          id: "recPB",
          createdTime: "2026-01-01T00:00:00.000Z",
          fields: { fld9gw5nJNzgywljY: ["recDB"] },
        },
      ],
    };
    const source: AirtableSource = {
      async tableFields() {
        return [];
      },
      async *records(base, table) {
        for (const r of data[`${base}.${table}`] ?? []) yield r;
      },
    };
    const only = ["unite.visit_diagnoses", "unite.patient_chronic_diagnoses"];
    const run = (dryRun: boolean) =>
      svc(() => runImport({ store, source }, { dryRun, includeTest: false, only }));

    const dry = await run(true);
    expect(dry.results.map((r) => r.counters.failed)).toEqual([0, 0]);
    expect(
      await count(c, "select 1 from public.contact_chronic_conditions where org_id = $1", [orgB]),
    ).toBe(0);

    const first = await run(false);
    const byKey = Object.fromEntries(first.results.map((r) => [r.key, r.counters]));
    expect(byKey["unite.visit_diagnoses"]).toMatchObject({
      read: 1,
      adopted: 1,
      created: 0,
      failed: 0,
    });
    expect(byKey["unite.patient_chronic_diagnoses"]).toMatchObject({
      read: 1,
      created: 1,
      failed: 0,
    });
    const { rows } = await svc(() =>
      c.query(
        "select (select count(*)::int from public.visit_diagnoses where visit_id = $1) as vd, (select is_primary from public.visit_diagnoses where visit_id = $1) as primary, (select source from public.contact_chronic_conditions where contact_id = $2) as cc",
        [id.vB, id.bContact],
      ),
    );
    expect(rows[0]).toEqual({ vd: 1, primary: true, cc: "airtable" });

    const again = await run(false);
    for (const r of again.results)
      expect(r.counters, r.key).toMatchObject({ created: 0, failed: 0 });
  });
});
