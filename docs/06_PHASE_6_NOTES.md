# Phase 6 notes — Appointments, Unite sync, clinical engine

Delivered in three steps on one branch: **6a Appointments**, **6b Unite sync + Sync Review**, **6c `lib/clinical` + Follow-Up Queue + Clinical Settings**. Each step ships with its own migrations, tests and docs below.

---

## 6a — Appointments

### What exists now

| Area                                          | Where                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Schema                                        | `20261009000050_rls_helpers.sql`, `…0100_appointments.sql`, `…0200_appointments_ext.sql`, `…0300_appointment_jobs.sql` |
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

| Area                                    | Where                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                                  | `20261009000400_unite.sql`: `integration_accounts`, `sync_cursors`, `unite_api_calls`, `sync_reviews.incoming`, `unite_claim_token_refresh()`, cron schedules |
| Config (flags, endpoints)               | `lib/unite/config.ts` → `integration_accounts.config`                                                                                                         |
| Auth (token on demand, single-flight)   | `lib/unite/auth.ts`                                                                                                                                           |
| Read-only client                        | `lib/unite/client.ts`                                                                                                                                         |
| Mappers (pure)                          | `lib/unite/mappers.ts`                                                                                                                                        |
| DB-backed token / breaker / call log    | `lib/unite/store.ts`                                                                                                                                          |
| Syncs (appointments, doctors, patients) | `lib/unite/sync.ts`                                                                                                                                           |
| Review resolution                       | `lib/unite/review.ts`                                                                                                                                         |
| Jobs                                    | `lib/jobs/handlers/unite-sync.ts` (queue `unite_sync`; tasks `unite_enqueue`, `unite_nightly`)                                                                |
| UI                                      | Settings → **Unite EMR** (`/settings/unite`), **Portal → Sync Review** (`/portal/sync-review`), Portal hub (`/portal`)                                        |

### Safety rails (CLAUDE.md rule 7)

- **Read-only.** The client exposes `getAppointments`, `listPage`, `listAll` and nothing else; the only POST in the package is the vendor's token refresh. `tests/unit/unite-readonly.test.ts` pins this at the source level.
- **Finance API is never called.** It is sync-once (each call permanently dequeues records). The client checks every endpoint against an allow-list and refuses anything matching `/finance/i`, even if it is configured; the settings action rejects it too. There is **no raw-payload table yet**: it is created together with the guarded, feature-flagged job that would call that API, not before.
- **Conservative traffic.** One call at a time, ≥ 250 ms apart (configurable), exponential back-off on 5xx / 429 / network errors (`Retry-After` honoured), circuit breaker after 5 consecutive failures (5-minute cool-down, admins notified the moment it trips, "Resume calls" button). Every call is logged in `unite_api_calls` — endpoint, outcome, timing; **no bodies, no patient data**.
- **Tokens (~240 s)** are refreshed on demand under a DB claim so two serverless invocations never refresh at once; they are stored AES-256-GCM encrypted (`token_enc`). Credentials come from `UNITE_APP_ID` / `UNITE_APP_KEY` or an encrypted per-org override entered (write-only) in Settings. Errors never contain tokens or credentials.
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
- `tests/unit/unite-client.test.ts` (20): URL/params/auth, throttle, back-off, 429, forced token refresh, circuit breaker, paging, token store hand-off, no credential leakage.
- `tests/unit/unite-readonly.test.ts` (4): no write methods, POST only in auth, Finance API refused.
- `tests/db/unite-sync.test.ts` (14, needs PostgREST): matching / adopt / create / review, idempotent replay, status map, reminder re-planning, cursors and failures, doctors, patients (fill blanks only), the token claim, a full `runUniteSync` with a scripted `fetch`, Sync Review link / dismiss / create, and cross-org isolation of the new tables.
