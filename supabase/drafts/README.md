# Draft migrations — core clinical tables (Phase 0)

These are **drafts**, deliberately kept out of `supabase/migrations/`. They reference tables that Phase 1 (`orgs`, `memberships`, `profiles`, `teams`), Phase 2 (`contacts`), Phase 3 (`messages`), Phase 4 (`wa_templates`) and Phase 6 (`locations`, `specialists`, `appointments`, `appointment_reminders`) create. In Phase 6 they are copied into `supabase/migrations/` with timestamp prefixes, applied with `pnpm db:migrate`, and never edited again.

| File | Creates |
|---|---|
| `0100_clinical_reference.sql` | `is_org_member()`, `set_updated_at()`, `ref_condition_groups`, `ref_diagnoses`, `ref_medications`, `ref_items`, `ref_medication_classes`, `seed_condition_groups()` |
| `0101_clinical_settings.sql` | `clinical_settings` (+ history/audit trigger), fail-closed accessors `clinical_setting()`, `clinical_setting_num()`, `clinical_setting_bool()`, `seed_clinical_settings()` with the 30 live Airtable parameters + engine/recall settings |
| `0102_visits_prescriptions.sql` | `clinic_calendar` + workday functions, `visits`, `visit_diagnoses`, `visit_items`, `contact_chronic_conditions`, `contact_regular_medications`, `prescriptions`, `prescription_sequences`, `visit_rule_evaluations`, views `v_visit_data_quality`, `v_unclassified_medications` |
| `0103_clinical_followups.sql` | `clinical_followups`, `clinical_feedback`, `clinical_message_log`, `clinical_call_scripts`, view `v_followup_queue` |
| `0104_recall.sql` | `recall_programmes`, `recall_programme_templates`, `recall_sends`, views `v_contact_visit_stats`, `v_chronic_recall_eligibility`, `v_birthday_today`, `v_recall_call_list`, `v_recall_weekly`, `seed_recall_programmes()` |
| `0105_appointment_reminders_ext.sql` | `unite_appointment_status_map`, `reminder_exclusions` (+ `is_reminder_excluded()`), extra columns on `appointments` / `appointment_reminders`, view `v_appointment_reminder_stats` |

Design rules applied to every table: `org_id` + RLS policy through `is_org_member(org_id)`, `created_at`/`updated_at` with trigger, natural keys for idempotent imports (`external_id`, `external_key`, `dedupe_key`, `idempotency_key`), enums for closed vocabularies, views created `with (security_invoker = true)` so RLS applies through them. Thresholds are never in SQL: views call `clinical_setting_num()`, which returns NULL (nobody eligible) until a value is approved or the org opts into unsigned defaults.

## Validate locally

```
supabase/drafts/validation/run.sh            # local cluster, creates db pulse_drafts_check
DATABASE_URL=postgres://... supabase/drafts/validation/run.sh
```

`validation/stubs_phase1_2_6.sql` creates minimal stand-ins for the core tables and `auth.uid()`; `validation/smoke_tests.sql` seeds two orgs with **synthetic** data and asserts: seeds complete, fail-closed accessor, chronic eligibility at 30/85/90 days and after a send, call-list flags, dedupe/idempotency/constraint violations, workday maths with a custom calendar, and cross-org RLS denial through tables and views. All drafts are idempotent (re-applied in the run).

## Seeds per org (importer or Phase 1 org bootstrap)

```sql
select public.seed_condition_groups(:org);
select public.seed_clinical_settings(:org);
select public.seed_recall_programmes(:org);
select public.seed_reminder_exclusions(:org);
select public.seed_unite_appointment_status_map(:org);
```

Fake data only. No patient data anywhere in this folder.
