# Phase 20G notes: the close timetable and close measures

_Built 13 Oct 2026 on `claude/funny-clarke-6t7gee`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20G (deck slides 6, 9 and 11; the finance meeting)._

## What it replaces

The close timetable on slide 9 of the deck ("The next stage of financial & management control"): working day 5 for principal reconciliations and departmental inputs (insurance submissions and resubmissions done by the 5th), working day 7 for revenue shares, incentives and the Tally close (lab reports arrive by the 7th or 8th), working day 8 for draft management accounts, working day 10 for the final Management / Board pack. Each step has an owner (slide 6) and, where a date is unrealistic, names its dependency. The measures on slide 11 are shown next to it.

## What exists

| Piece | Where |
|---|---|
| Close timetable page: the month's steps with due working day and date, owner, backup, dependencies (with their status), done / blocked; overdue highlighted; the Board pack row; close measures; checklist template; calendar and holidays | `/finance/close/timetable` (`app/(app)/finance/close/timetable/page.tsx`, `forms.tsx`, `actions.ts`) |
| The rules (pure, unit-tested): working-day calendar, due dates, overdue, reminders, measures | `lib/finance/close-timetable.ts` |
| Calendar loader, the daily job step, the measures loader (service role after the permission check) | `lib/finance/close-timetable-server.ts` |
| Daily job | step 4 of `runFinanceWorkflows` (`lib/finance/workflows.ts`, queue `finance_workflows`, pg_cron 03:50 UTC) |
| Notification event | `finance.close_due` in `lib/notify/events.ts` (generic push and e-mail text in `lib/notify/push-payload.ts`) |
| Migration | `supabase/migrations/20261029000100_finance_close_timetable.sql`, paste file `deploy/supabase-paste/28_finance_close_timetable.sql` |

**Permissions.** `finance.close.view` reads the timetable and the measures (CEO); `finance.close.manage` marks any step, creates a month's steps and edits the template and the calendar (Finance); new `finance.close.tasks` (Finance, Billing, Insurance, Cost / Payroll presets) sees the timetable and marks only the steps it owns or backs up. The new key exists because step owners (insurance, billing, costs, HR) must not get `finance.close.view`, which opens the close packs and their revenue figures; Cost / Payroll never sees revenue. `finance.close.tasks` holders do not see the measures panel. HR (Merry) has no finance role: give her role `finance.close.tasks` before assigning her a step.

