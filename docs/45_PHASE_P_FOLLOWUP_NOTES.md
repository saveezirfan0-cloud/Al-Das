# Track P follow-up: closing the gaps left in P0, P3, P4 and P5

_17 Oct 2026. Synthetic data only. Read with `docs/45_PATIENT_JOURNEY_AND_ECOSYSTEM_PLAN.md`,
`docs/45_PHASE_P0_NOTES.md`, `docs/45_PHASE_P3_NOTES.md` and `docs/45_PHASE_P4_P5_NOTES.md`. Four migrations
(`20261220000300` to `20261220000600`, paste files `102_` to `105_`)._

## What was closed

### Segments and the consent rule

| Gap                                                                        | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A static segment filled from a clinical filter could be used in a campaign | `segments.care_only`. `bulkSegment` marks a static segment automatically when the grid's filter uses a health field or points at a care-only segment (the grid sends what was on screen); anyone with `contacts.manage` can also mark one by hand. A dynamic segment is marked by the trigger `segments_care_only_guard` whenever its filter uses a health field or includes a care-only segment, whichever code path wrote it.                                                                                               |
| Who sets it                                                                | Marking: anyone who manages segments (it only restricts). **Releasing: an administrator only** (`settings.manage`), through `public.segment_set_care_only`; a browser write that clears the mark is refused by the trigger. Every mark and release is audited with the segment id and the reason, never a value. This is a default, easy to change in `saveSegment`.                                                                                                                                                          |
| The consent rule lived in TypeScript only                                  | `campaign_snapshot_segment` now takes `p_segment_id` and `p_purpose` and raises when a marketing snapshot names a care-only segment (own mark, a health field in its filter, or an included care-only segment, re-read at use time), when no segment is named, or when the segment is not the campaign's own. Every caller passes both. The SQL list `app.marketing_safe_filter_fields()` is the twin of the TypeScript registry (parity test in `tests/db/segment-care-only.test.ts`). An unknown field counts as care only. |
| The rule needs signing                                                     | `/settings/health-data-rule` (`settings.manage`): the clinical lead and management each sign the exact wording, bound to its SHA-256, two different people, withdrawable, audited. The system enforces the rule whether or not it is signed; signing records that the two accepted this wording. Changing the wording (bump `CONSENT_RULE_VERSION`) voids earlier signatures. **The signatures themselves are theirs to give.**                                                                                               |
| Existing fields not marked                                                 | New `careOnly` flag on a field, **separate from `clinical`**: appointment doctor, department, service and notes, enquiry doctor and conversation AI tags are `careOnly`. Unlike `clinical` it does not hide the field from members without `clinical.view`, so front-desk filters and saved views keep working; only marketing audiences refuse it.                                                                                                                                                                           |

**What this changes for existing data:** the migration re-evaluates every dynamic segment once (the notice `care_only backfill: N dynamic segments re-evaluated` appears in the migration log). A segment that uses one of those fields becomes Care only, and a campaign or recurring campaign that uses such a segment will fail its next audience build with the plain reason. Look for them with `select name from segments where care_only and kind = 'dynamic'`. Static segments already filled from clinical filters cannot be recognised after the fact: an administrator should mark any such list by hand.

`enquiry_service` is **not** marked care only (it was not in the list that was asked for). It is the same kind of field as appointment service; the clinical lead may want to add it.

### Patient 360

- **Open balance** in the header and Overview, for members with `finance.invoices.view`: what the patient (or company) still owes across their latest 50 Unite invoices, by the invoice view's own rule (`invoiceShares`). Insurance invoices need `finance.claims.view` to be worked out; without it they are left out and the header says so. Credits are shown apart, never netted against other invoices. Reading it is logged like the Billing tab (`recordAccess`, ids and counts only).
- **Insurance claim status per invoice** on the Billing tab (not claimed, awaiting, partly paid, paid, rejected) plus totals owed by patient and insurers.
- **Campaigns in the last 90 days** on the Overview (count of sent messages, `campaigns.view`).
- **Appointment status history**: read from `record_history`, which already records every `status` and `external_status` change with who (or automatic). No new table. It starts when the trigger started recording: appointments synced from Unite show their changes from the first sync (P7).
- **Ctrl+K** opens `/contacts/<id>`. The drawer's deep link (`/contacts?contact=<id>`) is unchanged for the pages that use it.
- **Allergies: not built, on purpose.** There is no allergy field in Airtable, Make or Pulse. Unite is the clinical system of record; recording allergies by hand in Pulse would create clinical data Unite does not hold, and an empty list could be read as "no allergies". It needs the Unite visit feed (P2, field list not yet known) or an explicit clinical decision to record them in Pulse.

