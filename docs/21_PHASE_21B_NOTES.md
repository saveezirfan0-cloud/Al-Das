# Phase 21B notes: chronic recall aligned with how Airtable really works

_Built 13 Oct 2026 on a branch from `claude/funny-clarke-6t7gee` (`e677e37`). Evidence: a live read of the Airtable Unite base `app7QJ2pvhADHQeBP` (schema, field configs, automations and their run history, aggregate counts only) and the Make blueprint of "Update Chronic" (4210055), 13 Oct 2026. No patient value was copied. Builds on `docs/21_PHASE_21A_NOTES.md`._

Only clear fixes are built. Everything that changes who is messaged for a clinical reason is left as a decision (OQ-104 (4) to (7)).

## What the evidence showed

| Finding | Evidence |
|---|---|
| The patient-level "Chronic Diagnosis" list is **not** filled by Unite. Make "Update Chronic" (inactive since 8 Sep 2026) watched new Medical Records rows and added **every** visit diagnosis to the patient's list, with no filter on the Diagnosis `Chronic` flag. It holds 1,365 non-chronic codes against 37 chronic ones; 3,000 of the 3,634 patients with a link have only non-chronic codes | Patients.`Chronic Diagnosis` `fld9gw5nJNzgywljY`; Diagnosis.`Unite` `fldrYIl9ThLNImcZZ`; Diagnosis.`Chronic` `fldIGBzWtu2QFP0Yk`; Make 4210055 |
| "Chronic" only enters through `Chronic Recall Groups`, which reads `Mapped condition group` (set on exactly the 762 Chronic-flagged codes) and strips Depression (major) and Anxiety disorders. One coded visit is enough; nothing is ever removed | `fldTnPcF0Y96Oe5so`, `fldyz11Dj5wK2y2S8`, `fldCLyNOOBpbLAkGp` |
| Days count from the patient-level Unite `Last Visit Date`, not from visits. 150 of the 445 patients eligible today have no visit row at all | `Time Elapsed (Days)` `fld9DJRSuMhP0uyv2` = `TODAY() - {fldwTnnvCipJeVvco}` |
| `Chronic Recall Sent On` is set once and never cleared (once per patient, ever). Each history row keeps the last visit date at send | `fldGJULCGakWZOt5S`; Chronic Recall Messages `fld6a8W0nUzktk9o5` |
| All 56 sends went to patients with `60 days >` = True, a flag set by Airtable automation `wflJ8HcmP16BqEv7z` when a visit's medication has 60 or 90 dosage days. The view "Chronic" (`viwXMAipcLg0wpcVt`) appears to filter on it; the API does not expose view filters | `fldXbiS53VgVfJaq3`; automation run history |
| `Chronic Status` = Yes means "touched by Update Chronic" (1,273 patients), not "has a chronic condition" | `fld0NR4XBFjQG6D4j` |
| Automation `wflwgvvZP4J8Kvg8K` appends ~33 patient fields to the Google Sheet "Chronic" whenever a patient enters the view "Chronic" (39 runs, 10 Aug to 28 Sep 2026) | OQ-41 |

## What changed

| Piece | Change |
|---|---|
| Importer `scripts/import/tables/clinical.ts` (`unite.patient_chronic_diagnoses`) | Keeps a patient–diagnosis link only when the diagnosis is flagged chronic (`chronicFlagSkip`; a blank flag is not chronic). Skipped links are counted per reason (`not_chronic`, `chronic_flag_unknown`) in the dry-run and reconciliation report |
| Importer `scripts/import/mappers/airtable.unite-patients.ts`, `scripts/import/patients.ts` | Unite's `Last Visit Date` is also written to the new typed column `contacts.unite_last_visit_date` (only a real calendar date; otherwise the warning `invalid last visit date`). The custom field `last_visit_date` ("Last visit (Unite)") stays for display |
| History importer `scripts/import/tables/pending-logs.ts` (`campaigns.chronic_recall`, still pending) | `cycle_key` = `last_visit_date_at_send`, so an imported send blocks the cycle the recall view checks; the send date is only a fallback, counted as `cycle_key_from_sent_date` |
| Migration `20261108000300_chronic_alignment.sql` (paste `deploy/supabase-paste/43_chronic_alignment.sql`) | See below |
| Pure rules `lib/clinical/chronic.ts` | `chronicFlagSkip` (used by the visit rule and the importer), `effectiveLastVisitDate` (the later of two real dates, else null), `isCalendarDate`; the visit rule now also refuses impossible dates; header corrected |
| Parallel run | The chronic recall section of the report states the differences expected by design (`EXPECTED_DIFFERENCES` in `lib/parallel-run/diff.ts`) |

### Database

