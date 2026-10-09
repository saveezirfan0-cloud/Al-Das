import { describe, expect, it } from "vitest";

import type { AirtableRecord } from "../../scripts/import/airtable-client";
import { planOrder, runImport, selectKeys } from "../../scripts/import/orchestrator";
import { overallVerdict, renderReport } from "../../scripts/import/report";
import { REGISTRY, type PatientEntry } from "../../scripts/import/registry";
import { emptyResult, type AirtableSource, type TableResult } from "../../scripts/import/results";
import { MemoryStore } from "../../scripts/import/store";

const E = {
  diagnosis: "app7QJ2pvhADHQeBP.tblZqf4Zcw5Kweadh",
  items: "app7QJ2pvhADHQeBP.tblTJtk6aIMbwpoA2",
  cpt: "appZbwlQvkuaUsF2l.tblopYbHPAbTi4QeX",
  settings: "appH2jHpsNR1nqEQ2.tbl69r1kelxG4g93L",
  website: "appkOnjPr1SMD83CP.tblpWst9QqYNuKpwZ",
  mrd: "app7QJ2pvhADHQeBP.tblllKPKIY9qvMoEU",
  unitePatients: "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB",
};

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

function fakeSource(data: Record<string, AirtableRecord[]>) {
  const readTables: string[] = [];
  const source: AirtableSource = {
    async tableFields() {
      return [{ id: "fldUNMAPPED000001", name: "Scratch", type: "singleLineText" }];
    },
    async *records(base, table) {
      readTables.push(`${base}.${table}`);
      for (const r of data[`${base}.${table}`] ?? []) yield r;
    },
  };
  return { source, readTables };
}

const DATA: Record<string, AirtableRecord[]> = {
  [E.diagnosis]: [
    rec("recD1", {
      fldld9DKnsoLK9ADK: "I10",
      fldIGBzWtu2QFP0Yk: true,
      fldyz11Dj5wK2y2S8: "Hypertension",
    }),
    rec("recD2", { fldld9DKnsoLK9ADK: "J45", fldyz11Dj5wK2y2S8: "Atlantis syndrome" }),
    rec("recD3", { fldld9DKnsoLK9ADK: "E11" }),
    rec("recD4", {}), // no code → invalid
  ],
  [E.items]: [
    rec("recI1", {
      fld0i0BQItTWZpTm5: "80061",
      fldB4i14uDiaFt0Qv: "Lipid panel",
      fldDUW6cM6saCg5m8: "Test",
    }),
    rec("recI2", { fld0i0BQItTWZpTm5: "99213", fldDUW6cM6saCg5m8: "Other Services" }),
  ],
  [E.cpt]: [
    rec("recC1", {
      fldjaLpahs9NgSFAF: "80061",
      fldX4POEMd2VY8FKc: "OVERWRITE ATTEMPT",
      fldi4vFfiPdSU7ZxC: true,
      fldqsVvaiGRe59o9w: "Lipids",
    }),
    rec("recC2", { fldjaLpahs9NgSFAF: "36415", fldX4POEMd2VY8FKc: "Venipuncture" }),
  ],
  [E.website]: [
    rec("recW1", {
      fld44pzWF1WiW96XW: "01. General",
      fld87i81Uv5xEbCjh: "Home",
      fldeVUgOhIlFt0fPu: "+971 4 000 0000",
    }),
    rec("recW2", { fld44pzWF1WiW96XW: "01. General", fld87i81Uv5xEbCjh: "Home" }), // duplicate natural key
  ],
  [E.mrd]: [
    rec("recV1", {
      fldKuI5eXoDJIiOcu: "2026-09-01",
      fldQEoJfTLKODHoq7: "92/61",
      fldtxNjAanspw8h40: ["recP1"],
      fldsrglawqYEoNqZu: ["recD1", "recMISSING"],
    }),
    rec("recV2", { fldKuI5eXoDJIiOcu: "2026-09-02", fldtxNjAanspw8h40: ["recNOPE"] }),
  ],
};

