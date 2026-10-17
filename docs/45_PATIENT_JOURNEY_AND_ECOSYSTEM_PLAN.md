# The Al Das ecosystem, the patient journey and the Patient 360 build plan

_17 Oct 2026. Written so that a separate Claude Code session can build Track P in parallel with the finance work. Read
with `CLAUDE.md` (the rules), `docs/34_CLINIC_OS_PLAN.md` (the product plan), `docs/audit/airtable-schema.md`,
`docs/audit/make-scenarios.md` and `docs/audit/make-replacement-design.md` (what is being replaced). No patient data
anywhere in this file._

## 1. The ecosystem in one picture

```
                 SOURCES                                   PULSE (one platform)                         PEOPLE AND OUTPUTS
 ┌──────────────────────────────┐        ┌──────────────────────────────────────────────────┐   ┌────────────────────────────┐
 │ Unite EMR (live, read-only)  │──API──▶│ Identity: one patient = one contact              │   │ Front desk: check-in, desk │
 │  patients, appointments,     │        │  (Unite PIN, phone E.164, WhatsApp BSUID)        │──▶│ Doctors: my day, history   │
 │  visits/MRD (vitals, Dx, Rx),│ files  │ Patient 360: appointments, visits, conditions,   │   │ Care team: recalls, follow │
 │  finance (deliver-once)      │──────▶ │  medicines, messages, enquiries, campaigns,      │   │  -ups, tasks               │
 ├──────────────────────────────┤        │  invoices, claims, documents, household          │   │ Marketing: segments,       │
 │ Airtable (back office today) │─import▶│ Messaging: WhatsApp inbox, templates, campaigns, │   │  campaigns, ads ROI        │
 │  patient master + MRD copy,  │  once  │  flows, recall (birthday, chronic, screening)    │   │ Finance: revenue, claims,  │
 │  Dx, Rx, follow-ups, logs    │        │ Clinical rules (lib/clinical, signed settings)   │   │  bank, close, P&L          │
 ├──────────────────────────────┤        │ Appointments + diary + waiting list              │   │ Accounts: ledger / Tally   │
 │ Make.com (automations today) │─rebuilt│ Finance + insurance + accounting (Phases 18-23)  │   │ Management: dashboards     │
 │  reminders, birthday, recall,│ native │ Reports and management dashboard                 │   └────────────────────────────┘
 │  MRD sync, token             │        └──────────────────────────────────────────────────┘
 ├──────────────────────────────┤                ▲                 ▲                 ▲
 │ Sanoflow (WhatsApp today)    │─import─────────┘                 │                 │
 │  contacts, tags, segments,   │  once                            │                 │
 │  enquiries, campaign history │                    Diligence / e-claims        Bank, card, Tabby,
 └──────────────────────────────┘                    (files: claims, RA)         labs (files); Tally
```

**The rule of the target state:** Unite stays the clinical system of record (Pulse reads it, never writes). Pulse replaces
Sanoflow, Airtable and Make entirely, and is where every team works. Airtable and Sanoflow are imported **once**
(idempotent, with reconciliation reports), then switched off; Make is replaced scenario by scenario after a parallel run.
Retirement order already agreed: **Make, then Airtable, then Sanoflow** (docs/09).

## 2. What exists today (inventory, 17 Oct)

**Airtable and Make in Pulse** (built, but not yet run against the real data):

