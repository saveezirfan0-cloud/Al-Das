# Phase 21A notes: Make and Airtable replacement gaps that need no new data

_Built 13 Oct 2026 on a branch from `claude/funny-clarke-6t7gee` (`72147a6`). Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, section 3 item 11 and slice 21 items 2, 3, 5 and 6._

## What it closes

| Gap found in the audit | Now |
|---|---|
| Chronic recall selected nobody: `v_chronic_recall_eligibility` reads `contact_chronic_conditions`, which nothing wrote; there was no visit-diagnosis table; the importer kept Unite's chronic fields in custom fields only | `visit_diagnoses` table; Unite's patient-level Chronic Diagnosis list and every visit's diagnoses are imported; a signed-off rule derives chronic conditions from visit diagnoses (after ingest and nightly). A database test shows recall selecting the right synthetic patient |
| Antibiotic / probiotic sequences: `lib/clinical/sequence.ts` existed but nothing created `prescription_sequences` or scheduled the steps | Every live antibiotic prescription gets one sequence and its steps in `scheduled_jobs`, created once in one transaction; the steps run on a new `clinical` queue and go through the clinical messaging gate (still OFF) |
| `v_visit_data_quality` and `v_unclassified_medications` were never read; no feedback list | Portal → Data quality, Unclassified medications (with an audited classify action), Clinical feedback |
| `v_appointment_reminder_stats` was never queried; the Management dashboard lacked recall, clinical load and data quality | Reports: Appointment reminders (per doctor), Recall performance, Clinical operations; the same KPIs on the Management dashboard and in the digest e-mail |
| Parallel-run seed rows for Token and MRD sync said "not built" with reasons that cite Phase 6 | Corrected by the new migration (Token built; MRD sync blocked on the Unite visits feed) |

## What exists

| Piece | Where |
|---|---|
| Migration (paste file) | `supabase/migrations/20261027000100_phase21_clinical_gaps.sql` (`deploy/supabase-paste/26_phase21_clinical_gaps.sql`) |
| Chronic-condition rule (pure, unit-tested) | `lib/clinical/chronic.ts` |
| Rule runner: facts → rule → writer | `lib/clinical/chronic-store.ts` (`deriveChronicConditionsForOrg`) |
| Diagnosis-code ingest (pure) and the ingest path | `lib/clinical/ingest.ts` (`ingestDiagnosisCodes`), `lib/clinical/visit-ingest.ts` (`storeVisitDiagnoses`, `afterVisitIngest`) |
| Sequence schedule and step decisions (pure) | `lib/clinical/sequence.ts` (`sequenceSchedule`, `decideSequenceStep`) |
| Sequence planning and step runner | `lib/clinical/sequence-store.ts` (`planPendingSequences`, `processSequenceStep`) |
| Jobs | `lib/jobs/handlers/clinical.ts`: task `clinical_evaluate` (every 10 min, now also plans sequences), task `clinical_nightly` (00:45 Dubai: chronic conditions and a catch-up sweep), queue `clinical` (kind `clinical.sequence_step`) |
| Airtable import | `scripts/import/tables/clinical.ts` (`unite.visit_diagnoses`, `unite.patient_chronic_diagnoses`), junction runner `scripts/import/run-junction.ts` |
| Portal screens | `/portal/data-quality`, `/portal/unclassified-medications` (`actions.ts`: `classifyMedication`), `/portal/clinical-feedback` |
| Medication suggestion (legacy heuristic, hint only) | `lib/clinical/medication-class.ts` |
| Reports | `lib/reports/clinical-queries.ts`, registry keys `reminder-stats`, `recall-performance`, `clinical-operations`; `lib/reports/management.ts` |
| Help | guides `clinical-data-quality`, `clinical-feedback` (`lib/help/guides.ts`), What's new entry |

### Database

