/**
 * Phase 21 junction importers (MRD → visit_diagnoses, Unite patient → contact_chronic_conditions) on the
 * in-memory store: one row per link, primary flag, unmatched links reported, idempotent re-run, dry run writes
 * nothing, and --only by plain entity does not drag the junction along. Synthetic records only.
 */
import { describe, expect, it } from "vitest";

import type { AirtableRecord } from "../../scripts/import/airtable-client";
import { runImport, selectKeys } from "../../scripts/import/orchestrator";
import { entityMap, REGISTRY } from "../../scripts/import/registry";
import type { AirtableSource } from "../../scripts/import/results";
import { MemoryStore } from "../../scripts/import/store";

const MRD = "app7QJ2pvhADHQeBP.tblllKPKIY9qvMoEU";
const PATIENTS = "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB";

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

const DATA: Record<string, AirtableRecord[]> = {
  [MRD]: [
    // two diagnoses, one of them primary; one link to a diagnosis that was never imported
    rec("recV1", {
      fldsrglawqYEoNqZu: ["recD1", "recD2", "recDX"],
      fldDJcDJYLqffQ5A0: ["recD1"],
    }),
    rec("recV2", { fldsrglawqYEoNqZu: ["recD1"] }),
    rec("recV3", { fldsrglawqYEoNqZu: ["recD1"] }), // visit not imported → parent unmatched
    rec("recV4", {}), // no links: not counted
  ],
  [PATIENTS]: [
    rec("recP1", { fld9gw5nJNzgywljY: ["recD1", "recD2"] }),
    rec("recP2", { fld9gw5nJNzgywljY: ["recD1"] }), // merged into P1's contact
  ],
};

const source = (): AirtableSource => ({
  async tableFields() {
    return [];
  },
  async *records(base, table) {
    for (const r of DATA[`${base}.${table}`] ?? []) yield r;
  },
});

async function seeded() {
  const store = new MemoryStore();
  const e = entityMap();
  const d1 = (await store.insertRow("ref_diagnoses", { code: "i10", chronic: true })) as {
    id: string;
  };
  const d2 = (await store.insertRow("ref_diagnoses", { code: "E11.9", chronic: true })) as {
    id: string;
  };
  await store.upsertRef({
    entity: e.get("unite.diagnosis")!,
    externalId: "recD1",
    localTable: "ref_diagnoses",
    localId: d1.id,
  });
  await store.upsertRef({
    entity: e.get("unite.diagnosis")!,
    externalId: "recD2",
    localTable: "ref_diagnoses",
    localId: d2.id,
  });
  const c1 = (await store.insertRow("contacts", { first_name: "Layla Demo-07" })) as { id: string };
  const c2 = (await store.insertRow("contacts", { first_name: "Old", merged_into_id: c1.id })) as {
    id: string;
  };
  await store.upsertRef({
    entity: e.get("unite.patients")!,
    externalId: "recP1",
    localTable: "contacts",
    localId: c1.id,
  });
  await store.upsertRef({
    entity: e.get("unite.patients")!,
    externalId: "recP2",
    localTable: "contacts",
    localId: c2.id,
  });
  for (const [rid, date] of [
    ["recV1", "2026-09-01"],
    ["recV2", "2026-09-20"],
  ] as const) {
    const v = (await store.insertRow("visits", {
      external_id: rid,
      visit_date: date,
      contact_id: c1.id,
    })) as { id: string };
    await store.upsertRef({
      entity: e.get("unite.medical_records")!,
      externalId: rid,
      localTable: "visits",
      localId: v.id,
    });
  }
  return { store, c1: c1.id, d1: d1.id, d2: d2.id };
}

const ONLY = ["unite.visit_diagnoses", "unite.patient_chronic_diagnoses"];

describe("junction importers", () => {
  it("writes one row per link with the primary flag, and reports what does not resolve", async () => {
    const { store, c1, d1, d2 } = await seeded();
    const run = await runImport(
      { store, source: source() },
      { dryRun: false, includeTest: false, only: ONLY },
    );
    const vd = run.results.find((r) => r.key === "unite.visit_diagnoses")!;
    expect(vd.counters).toMatchObject({ read: 5, created: 3, invalid: 2, failed: 0 });
    expect(vd.refsAfter).toBe(3);
    expect(vd.unmatched.map((u) => u.label).sort()).toEqual([
      "unite.visit_diagnoses · Diagnosis",
      "unite.visit_diagnoses · parent (unite.medical_records)",
    ]);
    expect(vd.verdict).toBe("WARN");
    const rows = store.rows("visit_diagnoses");
    expect(
      rows
        .map((r) => [r.diagnosis_code, r.is_primary, r.ref_diagnosis_id, r.source, r.contact_id])
        .sort(),
    ).toEqual(
      [
        ["E11.9", false, d2, "airtable", c1],
        ["I10", false, d1, "airtable", c1],
        ["I10", true, d1, "airtable", c1],
      ].sort(),
    );

    const cc = run.results.find((r) => r.key === "unite.patient_chronic_diagnoses")!;
    // P2 was merged into P1's contact: its I10 adopts the row P1 already created (natural key)
    expect(cc.counters).toMatchObject({ read: 3, created: 2, adopted: 1, failed: 0 });
    expect(
      store
        .rows("contact_chronic_conditions")
        .map((r) => [r.contact_id, r.ref_diagnosis_id, r.source])
        .sort(),
    ).toEqual(
      [
        [c1, d1, "airtable"],
        [c1, d2, "airtable"],
      ].sort(),
    );
  });

  it("is idempotent: a second run creates nothing", async () => {
    const { store } = await seeded();
    await runImport({ store, source: source() }, { dryRun: false, includeTest: false, only: ONLY });
    const again = await runImport(
      { store, source: source() },
      { dryRun: false, includeTest: false, only: ONLY },
    );
    for (const r of again.results) expect(r.counters.created, r.key).toBe(0);
    expect(store.rows("visit_diagnoses")).toHaveLength(3);
    expect(store.rows("contact_chronic_conditions")).toHaveLength(2);
  });

  it("a dry run writes nothing but reports what it would create", async () => {
    const { store } = await seeded();
    const run = await runImport(
      { store, source: source() },
      { dryRun: true, includeTest: false, only: ONLY },
    );
    expect(run.results.find((r) => r.key === "unite.visit_diagnoses")!.counters.created).toBe(3);
    expect(store.rows("visit_diagnoses")).toHaveLength(0);
    expect(store.rows("contact_chronic_conditions")).toHaveLength(0);
  });

  it("is selected by its own key or entity, never by the plain table entity", () => {
    expect([...selectKeys(REGISTRY, [MRD])]).toEqual(["unite.medical_records"]);
    expect([...selectKeys(REGISTRY, [`${MRD}#visit_diagnoses`])]).toEqual([
      "unite.visit_diagnoses",
    ]);
    expect([...selectKeys(REGISTRY, [PATIENTS])]).toEqual(["unite.patients"]);
  });
});
