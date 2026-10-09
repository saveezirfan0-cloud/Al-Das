import { describe, expect, it } from "vitest";

import {
  checkSignOff,
  findPii,
  latestRealRuns,
  outcomeTotal,
  reconcile,
  renderReport,
  REQUIRED_SIGNOFF_ROLES,
  type DbSnapshot,
  type ImportSummary,
  type RunCounters,
  type SourceCount,
} from "@/lib/migration/reconcile";

const ENTITY = "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB";
const K = `airtable/${ENTITY}`;

const counters = (over: Partial<RunCounters> = {}): RunCounters => ({
  read: 100,
  created: 80,
  updated: 10,
  skipped: 4,
  invalid: 2,
  duplicates: 0,
  review: 4,
  failed: 0,
  ...over,
});

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  source: "airtable",
  entity: ENTITY,
  label: "Unite patients",
  runAt: "2026-11-01T20:00:00.000Z",
  dryRun: false,
  since: null,
  includeTestRecords: false,
  counters: counters(),
  ...over,
});

const db = (over: Partial<DbSnapshot> = {}): DbSnapshot => ({
  refs: { [K]: 90 },
  reviews_open: {},
  reviews_dismissed: { [K]: 4 },
  reviews_resolved: {},
  orphan_refs: 0,
  refs_to_deleted_contacts: 0,
  contacts_live: 85,
  contacts_imported: 85,
  contacts_without_identifier: 0,
  duplicate_alternate_phones: 0,
  alternate_phone_is_other_primary: 0,
  merge_chains_over_1: 0,
  ...over,
});

const source: SourceCount[] = [
  { source: "airtable", entity: ENTITY, label: "Unite patients", total: 100 },
];

describe("reconcile", () => {
  it("signs off when every record is accounted for", () => {
    const r = reconcile(source, db(), [summary()], { freezeAt: "2026-11-01T18:00:00Z" });
    expect(r.rows[0]).toMatchObject({
      sourceTotal: 100,
      imported: 90,
      dismissedReviews: 4,
      testSkipped: 4,
      unidentifiable: 2,
      unaccounted: 0,
    });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags records that went missing", () => {
    const r = reconcile(source, db({ refs: { [K]: 85 } }), [summary()], {
      freezeAt: "2026-11-01T18:00:00Z",
    });
    expect(r.rows[0].unaccounted).toBe(5);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id.startsWith("count:"))?.ok).toBe(false);
  });

  it("flags extra refs too (a negative gap is also a mismatch)", () => {
    expect(reconcile(source, db({ refs: { [K]: 95 } }), [summary()]).rows[0].unaccounted).toBe(-5);
    expect(reconcile(source, db({ refs: { [K]: 95 } }), [summary()]).ok).toBe(false);
  });

  it("honours a tolerance", () => {
    const r = reconcile(source, db({ refs: { [K]: 89 } }), [summary()], {
      tolerance: 1,
      freezeAt: "2026-11-01T18:00:00Z",
    });
    expect(r.ok).toBe(true);
  });

  it("blocks on open sync reviews unless allowed, and counts them as accounted", () => {
    const open = db({ refs: { [K]: 86 }, reviews_open: { [K]: 4 }, reviews_dismissed: { [K]: 4 } });
    expect(reconcile(source, open, [summary()]).rows[0].unaccounted).toBe(0);
    expect(reconcile(source, open, [summary()], { freezeAt: "2026-11-01T18:00:00Z" }).ok).toBe(
      false,
    );
    expect(
      reconcile(source, open, [summary()], {
        freezeAt: "2026-11-01T18:00:00Z",
        allowOpenReviews: 4,
      }).ok,
    ).toBe(true);
  });

  it("requires a real run: dry runs do not count", () => {
    const r = reconcile(source, db(), [summary({ dryRun: true })]);
    expect(r.checks.find((c) => c.id.startsWith("run:"))?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("uses the latest real run per entity", () => {
    const old = summary({
      runAt: "2026-10-01T00:00:00.000Z",
      counters: counters({ failed: 9, read: 100, created: 71 }),
    });
    const latest = summary();
    const runs = latestRealRuns([old, latest]);
    expect(runs.get(K)?.runAt).toBe(latest.runAt);
    expect(
      reconcile(source, db(), [old, latest], { freezeAt: "2026-11-01T18:00:00Z" }).checks.find(
        (c) => c.id === "failed-writes",
      )?.ok,
    ).toBe(true);
  });

  it("fails when failed writes remain, or a run does not add up", () => {
    const failed = summary({ counters: counters({ failed: 3, created: 77 }) });
    expect(reconcile(source, db(), [failed]).checks.find((c) => c.id === "failed-writes")?.ok).toBe(
      false,
    );
    const bad = summary({ counters: counters({ read: 120 }) });
    expect(outcomeTotal(bad.counters)).toBe(100);
    expect(
      reconcile(source, db(), [bad]).checks.find((c) => c.id === "summary:consistent")?.ok,
    ).toBe(false);
  });

  it("requires the last import to be after the freeze", () => {
    const before = summary({ runAt: "2026-11-01T10:00:00.000Z" });
    expect(
      reconcile(source, db(), [before], { freezeAt: "2026-11-01T18:00:00Z" }).checks.find(
        (c) => c.id === "fresh",
      )?.ok,
    ).toBe(false);
    const noFreeze = reconcile(source, db(), [summary()]);
    const fresh = noFreeze.checks.find((c) => c.id === "fresh")!;
    expect(fresh.ok).toBe(false);
    expect(fresh.severity).toBe("warning"); // missing --freeze-at warns, it does not block by itself
    expect(noFreeze.ok).toBe(true);
  });

  it.each([
    ["orphan refs", { orphan_refs: 2 }],
    ["shared alternate phones", { duplicate_alternate_phones: 1 }],
    ["alternate phone equal to another primary", { alternate_phone_is_other_primary: 1 }],
  ])("blocks on %s", (_n, patch) => {
    expect(reconcile(source, db(patch), [summary()], { freezeAt: "2026-11-01T18:00:00Z" }).ok).toBe(
      false,
    );
  });

  it.each([
    ["contacts without an identifier", { contacts_without_identifier: 3 }],
    ["refs to deleted contacts", { refs_to_deleted_contacts: 1 }],
    ["merge chains", { merge_chains_over_1: 1 }],
  ])("only warns on %s", (_n, patch) => {
    const r = reconcile(source, db(patch), [summary()], { freezeAt: "2026-11-01T18:00:00Z" });
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => !c.ok && c.severity === "warning")).toBe(true);
  });

  it("works with importer summaries only (Sanoflow has no source total)", () => {
    const sano = summary({
      source: "sanoflow",
      entity: "contact",
      label: "Sanoflow contacts",
      counters: counters({
        read: 10,
        created: 6,
        updated: 2,
        skipped: 0,
        invalid: 1,
        review: 1,
        failed: 0,
      }),
    });
    const r = reconcile([], db({ refs: {} }), [sano], {
      freezeAt: "2026-11-01T18:00:00Z",
      allowOpenReviews: 99,
    });
    expect(r.rows).toEqual([]);
    expect(r.checks.find((c) => c.id === "summary:consistent")?.ok).toBe(true);
  });
});

