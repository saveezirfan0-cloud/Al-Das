# W2: appointments and invoices

Date: 17 Oct 2026. Plan of 16 Oct 2026, section 3, row W2. Migration: `supabase/migrations/20261222000100_finance_appointment_billing.sql`.

## What it does

Finance, Appointments and invoices (`/finance/appointment-billing`) sets the **Unite appointment export** for a month against the **Unite invoices** Pulse holds (`fin_invoices`) and shows:

- **Seen, not billed** and **billed, not seen** lists;
- a **review list** of what cannot be matched with certainty (never guessed);
- **utilisation per doctor**, and **per room** when the file has a room column: booked and seen hours against available hours;
- an Excel download with a Definitions sheet (`/api/finance/appointment-billing`).

Permissions: the page and the download need `finance.revenue.view` (it is a Capacity-style page); the upload needs `finance.revenue.import` (the Unite collection report's key). No new permission. Branch access is the Capacity page's (`loadCapacityScope`, `branchVisible`).

## How to use it

1. Export the month's appointments from Unite (.xlsx or .csv, up to 10 MB, one month at a time).
2. Drop the file in the upload box on the page. The preview shows the columns that will be read, the names (never values) of the columns that will be ignored, and any required column the file lacks. Import.
3. Pick the month and branch. The page needs the Unite invoices to be in Pulse (the capture or the invoice import) to say what was billed.

The original file is read once and never kept; only its sha256 and the sanitised rows are stored (`fin_appt_uploads`, `fin_appt_rows`, service role only). A new file replaces (`is_current = false`, nothing deleted) the earlier rows for the same dates and clinics. The same file twice changes nothing.

## From the Unite connection (23 Oct 2026)

Al Das confirmed the appointment list comes from the Unite API (the same `getallappointments` Make uses for reminders), so W2 no longer waits for an export file (data request D16). Migration `20261230000100_finance_appointments_from_unite.sql` (paste 115).

- **Settle pull.** The nightly Unite appointment run (`unite_nightly`, per clinic, only when `enabled.appointments`) also re-reads, in **one** call, the finished days of the last week the clinic has not settled (the first night: the whole week before it). It is **quiet**: rows are written as usual, but no reminders, events, timeline entries or freed-slot offers follow, because those days are over. A pull that skipped or failed any record settles nothing. Settled days per clinic are kept in `sync_cursors` (`entity = 'appointments_settled'`, `{ settled: [...] }`, newest 31 days); the run log is `appointments_settle_run`. It never reaches further back than a week by itself, and it never calls the Finance API.
- **Hand-over** (`handOverUniteDays`, `lib/finance/appointment-api-server.ts`). A day goes to W2 only when **every** active clinic with a Unite id has settled it, so a day never looks covered with a clinic missing. The day's rows go through the same `fin_appt_import` as a file, with `p_meta.source = 'unite_api'`, no person (`created_by` null) and a sha256 over the sanitised rows, so the same day twice changes nothing and a changed day replaces the earlier rows for its clinics.
- **Rows** (`uniteDayRows`, `lib/finance/appointment-api.ts`, pure): appointment id = Unite's; date and start in the clinic's time zone; length only when Unite sent an end time (`custom.unite_end_given`; the sync's default length is never read as real); the Unite PIN from the sync (`custom.unite_patient_pin`); the doctor is the linked Pulse doctor's name, else the name Unite sent; the clinic is the Unite long name of the location's finance branch (`locations.branch_code`), else none.
- **Status.** Through Settings, Unite EMR's code table (`unite_appointment_status_map`): completed → honoured, cancelled → cancelled, confirmed → confirmed, awaiting → awaiting, no-show → confirmed (booked and not seen). **A code with no meaning set (OQ-23) holds the whole day** and is logged by code only; nothing is guessed. Today every seeded code is unset, so nothing arrives until Finance or Unite confirm the codes.
- **Files still work** for days before the sync was on, or to correct a day. The newest upload for a day and clinic wins, whichever its source (`fin_appt_uploads.source`: `file` or `unite_api`).

Needs before it runs: the Unite API credentials for Pulse (OQ-26, Settings, Unite EMR), the clinics' Unite ids on their locations, and the meaning of the appointment status codes (OQ-23), above all which code is Honoured.

## The status rule

| Unite status | Meaning here | No invoice | With an invoice |
|---|---|---|---|
| Honoured | seen | **seen, not billed** (inside the days the invoices cover) | seen and billed |
| Cancelled | not seen | nothing (**never** seen, not billed) | **billed, not seen** |
| Confirmed, Awaiting Confirmation | not closed | still open (not an exception) | **billed, not seen** |

An unknown status word refuses the whole file and is listed by name (a new Unite status must be decided on, not guessed).

## Matching (pure: `lib/finance/appointment-billing.ts`)

1. By appointment id: an invoice whose `appointment_id` equals the appointment's. An appointment may have several invoices (self-pay and insurance).
2. Only for an appointment step 1 left without an invoice: an invoice with **no** appointment id (a direct invoice) for the same Unite PIN, the same doctor (normalised name) and the same day. Used only when exactly one appointment that is not cancelled has that PIN, doctor and day; with two or more it goes to review.
3. An appointment id that appears twice in the file goes to review. An invoice dated in the month that names an appointment id no uploaded file holds goes to review ("invoice's appointment not in the file"), unless another month's file holds it.
4. An invoice with no appointment id is valid (a direct invoice) and is never "billed, not seen". Deleted invoices and credit notes (negative net) are not bills and are left out.

**Invoice coverage.** The invoices Pulse holds may not cover the whole month (the Unite capture is off until Finance enables it). An honoured appointment with no invoice is judged only on days between the first and last invoice date of the month; outside them it is "not judged", and with no invoices at all nothing is judged.

## Utilisation

- Booked = appointments that are not cancelled; seen = honoured. Hours come from the file (end minus start, else a duration column). If any booked appointment has no length, that doctor's or room's hours and percentages are blank (never 0).
- Doctor available hours are the Capacity page's number (`loadCapacity`), reached through the one doctor link (`specialists.report_doctor_key`, the Doctors page). An unlinked doctor shows hours but no percentage.
- Room open hours = open days x room opening hours (Capacity page); a room name matches Settings, Rooms for the same branch by name, ignoring case and spacing. A room not in Rooms shows hours but no percentage.
- Branch comes from the clinic column through the current branch mapping (long name or any alias). A file with no clinic column has no branch, so only members who see every branch see its appointments.

## Assumptions that need the real export file

The real column names are unknown (only a one-day sample exists, outside the repo). All of them live in `lib/finance/appointment-mapping.ts` as alias lists; the first real upload tells what to add:

- required: appointment id, appointment date (a date, optionally with a time), appointment status, doctor name;
- optional: Unite PIN, clinic, room, start time, end time, duration (minutes);
- dates are day-first (`14-Oct-2026`, `14/10/2026`) or ISO; Excel date cells are read as clinic wall clock;
- appointment ids and invoice appointment ids are compared exactly after trimming (leading zeros are not normalised);
- the status words are the four in docs/41; the doctor name spelling is normalised like the Unite collection report's;
- the invoice's doctor is compared by name (`fin_invoices.doctor_name`), as no DHA id is in the appointment file.

A refused file says which required fields it could not find and lists the file's unrecognised header names (names only).

## Not done

- ~~The Capacity page still shows "Needs Unite appointments" for its booked-against-available column.~~ Done: the Capacity page now reads this upload (docs/48_CAPACITY_APPOINTMENTS_NOTES.md).
- Room occupancy from the staff rota is unchanged (M3A follow-up).
- Nothing writes to Unite or `fin_invoices`.