- **`visit_diagnoses`** (org, visit, contact, `ref_diagnosis_id` or null, `diagnosis_code`, `is_primary`, `source` unite / airtable / manual, `visit_date`), unique per visit and code. RLS: read needs `portal.clinical_visits.read` (health data), no write policy. Org-check triggers on visit, contact and reference; a trigger on `visits` keeps the contact and date in step (a visit linked later in Sync Review carries its diagnoses along).
- **`contact_chronic_conditions`** gained `id`, `evidence_visits`, `last_seen_on`, timestamps, a source check (unite, airtable, visit_diagnoses, manual) and org-check triggers. **Its RLS was tightened**: Phase 8 let every member read it; it now needs `portal.clinical_visits.read`, like visits. The recall engine reads it with the service role, so recall is unaffected.
- **`prescription_sequences.step_outcomes`**: what each scheduled step did (`{"ABX_DAY3": {"outcome": "skipped_gate_off", "reason": "clinical_messaging_not_signed_off", "at": …}}`); outcome words and reason codes only.
- **Functions** (service role only, `search_path = ''`): `clinical_store_visit_diagnoses`, `clinical_resolve_visit_diagnoses`, `clinical_chronic_facts`, `clinical_apply_chronic_conditions`, `clinical_prescriptions_needing_sequence`, `clinical_create_sequence`, and the reports `report_reminder_stats_by_specialist`, `report_reminder_stats_by_day`, `report_recall_week`, `report_clinical_followup_load`, `report_clinical_red_flags`, `report_clinical_data_quality`.
- **Views**: `v_visit_data_quality` gained `is_test_record`, `doctor_name`, `source`; new `v_unknown_diagnosis_codes`; `v_appointment_reminder_stats` gained delivered / read / replied and now buckets `sent_day` by the org's day.
- **Setting**: `chronic_condition_min_visits` (proposed 1, **awaiting sign-off**, OQ-102). `seed_clinical_settings` now calls the Phase 6 seed (renamed `seed_clinical_settings_phase6`) and `seed_clinical_settings_phase21`; existing workspaces got the row at migration time.
- **Queue and cron**: `pgmq.create('clinical')`, `pulse:clinical` (30 s), `pulse:clinical_nightly` (20:45 UTC).

## The rules

**Chronic conditions (R-20 input).** A diagnosis whose reference row is flagged `chronic`, coded on at least `chronic_condition_min_visits` separate non-test visits of the patient, is one of that patient's chronic conditions (`source = 'visit_diagnoses'`, `noted_at` = first such visit). Fail closed: an unknown code, a blank or false chronic flag, a visit without a patient or a date never counts, and while the threshold is unsigned (or not a whole number of at least 1) nothing is derived, so the writer removes every derived row. Rows from Unite, the Airtable import or a person are never removed by the rule. Medication classes are **not** used: the audit defines no chronic medication class (OQ-102 asks). The recall view then applies R-20 … R-22 as before (messageable group, `chronic_recall_min_days`, phone, `stop_marketing`, test records, one send per cycle).

