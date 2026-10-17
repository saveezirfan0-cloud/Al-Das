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
    expect(deriveState(refsEntry, facts({ refs: { "airtable/appX.tblY": 0 } }))).toBe(
      "not_started",
    );
    expect(deriveState(refsEntry, facts({ refs: { "airtable/appX.tblY": Number.NaN } }))).toBe(
      "not_started",
    );
    expect(deriveState(refsEntry, facts({ refs: { "sanoflow/appX.tblY": 9 } }))).toBe(
      "not_started",
    );
  });

  it("scenario states follow the recorded flags", () => {
    const f = (s: ScenarioFact, u = 0) =>
      facts({ scenarios: { birthday: s }, unexplainedDiffs: { birthday: u } });
    expect(deriveState(scEntry, f(scenario({ nativeBuilt: false })))).toBe("not_started");
    expect(deriveState(scEntry, f(scenario()))).toBe("native");
    expect(deriveState(scEntry, f(scenario({ parallelStartedOn: "2026-11-01" })))).toBe(
      "parallel_run",
    );
    expect(
      deriveState(
        scEntry,
        f(scenario({ parallelStartedOn: "2026-11-01", diffsExplained: true, makeOff: true })),
      ),
    ).toBe("retired");
  });

  it("never claims retired without built, explained and no open differences", () => {
    const f = (s: ScenarioFact, u = 0) =>
      facts({ scenarios: { birthday: s }, unexplainedDiffs: { birthday: u } });
    expect(deriveState(scEntry, f(scenario({ makeOff: true })))).toBe("native");
    expect(deriveState(scEntry, f(scenario({ makeOff: true, diffsExplained: true }), 2))).toBe(
      "native",
    );
    expect(
      deriveState(
        scEntry,
        f(scenario({ makeOff: true, nativeBuilt: false, diffsExplained: true })),
      ),
    ).toBe("not_started");
    expect(deriveState(scEntry, facts({}))).toBe("not_started");
  });

  it("programme groups need every programme active", () => {
    const e = { evidence: { kind: "programmes", keys: ["a", "b"] } } as const;
    expect(deriveState(e, facts({ programmes: { a: "active", b: "draft" } }))).toBe("not_started");
    expect(deriveState(e, facts({ programmes: { a: "active" } }))).toBe("not_started");
    expect(deriveState(e, facts({ programmes: { a: "active", b: "active" } }))).toBe("native");
    expect(deriveState({ evidence: { kind: "programmes", keys: [] } }, NO_FACTS)).toBe(
      "not_started",
    );
  });
});

describe("detailFor and summary", () => {
  it("is count-only text", () => {
    expect(detailFor(refsEntry, facts({ refs: { "airtable/appX.tblY": 1234 } }))).toMatch(
      /1.?234 records linked/,
    );
    expect(
      detailFor(
        scEntry,
        facts({
          scenarios: { birthday: scenario({ parallelStartedOn: "2026-11-01" }) },
          unexplainedDiffs: { birthday: 1 },
        }),
      ),
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
    const keys = MIGRATION_REGISTRY.flatMap((e) =>
      e.evidence.kind === "scenario" ? [e.evidence.key] : [],
    );
    expect(new Set(keys)).toEqual(
      new Set([
        "token",
        "appointment_reminders",
        "birthday",
        "chronic_recall",
        "chronic_update",
        "mrd_sync",
        "airtable_automations",
      ]),
    );
  });
});

// ---- Sanoflow, run evidence and the last-import line (docs/45 P0 follow-up)

import { runLine, toRunFact, type RunFact } from "@/lib/migration/status";

const run = (
  over: Partial<RunFact["counters"]> = {},
  runAt = "2026-10-14T09:00:00Z",
  dryRun = false,
): RunFact => ({
  runAt,
  dryRun,
  counters: {
    read: 100,
    created: 90,
    updated: 5,
    skipped: 3,
    invalid: 1,
    duplicates: 0,
    review: 0,
    failed: 0,
    ...over,
  },
});

describe("Sanoflow rows", () => {
  const sfEntry = { evidence: { kind: "refs", source: "sanoflow", entity: "contact" } } as const;

  it("count their own source, never an Airtable entity of the same name", () => {
    expect(deriveState(sfEntry, facts({ refs: { "sanoflow/contact": 40 } }))).toBe("imported");
    expect(deriveState(sfEntry, facts({ refs: { "airtable/contact": 40 } }))).toBe("not_started");
    expect(deriveState(refsEntry, facts({ refs: { "sanoflow/appX.tblY": 9 } }))).toBe(
      "not_started",
    );
  });

  it("are in the registry as their own group, and fail closed with no facts", () => {
    const rows = buildRows(NO_FACTS).filter((r) => r.group === "Sanoflow · Exports");
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.state === "not_started")).toBe(true);
  });
});