describe("report", () => {
  const result = reconcile(source, db(), [summary()], { freezeAt: "2026-11-01T18:00:00Z" });
  const md = renderReport({
    orgSlug: "al-das",
    generatedAt: "2026-11-02T08:00:00.000Z",
    result,
    db: db(),
    freezeAt: "2026-11-01T18:00:00Z",
  });

  it("states the result and carries a sign-off block", () => {
    expect(md).toContain("READY FOR SIGN-OFF");
    expect(md).toContain("| Operations lead |");
    expect(md).toContain(ENTITY);
  });

  it("contains no personal data", () => {
    expect(findPii(md)).toEqual([]);
  });
});

describe("findPii", () => {
  it("catches e-mails, phone numbers and long digit runs", () => {
    expect(findPii("contact jane@example.com")).toContain("e-mail address");
    expect(findPii("call +971 50 123 4567")).toContain("phone number");
    expect(findPii("pin 9715012345678")).toContain("long digit run");
  });
  it("ignores Airtable ids, ISO timestamps, dates and ordinary counts", () => {
    expect(
      findPii(
        "app7QJ2pvhADHQeBP tbl9856qJP9S7OEqB recAbCdEfGhIjKlMn 2026-11-02T08:00:00.000Z 2026-11-02 10652 records 1000000",
      ),
    ).toEqual([]);
  });
});

describe("checkSignOff", () => {
  const roles = [...REQUIRED_SIGNOFF_ROLES];
  const good = {
    report: "reconciliation-2026-11-02T08-00-00.md",
    decision: "GO" as const,
    signedBy: roles.map((role) => ({ role, name: "Someone", date: "2026-11-02" })),
  };
  it("accepts a complete GO for the latest report", () => {
    expect(checkSignOff(good, good.report, roles)).toEqual([]);
  });
  it("rejects a stale report, NO-GO, and missing signatures", () => {
    expect(checkSignOff(good, "reconciliation-2026-11-03T08-00-00.md", roles).join()).toMatch(
      /not the latest/,
    );
    expect(checkSignOff({ ...good, decision: "NO-GO" }, good.report, roles).join()).toMatch(
      /not GO/,
    );
    expect(
      checkSignOff({ ...good, signedBy: good.signedBy.slice(1) }, good.report, roles).join(),
    ).toMatch(/missing signature: Operations lead/);
    expect(
      checkSignOff(
        { ...good, signedBy: [{ role: "Engineering", name: "", date: "" }] },
        good.report,
        roles,
      ).length,
    ).toBeGreaterThan(1);
    expect(checkSignOff(null, good.report, roles)).toEqual([
      "sign-off file missing or not an object",
    ]);
  });
});
