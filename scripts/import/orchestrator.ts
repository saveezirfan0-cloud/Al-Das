import { runPatientTable, type PatientContext } from "./patients";
import { REGISTRY, entityMap, type PatientEntry, type RegistryEntry } from "./registry";
import { emptyResult, judge, type AirtableSource, type TableResult } from "./results";
import { runTable } from "./run-table";
import { DryRunStore, type ImportStore } from "./store";
import { entityOf } from "./tables/map";

export type ImportOptions = {
  /** Registry keys ("unite.diagnosis") or entities ("<baseId>.<tableId>"); empty = everything. */
  only?: string[];
  dryRun: boolean;
  includeTest: boolean;
  since?: string;
  auditedCounts?: Record<string, number>;
  log?: (line: string) => void;
};

export type ImportDeps = {
  /** Real store; a dry run wraps it in an overlay so nothing is written. */
  store: ImportStore;
  source: AirtableSource;
  /** Patient tables need contact-matching logic that talks to Supabase directly; injectable for tests. */
  runPatients?: (
    entry: PatientEntry,
    ctx: Omit<PatientContext, "admin" | "orgId" | "batch" | "tagIds">,
  ) => Promise<TableResult>;
  registry?: readonly RegistryEntry[];
};

export type ImportRun = {
  startedAt: string;
  dryRun: boolean;
  since?: string;
  includeTest: boolean;
  results: TableResult[];
  /** Selected keys whose dependencies were not selected (links to them may stay unmatched). */
  missingDependencies: Array<{ key: string; dependsOn: string }>;
};

/** Stable topological order: registry order, dependencies first. Dependencies outside `selected` are ignored. */
export function planOrder(
  entries: readonly RegistryEntry[],
  selected: Set<string>,
): RegistryEntry[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: RegistryEntry[] = [];
  const visit = (e: RegistryEntry) => {
    if (done.has(e.key)) return;
    if (visiting.has(e.key)) throw new Error(`dependency cycle at ${e.key}`);
    visiting.add(e.key);
    const deps = e.type === "skip" ? [] : e.dependsOn;
    for (const d of deps) {
      const dep = byKey.get(d);
      if (!dep) throw new Error(`${e.key} depends on unknown table ${d}`);
      if (selected.has(d)) visit(dep);
    }
    visiting.delete(e.key);
    done.add(e.key);
    out.push(e);
  };
  for (const e of entries) if (selected.has(e.key)) visit(e);
  return out;
}

export function selectKeys(
  entries: readonly RegistryEntry[],
  only: string[] | undefined,
): Set<string> {
  if (!only || only.length === 0) return new Set(entries.map((e) => e.key));
  const keys = new Set<string>();
  for (const want of only) {
    const hit = entries.filter((e) => {
      if (e.key === want) return true;
      const base = e.type === "skip" ? e : e.mapper;
      return `${base.baseId}.${base.tableId}` === want;
    });
    if (hit.length === 0) {
      const known = entries
        .filter((e) => e.type !== "skip")
        .map((e) => e.key)
        .join(", ");
      throw new Error(`--only "${want}" matches no table. Known: ${known}`);
    }
    for (const h of hit) keys.add(h.key);
  }
  return keys;
}

export async function runImport(deps: ImportDeps, opts: ImportOptions): Promise<ImportRun> {
  const registry = deps.registry ?? REGISTRY;
  const selected = selectKeys(registry, opts.only);
  const order = planOrder(registry, selected);
  const entities = entityMap();
  const store = opts.dryRun ? new DryRunStore(deps.store) : deps.store;
  const auditedCounts = opts.auditedCounts;

  const missingDependencies: ImportRun["missingDependencies"] = [];
  for (const e of order) {
    if (e.type === "skip") continue;
    for (const d of e.dependsOn)
      if (!selected.has(d)) missingDependencies.push({ key: e.key, dependsOn: d });
  }

  const results: TableResult[] = [];
  for (const e of order) {
    opts.log?.(`→ ${e.key}`);
    if (e.type === "skip") {
      results.push(
        emptyResult({
          key: e.key,
          name: e.name,
          entity: `${e.baseId}.${e.tableId}`,
          target: "-",
          outcome: "skipped_by_design",
          verdict: "SKIPPED",
          note: e.reason,
        }),
      );
      continue;
    }
    if (e.type === "patients") {
      const ctx = {
        store,
        source: deps.source,
        dryRun: opts.dryRun,
        includeTest: opts.includeTest,
        since: opts.since,
        auditedCounts,
        log: opts.log,
      };
      if (!deps.runPatients) throw new Error("runPatients is required to import patient tables");
      results.push(await deps.runPatients(e, ctx));
      continue;
    }
    const m = e.mapper;
    if (m.status === "pending" && !opts.dryRun) {
      results.push(
        emptyResult({
          key: m.key,
          name: m.name,
          entity: entityOf(m),
          target: m.target,
          outcome: "skipped_pending",
          verdict: "PENDING",
          auditedCount: auditedCounts?.[m.tableId] ?? null,
          note: `${m.pendingReason ?? `Not written yet (target \`${m.target}\`).`} Validated by --dry-run only.`,
        }),
      );
      continue;
    }
    const r = await runTable(m, {
      store,
      source: deps.source,
      entityOf: (k) => entities.get(k),
      dryRun: opts.dryRun,
      includeTest: opts.includeTest,
      since: opts.since,
      auditedCounts,
      log: opts.log,
    });
    results.push(r);
  }

  // A delta run (--since) cannot be reconciled against full table counts.
  for (const r of results)
    if (opts.since && r.verdict === "FAIL" && r.counters.failed === 0) r.verdict = judge(r, false);

  return {
    startedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    since: opts.since,
    includeTest: opts.includeTest,
    results,
    missingDependencies,
  };
}

export { runPatientTable };
