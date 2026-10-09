# Phase 6 notes — Appointments, Unite sync, clinical engine

Delivered in three steps on one branch: **6a Appointments**, **6b Unite sync + Sync Review**, **6c `lib/clinical` + Follow-Up Queue + Clinical Settings**. Each step ships with its own migrations, tests and docs below.

---

## 6a — Appointments

### What exists now

| Area                                          | Where                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Schema                                        | `20261009000700_rls_helpers.sql`, `…0710_appointments.sql`, `…0720_appointments_ext.sql`, `…0730_appointment_jobs.sql` |
| Booking rules + template mapping              | `orgs.settings->'appointments'`, schema in `lib/appointments/settings.ts`                                              |
| Slot engine (pure, tz-aware)                  | `lib/appointments/slots.ts`                                                                                            |
| Reminder planning, template values (pure)     | `lib/appointments/reminders.ts`                                                                                        |
| Button replies (pure + glue)                  | `lib/appointments/button-reply.ts`, `replies.ts`                                                                       |
| Booking / status / reschedule / notifications | `lib/appointments/service.ts`                                                                                          |
| Job handler + sweep                           | `lib/jobs/handlers/appointments.ts` (queue `appointments`, task `appointments_sweep`)                                  |
| Settings UI                                   | Settings → Appointments (`app/(app)/settings/appointments/`)                                                           |
| Diary UI                                      | `/appointments`: Resource day, Specialist calendar, Table (+ New appointment drawer, detail drawer)                    |
| Entry points                                  | Inbox sidebar **Book appointment**, contact drawer **Appointments** tab, `/appointments?new=<contactId>`               |

### Behaviour worth knowing

- **Working hours are wall-clock minutes in the location's timezone** (ISO weekday 1–7). The slot engine converts to instants with `date-fns-tz`, so 09:00 stays 09:00 across a DST change. The clinic's working week and closed dates are booking-rule settings (OQ-07 is still open), not hard-coded.
- **Appointments from every source block slots**, and a specialist can't be in two places: the overlap check is across all of their locations. Unite rows block too, which is what stops double-booking against the EMR.
- **Staff can book into the lead-time window** (lead time is for patient self-booking) but not into the past. "Book outside available hours" is an explicit override in the drawer.
- **Reminders** are rows in `appointment_reminders` (unique per appointment + slot 1–3) plus one `scheduled_jobs` entry keyed `reminder:<appointment>:<slot>`. Defaults mirror today's Make run: only the 24 h reminder is on (slot 2). A reminder whose time has already passed when the appointment is booked is skipped, never sent late.
  - A reminder is re-planned when the appointment moves; cancelled/no-show/completed appointments cancel theirs.
  - The handler re-checks everything at send time: still `scheduled`, due, appointment still open, patient not on the exclusion list, test mode, then queues the template through `queueOutbound(priority:false)` (so the per-number rate limit and window guard in the outbound handler apply).
  - `appointments_sweep` (every 5 min) re-plans reminders for appointments in the next 30 days, so editing the booking rules takes effect without manual work.