**Sequences (R-13 … R-17).** Only prescriptions from the live Unite feed (`source = 'unite'`) whose class is `antibiotic` (by code, R-05); imported history is never sequenced. `planSequence` gives the dates; the steps are ABX_DAY3 (day-3 check date), NO_REPLY_CHECK (antibiotic end + 1), PROBIOTIC_START (end + 1, only if the drug's class row says probiotics by default) and TREATMENT_OUTCOME (probiotic end). A step without a date (unsigned offset or duration, no probiotics) is not scheduled; a step whose day has passed is skipped, never sent late. Steps are queued at 10:00 clinic time (`SEQUENCE_STEP_LOCAL_TIME`, an operational constant, not a clinical threshold). An antibiotic with no duration gets a sequence with no dates and an internal follow-up (BC-22).

When a step runs, `decideSequenceStep` checks the status (ABX_DAY3 only from `not_started`; PROBIOTIC_START never after a halt or an unclear reply; TREATMENT_OUTCOME only after the probiotic message went), then every patient message goes through `dispatchClinicalMessage`: **with the gate off it logs a `suppressed_gate` would-send row, records `skipped_gate_off` on the sequence and sends nothing**; the status does not move. Test send mode still keeps real patients out when the gate is on. The idempotency key is `<prescription external key>:<template key>`, so a retry or a later gate change never sends an old step. NO_REPLY_CHECK raises one nurse call task when the day-3 check was sent and nothing came back by the end of the course (R-17); it is internal, so the gate does not apply.

**Classifying a medicine.** A person with `portal.medication_classes.write` picks the class (never "unclassified") and ticks that they checked the drug; the action writes `ref_medication_classes` through `createAdminClient(userId)` (record history names them), moves that code's still-unclassified prescriptions to the class and writes `recordAudit` (code, classes, count; no patient). The old Make heuristic is shown as a hint and never applied.

**Report definitions** are in `docs/audit/reports.md` §5.1d.

## How it was verified

- `tests/unit/clinical-phase21.test.ts` (12): the chronic rule (unsigned, unsigned-defaults, bad thresholds, minimum visits, every fail-closed case, merging and order), diagnosis-code ingest, the sequence schedule (BC-21 dates, passed days, unsigned settings, no probiotics, TP-19, BC-22) and step decisions (R-15, R-17), the medication hint.
- `tests/unit/clinical-sequence-jobs.test.ts` (5): a step with the gate OFF logs `suppressed_gate`, records `skipped_gate_off`, sends nothing and logs nothing twice on retry; gate on in test mode; halted probiotic; one nurse task; missing sequence.
- `tests/unit/airtable-junction.test.ts` (4): one row per link with the primary flag, unmatched links reported, merged patients, idempotent re-run, dry run writes nothing, `--only` by entity.
- `tests/db/phase21-clinical.test.ts` (11, Postgres 16): the seed; storing codes idempotently with unknown codes visible; late linking and the visit trigger; PHI RLS (a `contacts.view` member sees nothing, other org nothing, no user writes, cross-org references refused); **chronic recall selects nobody while the rule is unsigned and exactly the right synthetic patient once signed** (stop-marketing and mental-health-only patients excluded); derived rows removed when the rule changes, imported rows kept, another org's rows rejected; a sequence planned once from the live feed only with four durable steps; every report function's counts and that signed-in users cannot call them; the parallel-run seed; the junction importers against the real schema (adopting the Unite row).
- `tests/db/security-guard.test.ts` sweeps `visit_diagnoses` and `contact_chronic_conditions` (`PHASE21_TABLES`, `seedPhase21Rows`); `tests/db/jobs.test.ts` knows the two new cron entries; the digest test checks the clinical KPIs.
- `pnpm typecheck`, `pnpm lint`, the unit suite, the database suite and `pnpm audit:security` (0 unguarded actions).

## Not verified

- Not clicked through in a browser (no Supabase auth stack in the build sandbox).
- `storeVisitDiagnoses`, `afterVisitIngest`, `planPendingSequences` and the `clinical_nightly` task run through supabase-js and need PostgREST to test end to end; their SQL is covered by the database test and their logic by the unit tests.
- No real data: every visit, diagnosis and patient in the tests is synthetic. How Unite fills its own Chronic Diagnosis list is unknown.

## Not done in this slice (and why)

- **Unite visits / diagnoses / prescriptions sync** (item 1): Unite has not documented the visits endpoint (OQ-23 / OQ-26). `lib/clinical/visit-ingest.ts` is the seam it will call after storing a visit.
- **Day-3 replies** are not yet routed from the inbox into `applyDay3Reply`, and the sequence templates are sent without variables (a template that needs variables is blocked as `template_variables_missing`). Both matter only once the gate opens and the template texts are clinically approved.
- **RX_START** is not scheduled: no rule in `docs/audit/clinical-rules.md` defines when it is sent.
- **Message-log importers** (item 4), **screening eligibility views** (item 8), **parallel run and switch-off** (item 9).
- **Labs** (item 7): the Patient Treatment base has two live Airtable automations, **"Lab Result Ready"** and **"Lab Follow Up"**, that run custom scripts when a lab order's status changes. They are covered by **OQ-98** (export the scripts, find out whether they message patients) and are not built here.

## Before first use

1. Apply `deploy/supabase-paste/26_phase21_clinical_gaps.sql` to the Pulse project (after `22_finance_flash.sql`).
2. Import the two junctions once Airtable access exists: `pnpm import:airtable --dry-run --only=unite.visit_diagnoses,unite.patient_chronic_diagnoses`, then the same without `--dry-run`. They need the Diagnosis, Medical Records and Unite patient tables imported first.
3. The clinical lead signs `chronic_condition_min_visits` (OQ-102) and `chronic_recall_min_days` (OQ-01) in Portal → Clinical settings. Until both are signed chronic recall selects nobody from visit data.
4. Classify the codes on Portal → Unclassified medications (antibiotics first). Until then no sequence is planned for them.
5. Clinical messages stay OFF. Opening the gate still needs the steps in `docs/06_PHASE_6_NOTES.md` ("Before this goes live"): signed BLOCKING settings, approved template texts, a test-mode run.
6. Check Portal → Data quality after the first visit sync and fix missing vitals in Unite.