describe("run evidence", () => {
  const e = { evidence: { kind: "run", source: "sanoflow", entity: "lost_reason" } } as const;
  const key = "sanoflow/lost_reason";

  it("is imported only by a real run that wrote something and failed nothing", () => {
    expect(deriveState(e, NO_FACTS)).toBe("not_started");
    expect(deriveState(e, facts({ runs: { [key]: { real: run(), dry: null } } }))).toBe("imported");
    expect(
      deriveState(e, facts({ runs: { [key]: { real: run({ failed: 2 }), dry: null } } })),
    ).toBe("not_started");
    expect(
      deriveState(
        e,
        facts({ runs: { [key]: { real: run({ created: 0, updated: 0 }), dry: null } } }),
      ),
    ).toBe("not_started");
    // a dry run is never progress
    expect(
      deriveState(
        e,
        facts({ runs: { [key]: { real: null, dry: run({}, "2026-10-14T09:00:00Z", true) } } }),
      ),
    ).toBe("not_started");
  });
});

describe("last import line", () => {
  it("says what the newest real run did, counts only", () => {
    expect(runLine({ real: run(), dry: null })).toBe(
      "last import 14 Oct 2026: 100 read, 90 created, 3 skipped, 1 invalid",
    );
    expect(runLine({ real: run({ failed: 3, skipped: 0, invalid: 0 }), dry: null })).toContain(
      "3 failed",
    );
  });

  it("calls a dry run a dry run, and prefers the real one", () => {
    const dry = run({}, "2026-10-10T09:00:00Z", true);
    expect(runLine({ real: null, dry })).toMatch(/^dry run only \(10 Oct 2026\): 100 read/);
    expect(runLine({ real: run(), dry })).toMatch(/^last import 14 Oct 2026/);
    expect(runLine(undefined)).toBeNull();
    expect(runLine({ real: null, dry: null })).toBeNull();
  });

  it("is joined to the linked-records count on a refs row", () => {
    const f = facts({
      refs: { "airtable/appX.tblY": 12 },
      runs: { "airtable/appX.tblY": { real: run(), dry: null } },
    });
    expect(detailFor(refsEntry, f)).toBe(
      "12 records linked · last import 14 Oct 2026: 100 read, 90 created, 3 skipped, 1 invalid",
    );
    // a dry run alone leaves the row not started but says it was tried
    const dryOnly = facts({
      runs: { "airtable/appX.tblY": { real: null, dry: run({}, "2026-10-10T09:00:00Z", true) } },
    });
    expect(deriveState(refsEntry, dryOnly)).toBe("not_started");
    expect(detailFor(refsEntry, dryOnly)).toMatch(/^dry run only/);
  });
});

describe("toRunFact", () => {
  it("keeps only whole, non-negative counts and drops anything that is not an object", () => {
    expect(
      toRunFact("2026-10-14T09:00:00Z", false, { read: "12", created: 3.9, failed: -4, junk: 99 })
        ?.counters,
    ).toEqual({
      read: 12,
      created: 3,
      updated: 0,
      skipped: 0,
      invalid: 0,
      duplicates: 0,
      review: 0,
      failed: 0,
    });
    expect(toRunFact("2026-10-14T09:00:00Z", false, null)).toBeNull();
    expect(toRunFact("2026-10-14T09:00:00Z", false, [1, 2])).toBeNull();
    expect(toRunFact("2026-10-14T09:00:00Z", false, "text")).toBeNull();
  });
});
