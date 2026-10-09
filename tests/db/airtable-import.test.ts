/**
 * The Airtable importer against the real schema: column names, enums, unique keys and check
 * constraints of the ready tables, idempotent re-runs, dry-run isolation and sign-off protection.
 * Synthetic records only. Runs only with TEST_DATABASE_URL.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AirtableRecord } from "../../scripts/import/airtable-client";
import { runImport } from "../../scripts/import/orchestrator";
import type { AirtableSource } from "../../scripts/import/results";
import {
  asServiceRole,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";
import { PgStore, pgTypes } from "./pg-store";

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});
const source = (data: Record<string, AirtableRecord[]>): AirtableSource => ({
  async tableFields() {
    return [];
  },
  async *records(base, table) {
    for (const r of data[`${base}.${table}`] ?? []) yield r;
  },
});

const DATA: Record<string, AirtableRecord[]> = {
  "app7QJ2pvhADHQeBP.tblZqf4Zcw5Kweadh": [
    rec("recD1", {
      fldld9DKnsoLK9ADK: "I10",
      fldlgGXBFovQBgr7N: "Essential hypertension",
      fldIGBzWtu2QFP0Yk: true,
      fldFVPiTP5g4AGaV2: true,
      fldyz11Dj5wK2y2S8: "Hypertension / Hypertensive disease",
    }),
    rec("recD2", {
      fldld9DKnsoLK9ADK: "E11",
      fldIGBzWtu2QFP0Yk: true,
      fldyz11Dj5wK2y2S8: "Diabetes mellitus (Type 1/2/other)",
    }),
    rec("recD3", { fldld9DKnsoLK9ADK: "Z00", fldyz11Dj5wK2y2S8: "Not a real group" }),
  ],
  "app7QJ2pvhADHQeBP.tblLM2BXjA680GQws": [
    rec("recM1", {
      fld7kgxlA3c0kjFdW: "D-100",
      fldvBHlyQEFGX1UFS: "Fakecillin",
      fldQPwna6WcQkIsrb: "12.50",
      fldGvn9X6b6sNY9Xi: "2026-02-03",
      fldQQsGZMJDEmcIkL: "true",
      fld15ltyTEfiugYam: "Antibiotic + Probiotic",
      fldkhVVFyNnSz5T4n: "SOURCE",
    }),
  ],
  "app7QJ2pvhADHQeBP.tblTJtk6aIMbwpoA2": [
    rec("recI1", {
      fld0i0BQItTWZpTm5: "80061",
      fldB4i14uDiaFt0Qv: "Lipid panel",
      fldDUW6cM6saCg5m8: "Test",
    }),
  ],
  "appZbwlQvkuaUsF2l.tblopYbHPAbTi4QeX": [
    rec("recC1", {
      fldjaLpahs9NgSFAF: "80061",
      fldX4POEMd2VY8FKc: "ignored: description already set",
      fldi4vFfiPdSU7ZxC: true,
      fldqsVvaiGRe59o9w: "Lipids",
    }),
  ],
  "appH2jHpsNR1nqEQ2.tblIxa5xUOG3GRwmt": [
    rec("recR1", {
      fld8IyFkiQC3VrDpH: "D-100",
      fldBmjJIDVEFm6gbW: "Fakecillin",
      fldHUcvmoD8Sy8Yia: "Antibiotic",
      fldUVPyOsylLribKr: true,
    }),
    rec("recR2", {
      fld8IyFkiQC3VrDpH: "D-200",
      fldHUcvmoD8Sy8Yia: "Steroid",
      fldDSObi3AgyZAX3U: "heuristic",
    }),
  ],
  "appkOnjPr1SMD83CP.tblpWst9QqYNuKpwZ": [
    rec("recW1", {
      fld44pzWF1WiW96XW: "01. General Booking",
      fld87i81Uv5xEbCjh: "Home",
      fldMXt1bD5N6aTNbR: "Hello",
      fldySS9CEPFLYnWVP: "General receptionist triage",
      fld6BmbGE4MDFZENr: "No",
    }),
    rec("recW2", {
      fld44pzWF1WiW96XW: "04. Doctor-Specific",
      fld87i81Uv5xEbCjh: "DoctorProfile — Dr Fake",
      fld6BmbGE4MDFZENr: "Yes",
    }),
  ],
  "appH2jHpsNR1nqEQ2.tbl69r1kelxG4g93L": [
    // rec1GjMbqh07hYFDc is a seeded row (post_procedure_followup_interval); recNEW is a new parameter
    rec("rec1GjMbqh07hYFDc", {
      fldpn14HNQN3BFEfc: "Post-procedure follow-up interval",
      fld7M5zm094N0rlcm: "GP / Adults",
      fldg7eo4b6905Vouh: "48 hours",
      fldezo13piyceP6Ex: "Awaiting",
    }),
    rec("recNEW000000001", {
      fldpn14HNQN3BFEfc: "A brand new parameter",
      fld7M5zm094N0rlcm: "Operational",
      fldg7eo4b6905Vouh: "7",
      fldezo13piyceP6Ex: "Blocking",
    }),
  ],
};

describe.skipIf(!TEST_DATABASE_URL)("Airtable importer against the real schema", () => {
  let c: pg.Client;
  let orgA: string;
  let orgB: string;
  let storeA: PgStore;
  const only = [
    "unite.diagnosis",
    "unite.medication",
    "unite.items",
    "ptf.cpt_master",
    "acute.medication_reference",
    "acute.settings",
    "campaigns.website",
  ];

  beforeAll(async () => {
    c = new pg.Client({ connectionString: TEST_DATABASE_URL, types: pgTypes });
    await c.connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner@example.test");
    const ownerB = await createAuthUser(c, "ownerb@example.test");
    orgA = await createOrg(c, "Org A", "org-a", owner);
    orgB = await createOrg(c, "Org B", "org-b", ownerB);
    await asServiceRole(c, async () => {
      for (const o of [orgA, orgB]) {
        await c.query("select public.seed_condition_groups($1)", [o]);
        await c.query("select public.seed_clinical_settings($1)", [o]);
        await c.query("select public.seed_portal_objects($1)", [o]);
      }
    });
    storeA = new PgStore(c, orgA);
  });
  afterAll(async () => {
    await c.end();
  });

  const run = (dryRun: boolean) =>
    asServiceRole(c, () =>
      runImport({ store: storeA, source: source(DATA) }, { dryRun, includeTest: false, only }),
    );
  const snapshot = async () =>
    JSON.stringify(
      (
        await c.query(
          `select (select count(*) from ref_diagnoses) d, (select count(*) from ref_medications) m, (select count(*) from ref_items) i,
                  (select count(*) from ref_medication_classes) c, (select count(*) from clinical_settings) s,
                  (select count(*) from website_entry_points) w, (select count(*) from external_refs) r`,
        )
      ).rows,
    );

  it("a dry run changes nothing", async () => {
    const before = await snapshot();
    const r = await run(true);
    expect(await snapshot()).toBe(before);
    expect(r.results.find((x) => x.key === "unite.diagnosis")?.counters.created).toBe(3);
  });

  it("imports every ready table into the real columns", async () => {
    const r = await run(false);
    const byKey = Object.fromEntries(r.results.map((x) => [x.key, x]));
    for (const k of only) expect(byKey[k].counters.failed, k).toBe(0);

    const { rows: diag } = await c.query(
      "select d.code, d.chronic, d.top30, g.key as grp from ref_diagnoses d left join ref_condition_groups g on g.id = d.condition_group_id where d.org_id=$1 order by d.code",
      [orgA],
    );
    expect(diag).toEqual([
      { code: "E11", chronic: true, top30: false, grp: "diabetes" },
      { code: "I10", chronic: true, top30: true, grp: "hypertension" },
      { code: "Z00", chronic: false, top30: false, grp: null },
    ]);
    expect(byKey["unite.diagnosis"].unmatched.map((u) => u.count)).toEqual([1]);

    const { rows: med } = await c.query(
      "select ddc_code, package_price, source_updated_on, is_ebp, all_medicine_types, source from ref_medications where org_id=$1",
      [orgA],
    );
    expect(med[0]).toMatchObject({
      ddc_code: "D-100",
      is_ebp: true,
      all_medicine_types: ["Antibiotic", "Probiotic"],
      source: null,
    });
    expect(Number(med[0].package_price)).toBe(12.5);
    expect(med[0].source_updated_on).toBe("2026-02-03");

    const { rows: item } = await c.query(
      "select code, description, item_type, test_category, doctor_verified from ref_items where org_id=$1",
      [orgA],
    );
    expect(item).toEqual([
      {
        code: "80061",
        description: "Lipid panel",
        item_type: "TEST",
        test_category: "Lipids",
        doctor_verified: true,
      },
    ]);

    const { rows: cls } = await c.query(
      "select unite_local_code, class, classified_by from ref_medication_classes where org_id=$1 order by 1",
      [orgA],
    );
    expect(cls).toEqual([
      { unite_local_code: "D-100", class: "antibiotic", classified_by: null },
      { unite_local_code: "D-200", class: "unclassified", classified_by: "heuristic" },
    ]);

    const { rows: web } = await c.query(
      "select section, source_key, is_dynamic from website_entry_points where org_id=$1 order by 1",
      [orgA],
    );
    expect(web).toEqual([
      { section: "01. General Booking", source_key: "Home", is_dynamic: false },
      { section: "04. Doctor-Specific", source_key: "DoctorProfile — Dr Fake", is_dynamic: true },
    ]);

    // the seeded setting was matched by its Airtable record id; the new one was created
    const { rows: s } = await c.query(
      "select key, proposed_value, sign_off_status, source from clinical_settings where org_id=$1 and airtable_record_id in ('rec1GjMbqh07hYFDc','recNEW000000001') order by key",
      [orgA],
    );
    expect(s.map((x) => x.key)).toEqual([
      "a_brand_new_parameter",
      "post_procedure_followup_interval",
    ]);
    expect(s[0]).toMatchObject({
      proposed_value: "7",
      sign_off_status: "blocking",
      source: "airtable",
    });
    expect(s[1]).toMatchObject({ proposed_value: "48 hours", sign_off_status: "awaiting" });
    expect(byKey["acute.settings"].counters).toMatchObject({ created: 1 });
  });

  it("a second run is idempotent: nothing created, every row unchanged, counts stable", async () => {
    const before = await snapshot();
    const r = await run(false);
    expect(await snapshot()).toBe(before);
    for (const t of r.results) {
      expect(t.counters.created, t.key).toBe(0);
      expect(t.counters.failed, t.key).toBe(0);
      expect(t.counters.updated, t.key).toBe(0);
    }
    expect(r.results.find((x) => x.key === "unite.diagnosis")?.counters.unchanged).toBe(3);
  });

  it("keeps other orgs untouched", async () => {
    expect(await count(c, "select 1 from public.ref_diagnoses where org_id=$1", [orgB])).toBe(0);
    expect(
      await count(c, "select 1 from public.external_refs where org_id=$1 and source='airtable'", [
        orgB,
      ]),
    ).toBe(0);
  });

  it("an Airtable approval is never imported; the Pulse sign-off workflow owns it", async () => {
    await run(false);
    const { rows } = await c.query(
      "select sign_off_status, approved_value, signed_by from public.clinical_settings where org_id=$1 and airtable_record_id='recNEW000000001'",
      [orgA],
    );
    expect(rows[0]).toMatchObject({
      sign_off_status: "blocking",
      approved_value: null,
      signed_by: null,
    });
  });

  it("a signed-off setting survives a re-import", async () => {
    await asServiceRole(c, () =>
      c.query(
        "update public.clinical_settings set sign_off_status='approved', approved_value='24 hours', signed_by='Dr Fake', signed_at='2026-04-04' where org_id=$1 and airtable_record_id='rec1GjMbqh07hYFDc'",
        [orgA],
      ),
    );
    await run(false);
    const { rows } = await c.query(
      "select proposed_value, approved_value, sign_off_status, signed_by from public.clinical_settings where org_id=$1 and airtable_record_id='rec1GjMbqh07hYFDc'",
      [orgA],
    );
    expect(rows[0]).toMatchObject({
      approved_value: "24 hours",
      sign_off_status: "approved",
      signed_by: "Dr Fake",
      proposed_value: "48 hours",
    });
  });
});
