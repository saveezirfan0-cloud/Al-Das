import { z } from "zod";

import { deriveChronicConditionsForOrg } from "@/lib/clinical/chronic-store";
import { evaluateRecentVisits, loadClinicalSettings } from "@/lib/clinical/engine";
import { SEQUENCE_STEPS, type SequenceStep } from "@/lib/clinical/sequence";
import { planPendingSequences, processSequenceStep } from "@/lib/clinical/sequence-store";
import { registerHandler } from "@/lib/jobs/registry";
import { registerTask } from "@/lib/jobs/tasks";
import { PermanentJobError } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";

/** Orgs that have the clinical settings seeded take part in the clinical jobs. */
async function clinicalOrgs(admin: AdminClient): Promise<string[]> {
  const { data: orgs } = await admin.from("orgs").select("id");
  const out: string[] = [];
  for (const org of orgs ?? []) {
    const { count } = await admin
      .from("clinical_settings")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id);
    if (count) out.push(org.id);
  }
  return out;
}

/**
 * /api/jobs/clinical_evaluate (pg_cron every 10 min): evaluate each org's recent visits, then plan the
 * antibiotic sequences of new prescriptions. Unchanged visits are skipped by their inputs hash, so this is
 * also how a newly signed-off setting reaches visits that were evaluated earlier. It only fills the internal
 * Follow-Up Queue and schedules sequence steps; it never sends a patient message (the steps go through the
 * gate, lib/clinical/engine.ts dispatchClinicalMessage).
 */
registerTask("clinical_evaluate", {
  name: "clinical.evaluate",
  async run(admin, log) {
    const totals = { checked: 0, evaluated: 0, created: 0, sequences: 0, steps: 0 };
    for (const orgId of await clinicalOrgs(admin)) {
      const r = await evaluateRecentVisits(admin, orgId, { sinceDays: 30, limit: 500 });
      totals.checked += r.checked;
      totals.evaluated += r.evaluated;
      totals.created += r.created;
      const s = await planPendingSequences(admin, orgId, { limit: 200 });
      totals.sequences += s.created;
      totals.steps += s.scheduled;
    }
    log.info("clinical evaluation", totals);
    return totals;
  },
});

/**
 * /api/jobs/clinical_nightly (00:45 Asia/Dubai): chronic conditions from visit diagnoses for every patient
 * (lib/clinical/chronic.ts), and a catch-up sequence sweep. Counts only in the result.
 */
registerTask("clinical_nightly", {
  name: "clinical.nightly",
  async run(admin, log) {
    const totals = {
      orgs: 0,
      derived: 0,
      inserted: 0,
      removed: 0,
      linked: 0,
      sequences: 0,
      unsigned: 0,
    };
    for (const orgId of await clinicalOrgs(admin)) {
      totals.orgs++;
      const settings = await loadClinicalSettings(admin, orgId);
      const r = await deriveChronicConditionsForOrg(admin, orgId, { settings });
      totals.derived += r.derived;
      totals.inserted += r.inserted;
      totals.removed += r.removed;
      totals.linked += r.linked;
      if (r.missingSettings.length) totals.unsigned++;
      const s = await planPendingSequences(admin, orgId, { limit: 1000, settings });
      totals.sequences += s.created;
    }
    log.info("clinical nightly", totals);
    return totals;
  },
});

/**
 * `clinical` queue: scheduled_jobs of kind 'clinical.sequence_step' arrive as
 *   { kind, org_id, scheduled_job_id, attempt, payload: { sequence_id, step } }
 * Idempotent: the sequence status and the message idempotency key decide. With the clinical messaging gate
 * OFF the step records "skipped_gate_off" and only a suppressed would-send row is logged.
 */
const stepJob = z.object({
  kind: z.literal("clinical.sequence_step"),
  org_id: z.string().uuid(),
  payload: z.object({
    sequence_id: z.string().uuid(),
    step: z.enum(SEQUENCE_STEPS as [SequenceStep, ...SequenceStep[]]),
  }),
});

registerHandler({
  queue: "clinical",
  name: "clinical.sequence_step",
  batchSize: 25,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = stepJob.safeParse(raw);
    if (!parsed.success)
      throw new PermanentJobError(`invalid clinical job: ${parsed.error.issues[0]?.message}`);
    const { org_id, payload } = parsed.data;
    const r = await processSequenceStep(ctx.admin, {
      orgId: org_id,
      sequenceId: payload.sequence_id,
      step: payload.step,
    });
    ctx.log.info(
      r.outcome === "skipped_gate_off" ? "sequence step skipped: gate off" : "sequence step",
      { step: payload.step, outcome: r.outcome, reason: r.reason },
    );
  },
});
