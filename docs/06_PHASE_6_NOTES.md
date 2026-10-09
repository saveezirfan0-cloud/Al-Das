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
