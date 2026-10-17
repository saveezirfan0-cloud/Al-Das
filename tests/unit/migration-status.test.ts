import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIGRATION_REGISTRY,
  NO_FACTS,
  buildRows,
  deriveState,
  detailFor,
  summarise,
  type MigrationFacts,
  type ScenarioFact,
} from "@/lib/migration/status";

const scenario = (over: Partial<ScenarioFact> = {}): ScenarioFact => ({
  nativeBuilt: true,
  parallelStartedOn: null,
  diffsExplained: false,
  makeOff: false,
  ...over,
});
const facts = (over: Partial<MigrationFacts>): MigrationFacts => ({ ...NO_FACTS, ...over });

const refsEntry = { evidence: { kind: "refs", entity: "appX.tblY" } } as const;
const scEntry = { evidence: { kind: "scenario", key: "birthday" } } as const;

describe("deriveState", () => {
  it("fails closed with no facts", () => {
    for (const e of MIGRATION_REGISTRY) expect(deriveState(e, NO_FACTS)).toBe("not_started");
    expect(deriveState(refsEntry)).toBe("not_started");
  });

  it("imported only with linked records", () => {
    expect(deriveState(refsEntry, facts({ refs: { "airtable/appX.tblY": 3 } }))).toBe("imported");
    expect(deriveState(refsEntry, facts({ refs: { "airtable/appX.tblY": 0 } }))).toBe("not_started");
    expect(deriveState(refsEntry, facts({ refs: { "airtable/appX.tblY": Number.NaN } }))).toBe("not_started");
    expect(deriveState(refsEntry, facts({ refs: { "sanoflow/appX.tblY": 9 } }))).toBe("not_started");
  });

  it("scenario states follow the recorded flags", () => {
    const f = (s: ScenarioFact, u = 0) => facts({ scenarios: { birthday: s }, unexplainedDiffs: { birthday: u } });
    expect(deriveState(scEntry, f(scenario({ nativeBuilt: false })))).toBe("not_started");
    expect(deriveState(scEntry, f(scenario()))).toBe("native");
    expect(deriveState(scEntry, f(scenario({ parallelStartedOn: "2026-11-01" })))).toBe("parallel_run");
    expect(
      deriveState(scEntry, f(scenario({ parallelStartedOn: "2026-11-01", diffsExplained: true, makeOff: true }))),
    ).toBe("retired");
  });

  it("never claims retired without built, explained and no open differences", () => {
    const f = (s: ScenarioFact, u = 0) => facts({ scenarios: { birthday: s }, unexplainedDiffs: { birthday: u } });
    expect(deriveState(scEntry, f(scenario({ makeOff: true })))).toBe("native");
    expect(deriveState(scEntry, f(scenario({ makeOff: true, diffsExplained: true }), 2))).toBe("native");
    expect(deriveState(scEntry, f(scenario({ makeOff: true, nativeBuilt: false, diffsExplained: true })))).toBe(
      "not_started",
    );
    expect(deriveState(scEntry, facts({}))).toBe("not_started");
  });

  it("programme groups need every programme active", () => {
    const e = { evidence: { kind: "programmes", keys: ["a", "b"] } } as const;
    expect(deriveState(e, facts({ programmes: { a: "active", b: "draft" } }))).toBe("not_started");
    expect(deriveState(e, facts({ programmes: { a: "active" } }))).toBe("not_started");
    expect(deriveState(e, facts({ programmes: { a: "active", b: "active" } }))).toBe("native");
    expect(deriveState({ evidence: { kind: "programmes", keys: [] } }, NO_FACTS)).toBe("not_started");
  });
});

describe("detailFor and summary", () => {
  it("is count-only text", () => {
    expect(detailFor(refsEntry, facts({ refs: { "airtable/appX.tblY": 1234 } }))).toMatch(/1.?234 records linked/);
    expect(
      detailFor(scEntry, facts({ scenarios: { birthday: scenario({ parallelStartedOn: "2026-11-01" }) }, unexplainedDiffs: { birthday: 1 } })),
    ).toBe("parallel run since 2026-11-01, 1 unexplained difference");
    expect(detailFor(refsEntry)).toBeNull();
  });

  it("summarises every row once", () => {
    const rows = buildRows(NO_FACTS);
    expect(rows).toHaveLength(MIGRATION_REGISTRY.length);
    expect(summarise(rows).not_started).toBe(rows.length);
  });
});

describe("registry", () => {
  it("has unique ids and real page links", () => {
    const ids = MIGRATION_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MIGRATION_REGISTRY) {
      if (!e.href) continue;
      expect(existsSync(join(process.cwd(), "app/(app)", e.href, "page.tsx")), e.href).toBe(true);
    }
  });

  it("covers the seven scenario keys of the parallel-run checklist", () => {
    const keys = MIGRATION_REGISTRY.flatMap((e) => (e.evidence.kind === "scenario" ? [e.evidence.key] : []));
    expect(new Set(keys)).toEqual(
      new Set(["token", "appointment_reminders", "birthday", "chronic_recall", "chronic_update", "mrd_sync", "airtable_automations"]),
    );
  });
});
