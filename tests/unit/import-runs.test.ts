import { describe, expect, it } from "vitest";

import { importRunRows } from "@/lib/migration/import-runs";
import type { ImportSummary } from "@/lib/migration/reconcile";

const counters = {
  read: 10,
  created: 7,
  updated: 1,
  skipped: 1,
  invalid: 1,
  duplicates: 0,
  review: 0,
  failed: 0,
};
const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  source: "airtable",
  entity: "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB",
  label: "Unite / Unite (patients)",
  runAt: "2026-10-14T09:00:00.000Z",
  dryRun: false,
  since: null,
  includeTestRecords: false,
  counters,
  ...over,
});

describe("importRunRows", () => {
  it("turns a run summary into a counts-only row for the org", () => {
    expect(importRunRows("org-1", [summary()])).toEqual([
      {
        org_id: "org-1",
        source: "airtable",
        entity: "app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB",
        label: "Unite / Unite (patients)",
        dry_run: false,
        run_at: "2026-10-14T09:00:00.000Z",
        counters,
      },
    ]);
  });

  it("drops unknown sources, blank entities and bad dates, and zeroes bad counters", () => {
    const out = importRunRows("org-1", [
      summary({ source: "other" }),
      summary({ entity: "  " }),
      summary({ runAt: "not a date" }),
      summary({ counters: { ...counters, read: Number.NaN, failed: -3, created: 2.8 } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.counters).toMatchObject({ read: 0, failed: 0, created: 2 });
  });

  it("carries nothing but the fixed columns, so no value can ride along", () => {
    const dirty = {
      ...summary(),
      patient: "Layla Demo-01",
      counters: { ...counters, name: "x" },
    } as unknown as ImportSummary;
    const row = importRunRows("org-1", [dirty])[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "counters",
      "dry_run",
      "entity",
      "label",
      "org_id",
      "run_at",
      "source",
    ]);
    expect(Object.keys(row.counters).sort()).toEqual([
      "created",
      "duplicates",
      "failed",
      "invalid",
      "read",
      "review",
      "skipped",
      "updated",
    ]);
    expect(JSON.stringify(row)).not.toContain("Layla");
  });

  it("marks a dry run as a dry run", () => {
    expect(importRunRows("org-1", [summary({ dryRun: true })])[0]!.dry_run).toBe(true);
  });
});