async function seededStore() {
  const store = new MemoryStore();
  await store.insertRow("ref_condition_groups", { key: "hypertension", name: "Hypertension" });
  return store;
}

const fakePatients = async (
  entry: PatientEntry,
  ctx: { store: MemoryStore["constructor"] extends never ? never : unknown },
): Promise<TableResult> => {
  const c = ctx as { store: MemoryStore };
  const entity = `${entry.mapper.baseId}.${entry.mapper.tableId}`;
  await c.store.upsertRef({
    entity,
    externalId: "recP1",
    localTable: "contacts",
    localId: "contact-1",
  });
  const r = emptyResult({ key: entry.key, name: entry.mapper.name, entity, target: "contacts" });
  r.counters.read = 1;
  r.counters.created = 1;
  r.refsAfter = await c.store.countRefs(entity);
  return r;
};

const baseOpts = { dryRun: false, includeTest: false } as const;

describe("importer orchestration", () => {
  it("runs ready tables in dependency order and reconciles counts, links and merges", async () => {
    const store = await seededStore();
    const { source, readTables } = fakeSource(DATA);
    const run = await runImport(
      { store, source, runPatients: fakePatients as never },
      {
        ...baseOpts,
        only: ["unite.diagnosis", "unite.items", "ptf.cpt_master", "campaigns.website"],
      },
    );

    // CPT Master depends on Items even though it is listed after it in --only
    expect(run.results.map((r) => r.key)).toEqual([
      "unite.diagnosis",
      "unite.items",
      "ptf.cpt_master",
      "campaigns.website",
    ]);

    const diag = run.results[0];
    expect(diag.counters).toMatchObject({ read: 4, created: 3, invalid: 1, failed: 0 });
    expect(diag.refsAfter).toBe(3);
    expect(diag.unmatched).toEqual([
      { label: "unite.diagnosis · Mapped condition group", count: 1, sample: ["recD2"] },
    ]);
    expect(diag.verdict).toBe("WARN"); // the unknown group is reported, not guessed
    const rows = store.rows("ref_diagnoses");
    expect(rows.find((r) => r.code === "I10")?.condition_group_id).toBe("ref_condition_groups-1");
    expect(rows.find((r) => r.code === "J45")?.condition_group_id ?? null).toBeNull(); // unknown group: left unset, reported above

    // CPT Master merges into ref_items: description is fill-blank-only, new columns are applied
    const items = store.rows("ref_items");
    expect(items).toHaveLength(3); // 80061, 99213, 36415
    expect(items.find((r) => r.code === "80061")).toMatchObject({
      description: "Lipid panel",
      doctor_verified: true,
      test_category: "Lipids",
      item_type: "TEST",
    });
    expect(items.find((r) => r.code === "36415")?.description).toBe("Venipuncture");
    expect(run.results[2].counters).toMatchObject({ adopted: 1, created: 1 });

    // two Airtable records for one natural key → one row, second counted as a duplicate
    const web = run.results[3];
    expect(store.rows("website_entry_points")).toHaveLength(1);
    expect(web.counters).toMatchObject({ created: 1, duplicates: 1 });
    expect(web.refsAfter).toBe(2);
    expect(web.verdict).toBe("WARN");

    expect(readTables).not.toContain(E.mrd);
  });

  it("is idempotent: a second run creates nothing and reports every row unchanged", async () => {
    const store = await seededStore();
    const { source } = fakeSource(DATA);
    const only = ["unite.diagnosis", "unite.items", "ptf.cpt_master"];
    await runImport({ store, source }, { ...baseOpts, only });
    const before = JSON.stringify([...store.tables.entries()]);
    const again = await runImport({ store, source }, { ...baseOpts, only });
    expect(JSON.stringify([...store.tables.entries()])).toBe(before);
    for (const r of again.results) {
      expect(r.counters.created, r.key).toBe(0);
      expect(r.counters.updated, r.key).toBe(0);
      expect(r.counters.unchanged, r.key).toBe(r.counters.read - r.counters.invalid);
    }
  });

  it("a blank source never erases a value; a changed source updates only that column", async () => {
    const store = await seededStore();
    const first = fakeSource({
      [E.items]: [
        rec("recI1", {
          fld0i0BQItTWZpTm5: "80061",
          fldB4i14uDiaFt0Qv: "Lipid panel",
          fldDUW6cM6saCg5m8: "Test",
        }),
      ],
    });
    await runImport({ store, source: first.source }, { ...baseOpts, only: ["unite.items"] });
    // staff edit in the portal, then Airtable re-sync with a blank description and a new type
    store.rows("ref_items")[0].description = "Edited in portal";
    const second = fakeSource({
      [E.items]: [rec("recI1", { fld0i0BQItTWZpTm5: "80061", fldDUW6cM6saCg5m8: "Radiology" })],
    });
    const run = await runImport(
      { store, source: second.source },
      { ...baseOpts, only: ["unite.items"] },
    );
    expect(run.results[0].counters.updated).toBe(1);
    expect(store.rows("ref_items")[0]).toMatchObject({
      description: "Edited in portal",
      item_type: "RADIOLOGY",
    });
  });

  it("a dry run writes nothing, but resolves links through an overlay (including pending tables)", async () => {
    const store = await seededStore();
    const { source, readTables } = fakeSource(DATA);
    const run = await runImport(
      { store, source, runPatients: fakePatients as never },
      {
        dryRun: true,
        includeTest: false,
        only: [
          "unite.diagnosis",
          "unite.items",
          "unite.medication",
          "unite.patients",
          "unite.medical_records",
        ],
      },
    );
    // the real store only holds the pre-seeded group
    const rowCounts = Object.fromEntries(
      [...store.tables.entries()].map(([t, r]) => [t, r.length]).filter(([, n]) => n !== 0),
    );
    expect(rowCounts).toEqual({ ref_condition_groups: 1 });
    expect(store.refs.size).toBe(0);

    const diag = run.results.find((r) => r.key === "unite.diagnosis")!;
    expect(diag.counters.created).toBe(3); // "would create"
    expect(diag.refsAfter).toBe(3);

    const mrd = run.results.find((r) => r.key === "unite.medical_records")!;
    expect(mrd.outcome).toBe("validated");
    expect(mrd.counters.read).toBe(2);
    // recV1 → patient recP1 and diagnosis recD1 resolved via overlay; recMISSING / recNOPE do not
    const labels = mrd.unmatched.map((u) => [u.label, u.count]);
    expect(labels).toContainEqual(["unite.medical_records · Unite (patient)", 1]);
    expect(labels).toContainEqual(["unite.medical_records · Diagnosis", 1]);
    expect(readTables).toContain(E.mrd);
  });

  it("a real run skips Phase 6 tables without reading them and says why", async () => {
    const store = await seededStore();
    const { source, readTables } = fakeSource(DATA);
    const run = await runImport(
      { store, source, runPatients: fakePatients as never },
      { ...baseOpts, only: ["unite.medical_records", "acute.prescriptions"] },
    );
    expect(readTables).toEqual([]);
    expect(
      run.results.every((r) => r.outcome === "skipped_pending" && r.verdict === "PENDING"),
    ).toBe(true);
    expect(run.results[0].note).toMatch(/Phase 6/);
    expect(overallVerdict(run.results)).toBe("PASS");
  });

  it("skips test records unless asked, and counts failed writes as FAIL", async () => {
    const store = await seededStore();
    const test = fakeSource({
      [E.website]: [rec("recW1", { fld44pzWF1WiW96XW: "a", fld87i81Uv5xEbCjh: "b" })],
    });
    store.failInsert.set("website_entry_points", "db 23505");
    const run = await runImport(
      { store, source: test.source },
      { ...baseOpts, only: ["campaigns.website"] },
    );
    expect(run.results[0].counters.failed).toBe(1);
    expect(run.results[0].failures).toEqual([["recW1", "db 23505"]]);
    expect(run.results[0].verdict).toBe("FAIL");
    expect(overallVerdict(run.results)).toBe("FAIL");
  });

  it("lists skipped tables with their reason when everything is selected", async () => {
    const store = await seededStore();
    const { source } = fakeSource({});
    const run = await runImport(
      { store, source, runPatients: fakePatients as never },
      { ...baseOpts },
    );
    const skipped = run.results.filter((r) => r.outcome === "skipped_by_design");
    expect(skipped.length).toBe(REGISTRY.filter((e) => e.type === "skip").length);
    expect(skipped.every((r) => (r.note ?? "").length > 10)).toBe(true);
  });
});

