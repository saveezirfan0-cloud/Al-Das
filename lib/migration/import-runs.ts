import type { ImportSummary } from "@/lib/migration/reconcile";

/**
 * What an importer records about a finished run (public.import_runs): one row per entity, counts only. Pure, so the
 * shape is tested without a database. A summary with an unknown source, a blank entity or a non-numeric counter is
 * dropped or zeroed rather than guessed; no record id, name, phone or value can reach the table through here.
 */

const SOURCES = new Set(["airtable", "sanoflow"]);
const KEYS = [
  "read",
  "created",
  "updated",
  "skipped",
  "invalid",
  "duplicates",
  "review",
  "failed",
] as const;

export type ImportRunRow = {
  org_id: string;
  source: "airtable" | "sanoflow";
  entity: string;
  label: string;
  dry_run: boolean;
  run_at: string;
  counters: Record<(typeof KEYS)[number], number>;
};

export function importRunRows(orgId: string, summaries: readonly ImportSummary[]): ImportRunRow[] {
  const out: ImportRunRow[] = [];
  for (const s of summaries) {
    const entity = (s.entity ?? "").trim();
    if (!SOURCES.has(s.source) || entity.length === 0 || entity.length > 200) continue;
    const at = new Date(s.runAt);
    if (Number.isNaN(at.getTime())) continue;
    const counters = {} as ImportRunRow["counters"];
    for (const k of KEYS) {
      const n = Number(s.counters?.[k]);
      counters[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    out.push({
      org_id: orgId,
      source: s.source as ImportRunRow["source"],
      entity,
      label: (s.label ?? entity).slice(0, 200) || entity,
      dry_run: s.dryRun === true,
      run_at: at.toISOString(),
      counters,
    });
  }
  return out;
}