- **`contact_chronic_conditions`** refuses a diagnosis that is not flagged chronic, from any source (trigger `contact_chronic_conditions_require_chronic`, after the org checks). Rows already stored from the **Airtable import** whose diagnosis is not chronic are deleted with their `external_refs`, so a re-import (which now skips them) reconciles. Rows from any other source are left in place and are not counted: **`v_chronic_recall_eligibility`** reads chronic-flagged diagnoses only (`d.chronic is true`), whichever source wrote the row and even if a diagnosis is unflagged later. Chosen because the import rows are known to be copies of every visit diagnosis, while a manual or Unite row is someone's record and should not vanish silently.
- **`contacts.unite_last_visit_date date`**, backfilled from `custom->>'last_visit_date'` through `app.safe_ymd_date` (anything that is not a real `YYYY-MM-DD` date is ignored). The backfill touches `contacts.updated_at` for those rows. Erasure clears it (trigger on `erased_at`); a merge carries the later date to the surviving record (trigger on `merged_into_id`), both as triggers so a later rewrite of `erase_contact` / `merge_contacts` cannot forget them.
- **`v_contact_visit_stats`**: `last_visit_date` = the later of the latest non-test Pulse visit and `unite_last_visit_date`; patients with only the Unite date are included (`visit_count` 0). Two columns appended: `pulse_last_visit_date`, `unite_last_visit_date`. The chronic recall `cycle_key` follows (it is `last_visit_date`). Its generated type no longer lists foreign-key relationships (the contact id is now a `coalesce`); nothing embeds it.
- **`v_recall_call_list`**: `call_now` also needs `booked_at is null`, so a booked patient never appears, whatever the follow-up status says.
- **`chronic_condition_min_visits`**: the description now says the list was filled from visits by Make, not by Unite (only rows still carrying the original text are updated; the seed function carries the new text). **Not signed, value unchanged.**
- **Unite sync**: `lib/unite/*` maps no patient last-visit date (the patient payload it reads has none), so only the importer writes the column for now. When the Unite visits / patients feed (OQ-23 / OQ-26) carries one, set `unite_last_visit_date` there with the same calendar-date check.

## Expected effect on counts (parallel-run report)

Once `chronic_recall_min_days` (OQ-01) and `chronic_condition_min_visits` (OQ-104 (1)) are signed and the programme runs in Test mode, Pulse will select **more patients than Make**, by design:

- patients with a chronic-coded visit that Make never added to their list (about 170 with a chronic-coded visit and no messageable group on the list);
- patients the Airtable view leaves out through `60 days >` (Make sent to 56 patients, all `60 days >` = True, while 445 were formula-eligible; 20 eligible and True were still unsent);
- the 150 formula-eligible patients with no visit row are now **kept** (before 21B Pulse dropped them).

Pulse will select **fewer** where it is stricter: opted-out and test records, the mental-health-only groups (as Airtable), and, in Live mode, patients without `clinical_messaging_consent` (OQ-104 (6)). Patients Airtable already messaged are blocked for the same last-visit date only (OQ-104 (5)). The chronic recall section of Recall → Parallel run shows this text above the day-by-day table; each day still needs a person to explain it.

## Decisions left open (not changed by the build)

Recorded as OQ-104 (4) to (7) in `docs/audit/open-questions.md`:

4. `60 days >` (60/90-day prescription, automation `wflJ8HcmP16BqEv7z`): adopt as a clinical setting or not.
5. Once ever (Airtable) or once per last-visit cycle (Pulse).
6. Consent: `chronic_90d` requires `clinical_messaging_consent` in Live mode; after the import only test records have it, so live chronic recall would reach nobody. Drop the requirement for chronic recall (still honouring `stop_marketing`) or capture consent first.
7. Call list: Airtable counts the send day (`WORKDAY_DIFF(sent, today) >= 3`); Pulse calls one working day later.

Also still open: signing `chronic_condition_min_visits` (recommended 1, Airtable parity) and OQ-41 (both Unite-base automations go off at the cut-over freeze; the Google Sheet "Chronic" is deleted or archived; added to `docs/06_PHASE_11_CUTOVER.md` §5 and §8).

## How it was verified

- `tests/unit/clinical-phase21.test.ts`: chronic flag, last-visit fallback, calendar dates, impossible visit dates.
- `tests/unit/airtable-junction.test.ts`: a non-chronic and a blank-flag link on a patient's list are skipped and counted per reason.
- `tests/unit/airtable-mappers.test.ts`: the history `cycle_key` comes from the last-visit date at send; the fallback is counted.
- `tests/unit/import-mappers.test.ts`: the Unite patient mapper returns a typed last-visit date only for a real date.
- `tests/unit/parallel-run.test.ts`: the expected-differences text exists for comparable scenarios only.
- `tests/db/chronic-alignment.test.ts` (Postgres 16): the trigger refuses a non-chronic diagnosis from every source; a patient with no Pulse visit is eligible from the Unite date; the later date wins (parity with `effectiveLastVisitDate`); an unflagged diagnosis stops counting; an imported send blocks its cycle; a booked patient is not on the call list; merge carries and erasure clears the date; the setting text changed without a signature. `tests/db/phase21-clinical.test.ts` now stores a chronic code for its imported row.
- The migration's clean-up was checked by hand on the test database (a non-chronic Airtable row and its external ref removed, inside a rolled-back transaction).

## Before first use

1. Apply `deploy/supabase-paste/43_chronic_alignment.sql` after `40_finance_provider_file_ext.sql` (it does not depend on 41 or 42).
2. Re-run the patient and junction imports as a dry run (`pnpm import:airtable --dry-run --only=unite.patients,unite.patient_chronic_diagnoses`): the junction report shows the `not_chronic` skips; the real run then writes `unite_last_visit_date` for every patient.
3. The clinical lead answers OQ-104 (1) and (4) to (7) before chronic recall goes Live.