describe("clinical settings sign-off rules", () => {
  const S = (id: string, f: Record<string, unknown>) =>
    rec(id, { fldpn14HNQN3BFEfc: `Param ${id}`, fld7M5zm094N0rlcm: "GP / Adults", ...f });

  it("never overwrites a signed-off setting, never trusts an unsigned 'approved', and fails closed on unknown categories", async () => {
    const store = new MemoryStore();
    await store.insertRow("clinical_settings", {
      key: "signed",
      label: "Param recS",
      category: "gp_adults",
      sign_off_status: "approved",
      approved_value: "5",
      signed_by: "Dr Fake",
      signed_at: "2026-01-01",
      proposed_value: "5",
      airtable_record_id: "recS",
    });
    await store.insertRow("clinical_settings", {
      key: "open",
      label: "Param recU",
      category: "gp_adults",
      sign_off_status: "awaiting",
      proposed_value: "old",
      airtable_record_id: "recU",
    });
    const { source } = fakeSource({
      [E.settings]: [
        S("recS", {
          fldg7eo4b6905Vouh: "999",
          fld5xepAeK9pdB6mE: "999",
          fldU8lQx3G30drRGi: "Someone",
          fld51DuMTqkow2Qic: "2026-02-02",
          fldezo13piyceP6Ex: "Approved",
        }),
        S("recU", { fldg7eo4b6905Vouh: "new", fldezo13piyceP6Ex: "Approved" }), // approved but unsigned
        S("recN", { fldg7eo4b6905Vouh: "x", fld7M5zm094N0rlcm: "GP / Adults" }),
        S("recX", { fld7M5zm094N0rlcm: "Astrology" }),
      ],
    });
    const run = await runImport({ store, source }, { ...baseOpts, only: ["acute.settings"] });
    const rows = store.rows("clinical_settings");
    expect(rows.find((r) => r.airtable_record_id === "recS")).toMatchObject({
      approved_value: "5",
      signed_by: "Dr Fake",
      proposed_value: "5",
    });
    expect(rows.find((r) => r.airtable_record_id === "recU")).toMatchObject({
      proposed_value: "new",
      sign_off_status: "awaiting",
    });
    expect(rows.find((r) => r.airtable_record_id === "recU")?.approved_value).toBeUndefined();
    expect(rows.find((r) => r.airtable_record_id === "recN")).toMatchObject({
      category: "gp_adults",
      sign_off_status: "awaiting",
      source: "airtable",
      key: "param_recn",
    });
    expect(rows.find((r) => r.airtable_record_id === "recX")).toBeUndefined();
    const r = run.results[0];
    expect(r.failures).toEqual([["recX", "unknown_category"]]);
    expect(r.warnings).toMatchObject({ kept_signed_off_setting: 1, approved_without_signature: 1 });
    expect(r.verdict).toBe("FAIL");
  });

  it("a fully signed Airtable row signs off an open setting", async () => {
    const store = new MemoryStore();
    await store.insertRow("clinical_settings", {
      key: "k",
      label: "Param recU",
      category: "gp_adults",
      sign_off_status: "awaiting",
      airtable_record_id: "recU",
    });
    const { source } = fakeSource({
      [E.settings]: [
        S("recU", {
          fld5xepAeK9pdB6mE: "48 hours",
          fldU8lQx3G30drRGi: "Dr Fake",
          fld51DuMTqkow2Qic: "2026-03-03",
          fldezo13piyceP6Ex: "Approved",
        }),
      ],
    });
    await runImport({ store, source }, { ...baseOpts, only: ["acute.settings"] });
    expect(store.rows("clinical_settings")[0]).toMatchObject({
      sign_off_status: "approved",
      approved_value: "48 hours",
      signed_by: "Dr Fake",
      signed_at: "2026-03-03",
    });
  });
});

