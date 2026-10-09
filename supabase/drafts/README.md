# Draft migrations — core clinical tables (Phase 0)

> **Status:** `0100`–`0102` and `0105` were superseded by Phase 6 (`20261009000900`–`…000960`). `0104` (recall) shipped in Phase 8 as `20261009001200_recall.sql`, plus `20261009001100_recall_reference.sql` for the condition-group / diagnosis / calendar pieces. `0103` is also covered by Phase 6 (`clinical_followups`, …). These files are kept for reference only. See `docs/06_PHASE_8_NOTES.md`.

These are **drafts**, deliberately kept out of `supabase/migrations/`. They build on the Phase 1 foundation that is already applied (`app.set_updated_at`, `app.is_org_member`, `app.has_perm`, `orgs`, `roles`, `memberships`, `teams`, `profiles`) and reference tables that Phase 2 (`contacts`), Phase 3 (`messages`), Phase 4 (`wa_templates`) and Phase 6 (`locations`, `specialists`, `appointments`, `appointment_reminders`) create. In Phase 6 they are copied into `supabase/migrations/` with timestamp prefixes, applied with `pnpm db:migrate`, and never edited again.

> **Promotion status.** Phase 6 promoted the helpers (`app.has_perm_wild`, `app.add_tenant_rls`), `clinical_settings`, `ref_medication_classes`, visits, prescriptions, sequences, follow-ups, feedback, message log and call scripts (`20261009000900`–`…0960`). Phase 9 promoted `ref_condition_groups`, `ref_diagnoses`, `ref_medications`, `ref_items` and `seed_condition_groups()` (`20261010000400_portal_ref_tables.sql`). **Still drafts:** `0102` leftovers (`clinic_calendar`, `visit_diagnoses`, `visit_items`, `contact_chronic_conditions`, `contact_regular_medications`), `0104_recall.sql`, and the rest of `0105`. Check `supabase/migrations` before promoting anything.

| File | Creates |
|---|---|
| `0100_clinical_reference.sql` | `app.has_perm_wild()` (wildcard-aware permission check), `app.add_tenant_rls()` (Phase 1-style per-operation policies + updated_at trigger), `ref_condition_groups`, `ref_diagnoses`, `ref_medications`, `ref_items`, `ref_medication_classes`, `seed_condition_groups()` |
| `0101_clinical_settings.sql` | `clinical_settings` + `clinical_settings_history` (audit trigger), fail-closed accessors `clinical_setting()`, `clinical_setting_num()`, `clinical_setting_bool()`, `seed_clinical_settings()` with the 30 live Airtable parameters + engine/recall settings |
| `0102_visits_prescriptions.sql` | `clinic_calendar` + workday functions, `visits`, `visit_diagnoses`, `visit_items`, `contact_chronic_conditions`, `contact_regular_medications`, `prescriptions`, `prescription_sequences`, `visit_rule_evaluations`, views `v_visit_data_quality`, `v_unclassified_medications` |
| `0103_clinical_followups.sql` | `clinical_followups`, `clinical_feedback`, `clinical_message_log`, `clinical_call_scripts`, view `v_followup_queue` |
| `0104_recall.sql` | `recall_programmes`, `recall_programme_templates`, `recall_sends`, views `v_contact_visit_stats`, `v_chronic_recall_eligibility`, `v_birthday_today`, `v_recall_call_list`, `v_recall_weekly`, `seed_recall_programmes()` |
| `0105_appointment_reminders_ext.sql` | `unite_appointment_status_map`, `reminder_exclusions` (+ `is_reminder_excluded()`), extra columns on `appointments` / `appointment_reminders`, view `v_appointment_reminder_stats` |

## Conventions (same as Phase 1)

- Every table has `org_id`, RLS enabled, and `<table>_select` for active org members (`app.is_org_member`).
- Tables staff edit in the portal get `<table>_insert/_update/_delete` policies gated on a permission key through `app.has_perm_wild` (honours `*`, `portal.*`, `portal.*.read`). Tables written only by the Unite sync, the importer or the clinical engine have **no** write policy: the service role writes them after `can()` checks, exactly like the Phase 1 jobs tables.
- Permission keys used (to be added to `lib/auth/permissions.ts` in Phase 6, OQ-46): `clinical.settings.manage`, `portal.clinical_followups.write`, `portal.clinical_feedback.write`, `portal.recall_sends.write`, `portal.medication_classes.write`, `portal.clinic_calendar.write`, `portal.prescription_sequences.write`, plus the existing `appointments.manage`, `campaigns.create`, `templates.manage`.
- `created_at`/`updated_at` with the `app.set_updated_at` trigger; natural keys for idempotent imports (`external_id`, `external_key`, `dedupe_key`, `idempotency_key`); enums for closed vocabularies; views `with (security_invoker = true)` so RLS applies through them; seed functions are `service_role` only.
- Thresholds are never in SQL: views call `clinical_setting_num()`, which returns NULL (nobody eligible) until a value is approved or the org opts into unsigned defaults.

## Validate locally

```
supabase/drafts/validation/run.sh            # local cluster, creates db pulse_drafts_check
DATABASE_URL=postgres://... supabase/drafts/validation/run.sh
```

The runner applies `supabase/test/auth-stub.sql`, the real Phase 1 migrations (extensions/helpers, tenancy, jobs), `validation/stubs_phase2_6.sql` (minimal contacts / locations / specialists / messages / wa_templates / appointments), then the drafts twice (idempotency), then `validation/smoke_tests.sql`. The smoke tests create two orgs through the Phase 1 `create_org` RPC with **synthetic** data and assert: seeds complete and audited, fail-closed accessor, chronic eligibility at 30/85/90 days and after a send, call-list flags, dedupe/idempotency/constraint violations, workday maths with a custom calendar, and RLS as PostgREST evaluates it (`set role authenticated` + `request.jwt.claims`): an Agent reads only their org and cannot write portal objects or sign off settings; a Coordinator with `portal.*` + `clinical.settings.manage` can edit the queue and call list and sign off a setting (audited) but still cannot write engine-owned tables.

## Seeds per org (importer or Phase 1 org bootstrap, service role)

```sql
select public.seed_condition_groups(:org);
select public.seed_clinical_settings(:org);
select public.seed_recall_programmes(:org);
select public.seed_reminder_exclusions(:org);
select public.seed_unite_appointment_status_map(:org);
```

Fake data only. No patient data anywhere in this folder.