### Identity and filters

- **Sanoflow lead to Unite patient matching**: `public.lead_patient_blocks` lists cheap candidate pairs (same last nine digits of a phone, or the same name of two or more words; household members excluded); `lib/contacts/lead-match.ts` decides. Evidence only ever refuses or ranks (the family-aware `comparePerson`): name and date of birth equal, or a phone and an equal name, is high; a phone alone with no lead name is medium; a phone with the same first name or a name alone is low; a lead that fits several patients is marked ambiguous and none is preferred. Pairs appear in Possible duplicates with the patient first, so Merge keeps the Unite number. Nothing merges by itself. Built and tested on synthetic data; it needs the Airtable import and the Sanoflow export only to have something to find. There is no "not the same person" dismissal yet (the existing duplicate kinds have none either).
- **Insurer filter**: Airtable's `Insurance Plan` is a two-option select (Mednet, AXA) and was not a reliable source. The filter uses matched insurance claims by Unite PIN (`public.v_contact_insurers`, service role only): a patient has the insurers they have a matched claim with. It is offered only with `finance.claims.view` (`requiresClaims`) and is care only, because a claim means the patient received care. The options come from `fin_ref_payers`.

### Migration status page

- **Sanoflow is covered**: 18 rows (contacts, tags, labels, categories, quick replies, segments and members, dynamic segments (report only), pipelines, stages, enquiry fields, sources and lost reasons, enquiries and activity, campaign history and recipients, appointments).
- **"Last import" is real now**: each importer run records one `import_runs` row per entity (counts only; service role only; no policies). The page shows the newest real run, or "dry run only" when only a dry run exists (a dry run is never progress). The state still comes from linked records (`external_refs`), or for settings that link nothing, from a real run that wrote something and failed nothing.
- **A test ties the ids together**: `tests/unit/migration-registry-tie.test.ts` fails if the status page lists an Airtable entity the importer never writes, if the importer writes one the page does not list, or if the Sanoflow entity lists (`scripts/import/sanoflow/entities.ts`) drift from the importer's sources.
- **The three message-log importers are written** (`scripts/import/tables/message-logs.ts`, no longer pending): Chronic Recall and Birthday Messages → `recall_sends` (programmes `chronic_90d`, `birthday`; cycle keys as the eligibility views read them, so a cycle Make already messaged is blocked in Pulse); Appointment Messages → `appointment_reminders` (reminder history of appointments Pulse already has from the Unite sync; it never creates an appointment) and, for the early birthday sends logged there, `recall_sends`. All create-only, patients found by the Unite import's link then PIN, anything else skipped with a reason code, no phone, name or free text read.

## Known limits

- **Care only governs campaign audiences.** A flow that is attached to a segment (a drip flow, or a recurring flow reading its members) still reads a care-only segment: a flow is staff-written automation and its messages follow the template's own consent rules (marketing templates still need opt-in). If flows should also refuse care-only segments, that is a separate rule in the flow engine.
- A static list is marked automatically only when it is filled from the Patients grid (the paths `bulkSegment` sees). Segment members added by import or by hand-picking the same people without the filter are not recognised.
- No "not the same person" dismissal for the lead and patient pairs.

## Decisions for people

1. **Who may release a Care only list** (default: administrators).
2. **Sign the health-data rule** (clinical lead and management, `/settings/health-data-rule`).
3. **Mark enquiry service** as care only too?
4. **Allergies**: wait for the Unite visit feed, or record them in Pulse?
5. **Review the segments the migration flagged** before the next campaign runs.

## Running the message-log importers

Order matters: Unite patients first (they supply the links), the Unite appointment sync before Appointment Messages (a reminder is only recorded for an appointment Pulse has). A dry run on an empty database cannot see contacts that exist only in the dry run's overlay when a row has only a PIN, so expect many `patient_not_in_pulse` warnings until patients are imported for real. `docs/audit` summaries are unchanged; the same counts are also recorded on the status page.