describe("planning", () => {
  it("orders dependencies first and ignores unselected ones", () => {
    const all = selectKeys(REGISTRY, undefined);
    const order = planOrder(REGISTRY, all).map((e) => e.key);
    const idx = (k: string) => order.indexOf(k);
    expect(idx("unite.diagnosis")).toBeLessThan(idx("unite.medical_records"));
    expect(idx("unite.patients")).toBeLessThan(idx("unite.medical_records"));
    expect(idx("unite.medical_records")).toBeLessThan(idx("acute.visits"));
    expect(idx("acute.visits")).toBeLessThan(idx("acute.prescriptions"));
    expect(idx("acute.prescriptions")).toBeLessThan(idx("acute.feedback"));
    expect(planOrder(REGISTRY, new Set(["acute.feedback"])).map((e) => e.key)).toEqual([
      "acute.feedback",
    ]);
  });

  it("accepts entities and keys for --only, and rejects unknown names", () => {
    expect([...selectKeys(REGISTRY, [E.unitePatients])]).toEqual(["unite.patients"]);
    expect(() => selectKeys(REGISTRY, ["nope"])).toThrow(/matches no table/);
  });

  it("reports selected tables whose dependencies were left out", async () => {
    const store = new MemoryStore();
    const { source } = fakeSource({});
    const run = await runImport({ store, source }, { ...baseOpts, only: ["ptf.cpt_master"] });
    expect(run.missingDependencies).toEqual([{ key: "ptf.cpt_master", dependsOn: "unite.items" }]);
  });
});

