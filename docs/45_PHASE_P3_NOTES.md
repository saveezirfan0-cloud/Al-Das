# Phase P3 notes: Patient 360 page (docs/45)

## What was built
- `/contacts/[id]` (needs `contacts.view`): header (name, age, gender, Unite PIN, home branch, life stage, chronic badges,
  consent chips, household, next appointment) and tabs Overview, Appointments, Visits & medical record, Conditions &
  medicines, Care & follow-ups, Conversations, Enquiries & marketing, Billing & insurance, Documents, Tasks & notes,
  Household. A tab appears only when the member holds its permission and loads when opened.
- Existing tab components are reused unchanged (appointments, conversations, enquiries, tasks, history, invoices,
  documents). New: `app/(app)/contacts/[id]/clinical-actions.ts` (visits, conditions and medicines, care, overview card),
  `overview-actions.ts` (campaigns received), `lib/contacts/patient-360.ts` (pure helpers) and
  `lib/contacts/patient-360-server.ts` (header loader).
- Migration `20261220000100_clinical_view.sql` (paste file `deploy/supabase-paste/100_clinical_view.sql`): grants
  `clinical.view` to the system roles Doctor, Medical Director, Care coordinator of existing workspaces, and lets the
  SELECT policies of `visits`, `visit_diagnoses`, `prescriptions`, `contact_chronic_conditions`, `clinical_followups` and
  `clinical_feedback` accept `clinical.view` as well as the old portal key. `visits` also follows
  `app.location_visible_to` (a visit with no branch stays visible). Write policies are untouched.
- "Open full record" in the contact drawer and a small link icon in the grid's name cell.

## Decisions
- Clinical actions need `contacts.view` AND `clinical.view` (`clinicalMember()`), read through the member's own client, cap
  pages (15 visits, 40 medicines, 30 care rows), and call `recordAccess` with `{ tab }` only. `recordAccess` now dedupes
  per tab (a different tab is a new row; a refresh of the same tab is not).
- Notes come from `visits.observation_notes_scrubbed` only (capped at 2000 characters). Raw notes, doctor/nurse notes,
  feedback reply text and recall message bodies are never selected (a unit test greps for it).
- "Medicine running now" is derived from start date + duration; missing data gives "unknown", never "current".
- Life stage uses `DEFAULT_LIFECYCLE_THRESHOLDS` through `headerLifecycle()` in `lib/contacts/patient-360.ts`; swap in the
  organisation's thresholds there when the settings loader lands. The stage is derived from `v_contact_visit_stats` with the
  service role (org and contact scoped; only the derived label leaves the server), so members without `clinical.view`
  still see the stage but no dates.
- Ctrl+K still opens the drawer (`/contacts?contact=<id>`): quick look first, with the "Open full record" button. Changing
  `recordHref` would break the fast path used by other pages (`tests/unit/record-search.test.ts`).
- Help: the guide `patient-record` is matched by path shape in `guideForPath` (the path carries an id).

## Not built
_Follow-up 17 Oct 2026: all of this is closed except allergies, see `docs/45_PHASE_P_FOLLOWUP_NOTES.md`._
- Allergies: no source table exists; the tab says so.
- Insurance claim status per patient (the Billing tab shows invoices only).
- Balance in the header (finance roles only) and "campaigns in the last 90 days" on the Overview.
- Appointment status history ("each status change") waits for P7.
- Live data: the page is built on synthetic rows; real visits arrive with P1/P2.
