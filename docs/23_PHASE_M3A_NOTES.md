# M3a: rooms, room rota and capacity measures (first slice of M3)

Date: 14 Oct 2026. Plan: `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §4 (M3), `docs/34_CLINIC_OS_PLAN.md` Phase C (rota) and
Phase E (rooms). Migration: `supabase/migrations/20261127000500_rooms_capacity.sql`.

## What is built

| Piece | Where | Who |
|---|---|---|
| Rooms register (branch, name, kind, monthly cost, in use) | Settings, Rooms (`/settings/rooms`) | `rooms.manage` (new; Admin via `*`, Manager preset) |
| Weekly room rota (doctor × room × weekday × time) | the same page, "Rota" drawer per room | `rooms.manage` |
| Capacity measures for a month | Finance, Capacity (`/finance/capacity`) | `finance.revenue.view` |
| Unite doctor ↔ Pulse doctor links | Finance, Capacity, "Unite doctors and Pulse doctors" | `finance.reference.manage` |
| Room opening hours setting | Finance, Capacity, "Room opening hours" | `finance.targets.manage` |

**Tables.**
- `rooms` (`org_id`, `location_id`, `name` unique per branch, `kind` in consultation / procedure / dental / other,
  `monthly_cost numeric(12,2)`: null = unknown, 0 refused, `active`).
- `room_rota` (`org_id`, `room_id`, `specialist_id`, `weekday` ISO 1–7, `start_min`, `end_min`).
- `fin_ref_doctor_keys` (`org_id`, `doctor_key` → `specialist_id`; several keys may point at one doctor).
- `fin_ref_finance_settings.room_open_hours_per_day` (default 10, 0 < h ≤ 24).

**RLS.** Select policies only; every write is a server action (service role after `requirePerm` / `can`, audited with
`recordAudit`). `rooms`: `rooms.manage` and `app.location_visible_to()` on the room's branch. `room_rota`: `rooms.manage`
and the room visible under the rooms policy. `fin_ref_doctor_keys`: `finance.revenue.view` or `finance.reference.manage`.
All three are in the security-guard sweep (`M3_TABLES`, `seedM3Rows`).

**Rota rules (database).**
- A room is never on the rota twice at overlapping minutes on the same weekday. This is a trigger
  (`app.room_rota_check`) under a per-room advisory lock rather than an exclusion constraint, so no `btree_gist`
  extension is needed. Two concurrent writers are tested.
- The doctor must work at the room's branch (`specialist_locations`).
- A room with a rota cannot move to another branch. Minutes are half-open, so 09:00–12:00 and 12:00–15:00 fit.

Booking is untouched: `app.slot_conflict` and `slotFits` never read rooms or the rota.

## The measures (`lib/capacity/`, pure, unit-tested)

- **Available hours (doctor):** working-hours windows on open days, minus weekly blocks and one-off `time_blocks`
  (leave). It reuses the slot engine (`workingWindows`, `expandRecurringBlocks`, `isOpenDay`), so open days are the
  booking rules' working week and holidays (Settings, Appointment rules).
  - Overlapping blocks are cut once.
  - Overlapping rows, and two branches at the same moment, count once.
  - Each branch uses its own timezone, and blocks follow their branch (null = every branch).
- **Revenue (doctor):** Unite net billing for the month from the current collection-report rows. It comes from the
  same SQL as doctor performance (`fin_doctor_performance_inputs`), summed over departments and over every linked
  key. A doctor with no link shows "Not linked", never 0.
- **Revenue per available hour** = revenue ÷ available hours. It is blank when either side is unknown or zero. The
  headline figure uses only doctors who have both.
- **Room rota hours:** each weekly rota row counted on every open day with that weekday.
- **Occupancy:** rota hours ÷ open hours, where open hours = open days × `room_open_hours_per_day`. Branches have no
  opening hours in Pulse (`clinic_calendar` has days, not hours), so the setting is used everywhere for now.
- **Revenue attributed to a room:** each doctor's revenue is split over their rooms by their share of rota hours, in
  thousandths with the largest remainder, so the parts always add up to the doctor's revenue. Revenue of a linked
  doctor with no rota hours in scope stays "not attributed" and is shown as a separate line.
- **Revenue per room-hour** = attributed revenue ÷ rota hours.
- **Cost per rota hour** = monthly cost ÷ rota hours. An unknown cost stays unknown. Only people with
  `finance.costs.view` or `finance.profit.view` see it (Billing and the Medical Director get no cost data).

**Branch access (Phase B).**
- Hours, rooms and the rota keep to the branches the member may see, then to the page's branch choice (default: the
  branch switcher's).
- Revenue keeps to their finance branch codes, exactly as doctor performance does.
- A chosen branch with no `locations.branch_code` shows hours and rooms but no revenue, with a note. Revenue is not
  guessed.

## Waits on the Unite appointment feed

Shown as "Needs Unite appointments", never as a number:
- Appointment utilisation: booked minutes ÷ available minutes, per doctor and overall.
- No-shows, late cancels and retention (the rest of M3 in docs/40).
- Alerts: under-booked doctor, under-used room, no-show spike.

Pulse sees only bookings made in Pulse until Unite appointments flow, so any booked figure would understate.

## Decisions taken here (for review)

1. **Weekday is ISO 1–7**, not 0–6, to match `working_hours` and `specialist_recurring_blocks`. The rota can then
   be compared with working hours without conversion.
2. **Doctor link as a mapping table** (`fin_ref_doctor_keys`), not `specialists.report_doctor_key`. Unite spells one
   doctor several ways over time, so several keys may point at one doctor. The `specialists` rows stay untouched.
3. **Cost per hour is per rota hour** (used hours), so it sits next to revenue per room-hour. Cost per open hour would
   be monthly cost ÷ open hours.
4. **Rota is the plan.** Leave is not subtracted from room rota hours, but it is subtracted from the doctor's
   available hours.
5. **Room cost is entered on the rooms page** by whoever holds `rooms.manage` (Admin, Manager), who therefore sees
   it. On Finance, Capacity the cost column needs a cost or profit permission.
6. **No double-booking check for a doctor across rooms.** One doctor may hold two rooms at once (for example, two
   dental chairs).

## Open questions to raise (not yet in `docs/audit/open-questions.md`)

- Real opening hours per branch and weekday (would replace `room_open_hours_per_day`). Owner: Operations.
- Cost per rota hour vs per open hour (decision 3). Owner: Finance Manager.
- Should a doctor be refused two rooms at the same time (decision 6)?
- When a doctor is removed from a branch, their rota rows there stay and are flagged "No longer at this branch" on
  the rooms page. Should they be removed automatically?
- `fin_ref_doctor_keys` vs the planned `specialists` ↔ `fin_ref_doctors.dha_id` link (docs/40 §2). When the DHA link
  lands, revenue could be keyed by DHA id instead of the report's doctor name.

## Not done in this slice

- A `deploy/supabase-paste` file for the migration (paste files follow review).
- Rooms as bookable resources (Phase E, later).
- Rota history (the rota is the current weekly plan; past months use today's rota).
- The metric register entry for these measures (docs/40 §2.3).
