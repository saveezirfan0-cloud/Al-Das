import "server-only";

import {
  NO_FACTS,
  type MigrationFacts,
  toRunFact,
  type RunFacts,
  type ScenarioFact,
} from "@/lib/migration/status";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const SCENARIO_KEYS = [
  "token",
  "appointment_reminders",
  "birthday",
  "chronic_recall",
  "chronic_update",
  "mrd_sync",
  "airtable_automations",
] as const;

/**
 * Gathers the migration facts for one organisation. Service role: call it only after `requirePerm('settings.manage')`.
 * Counts and configuration flags only; no patient rows are read and nothing is logged. A failed read leaves that part
 * of the facts empty, which `deriveState` treats as "not started" (fail closed).
 */
export async function loadMigrationFacts(admin: Admin, orgId: string): Promise<MigrationFacts> {
  const [snapshot, scenarios, programmes, diffCounts, runRows] = await Promise.all([
    admin.rpc("reconcile_snapshot", { p_org_id: orgId }),
    admin
      .from("parallel_run_scenarios")
      .select("scenario_key, native_built, parallel_started_on, diffs_explained, make_off")
      .eq("org_id", orgId),
    admin.from("recall_programmes").select("key, status").eq("org_id", orgId),
    Promise.all(
      SCENARIO_KEYS.map(async (key) => {
        const r = await admin
          .from("parallel_run_diffs")
          .select("scenario_key", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("scenario_key", key)
          .eq("explained", false);
        return [key, r.error ? null : (r.count ?? 0)] as const;
      }),
    ),
    // Counts of each importer run (public.import_runs). The newest rows are enough: only the latest real and dry run of
    // each entity are shown.
    admin
      .from("import_runs")
      .select("source, entity, dry_run, run_at, counters")
      .eq("org_id", orgId)
      .order("run_at", { ascending: false })
      .limit(1000),
  ]);

  const refsRaw = (snapshot.data as { refs?: Record<string, unknown> } | null)?.refs ?? {};
  const refs: Record<string, number> = {};
  for (const [k, v] of Object.entries(refsRaw)) {
    const n = Number(v);
    if (Number.isFinite(n)) refs[k] = n;
  }

  const scenarioFacts: Record<string, ScenarioFact> = {};
  for (const s of scenarios.data ?? []) {
    scenarioFacts[s.scenario_key] = {
      nativeBuilt: s.native_built === true,
      parallelStartedOn: s.parallel_started_on ?? null,
      diffsExplained: s.diffs_explained === true,
      makeOff: s.make_off === true,
    };
  }

  const programmeFacts: Record<string, string> = {};
  for (const p of programmes.data ?? []) programmeFacts[p.key] = p.status;

  const unexplainedDiffs: Record<string, number> = {};
  for (const [key, n] of diffCounts) {
    // An unreadable count must not look like "no differences": mark it as one so nothing reads as retired.
    unexplainedDiffs[key] = n ?? 1;
  }

  const runs: Record<string, RunFacts> = {};
  for (const r of runRows.data ?? []) {
    const fact = toRunFact(r.run_at, r.dry_run, r.counters);
    if (!fact) continue;
    const key = `${r.source}/${r.entity}`;
    const slot = (runs[key] ??= { real: null, dry: null });
    // Newest first: the first row of each kind wins.
    if (r.dry_run) slot.dry ??= fact;
    else slot.real ??= fact;
  }

  return {
    ...NO_FACTS,
    refs,
    runs,
    scenarios: scenarioFacts,
    programmes: programmeFacts,
    unexplainedDiffs,
  };
}
