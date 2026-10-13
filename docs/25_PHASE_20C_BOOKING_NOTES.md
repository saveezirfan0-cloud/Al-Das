# Phase 20c (booking half): booking capacity (G6)

Read with `docs/20_SANOFLOW_REA_PARITY.md` §4 (row G6) and `docs/21_SANOFLOW_PARITY_PROMPTS.md` §20c. This note covers the booking-capacity half only. The routing half (G5) is a separate branch.

Before this phase, each booking took one place and blocked any overlap (`app.assert_slot_free`). There were no buffers, one org-wide slot step, and one-off `time_blocks` only.

## What exists

| Where | What |
|---|---|
| `services` | `buffer_before_min`, `buffer_after_min` (0 to 240, default 0) and `capacity`, the patients one session takes at once (1 to 50, default 1). `duration_min` is still the default visit length. |
| `specialists` | `slot_length_min` (5 to 240, or null for the org's `slot_granularity_min`) and `max_per_slot` (1 to 50, default 1). |
| `specialist_recurring_blocks` (new) | Weekly unavailable time: `weekday` (ISO 1 to 7), `start_min`/`end_min` in the location's wall clock (like `working_hours`), `location_id` (null means every location) and an optional `reason` (120 characters max). RLS: any member reads it (like `working_hours`) and `settings.manage` writes it. Org-consistency and `updated_at` triggers are attached. |
| `app.slot_conflict(org, specialist, location, service, starts, ends, exclude)` | The one SQL rule. Returns null, `'blocked'` or `'full'`. |
| `app.assert_slot_fits(...)` | Raises `slot_taken` when `slot_conflict` is not null. `app.assert_slot_free` (6 arguments) is kept and delegates with no service. |
| `book_appointment`, `move_appointment`, `accept_slot_offer` | **Same signatures.** They re-check with the service, under the same per-specialist advisory lock. `move_appointment` uses the moved appointment's own `service_id`. `accept_slot_offer` uses the offer's `service_id`, and after a booking it marks the other pending offers for that slot `taken` only when no place is left. |
| `public.appointment_capacity_conflicts(org, ids[])` | SECURITY DEFINER, service role only, at most 2,000 ids. Returns `(appointment_id, reason)` for awaiting/confirmed rows that break the rule against everything else. Display only. |
| `lib/appointments/slots.ts` | The one pure engine. `generateSlots` gains buffers, `capacity`, `recurringBlocks` and the specialist step (`granularityMin`). `slotFits` is the TypeScript mirror of `app.slot_conflict`. `expandRecurringBlocks` and `shiftLocalDate` were added. |
| `lib/appointments/availability.ts` | `loadSlotInput` / `slotsForDay` take an optional `serviceId` and load buffers, places, weekly blocks and the specialist's slot length. `intervalHasPlace` checks one exact interval and serves the waiting list. |
| Callers | The booking drawer (`getFreeSlots` passes the service), `createAppointment` / `rescheduleAppointment` (`slotOk` passes the service), the front desk's next free slots (no service: no buffers, one place) and waiting-list offers (`slotIsBusy` uses `intervalHasPlace`) all use the one engine. The public API v1 is read-only and has no slot endpoint. The flow engine's `bookAppointment` port has no production implementation, so there is no other bot booking path. |
| Conflict flag | `lib/appointments/conflicts.ts` (`loadCapacityConflicts`) calls the SQL function. `listRange`, `listAppointments` and `getAppointmentDetail` add `conflict: 'blocked' | 'full' | null` through `appointment_capacity_conflicts`. A warning icon appears in the resource grid, agenda list and table. The drawer shows a "Booking conflict" badge with a sentence, and for Unite rows says the booking is kept as Unite has it. |
| Settings, Appointments | Services: Buffer before, Buffer after, Concurrent patients. Specialists: Slot length, Bookings per slot and a Weekly blocks editor. Saved by the existing `saveService` / `saveSpecialist` actions (`settings.manage`). The audit diff now includes the new values and the number of weekly blocks. |

### The rule (SQL and TypeScript)

1. Every interval is widened by its own service buffers: the candidate by the booked service's buffers, and each existing booking by its own.
2. The candidate is refused (`blocked`) if its widened interval overlaps a one-off block for that location or a weekly block. Weekly blocks are expanded in the location's timezone for every local date the widened interval touches, so a buffer that crosses midnight meets the next day's block.
3. Let n be the number of busy bookings (awaiting, confirmed or completed) of that specialist, **at any location**, whose widened interval overlaps the candidate's widened interval. The candidate is refused (`full`) when n > 0 and n ≥ the smallest number of places among the candidate and every overlapping booking. A booking's places are `least(service.capacity, specialist.max_per_slot)`; a booking with no service has 1.
4. Working hours, holidays, the working week and lead time stay in TypeScript, as before. The SQL re-check does not look at them; the staff override (`p_enforce = false`) still skips the SQL check.

With every default (capacity 1, max 1, no buffers, no weekly blocks), step 3 refuses any overlap, which is exactly the old behaviour.

## Decisions

- **Both numbers must allow sharing.** A slot holds `least(service concurrent patients, specialist bookings per slot)`. A group class therefore needs both raised, and a one-patient consultation never shares a slot, whichever side was booked first. This is the conservative reading: a forgotten setting refuses a booking, it never overbooks.
- **n counts every overlapping booking, not the peak at one instant.** Partly overlapping group bookings can make n larger than the true peak, so the rule may refuse a slot that would have fitted. It can never overbook.
- **Buffers keep bookings and blocks apart, but are not clipped to working hours.** The first slot of the day starts at opening time even when its preparation buffer falls before opening. A weekly lunch block and a one-off block both refuse a booking whose buffers reach into them.
- **Weekly blocks are a separate table**, not a recurrence on `time_blocks`. This kept the old one-off overlap check, the resource-grid block drawing and the "delete block" action unchanged.
- **Unite is read-only and is never checked.** The Unite sync writes `appointments` directly. No trigger was added to `appointments`, so nothing in this phase can refuse or alter a synced row. Conflicts are only flagged, from the same SQL rule.
- **The conflict flag covers awaiting and confirmed rows only.** Completed, cancelled and no-show rows are history.
- **The front desk's "next free slots" overview has no service.** It uses no own buffers and one place, so it may show a time that a buffered service later refuses. The booking drawer and the SQL re-check decide.
- **Waiting-list offers** check the freed slot with the freed appointment's service. Acceptance checks again under the lock with the offer's service.
- **Sanoflow import** (`book_appointment` with `source = 'import'`, enforced) is subject to the new rules too. If buffers or weekly blocks are configured before the cut-over import, more Sanoflow appointments can be reported as `slot_taken`. Configure capacity after the import, or review those rows in the report.
- **A pre-existing gap was fixed:** `saveSpecialist` now confirms that an edited specialist id belongs to the caller's org before it replaces links, hours and weekly blocks. Before, a forged id updated nothing but could delete another org's link rows.

## How it was verified

All runs used the test database `pulse_test_c` (fresh from `scripts/test-db.sh`). The PostgREST suites ran against PostgREST 12.2.3 with `supabase/test/rest-proxy.mjs`.

- `tests/unit/appointment-capacity.test.ts` (new, 16 tests): checks that the defaults equal the old rule, and that buffers work before, after, at exact edges, against blocks and across midnight in both directions. It also covers capacity (last place, smallest places wins, blocks never shared, buffers in overlap), weekly blocks (weekday only, Asia/Dubai wall clock in January, July and October, end of day 1440, buffers), the specialist slot length, holidays, closed weekdays and lead time. `tests/unit/appointment-slots.test.ts` is unchanged and passes.
- `tests/db/booking-capacity.test.ts` (new, 10 tests), on plain Postgres:
  - With the defaults, any overlap gives `slot_taken`, back-to-back bookings work, and the old `assert_slot_free` still agrees.
  - **Capacity race:** two connections book the last place of a 3-place group at the same instant, and exactly one succeeds. A one-patient service cannot join a group slot and a group cannot join a consultation.
  - `max_per_slot` = 1 limits a group service.
  - Buffer edges are checked to the minute (10:44 is refused, 10:45 is allowed), along with preparation buffers and the 23:30 + 15 minutes case across midnight.
  - Weekly blocks are per location or for every location, with buffers. The override still books.
  - `move_appointment` checks the appointment's own buffers.
  - **`accept_slot_offer` with capacity:** offers are booked while places remain, the remaining offers are marked `taken` only when the slot is full, and a one-place slot is taken as before.
  - **Unite rows** inserted and then moved the way the sync writes them are accepted. They are flagged `blocked` or `full`, as is the portal booking they overlap. Cancelled and fitting rows are not flagged. Another org's ids return nothing, and signed-in users get `permission denied`.
  - A **TypeScript/SQL parity** sweep compared `slotFits` with `app.slot_conflict` for 4 services, every 5 minutes from 08:00 to 17:00 on a day with mixed bookings and weekly blocks, and they matched.
  - RLS on `specialist_recurring_blocks`: an Agent reads but cannot insert, the Admin inserts, the check constraint holds, and the other org sees nothing.
- `tests/db/unite-sync.test.ts` gained a case that runs the **real Unite sync path** (`syncAppointments`, through PostgREST). A Unite appointment for a doctor blocked all day, on top of a portal booking, is created and then moved, and `appointment_capacity_conflicts` flags it `blocked`.
- `tests/db/appointments-service.test.ts` gained a case through PostgREST: `slotsForDay` respects the 20-minute specialist step, buffers and the weekly break; `createAppointment` books two places of a 2-place group and refuses the third.
- These existing suites also pass: `appointment-booking-lock`, `front-desk`, `front-desk-service` (waiting-list offers through `intervalHasPlace`), `appointments-rls`, `sanoflow-import`, `security-guard` (with `SF20C_BOOKING_TABLES` + `seedSf20cBookingRows`), `appointment-reports` and `demo-reset`.
- `tsc --noEmit` and eslint on the changed files are clean, `pnpm audit:security` reports 0 unguarded entry points, and the full `pnpm test` unit suite passes.

## Not built or not verified

- **ShowBusy** (G6 lists it) was not built: there is no "show taken slots greyed out" option. The engine returns only free slots.
- **Places left** are not shown in the slot list. A group slot is listed while at least one place remains.
- The resource grid does not draw weekly blocks; it still draws one-off blocks only. Clicking into a weekly block and booking is refused by the slot list and by SQL, unless overridden.
- No public slot-availability API and no bot booking flow exist to refactor; see Callers above.
- The UI (settings fields, conflict icons and badge) was typechecked and linted, but **not clicked through in a browser** in this session.
- Performance: `appointment_capacity_conflicts` runs `slot_conflict` once per listed row, which is a few indexed lookups each. It was not measured on a full production-size day; the list is capped at 2,000 rows.
- The rules have not been compared with how Sanoflow actually behaves (for example, whether Sanoflow clips buffers to working hours). The decisions above are our own.

## How to add the next booking rule

Change `app.slot_conflict` in a new migration (create or replace) and `slotFits` / `generateSlots` in `lib/appointments/slots.ts` together. Add cases to `tests/unit/appointment-capacity.test.ts`, and extend the parity sweep in `tests/db/booking-capacity.test.ts` so the two implementations stay identical.