**Tables.** `fin_ref_holidays` (date, name), `fin_close_steps` (code, title, owner, backup, owner's role label, due working day 1 to 23, depends-on codes, evidence hint, active, order) and `fin_close_tasks` (close month, step code, due working day copied from the step, status open / done / blocked, blocked reason, note, done by and at, reminded on). All three have RLS with select policies for the three permissions and no write policies: every change is a server action with `recordAudit` (codes, statuses and counts only; the typed reason and note never reach the audit row). Settings on `fin_ref_finance_settings`: `close_timetable_start` (null = the job is off), `close_weekend_days` (ISO 1 = Monday .. 7 = Sunday, default Saturday and Sunday), `close_inputs_wd` (5), `close_deadline_wd` (10), `close_item_max_age_days` (60).

**SQL** (SECURITY DEFINER, `search_path = ''`, service role only): `fin_close_seed_steps(org)` (the standard steps, idempotent, never overwrites an edited step; run for every org by the migration and by `pnpm finance:seed`), `fin_close_generate_tasks(org, month)` (the active steps become the month's tasks, idempotent, nothing for a locked month), `fin_close_set_task_status(...)` (owner or backup check unless the server says the caller manages the close; blocked needs the dependency; keeps the first done-by), `fin_close_claim_reminders(org, ids, today)` (claims each unfinished task once per day; refuses a locked month). The daily job reminds open steps of the current close month **and of the two before it while they are not locked** (review fix: September's WD23 falls on 2 November, when the timetable is already on October; `reminderMonths()` in `close-timetable.ts`, tested in `tests/unit/finance/close-timetable-reminders.test.ts`). Trigger `app.fin_close_task_guard`: a locked month's tasks can never be added, changed or deleted (all roles), and a task never moves to another month or step.

## The rules

- **Close month and working days.** A close month is the month being closed (as in `fin_period_closes`). Its working days are counted in the month after: September's WD5 is the fifth working day of October. A working day is not a weekend day and not a listed holiday. A step due on a working day beyond the month's count rolls into the next month (WD23 of a 20-working-day February is 3 March).
- **Standard steps** (seeded without names; owners and backups are chosen in the template): WD5 insurance submissions and resubmissions, Diligence reconciliation (depends on submissions), revenue reconciled to Unite, bank and cash reconciled, supplier invoices booked, HR inputs; WD7 lab and referral invoices checked, revenue shares and incentives (depends on Unite revenue, lab and referral invoices, HR inputs), Tally close (depends on supplier invoices, bank and cash); WD8 draft management accounts (depends on Tally, revenue shares, Diligence). Suggested owners from slide 6: Mohammed Sharafadin (insurance, Diligence) with Vineetha as backup; Krishna (revenue, bank and cash); Althaf (supplier invoices, lab and referral invoices, Tally); Merry (HR); Hardik (revenue shares, draft accounts).
- **Board pack issued** is not a step: it is the existing close (Finance signs, the CEO signs and the month locks). The timetable shows it as the last row with its WD10 date and the close status. Nothing is duplicated.
- **Due day snapshot.** A task keeps the working day it was created with, so a template change never rewrites a past month's measure. Owners and backups are read live from the template (a new owner takes over open steps at once).
- **Blocked** needs "waiting for" text (the dependency); the database refuses a blocked step without it.
- **Daily job** (off until a start month is set): from working day 1 it creates the previous month's tasks (idempotent; a step added later joins the month on the next run). On working days only, it sends ONE `notify()` per person for their steps due today or overdue, at most once a day per step (the claim is in the database, so a retry sends nothing). A step with no owner goes to the members holding `finance.close.manage`. In-app, push and e-mail carry a count and the fixed sentence "Open Finance, Close timetable to see which." only.
- **Measures** (last 7 close months ending with the one being worked on):
  - Inputs by WD5: the steps due on or before `close_inputs_wd`. On time = marked done on or before its due date; late = done after it or still not done after it; not yet due = pending. Rate = on time / (on time + late).
  - Close delivered by WD10: the CEO lock date (clinic timezone) on or before WD10 of the following month. "No, not yet closed" once WD10 has passed without a lock.
  - Open reconciling items: open and in-progress finance exceptions (`ops_exceptions`): count, oldest age and how many are older than `close_item_max_age_days`. Bank and settlement items join when 20C exists.
  - Single-person dependency: active steps whose backup is set and differs from the owner.
  - Unapproved invoice changes and the calculation trail: shown as "Not measured yet" (they need 20J and 20F).

## How it was verified

- `tests/unit/finance/close-timetable.test.ts` (17 tests): ISO weekdays, a month starting on a Saturday or Sunday, holidays (National Day moves December's WD5 from the 7th to the 9th), another weekend setting, running past the end of February, the limits, `workingDayOf`, close months across the year end, overdue, reminder selection and grouping, and the measures against the synthetic fixture `tests/unit/finance/fixtures/close-timetable.synthetic.json`.
- `tests/unit/finance-close-timetable-actions.test.ts` (7 tests): every action refuses without its permission before the service role is created; the template, calendar and task creation need `finance.close.manage`; an owner goes through the database's owner check, a manager does not; blocked needs a reason; database refusals are shown, others are not; the audit row holds no typed text.
- `tests/db/finance-close-timetable.test.ts` (13 tests, Postgres 16): the seed and generation are idempotent, the due day is copied, steps with tasks cannot be deleted, who reads (Finance, CEO, Billing, Insurance; not the Medical Director, not another org), nobody writes directly, service-role-only functions, blocked needs a reason (function and table), owner / backup / manager rules, cross-org task not found, the reminder claim is once per task and day, the permission grant block, and a locked month refuses new tasks, changes, deletes and reminders.
- `tests/unit/finance/nav.test.ts`: who sees the page. Typecheck, lint, the unit suite, the database suite and `pnpm audit:security` (see the commit).

## Not verified

- Not clicked through in a browser (no Supabase auth stack here).
- The daily job's PostgREST path (`runCloseTimetable`) is covered by its parts (pure rules, SQL claim and generation) but not end to end, as the PostgREST suites are skipped here.

## Before first use

1. Apply `deploy/supabase-paste/28_finance_close_timetable.sql` to the **Pulse** project (not THC Portal).
2. Finance, Close timetable, Checklist template: assign each step an owner and a trained backup; adjust titles, due days and dependencies.
3. Calendar and settings: check the weekend (Saturday and Sunday) and add the year's UAE public holidays (Islamic holidays move each year: add them when announced).
4. Set the first close month (for example October 2026); from WD1 of the next month the steps appear and owners are reminded.
5. Give HR's role `finance.close.tasks` if Merry owns the HR inputs step.

## Decisions worth knowing

- No step for "Board pack issued": the CEO lock already is that step, with two signatures and the hash; a second checkbox could disagree with it.
- The 20G plan row also lists extending the pack with P&L, balance sheet, cash and bank, payables, liabilities and variances. That is Part 2 below (Board pack controls).
- Reconciling items are the finance exceptions only for now; the open-items measure gains bank items with 20C.

## Part 2: Board pack controls

_Built on `claude/funny-clarke-6t7gee` (deck slide 10: "one concise picture ... not hundreds of transactions; the detailed schedules sit underneath")._

**What it adds.** When the month-end pack is built, `fin_close_controls(org, month, today)` (SECURITY DEFINER, `search_path = ''`, service role only, in `PHASE20_SERVICE_FUNCTIONS`) returns one control summary. It is stored inside the pack snapshot (`controls`), together with the **matters needing attention** derived from it (`matters`, pure `deriveMatters` in `lib/finance/close-controls.ts`), so both are covered by the pack's sha256 and the sign-offs. The page (`/finance/close/[month]`, `controls-summary.tsx`), the Excel ("Controls" sheet, after Summary, text values only) and the PDF (after the summary) all render the frozen copy, never live data. Counts, amounts, statuses and dates only; no patient, payee, supplier or doctor detail (bank accounts by name and last four digits).

| Block | What it says | "Not set up" (null) when |
|---|---|---|
| Bank | per active account: the month's reconciliation status (none, open, reviewed, signed); expected receipts not found (from the frozen figures once reviewed, otherwise "known once the month is reviewed"); bank credits dated up to the month end that are unmatched and carry no reason in any reconciliation (count, amount, oldest age, how many over the age limit) | no active bank account |
| Payables | supplier invoices unpaid **at the month end** (dated on or before it, not void, not paid by a voucher whose payment date is on or before it) by age 0-30 / 31-60 / 61-90 / 90+ at the month end; approved vouchers not paid (oldest days since approval, over the limit); vouchers waiting to be verified, for approval, for the CEO, at Tally | no supplier invoice and no voucher |
| Revenue share | the month's run status, approval date, due date (WD `close_revshare_wd`); liability approved or posted but not paid (the `fin_revshare_liability` runs up to this month) | no scheme and no run |
| Invoice changes | unapproved changes dated in the month (the 20J measure: needs approval, on or after the start date, no review or "not approved") | "Not measured" while there is no start date (or it is after the month) |
| Insurance receivables | open claims and outstanding (20I's `fin_followup_open_claims`), the amount and share over 90 days | no claim activity at all |
| Close timetable | steps done and blocked; inputs due by WD `close_inputs_wd` on time / late / not yet due (the timetable page's rule) | no task for the month |
| Exceptions | open finance exceptions, oldest age, how many are older than the age limit (same count as the pack's open exceptions) | always shown |

**As of what.** Payables are as at the month end. Everything else (reconciliation status, vouchers, revenue-share runs and liability, receivables, the timetable, exceptions) is the state at the build date in the clinic's time zone, like the pack's receivables ageing; ages are counted to the build date. Working days are counted in SQL the same way as `lib/finance/close-timetable.ts` (weekend days and holidays; a test compares the two).

**Matters needing attention** (each threshold read from `fin_ref_finance_settings` at build time and frozen with the summary): a bank reconciliation for the month not signed; unexplained bank credits older than `close_item_max_age_days` (60); approved vouchers unpaid longer than `close_voucher_unpaid_days` (new, 14); the revenue-share run not approved, or approved after WD `close_revshare_wd` (new, 7); any unapproved invoice change; insurance receivables over 90 days above `close_receivables_over90_pct` of the outstanding (new, 25%); inputs late or missing; blocked steps; finance exceptions older than the age limit. The three new settings are on Finance, Close timetable, Calendar and settings ("Board pack: matters needing attention").

**Said plainly on the page, in Excel and in the PDF:** the P&L in Pulse is the provisional profitability view (Finance, Profitability); the balance sheet comes from Tally; employee incentive liabilities are not held in Pulse yet.

**Old packs.** A pack built before this change has no `controls`; it still opens, downloads and signs, and shows "Not captured in this pack". Rebuild an unsigned month to add the summary; signed and locked packs never change.

**Files.** `supabase/migrations/20261106000100_finance_close_controls.sql` (paste file `deploy/supabase-paste/36_finance_close_controls.sql`, after `35_finance_labs.sql`), `lib/finance/close-controls.ts`, `lib/finance/close-pack.ts` (optional `controls` and `matters`), `close-server.ts` (calls the function when building), `close-xlsx.ts`, `close-pdf.ts`, `app/(app)/finance/close/[month]/controls-summary.tsx`, the settings form in `app/(app)/finance/close/timetable/`.

**Verified.** `tests/unit/finance/close-controls.test.ts` (matters on a troubled and a clean month, a share equal to the limit, "not set up" and "not measured", the revenue-share cases, amount text, the pack freezing the summary, an old pack unchanged and rendering "not captured" in Excel and PDF, the Controls sheet with no formulas, the PDF text); `tests/unit/finance/close-pack.test.ts` (sheet list); `tests/unit/finance-close-timetable-actions.test.ts` (threshold validation); `tests/db/finance-close-controls.test.ts` (10, Postgres 16: every block against hand-worked synthetic rows, the working days against the TypeScript calendar with a holiday, pending inputs on an earlier day, thresholds from the settings, the derived matters, another org excluded, "not set up" for an empty org, an unknown org refused, service-role only, and the summary inside the stored snapshot with the sha256 covering it).

**Not verified / decisions.** Not clicked through in a browser. The new defaults (14 days for vouchers, 25% over 90 days) are placeholders until Hardik sets them. Expected receipts of an open reconciliation are not shown (the reconciliation screen computes them; copying that logic into SQL would duplicate it). A bank credit explained with any reason counts as explained, as in 20C's review. Material variances and unusual transactions are not separate blocks yet: the drift table, cash-up variances, the voucher report's unusual transactions and the exceptions cover them until the clinic's Board pack template (D11) says what it wants.
