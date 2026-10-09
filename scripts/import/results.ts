import type { AirtableField, AirtableRecord } from "./airtable-client";

/** What the importer needs from Airtable. AirtableClient implements it; tests use a fake. */
export interface AirtableSource {
  tableFields(baseId: string, tableId: string): Promise<AirtableField[]>;
  records(
    baseId: string,
    tableId: string,
    opts?: { since?: string },
  ): AsyncIterable<AirtableRecord>;
}

export type RunCounters = {
  read: number;
  created: number;
  updated: number;
  /** Row already identical to what the record maps to (the idempotent re-run outcome). */
  unchanged: number;
  /** Existing row matched on its natural key and linked to this Airtable record. */
  adopted: number;
  /** Two Airtable records mapped to the same local row. */
  duplicates: number;
  skipped: number;
  invalid: number;
  review: number;
  failed: number;
};

export function runCounters(): RunCounters {
  return {
    read: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    adopted: 0,
    duplicates: 0,
    skipped: 0,
    invalid: 0,
    review: 0,
    failed: 0,
  };
}

export type UnmatchedLink = {
  /** Source table key + link label, e.g. "unite.medical_records · Diagnosis". */
  label: string;
  /** Records whose link could not be resolved. */
  count: number;
  /** Airtable record ids only (never names or values), capped. */
  sample: string[];
};

export type Verdict = "OK" | "WARN" | "FAIL" | "PENDING" | "SKIPPED";

export type TableResult = {
  key: string;
  name: string;
  entity: string;
  target: string;
  /** What this run did with the table. */
  outcome: "imported" | "validated" | "skipped_pending" | "skipped_by_design" | "not_selected";
  counters: RunCounters;
  linksResolved: number;
  unmatched: UnmatchedLink[];
  warnings: Record<string, number>;
  failures: Array<[string, string]>;
  unmappedFields: Array<{ id: string; name: string; type: string }>;
  createdCustomFields: string[];
  /** external_refs for the entity after the run (dry runs include what would be written). */
  refsAfter: number | null;
  /** Rows in the target table after the run (dry runs include the overlay). */
  rowsAfter: number | null;
  /** Airtable count noted in docs/audit/airtable-raw/counts.json at audit time, if any. */
  auditedCount: number | null;
  verdict: Verdict;
  note?: string;
};

export function emptyResult(
  base: Pick<TableResult, "key" | "name" | "entity" | "target"> & Partial<TableResult>,
): TableResult {
  return {
    outcome: "imported",
    counters: runCounters(),
    linksResolved: 0,
    unmatched: [],
    warnings: {},
    failures: [],
    unmappedFields: [],
    createdCustomFields: [],
    refsAfter: null,
    rowsAfter: null,
    auditedCount: null,
    verdict: "OK",
    ...base,
  };
}

/** Airtable records that should end up with an external_ref after a full import of the table. */
export function expectedRefs(c: RunCounters): number {
  return c.read - c.skipped - c.invalid - c.review;
}

/**
 * Reconciliation verdict for one table.
 * FAIL  → failed writes, or fewer external_refs than importable Airtable records.
 * WARN  → unmatched links, ambiguous matches, mapper warnings or more refs than records.
 * OK    → everything importable has a ref and every link resolved.
 */
export function judge(r: TableResult, fullRun: boolean): Verdict {
  if (r.outcome === "skipped_pending") return "PENDING";
  if (r.outcome === "skipped_by_design" || r.outcome === "not_selected") return "SKIPPED";
  if (r.counters.failed > 0) return "FAIL";
  if (fullRun && r.refsAfter !== null && r.refsAfter < expectedRefs(r.counters)) return "FAIL";
  const unmatched = r.unmatched.reduce((n, u) => n + u.count, 0);
  const warnings = Object.keys(r.warnings).length;
  if (
    unmatched > 0 ||
    r.counters.review > 0 ||
    r.counters.duplicates > 0 ||
    warnings > 0 ||
    (fullRun && r.refsAfter !== null && r.refsAfter > expectedRefs(r.counters))
  )
    return "WARN";
  return "OK";
}