| Today (Airtable / Make) | In Pulse | State |
|---|---|---|
| Unite base: patients (10,652), Medical Records Data (11,656 visits), Diagnosis (4,107), Medication (13,534), Items (1,981) | `contacts`, `visits`, `visit_diagnoses`, `prescriptions`, `ref_diagnoses`, `ref_medications`, `ref_items` via `pnpm import:airtable` (`scripts/import-airtable.ts`, `scripts/import/tables/*`) | Dry-run verified only; real import waits for `AIRTABLE_PAT` + go-ahead (OQ-49) |
| Acute Clinical Follow-Up base (10 tables) | `clinical_followups`, `clinical_feedback`, `clinical_message_log`, `clinical_call_scripts`, `clinical_settings` | Same |
| Campaigns – Message Log (appointment, birthday, chronic recall messages) | Pending-log importer | Validated in dry run, not written (draft column names, PR #28) |
| PTF base (lab tests, 5-star feedback) | none | **No `lab_orders` or visit-feedback table** |
| Make: Token, Appointment Reminders (+6 PM) | `lib/unite/auth.ts`, `lib/appointments/reminders.ts` | Native; Unite sync OFF until credentials (OQ-26) |
| Make: Agewise Birthday, Chronic Recall 90-Day, Chronic Update | `lib/recall/*` (`recall_programmes`, `recall_sends`, `/recall/calls`) | Native, Test mode only |
| Make: **Acute Follow-Up MRD Sync** (Unite `GetMedicalRecordsDetails` → visits + prescriptions) | Clinical engine exists (`lib/clinical/*`) | **The Unite visit feed is not built**; only the importer writes visits |
| Make: 9 screening reminders, dormant reactivation, no-show, post-visit | Recall programmes seeded as drafts | **Not functional** (`eligibility_view` null) |
| Airtable's 2 native automations | none | Not rebuilt (OQ-41) |
| Parallel run and cut-over | `pnpm parallel:ingest`, `/recall/parallel-run`, `pnpm reconcile`, `pnpm cutover:preflight` | Built; every row of the parallel-run checklist still unticked |

**Why it looks like "nothing is set up":** there is no single screen that shows this migration. The pieces live in
`/recall`, `/portal/*` and scripts, and none of it has been run with real credentials.

**Patients today:** `contacts` holds demographics, phone, BSUID, Unite PIN (`external_id`), consent, tags, segments,
custom fields, household links and documents. The Patient 360 drawer (`app/(app)/contacts/contact-drawer.tsx`) has
Timeline, History, Inbox, Enquiries, Appointments, Tasks, Invoices, Campaigns and Documents tabs. **Visits, diagnoses,
prescriptions and chronic conditions are stored but no screen shows them per patient**; there is no Clinical, Visits,
Conditions or Household tab; segments cannot filter on anything clinical; there is no fixed "how did you hear about us"
list; insurance sits in `contacts.custom`.

## 3. The patient journey Pulse must cover

| Stage | What happens | Source of truth | Pulse today | Gap |
|---|---|---|---|---|
| 1. First contact | Ad click, website chat, WhatsApp, phone, walk-in | Pulse (WhatsApp, widget, CAPI clicks) | Inbox, enquiries, ad attribution | Fixed "how did you hear" list (OQ-180) |
| 2. Lead / enquiry | Questions, pricing, nurturing | Pulse | Enquiries pipeline, flows, quick replies | Lifecycle stage on the patient |
| 3. Booking | Slot chosen, reminders | Unite (diary), Pulse for WhatsApp bookings | Appointments, desk booking, reminders, waiting list | Unite appointment sync needs credentials; status map unconfirmed (OQ-23) |
| 4. Registration | Unite PIN created | Unite | Contact gets `external_id` when matched | Patient sync endpoint undocumented; match review (`sync_reviews`) |
| 5. Visit | Arrive, see doctor, vitals, diagnosis, prescription, tests | Unite EMR | Check-in in Pulse only | **Visit feed (MRD) not built; no visit history UI** |
| 6. Billing and insurance | Invoice, payment, claim, remittance | Unite finance, Diligence, bank | Finance module (Phases 18-23) | Per-patient claim status in the 360 |
| 7. Follow-up | Acute follow-up, chronic recall, screening, results | Pulse (rules from Unite data) | Clinical engine, recall | Needs the visit feed; screening eligibility |
| 8. Retention | Birthday, reactivation, campaigns, reviews | Pulse | Recall, campaigns, review requests | Clinical-aware segments (with consent rules) |
| 9. Household | Children and dependants under a guardian | Pulse | `household_links` | Not visible in the 360 |

**Two populations, one record.** Sanoflow brings WhatsApp contacts (many are leads with no Unite PIN); Airtable and Unite
bring registered patients (PIN, visits). They meet on phone E.164 and, after the import, on the Unite PIN. A person is
one contact with a **lifecycle stage** derived from data, never typed: `lead` (no PIN), `new patient` (first visit in the
last 90 days), `active` (a visit in the last 18 months), `lapsed` (no visit in 18 months), plus a `chronic` flag from
`contact_chronic_conditions`. Thresholds are settings, not code.

## 4. Patient 360, the target

A full page at `/contacts/[id]` (the drawer stays for quick looks, with an "Open full record" link). Header: name, age,
gender, Unite PIN, home branch, lifecycle stage, chronic badges, consent chips (WhatsApp, marketing, clinical messaging),
household (guardian or dependants), next appointment, open balance (finance roles only).

| Tab | Content | Read permission | Data |
|---|---|---|---|
| Overview | Next and last appointment, last visit summary, active conditions and medicines, open tasks and follow-ups, last message, campaigns in the last 90 days, balance | each card its own | all below |
| Appointments | **Upcoming**, **Today** (live check-in status: arrived, with doctor, done, checked out), **Past** with each status change (booked, confirmed, cancelled, no-show, honoured) | `appointments.view` | `appointments`, `appointment_reminders`, Unite status history |
| Visits and medical record | One row per Unite visit: date, branch, doctor, department, vitals, diagnoses (ICD-10 with names), prescriptions, notes; expandable | **`clinical.view` (new)** | `visits`, `visit_diagnoses`, `prescriptions`, `ref_*` |
| Conditions and medicines | Chronic conditions with first and last seen, current medicines (from recent prescriptions), allergies (when a source exists) | `clinical.view` | `contact_chronic_conditions`, `prescriptions` |
| Care and follow-ups | Acute follow-ups, chronic recall, screening due, messages sent by the clinical engine, feedback | `clinical.view` or recall keys | `clinical_followups`, `recall_sends`, `clinical_feedback` |
| Conversations | WhatsApp, web chat, Instagram, Messenger | `inbox.view` | existing |
| Enquiries and marketing | Source and ad attribution, enquiries, campaigns received, segments, tags, consent history | `enquiries.view`, `campaigns.view` | existing + `ad_attributions` |
| Billing and insurance | Invoices, payments, insurance claims and their status, outstanding | `finance.invoices.view`, `finance.claims.view` | `v_fin_invoice_list` by PIN, claims by PIN |
| Documents | Patient documents, e-signatures | `documents.view` | existing |
| Tasks and notes | Tasks, comments, notes | `tasks.view` | existing |
| Household | Guardian and dependants, shared phone | `contacts.view` | `household_links` |

**Health-data rules for this page (non-negotiable, from CLAUDE.md):** clinical tabs need `clinical.view`, never implied by
`contacts.*` (same pattern as `documents.*`); every open of a clinical tab calls `recordAccess` (ids only); nothing
clinical goes into push, e-mail, task titles, logs or AI prompts; no real data in tests, fixtures or screenshots; branch
access applies to visits as to appointments (`app.location_visible_to`).

## 5. Build plan (Track P)

| # | Work | What to build | Needs | Done when |
|---|---|---|---|---|
| **P0** | Migration control centre | One page (`/settings/migration`, `settings.manage`) listing every Airtable table and Make scenario with its Pulse equivalent, state (not started, imported, native, parallel run, retired), counts from the last import or reconcile, and links. Reads existing tables (`external_refs`, `parallel_run_*`, recall, import reports); no new data | Nothing | The team can see the whole migration on one screen |
| **P1** | Run the Airtable import | Finish the pending-log mapper (PR #28 column names), run `pnpm import:airtable --dry-run` then for real with reconciliation; fix what the dry run shows | `AIRTABLE_PAT`, go-ahead on data residency (OQ-49) | Reconcile report signed; counts match Airtable |
| **P2** | Unite visit feed (replaces Make MRD Sync) | `GetMedicalRecordsDetails` sync into `visits`, `visit_diagnoses`, `prescriptions` through `lib/unite/sync-client.ts` (read-only, rate-limited, logged, idempotent via `external_refs`, cursor per clinic; `visitdetails[].clinicname` mapped to a branch by name and aliases); feeds the clinical engine (`lib/clinical/visit-ingest.ts`) | Unite credentials (OQ-26), endpoint shape confirmed on a synthetic sample | Parallel run against Make MRD Sync for 2 weeks with no unexplained difference |
| **P3** | Patient 360 page | Full page with the header and the tabs of section 4; `clinical.view` permission (Doctor, Medical Director and Care coordinator presets; not Receptionist, Agent or Marketing); `recordAccess`; phone layout; guides; nav and Ctrl+K deep link | P1 or P2 for real data (build on synthetic) | Every tab works on the demo workspace; access log rows written; security guard tests pass |
| **P4** | Lifecycle stage and identity | Derived lifecycle stage (SQL view or function, thresholds in org settings), Sanoflow lead ↔ Unite patient matching on phone and PIN with the existing `sync_reviews` flow, duplicate panel improvements | P1, Sanoflow export | Every imported contact has a stage; duplicates queue reviewed |
| **P5** | Segments v2 | Filters: age band, gender, branch, last visit, visit count, doctor, department, lifecycle stage, insurer, chronic condition, diagnosis group. **Clinical filters only for care programmes (recall, follow-up) unless the patient's consent covers marketing**; enforced in `lib/campaigns/audience.ts`, not only in the UI | P2 or P1 data; consent rule signed by the clinical lead and management | A recall audience and a marketing audience each built and counted correctly on synthetic data |
| **P6** | Recall and screening programmes | Eligibility views for the 9 screening reminders, dormant reactivation, no-show and post-visit (seeded drafts today), each with its signed clinical setting, Test mode first | P2 data, clinical sign-off | Each programme sends in Test mode to the right synthetic patients |
| **P7** | Appointments end to end | Unite appointment sync on (credentials), status map confirmed (OQ-23: Awaiting Confirmation, Confirmed, Honoured, Cancelled), status history kept for the 360, utilisation (also docs/43 W2) | Unite credentials, status codes | A week of appointments mirrors Unite; reminders match Make |
| **P8** | Marketing source and attribution | A fixed "how did you hear about us" list (Settings), mapped from Sanoflow UTM and Unite free text; enquiry → booking → first visit → revenue funnel per source (counts only) | Decision on the list (OQ-180) | Funnel report per source for one month |
| **P9** | Retire Make, then Airtable, then Sanoflow | Parallel-run checklist (`docs/audit/make-replacement-design.md` §10) ticked scenario by scenario; `pnpm cutover:preflight`; credentials rotated; Airtable read-only then archived; Sanoflow export kept | All of the above | Each tool switched off with a signed reconcile report |

**Order:** P0 and P3 (on synthetic data) can start today; P1 the day the Airtable token is given; P2 and P7 the day the
Unite credentials arrive; P4 and P5 after P1; P6 after P2; P8 when the source list is agreed; P9 last.

**Decisions needed (owners to agree):** OQ-26 Unite credentials and the patients/MRD endpoint shapes; OQ-49 data
residency for the import; OQ-23 appointment status codes; who gets `clinical.view`; whether clinical data may ever be used
for marketing segments (recommendation: no, care programmes only, unless explicit consent); the lifecycle thresholds; the
"how did you hear" list (OQ-180).

## 6. How the parallel session works with this repository

- **Repository:** `saveezirfan0-cloud/Al-Das` on GitHub. Production database migrations run from `main` through
  `.github/workflows/db-migrate.yml`; Vercel deploys `main`. Hosting details: `docs/38_HOSTING_SETUP.md`.
- **Branch:** start from the latest `main` on a branch of its own (for example `claude/patient-360`); never push to the
  finance branch (`claude/sweet-cannon-anhmoi`). Open a pull request per slice (P0, P3, ...) and keep each mergeable.
- **Avoid collisions with the finance track:** migration timestamps from `20261220000100` upwards and paste files from
  `100_` upwards (`deploy/supabase-paste/`); stay out of `lib/finance`, `lib/accounting`, `app/(app)/finance`,
  `app/(app)/accounting` and `connector/`; for shared files (`CLAUDE.md`, `lib/help/whats-new.ts`, `lib/auth/permissions.ts`,
  `lib/supabase/types.ts`, `docs/09_STATUS_AND_ROADMAP.md`) add lines, do not reorder, and merge `main` in before each PR.
- **Local checks** (Definition of done in CLAUDE.md): `pnpm typecheck`, `pnpm lint`, `pnpm test`, the database tests on
  plain Postgres (`supabase/test/README.md`: `bash scripts/test-db.sh` then `vitest run tests/db`), `pnpm audit:security`.
- **Data:** synthetic only (`lib/demo/`, names like `Layla Demo-07`, numbers `+44 7700 900xxx`). Real exports are analysed
  outside the repository and never committed; Unite is read-only and the Unite Finance API is never called.

## 7. Prompt to start the parallel session

Copy this into the new Claude Code session once it is connected to GitHub (`saveezirfan0-cloud/Al-Das`), Supabase and
Vercel:

> You are building Track P (patient journey, Patient 360, Airtable/Make migration) of Pulse, Al Das Medical's clinic
> platform (Next.js 15 + Supabase on Vercel). Clone `saveezirfan0-cloud/Al-Das`, read `CLAUDE.md` in full, then
> `docs/45_PATIENT_JOURNEY_AND_ECOSYSTEM_PLAN.md` (if it is not on `main` yet: `git fetch origin claude/sweet-cannon-anhmoi`
> and `git show origin/claude/sweet-cannon-anhmoi:docs/45_PATIENT_JOURNEY_AND_ECOSYSTEM_PLAN.md`), `docs/34_CLINIC_OS_PLAN.md`,
> `docs/audit/airtable-schema.md`, `docs/audit/make-scenarios.md` and `docs/audit/make-replacement-design.md`. Another
> session is building finance and accounting on `claude/sweet-cannon-anhmoi`: do not touch `lib/finance`, `lib/accounting`,
> `app/(app)/finance`, `app/(app)/accounting` or `connector/`; use migration timestamps from `20261220000100` and paste
> files from `100_`. Work on a new branch from `main` (`claude/patient-360`), one pull request per slice. Start in Plan
> Mode with P0 (migration control centre) and P3 (Patient 360 full page with a new `clinical.view` permission, built and
> tested on synthetic data only), then P4 and P5. Follow every rule in CLAUDE.md: RLS and `requirePerm`/`can` on
> everything, `recordAccess` for clinical views, `recordAudit` for writes, no patient data in code, tests, logs or
> prompts, Unite read-only. Definition of done: typecheck, lint, unit and database tests pass, `pnpm audit:security`
> clean, docs updated (a notes file per slice, a guide per new page, a What's new entry).
