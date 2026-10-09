import { COMPARABLE, previousDay, SCENARIO_KEYS, type ScenarioKey } from "@/lib/parallel-run/diff";
import { computeDiff } from "@/lib/parallel-run/service";
import { registerTask } from "@/lib/jobs/tasks";

/** /api/jobs/parallel_run (nightly 00:30 Asia/Dubai): compare yesterday's native output with the imported Make output. */
registerTask("parallel_run", {
  name: "parallel_run.nightly",
  async run(admin) {
    const day = previousDay(new Date());
    const { data: rows } = await admin.from("parallel_run_scenarios").select("org_id, scenario_key, native_built").eq("native_built", true);
    let compared = 0;
    for (const r of rows ?? []) {
      const key = r.scenario_key as ScenarioKey;
      if (!SCENARIO_KEYS.includes(key) || !COMPARABLE.has(key)) continue;
      if (await computeDiff(admin, r.org_id, key, day)) compared += 1;
    }
    return { day, compared };
  },
});
