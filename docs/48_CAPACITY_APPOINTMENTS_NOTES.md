# Capacity: booked against available from the Unite appointment upload

Date: 19 Oct 2026. Follows docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md ("Not done") and docs/23_PHASE_M3A_NOTES.md
("Waits on the Unite appointment feed"). No migration, no new table, no new permission.

## What changed

Finance, Capacity (`/finance/capacity`, `finance.revenue.view`) showed "Needs Unite appointments" in the doctors'
**Booked vs available** column and in the **Appointment utilisation** tile. Both are now filled from the Unite
appointment export uploaded on Finance, Appointments and invoices (W2: `fin_appt_rows`, `fin_appt_uploads`, service
role only) whenever that upload covers the month, the branch and the doctor. Otherwise the cell keeps "Needs Unite
appointments" and says why in one short line.

| Piece | Where |
|---|---|
| The rule (pure) | `lib/finance/capacity-appointments.ts` (`capacityBookings`, `NO_BOOKING_LABEL`) |
| Loader (service role, after the page's `requirePerm`) | `lib/finance/capacity-appointments-server.ts` (`loadCapacityBookings`) |
| Capacity loader | `lib/capacity/server.ts`: `Capacity.doctorScope` (each shown doctor's report key and working-hours branches in scope) |
| Page | `app/(app)/finance/capacity/page.tsx` (`BookedCellView`, the tile, a part-month and a truncation alert, footer) |
| Guides | `finance-capacity` and `finance-appointment-billing` in `lib/help/guides.ts` |
| Tests | `tests/unit/finance/capacity-appointments.test.ts`, `capacity-appointments-server.test.ts`, one assertion in `tests/unit/capacity/server.test.ts` |

## The measure

The W2 measure, unchanged (`doctorUtilisation` in `lib/finance/appointment-billing.ts`): booked = appointments that are
not cancelled, seen = honoured; booked hours come from the file (end minus start, else duration); if any booked
appointment has no length the hours and percentage are blank, never 0. Available hours are the Capacity page's own
(working hours on open days minus weekly blocks and leave). Booked % = booked hours / available hours, one decimal.
The cell shows the percentage and "N booked, M seen; X of Y h". The tile is booked hours over available hours of
the doctors that have both.

Counts and hours only: the loader never selects `patient_pin`, and no appointment id, PIN or patient name reaches the
page (a test checks the select list and the result).

## When a figure is shown (the coverage rule)

| Reason (cell keeps "Needs Unite appointments") | Meaning |
|---|---|
| No appointment file for this month | no current row dated in the month |
| The appointment file covers part of the month | the uploads holding current rows do not cover every day (an alert lists the dates) |
| A branch has no finance branch code | the chosen branch, or a branch of the doctor's working hours in view, has no `locations.branch_code` |
| A branch of this doctor is not in the appointment file | a working branch in view has no appointment at all in the month's file (that clinic was not exported) |
| Some appointments have a clinic not mapped to a branch | the doctor has unknown-branch rows this member may not see (23B rule), so the figure would understate |
| Not linked to a Unite doctor | no `specialists.report_doctor_key` (the one doctor link, Doctors page) |

A linked doctor whose branches are all in the file and who has no appointments shows a real 0. A doctor with
appointments but no available hours shows the counts and no percentage. A read that hits its safety ceiling (60,000
rows) withholds every figure and says so.

**Branch rule (23B).** The clinic name becomes the finance branch through `branchOfClinic` (long name or any alias,
docs/41); rows are kept to `branchVisible` with the Capacity scope (`branchScopeOf`): the page's branch choice narrows,
never widens; unknown-branch rows count only for a member who sees every branch and chose none. Available hours are
already kept to the same branches, so both sides of the ratio cover the same branches.

## Decisions

- **Whole month only.** A part-month file next to whole-month available hours would understate; the page waits for
  the rest of the month rather than pro-rating.
- **A clinic missing from the file is not zero.** A doctor's branch with no appointment rows at all is treated as not
  exported, not as an empty diary. A branch that truly had no appointments in a month would also show no figure; that
  is the safe side.
- **Rooms unchanged.** Room occupancy still waits for the staff rota (M3A follow-up); the W2 page already shows room
  booked hours against open hours.
- Bookings made in Pulse are not counted (Unite is the diary the export comes from).

## How it was verified

- `pnpm vitest run tests/unit/finance/capacity-appointments.test.ts tests/unit/finance/capacity-appointments-server.test.ts tests/unit/capacity`
  and the wider unit runs listed in the report.
- Not clicked through in a browser (no Supabase auth stack here); the page was typechecked and linted.
- No real appointment export: the W2 column assumptions (docs/47 W2, "Assumptions that need the real export file")
  apply here too.
