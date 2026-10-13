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

**SQL** (SECURITY DEFINER, `search_path = ''`, service role only): `fin_close_seed_steps(org)` (the standard steps, idempotent, never overwrites an edited step; run for every org by the migration and by `pnpm finance:seed`), `fin_close_generate_tasks(org, month)` (the active steps become the month's tasks, idempotent, nothing for a locked month), `fin_close_set_task_status(...)` (owner or backup check unless the server says the caller manages the close; blocked needs the dependency; keeps the first done-by), `fin_close_claim_reminders(org, ids, today)` (claims each unfinished task once per day). Trigger `app.fin_close_task_guard`: a locked month's tasks can never be added, changed or deleted (all roles), and a task never moves to another month or step.

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
- The 20G plan row also lists extending the pack with P&L, balance sheet, cash and bank, payables, liabilities and variances. That needs 20C, 20D and 20F data and is not built here.
- Reconciling items are the finance exceptions only for now; the open-items measure gains bank items with 20C.
