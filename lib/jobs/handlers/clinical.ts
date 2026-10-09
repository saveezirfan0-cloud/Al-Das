import { evaluateRecentVisits } from "@/lib/clinical/engine";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * /api/jobs/clinical_evaluate (pg_cron every 10 min): evaluate each org's recent visits.
 * Unchanged visits are skipped by their inputs hash, so this is also how a newly signed-off setting
 * reaches visits that were evaluated earlier. It only fills the internal Follow-Up Queue; it never
 * sends a patient message (that is gated separately, lib/clinical/engine.ts dispatchClinicalMessage).
 */
registerTask("clinical_evaluate", {
  name: "clinical.evaluate",
  async run(admin, log) {
    const { data: orgs } = await admin.from("orgs").select("id");
    const totals = { checked: 0, evaluated: 0, created: 0 };
    for (const org of orgs ?? []) {
      // Only orgs that have the clinical settings seeded take part.
      const { count } = await admin
        .from("clinical_settings")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org.id);
      if (!count) continue;
      const r = await evaluateRecentVisits(admin, org.id, { sinceDays: 30, limit: 500 });
      totals.checked += r.checked;
      totals.evaluated += r.evaluated;
      totals.created += r.created;
    }
    log.info("clinical evaluation", totals);
    return totals;
  },
});
