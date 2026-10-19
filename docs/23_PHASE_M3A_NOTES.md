# M3a: rooms and capacity measures (first slice of M3)

Date: 14 Oct 2026. Plan: `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §4 (M3) and `docs/34_CLINIC_OS_PLAN.md` Phase E
(rooms). Migration: `supabase/migrations/20261208000500_rooms_capacity.sql`. It sorts after
`20261202000100_organisation.sql` (PR #72), whose `rota_shifts` is Pulse's one rota: this slice deliberately adds no
second rota.

## What is built

| Piece | Where | Who |
|---|---|---|
| Rooms register (branch, name, kind, monthly cost, in use) | Settings, Rooms (`/settings/rooms`) | `rooms.manage` (new; Admin via `*`, Manager preset) |
| Capacity measures for a month | Finance, Capacity (`/finance/capacity`) | `finance.revenue.view` |
| Unite doctor ↔ Pulse doctor link | Doctors page, Finance link (`specialists.report_doctor_key`, `20261205000100_doctor_identity.sql`); Capacity lists the doctors not linked yet | `settings.manage` and `finance.reference.manage` |
| Room opening hours setting | Finance, Capacity, "Room opening hours" | `finance.targets.manage` |

**Tables.**
- `rooms`:
  - `org_id` and `location_id`;
  - `name`, unique per branch, so a rota shift's room can later be matched to it;
  - `kind`: consultation / procedure / dental / other;
  - `monthly_cost numeric(12,2)`: null means unknown, and 0 is refused;
  - `active`.
- `fin_ref_finance_settings.room_open_hours_per_day` (default 10, 0 < h ≤ 24).

**RLS.**
- Select policies only. Every write is a server action that uses the service role after `requirePerm` / `can`, and is
  audited with `recordAudit`.
- `rooms`: `rooms.manage` and `app.location_visible_to()` on the room's branch.
- `rooms` is in the security-guard sweep (`M3_TABLES`, `seedM3Rows`).

Booking is untouched: `app.slot_conflict` and `slotFits` never read rooms.

## The measures (`lib/capacity/`, pure, unit-tested)

- **Available hours (doctor):** working-hours windows on open days, minus weekly blocks and one-off `time_blocks`
  (leave). It reuses the slot engine (`workingWindows`, `expandRecurringBlocks`, `isOpenDay`), so open days are the
  booking rules' working week and holidays (Settings, Appointment rules).
  - Overlapping blocks are cut once.
  - Overlapping rows, and two branches at the same moment, count once.
  - Each branch uses its own timezone, and blocks follow their branch (null = every branch).
- **Revenue (doctor):** Unite net billing for the month from the current collection-report rows. It comes from the
  same SQL as doctor performance (`fin_doctor_performance_inputs`), summed over departments and over every linked key.
  A doctor with no link shows "Not linked", never 0.
- **Revenue per available hour** = revenue ÷ available hours. It is blank when either side is unknown or zero. The
  headline figure uses only doctors who have both.
- **Rooms:** open hours (open days × `room_open_hours_per_day`) and monthly cost. An unknown cost stays unknown. Only
  people with `finance.costs.view` or `finance.profit.view` see cost (Billing and the Medical Director get no cost
  data).
- **Shown as "Needs the staff rota":** room rota hours, occupancy and revenue per room-hour.

**Branch access (Phase B).**
- Hours and rooms keep to the branches the member may see, then to the page's branch choice (default: the branch
  switcher's).
- Revenue keeps to their finance branch codes, exactly as doctor performance does.
- A chosen branch with no `locations.branch_code` shows hours and rooms but no revenue, with a note. Revenue is not
  guessed.

## Follow-up: room measures from the staff rota (PR #72 is merged; this is the next step)

PR #72's `rota_shifts` has dated shifts per staff member and branch, with `room` as free text (up to 40 characters).
To finish the room measures:

1. Link a shift to a room.
   - Add `rota_shifts.room_id uuid references rooms` (same branch, checked by trigger), and keep or retire the
     free-text `room`.
   - Back-fill it by matching the text to `rooms.name` within the shift's branch. Names are unique per branch for
     this.
   - Add a room picker in the rota editor.
2. Tie a doctor's shift to the doctor (`staff_members` ↔ `specialists`, as #72 defines it), so room hours can be
   split per doctor.
3. Compute, in `lib/capacity/`:
   - room rota hours (the dated shifts in the month, clipped to it);
   - occupancy = rota hours ÷ open hours;
   - revenue attributed to rooms by each doctor's share of rota hours (largest remainder, so the shares add up to the
     doctor's revenue);
   - revenue per room-hour;
   - cost per rota hour.
   The first version of this branch had these with tests (commit d9f46b6, on a weekly room rota); reuse that maths on
   dated shifts.

## Waits on the Unite appointment feed

Shown as "Needs Unite appointments", never as a number:
- ~~Appointment utilisation: booked minutes ÷ available minutes, per doctor and overall.~~ Filled from the Unite
  appointment upload (W2) when it covers the month and the doctor's branches: docs/48_CAPACITY_APPOINTMENTS_NOTES.md.
- No-shows, late cancels and retention (the rest of M3 in docs/40).
- Alerts: under-booked doctor, under-used room, no-show spike.

Pulse sees only bookings made in Pulse until Unite appointments flow, so any booked figure would understate.

## Decisions taken here (for review)

1. **One doctor link.** Revenue meets hours through `specialists.report_doctor_key`, the link made on the Doctors page
   (main's doctor identity, docs/34 Phase C). This slice first had its own mapping table (`fin_ref_doctor_keys`); it was
   dropped before release so a doctor is linked in one place (OQ-160). Spellings that differ only in case or
   punctuation already share one report key (`normaliseDoctorKey`).
2. **Room cost is entered on the rooms page** by whoever holds `rooms.manage` (Admin, Manager), who therefore sees it.
   On Finance, Capacity the cost column needs a cost or profit permission.
3. **A room's branch is fixed after creation** in the rooms page (delete and re-add to move it), so later shift links
   cannot point across branches.

## Open questions (OQ-158 to OQ-160 in `docs/audit/open-questions.md`)

- Real opening hours per branch and weekday (would replace `room_open_hours_per_day`). Owner: Operations.
- Cost per hour, once room hours exist: per rota hour (used) or per open hour? Owner: Finance Manager.
- One doctor key: answered by the Doctors page link (OQ-160).

## Not done in this slice

- Rooms as bookable resources (Phase E, later).
- The metric register entry for these measures (docs/40 §2.3).