- **Test mode** (`reminder_test_mode`): only contacts whose phone is in `reminder_test_numbers` get reminders; everyone else is recorded as `excluded` with reason `test_mode`. Use it for the parallel run alongside Make.
- **Exclusions** (`reminder_exclusions`, seeded via "Load previous defaults") carry the placeholder names and doctors from the old Make filters (OQ-21 asks whether they're still right).
- **Button replies** arrive as a `message.received` event that now carries `reply_to_wa_message_id` and `interactive`. The listener only acts on replies to a message that is a stored reminder for **that patient**: Confirm → `confirmed`; Cancel → `cancelled` unless inside the cancel cut-off, in which case reception is notified; Reschedule → reception is notified (they re-book). Closed or past appointments are never reopened.
- **Failed reminders** (no template, template not approved, no WhatsApp identifier, or Meta rejects the send) mark the reminder `failed` and notify everyone holding `appointments.manage`. The Phase 5 `tasks` table doesn't exist yet; when it does, create a "call patient" task from `reportReminderFailure` in `lib/jobs/handlers/appointments.ts`.
- **Unite rows are read-only in the UI** (`source = 'unite'`): status and time changes are made in Unite. `contact_id` may be null for an unmatched Unite patient (the row is waiting in Sync Review).

### Not covered / follow-ups

- **No database-level lock against two staff booking the same slot at the same moment.** The service re-checks the slot right before inserting, which closes the common window, but a true race is possible. A per-specialist advisory lock (RPC) is the fix if it shows up in practice.
- The UI has been type-checked, built (`next build`) and the resource grid is server-render tested, but it was **not driven in a browser** in the build sandbox (no Supabase Auth stack). Do a manual pass of Settings → Appointments and `/appointments` on a dev stack (`supabase start && pnpm db:seed`).
- FullCalendar free plugins only (`daygrid`, `timegrid`, `interaction`); the resource view is our own grid, so no Premium licence is needed.
- Google Calendar sync is out of scope (Phase 2 in the build plan).
- The **Reschedule cut-off** only changes how a patient's Reschedule tap is reported to reception ("late request"); staff can always move an appointment.

### Test coverage added

- `tests/unit/appointment-slots.test.ts` (17): hours, blocks, lead time, DST (spring-forward and fall-back in New York), split shifts, closed days.
- `tests/unit/appointment-reminders.test.ts` (21): reminder planning, re-plan on move, template values, button decisions, status rules, settings.
- `tests/unit/resource-grid.test.tsx`: renders columns, positions a booking by local time, closed-day banner.
- `tests/db/appointments-rls.test.ts`: cross-org isolation on every new table, permission-gated writes, cross-org reference rejection, numbering, integrity checks, `contacts_search` with appointment filters.
- `tests/db/appointments-service.test.ts` (needs PostgREST, see `supabase/test/README.md`): slots → booking → overlap → block → reminder planning/idempotence → send → button replies → reschedule → exclusions/test mode.

---

## 6b — Unite sync + Sync Review

### What exists now

| Area                                    | Where                                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                                  | `20261009000740_unite.sql`: extra `integration_accounts` columns (config, breaker), `sync_cursors`, `sync_reviews.incoming`, cron schedules. `integration_accounts` and `unite_api_calls` themselves come from the Finance module |
| Config (flags, endpoints)               | `lib/unite/config.ts` → `integration_accounts.config`                                                                                                                                                                             |
| Auth (shared token manager, Finance)    | `lib/unite/auth.ts`                                                                                                                                                                                                               |
| Read-only client                        | `lib/unite/sync-client.ts`                                                                                                                                                                                                        |
| Mappers (pure)                          | `lib/unite/mappers.ts`                                                                                                                                                                                                            |
| DB-backed token / breaker / call log    | `lib/unite/store.ts`                                                                                                                                                                                                              |
| Syncs (appointments, doctors, patients) | `lib/unite/sync.ts`                                                                                                                                                                                                               |
| Review resolution                       | `lib/unite/review.ts`                                                                                                                                                                                                             |
| Jobs                                    | `lib/jobs/handlers/unite-sync.ts` (queue `unite_sync`; tasks `unite_enqueue`, `unite_nightly`)                                                                                                                                    |
| UI                                      | Settings → **Unite EMR** (`/settings/unite`), **Portal → Sync Review** (`/portal/sync-review`), Portal hub (`/portal`)                                                                                                            |

### Safety rails (CLAUDE.md rule 7)

- **Read-only.** The client exposes `getAppointments`, `listPage`, `listAll` and nothing else; the only POST in the package is the vendor's token refresh. `tests/unit/unite-readonly.test.ts` pins this at the source level.
- **Finance API is never called.** It is sync-once (each call permanently dequeues records). The client checks every endpoint against an allow-list and refuses anything matching `/finance/i`, even if it is configured; the settings action rejects it too. There is **no raw-payload table yet**: it is created together with the guarded, feature-flagged job that would call that API, not before.
- **Conservative traffic.** One call at a time, ≥ 250 ms apart (configurable), exponential back-off on 5xx / 429 / network errors (`Retry-After` honoured), circuit breaker after 5 consecutive failures (5-minute cool-down, admins notified the moment it trips, "Resume calls" button). Every call is logged in `unite_api_calls` — endpoint, outcome, timing; **no bodies, no patient data**.
- **Tokens (~240 s)** are refreshed on demand by the token manager the Finance module uses (`lib/unite/auth.ts`): one set of credentials and one token cache, AES-256-GCM encrypted in `integration_accounts.config_enc`. Credentials are entered once, write-only, under Finance → Capture health; Settings → Unite EMR only holds the non-secret sync settings and needs those credentials to exist. Errors never contain tokens or credentials.
- **Vendor quirk:** every response is HTTP 200; success is read from the body (`Status`/`Message`). "Token Expired" / "Invalid Token" trigger exactly one forced refresh and retry.

### Behaviour worth knowing

- **Everything is off by default.** `integration_accounts.config.enabled.{appointments,doctors,patients}` are all false; nothing runs until someone switches an entity on in Settings → Unite EMR. Patients and doctors also need their endpoint name entered first (the vendor docs only cover `getallappointments`), and are fixture-tested only.
- **Schedule.** `unite_enqueue` (pg_cron `*/15 3-17 * * *` UTC = 07:00–22:00 Dubai) queues one appointments job per location that has a Unite clinic id, covering today … today + `incremental_days` (3). `unite_nightly` (`30 18 * * *` UTC) covers today … today + `horizon_days` (7) and also queues doctors/patients if enabled. "Sync now" queues the same jobs.
- **Idempotent.** Appointments are keyed `(org, source = 'unite', external_id)` (+ an `external_refs` row); a replayed payload reports `unchanged` and emits nothing. Events fire only on a real change: `appointment.created`, `appointment.status_changed`, `appointment.updated`, plus timeline entries. Reminders are re-planned from the synced time/status, so a moved or cancelled Unite appointment moves or cancels its reminder.
- **Patient matching:** Unite PIN → E.164 phone (primary and alternates) → name + DOB, via the Phase 2 matcher. One match links (and adopts the PIN if the contact had none). **More than one match goes to Sync Review and is never auto-merged.** An unknown patient becomes a new contact (`source = 'unite'`) unless "Create a contact for unknown patients" is off, in which case it also goes to Sync Review. The appointment is saved unlinked meanwhile (`contact_id` null), and no reminder is planned for it.
- **Review decisions stick.** A resolved or dismissed item is never re-queued by later syncs. Linking attaches the waiting appointments, plans their reminders and writes a timeline entry; it refuses a contact that already has a different PIN.
- **Status codes (OQ-23).** Unite codes map through `unite_appointment_status_map` (editable in Settings → Unite EMR). A code with no mapping is recorded in `external_status` but **never changes `status`**; a new appointment starts as Awaiting. So no-show / cancelled reporting stays empty until the meanings are confirmed with Unite.
- **Times.** Unite's date format is undocumented. The mapper reads ISO 8601 and day-first `DD-MM-YYYY` / `DD/MM/YYYY` (optional time, AM/PM) as clinic time (`config.timezone`, Asia/Dubai) and never guesses month-first. Unreadable rows are counted by reason (`unparseable_time`, `missing_id`, `end_before_start`) in the job log and skipped, not dropped silently.
- **Permissions.** Sync Review uses `portal.sync_review.read` / `.write` (Manager's `portal.*` and Agent's `portal.*.read` already cover them); Settings → Unite needs `settings.manage`.

### Not covered / follow-ups

- **No live Unite access in the build sandbox**, so the client is verified against scripted responses only (token expiry, always-200 error bodies, back-off, breaker, paging). Before switching it on: fresh app credentials for Pulse (OQ-26), confirm the date format, the status codes (OQ-23) and the rate limit with Unite, and run in reminder **test mode** for the parallel run.
- Patient/doctor endpoints, their field names and paging are configuration + tolerant mappers, not confirmed against the real API.
- Appointments deleted in Unite (rather than cancelled) are not detected; they stay as last seen.
- Clinic visit/prescription sync for the clinical engine arrives with 6c's tables and needs the visits endpoint from Unite.

### Test coverage added

- `tests/unit/unite-mappers.test.ts` (13): time formats and edge cases, appointment/doctor/patient mapping.
- `tests/unit/unite-sync-client.test.ts`: URL/params/auth, throttle, back-off, 429, forced token refresh through the shared token manager, circuit breaker, paging, no credential leakage. (`unite-client.test.ts` is the Finance client's.)
- `tests/unit/unite-readonly.test.ts` (4): no write methods, POST only in auth, Finance API refused.
- `tests/db/unite-sync.test.ts` (14, needs PostgREST): matching / adopt / create / review, idempotent replay, status map, reminder re-planning, cursors and failures, doctors, patients (fill blanks only), a full `runUniteSync` with a scripted `fetch`, Sync Review link / dismiss / create, and cross-org isolation of the new tables.

## 6c — Clinical rules, Follow-Up Queue, Clinical settings

Source of truth: `docs/audit/clinical-rules.md` (rules R-01…R-26, Test Plan TP-01…20, BC cases). Nothing here is clinically approved yet; see "Before this goes live".

### What exists now

- **`lib/clinical/`**: pure functions, no I/O. `vitals` / `negation` / `age` / `department` / `triggers/{paeds,gp,gyn}` / `category` / `followup` / `evaluate` / `sequence` / `feedback` / `gate` / `sign-off`. `engine.ts` is the only part that touches the database (load settings, evaluate a visit, write the follow-up, dispatch a message through the gate, record feedback, apply a day-3 reply). `clinical.test.ts` holds the Test Plan cases and boundary cases as table-driven tests on synthetic fixtures.
- **Schema** (`20261009000750_clinical_core.sql`, `…0760_org_check_triggers.sql`): `clinical_settings` (+ history), `visits`, `prescriptions`, `prescription_sequences`, `visit_rule_evaluations`, `clinical_followups`, `clinical_feedback`, `clinical_message_log`, `clinical_call_scripts`, `ref_medication_classes`, three views, and the gate function `app.clinical_messaging_enabled(org)`. RLS on every table; clinical data is PHI, so reads are gated by `portal.clinical_visits.read` / `portal.clinical_followups.read` rather than plain org membership.
- **Portal → Follow-Up Queue** (`/portal/follow-ups`): open items, High first then oldest due date, filters, overdue highlighting, drawer with vitals (only if the viewer may read visits), the approved call script for the category, call status / outcome / escalation / assignee / notes, "Notify doctor", Save & close. Staff can only change those columns; engine columns are protected by a database trigger as well as by the server action.
- **Portal → Clinical settings** (`/portal/clinical-settings`): rows grouped by category with proposed / approved / "in use today" values, owner, signer and date; sign-off, revoke and history. Writes go through the signed-in user's own client so the history trigger records who changed what. `clinical_messaging_enabled` and `allow_unsigned_defaults` additionally need the confirm phrase to be switched on.
- **Scheduler**: `clinical_evaluate` (pg_cron, every 10 min) re-evaluates visits whose inputs or settings changed.
- **Permissions**: new "Clinical" group, a "Care coordinator" preset (works the queue, cannot sign off). **Only Admin holds `clinical.settings.manage` by default.**

### Fail-closed policy (the decisions behind the code)

- **A setting counts only when `sign_off_status = 'approved'`.** An unsigned or blank value never fires a rule and never defaults to anything. The one exception is the per-org `allow_unsigned_defaults` switch (itself a signed setting), which lets _proposed_ values stand in for internal validation. It can never open the messaging gate.
- **OR-terms are evaluated independently.** If GP-01's temperature threshold is unsigned but its SpO₂ threshold is signed, a low SpO₂ still fires. An evaluation records the settings it could not use (`missing_settings`), and the queue page shows how many visits were evaluated that way.
- **Department undetermined.** If the child/adult cut-off (`paeds_age_cutoff_years`) is unsigned, a visit with a known age gets `department_effective = null`: no department rules run, and it is reported as missing a setting rather than silently treated as GP. A missing date of birth falls back to the department text.
- **Dedupe key** is `<visit external id>-<category>`. (The enum slug is used rather than a display label because it is stable. If Airtable follow-ups are imported later, their keys must be mapped to these before the engine is allowed to evaluate the same visits, or duplicates will appear.) A follow-up is superseded or closed automatically **only while untouched** (`call_status = pending`, nobody assigned); once a person is working it the engine leaves it alone.
- **The gate.** `decideClinicalSend` checks, in order: gate signed off → template clinically approved → contact consent → test-record rules for the current send mode. Every attempt is written to `clinical_message_log` with its reason (`suppressed_gate`, `suppressed_test_record`, `blocked`, `sent`…) under a unique idempotency key, so a replay logs nothing twice. With the gate off nothing reaches `messages` or the `outbound` queue.
- **Replies.** Free text is stored verbatim. A score is parsed (including Arabic-Indic digits); a score at/below the red-flag threshold **or** a side-effect keyword raises the flag, notifies the treating doctor _and_ the coordinators, and stamps both together. If the threshold or keyword list is unsigned, every reply goes to a person.
- **Day 3.** With the HALT threshold unsigned, a score never decides anything: it goes to human review.

### Deviations and ambiguities resolved

- **Clinic calendar** reuses the appointments booking-rule calendar (working weekdays + holidays) instead of a second table.
- **Recall** (R-20…R-25: tables, sends, the recall view) is **deferred**: the drafts remain in `supabase/drafts/`. It needs the template texts signed off first.
- **Sequence scheduling not wired.** Pure planning (`planSequence`), the day-3 decision, the probiotic guard and the dispatch/feedback helpers exist and are tested, but nothing yet schedules the ABX_DAY3 / probiotic messages from a prescription or routes an inbound reply into `applyDay3Reply`. That is deliberate: it would only matter once the gate opens, and it needs the template keys approved.
- **Visit and prescription ingestion** needs the Unite visits endpoint, which is not documented (see 6b). `lib/clinical/ingest.ts` maps a fixture-shaped payload; nothing calls it yet.
- Rules where the audit left ambiguity are implemented conservatively and listed in `clinical-rules.md` open questions (OQ-19, 21, 40, 46–48).

### Before this goes live

1. A clinical lead signs off every BLOCKING setting (day-3 HALT threshold, side-effect keywords, …) and the thresholds they accept. Until then the engine is inert by design.
2. Doctor-approved template texts and call scripts; mark them approved in `wa_templates.clinical_approval` / `clinical_call_scripts`.
3. Run in `test` send mode against internal numbers (`contacts.is_test_record`) first.
4. Only then sign off `clinical_messaging_enabled`.

### Not covered / caveats

- The two portal screens are verified by typecheck, lint and the server-side tests, **not driven in a browser** (no Supabase Auth in the build sandbox).
- No real patient data anywhere: every fixture, seed visit and test row is synthetic (rule 10). The two seeded visits and their contacts are flagged `is_test_record`.

### Test coverage added

- `lib/clinical/clinical.test.ts` (69) and `sign-off.test.ts` (5): Test Plan cases, boundaries, fail-closed behaviour.
- `tests/db/clinical-rls.test.ts` (12): seed, org isolation, PHI gating, queue edit guard, sign-off integrity and history, the gate function, integrity constraints.
- `tests/db/clinical-engine.test.ts` (19, needs PostgREST): unsigned vs signed evaluation, create / unchanged / close / supersede / leave-alone, children as paediatrics, negation, history without follow-ups, the scheduled task, the gate in all its states, red flags with dual notification, day-3 outcomes.
- `tests/db/appointments-rls.test.ts` gained a regression for the column-specific org-check triggers.

## Merge with the Finance module (PR #5)

`main` gained the Finance & Insurance module while Phase 6 was in progress. Reconciled as follows:

- **Two Unite clients, kept apart.** Finance owns `lib/unite/auth.ts` (token manager) and `lib/unite/client.ts` (the guarded, POST-only `GetFinanceDetails` client). The read-only sync client is `lib/unite/sync-client.ts`, and `lib/unite/sync-auth.ts` only holds its small helpers. A source-level test (`unite-readonly.test.ts`) checks that the sync code never POSTs, never imports the Finance client or capture pipeline, and never names `GetFinanceDetails`.
- **One credential store.** Both modules use `integration_accounts` / `unite_api_calls` as created by `…0600_finance_capture.sql`; the Phase 6 migration only adds columns to the former. The sync's own token store, per-org app id/key form and refresh claim were removed. Because Finance's capture and the sync now share a token, an authorize from one can invalidate the other's token; each handles that with its single "Token Expired" renewal.
- **Migrations renumbered** to `…0700`–`…0760`, after Finance's `…0100`–`…0600`. They have not been applied anywhere yet, so this is safe; if they had been, the numbers would have to stay.
- Phase 6's `Settings → Unite EMR` status uses Finance's `'disabled'` for "paused".