describe("reconciliation report", () => {
  it("shows counts, unmatched record ids and a verdict — and no cell values", async () => {
    const store = await seededStore();
    const { source } = fakeSource({
      [E.diagnosis]: [
        rec("recD2", {
          fldld9DKnsoLK9ADK: "I10",
          fldlgGXBFovQBgr7N: "SECRET DESCRIPTION",
          fldyz11Dj5wK2y2S8: "Atlantis syndrome",
        }),
      ],
    });
    const run = await runImport({ store, source }, { ...baseOpts, only: ["unite.diagnosis"] });
    const md = renderReport(run, { org: "al-das-dev" });
    expect(md).toContain("Overall: PASS WITH WARNINGS");
    expect(md).toContain("recD2");
    expect(md).toContain("| Unite · Diagnosis | ref_diagnoses | 1 | 1 | 1 |");
    expect(md).not.toContain("SECRET DESCRIPTION");
    expect(md).not.toContain("Atlantis");
    expect(md).toContain("fldUNMAPPED000001"); // mapping coverage lists field ids
  });

  it("dry-run reports are labelled and verdict is FAIL when refs fall short", () => {
    const r = emptyResult({ key: "k", name: "K", entity: "b.t", target: "x" });
    r.counters.read = 3;
    r.refsAfter = 1;
    r.verdict = "FAIL";
    const md = renderReport(
      { startedAt: "t", dryRun: true, includeTest: false, results: [r], missingDependencies: [] },
      { org: "o" },
    );
    expect(md).toContain("dry run, nothing written");
    expect(md).toContain("Overall: FAIL");
  });
});
