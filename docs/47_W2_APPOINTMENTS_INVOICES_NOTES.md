# W2: appointments and invoices

Date: 17 Oct 2026. Plan of 16 Oct 2026, section 3, row W2. Migration: `supabase/migrations/20261210000100_finance_appointment_billing.sql`.

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

- The Capacity page still shows "Needs Unite appointments" for its booked-against-available column; this page fills that gap. Linking the two is a follow-up.
- Room occupancy from the staff rota is unchanged (M3A follow-up).
- Nothing writes to Unite or `fin_invoices`.
