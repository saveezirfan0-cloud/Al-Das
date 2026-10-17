# Track P, slices P4 (lifecycle stage) and P5 (segments v2)

_17 Oct 2026. Synthetic data only. Read with `docs/45_PATIENT_JOURNEY_AND_ECOSYSTEM_PLAN.md` (section 3, P4 and P5)._

## What was built

**P4, lifecycle stage**
- The rule is `lifecycleStage()` in `lib/contacts/lifecycle.ts` (lead, new patient, active, lapsed, not enough visit data). Its SQL twin is `app.contact_lifecycle_stage()`, used by the `security_invoker` view `public.v_contact_lifecycle (org_id, contact_id, stage)`. They are parity-tested on `tests/unit/contacts/fixtures/lifecycle.synthetic.json` (`tests/unit/contacts/lifecycle-parity.test.ts`, `tests/db/lifecycle-segments.test.ts`). Change both together.
- Thresholds: `orgs.settings.lifecycle` `{ newPatientDays: 90, activeMonths: 18 }` (bounds 1 to 365 and 1 to 60). `lib/contacts/lifecycle-settings.ts` reads and writes; `app.lifecycle_thresholds()` reads the same keys. An unreadable block means both defaults. Edited at Settings, Patient lifecycle (`settings.manage`, audited with field names only).
- Inputs: `v_contact_visit_stats` (first visit is Pulse visits only; last visit already merges Unite's patient-level date) and `contacts.external_id` as the PIN. "Today" is the org's timezone day (`app.org_today`, falls back to UTC for an unreadable zone).
- `loadLifecycleStages(client, orgId, contactIds)` and `loadChronicFlags(...)` in `lib/contacts/lifecycle-load.ts` are for Patient 360. Chronic flag = a row in `contact_chronic_conditions`. With a member's own client they follow RLS (visits are gated by `portal.clinical_visits.read`), with the admin client call `can(member, 'clinical.view')` first.
- Patients grid: optional "Lifecycle" column (hidden by default), loaded only for members with `clinical.view` (`queryContacts({ withLifecycle })`).
- Duplicates: nothing built. Sanoflow lead to Unite patient matching on phone and PIN waits for P1 data (the Airtable import) and the Sanoflow export; building it now would be guessing. The existing `merge_contacts` / `contact_duplicate_candidates` / `sync_reviews` flow is unchanged.

**P5, segment filters** (all in `lib/filters/field-registry.ts`, group "Patient")

| Field | Source | Clinical |
|---|---|---|
| `age_band` (0_11, 12_17, 18_34, 35_49, 50_64, 65_plus, unknown) | `v_contact_age_band` | no |
| gender, home branch | existing fields | no |
| `lifecycle_stage` | `v_contact_lifecycle` | yes |
| `last_visit` | `v_contact_visit_stats` | yes |
| `visit_count` | count of `v_contact_visit_segments` (real, non-test visits) | yes |
| `visit_doctor`, `visit_department` | `v_contact_visit_segments` | yes |
| `chronic_condition` (chronic list, by condition group) | `v_contact_diagnosis_groups` source `chronic` | yes |
| `diagnosis_group` (any coded visit diagnosis) | `v_contact_diagnosis_groups` source `visit` | yes |

- Every `FieldDef` now has `clinical: boolean`. Conservative rule: anything derived from visits, visit dates, doctors, departments, diagnoses or the chronic list is clinical, so lifecycle is clinical too. Age band and gender are not.
- **Insurer: left out.** There is no reliable source (nothing in `contacts.custom`, and finance tables carry the PIN only by design). Add it when a source is agreed.
- Clinical fields are available only to members with `clinical.view`: the Patients page, list, select-all, filter count, segment save and export build their registry with `clinical: false` otherwise, so the compiler rejects them. System paths (campaign audiences, segment counts) use the full registry.

## The consent rule (enforced on the server)

`lib/campaigns/audience-purpose.ts`: `audiencePurposeProblem(filter, purpose, registry)` returns a reason or null. An audience has a purpose, `care` (recall, follow-up) or `marketing` (campaigns), **default marketing**. A filter with any clinical field, or an unknown field, is refused for marketing. It is checked in `segmentAudience()` (`lib/campaigns/audience.ts`) before anything is counted or written, so it covers previews, the recipient snapshot at campaign creation and recurring runs, including a filter stored in a saved segment. Campaign actions pass no purpose, so campaigns are always marketing. Care callers pass `purpose: 'care'`. The segment dialog shows "Care programmes only (recall and follow-up), not marketing." when a clinical field is in use. The AI campaign copilot is unaffected (it only sees its own allow-list of fields).

**Recommendation (needs signing by the clinical lead and management before it is relied on):** clinical data is used for care programmes only, never for marketing, unless the patient has given explicit consent that covers it. The code implements the strict version; a consent-based exception would need a per-patient consent record and a new purpose, which does not exist.

## Deliberately not done / known limits
- **Static segments** are hand-picked lists (the grid's "Add to segment" works from whatever filter the person had on screen). The rule cannot see how a static segment was filled, so a static segment filled from a clinical filter could be used in a campaign. Closing this needs a `care_only` mark on the segment (a column) and a decision on who may set it; not built.
- **Existing fields** such as appointment doctor, department and service, enquiry doctor, AI tags and appointment notes are NOT marked clinical (changing that would block segments that exist today). The lead should decide whether to mark them. Custom fields are non-clinical by default.
- The `campaign_snapshot_segment` SQL function takes a compiled predicate and does not know the purpose; the check is in TypeScript only.
- `v_contact_visit_stats.first_visit_date` is Pulse visits only, so a patient with only a Unite last-visit date has no first visit and cannot be "new".
- The "recall audience" in the integration test is `segmentAudience(..., purpose: 'care')`; the recall engine itself builds its lists from its own eligibility views, not from the filter language.

## Files
Migration `supabase/migrations/20261220000200_lifecycle_segments.sql` (paste file `deploy/supabase-paste/101_lifecycle_segments.sql`). No new table. Tests: `tests/unit/contacts/lifecycle-parity.test.ts`, `tests/unit/campaigns/audience-purpose.test.ts`, `tests/db/lifecycle-segments.test.ts`.
