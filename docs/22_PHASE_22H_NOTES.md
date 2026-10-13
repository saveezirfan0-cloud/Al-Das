# Phase 22H notes: fixed assets, depreciation, prepayments and accruals

_Built 13 Oct 2026 on the 22H worktree branch (based on `claude/funny-clarke-6t7gee` at `2d1fa54`). Plan: `docs/22_ACCOUNTING_PLAN.md` §1 to 5 and the 22H row. Builds on the 22A ledger core (`docs/22_PHASE_22A_NOTES.md`): every figure reaches the ledger through `acc_post_from_source`._

## What it is

A fixed asset register with monthly depreciation, and schedules that spread prepayments, accruals and deferred revenue over their months. Each month has one run per kind (depreciation, schedules, reversing accruals). A run is **prepared** (by a person with `accounting.assets.manage`, or by the monthly job) and **posted** by a different person holding `accounting.journals.approve`, bound to the sha256 of the lines they reviewed, as ONE journal. Disposals follow the same two-person rule and book the gain or loss.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 48, needs 43 and 41 first) | `supabase/migrations/20261109000500_accounting_assets.sql`, `deploy/supabase-paste/48_accounting_assets.sql` |
| Pure rules (unit-tested) | `lib/accounting/assets/depreciation.ts` (schedules, full-month convention, catch-up, disposal figures, forecast), `schedules.ts` (even releases), `runs.ts` (which assets and schedules a month's run holds), `register.ts` (register at a date, totals by class and branch, schedule status), `errors.ts` (hints as sentences) |
| Server | `lib/accounting/assets/server.ts` (loaders, `prepareRun`, `loadAssetReport`), `xlsx.ts` (workbook), `job.ts` (monthly job) |
| Pages (Accounting, section Assets) | `/accounting/assets` (register at a date, add / edit, dispose, classes), `/accounting/depreciation` (runs, line preview, post, 12-month forecast), `/accounting/schedules` (schedules, their runs) |
| Export | `GET /api/accounting/assets?asOf=` (register, forecast, schedules; `recordAudit` + `recordExport`) |
| Job | `/api/jobs/accounting_assets`, pg_cron `pulse:accounting_assets` daily 04:25 UTC (`lib/jobs/handlers/accounting-assets.ts`) |
| Notification | `accounting.runs_prepared` (Work, `accounting.assets.manage`, in-app by default; push and e-mail carry the generic sentence only) |
| Help | guides `accounting-assets` and `accounting-schedules`; release note `2026-11-09-accounting-assets` |

## Tables (all `public.acc_*`, `org_id` on every row, RLS read for any `accounting.*` key via `app.acc_can_view`, no write policy)

- `acc_asset_classes`: code, name, cost / accumulated depreciation / depreciation expense / gain-or-loss ledgers, method, life in months, residual %. Seeded (straight line, no residual): **medical equipment 60 months, IT equipment 36, furniture and fittings 60, leasehold improvements 60 (or the lease term if shorter), motor vehicles 60**. The seed adds ledgers 1520 IT equipment, 1530 Leasehold improvements, 1540 Motor vehicles, 1591 to 1595 accumulated depreciation per class, 2310 Deferred revenue and 4910 Gain or loss on disposal; the 22A ledgers 1500, 1510 and 6400 are reused. Run for every existing org and by the trigger `orgs_seed_finance_phase22h` (after the chart) for new ones.
- `acc_assets`: code (blank = next `FA-00001`), class, description (never patient data; redacted like narrations), branch, department, acquisition and in-service dates, cost, residual, life, method, status active / disposed / fully_depreciated, `opening_accumulated` (depreciation already in the books before Pulse, from Tally's opening balance; runs charge only what the schedule adds beyond it), optional `supplier_invoice_id` (20D bill), and the disposal columns. `record_history` is on.
- `acc_schedules`: kind prepayment / accrual / deferred_revenue, P&L ledger, balance-sheet ledger, total, first month, months, branch, department, `auto_reverse` (accruals only), status active / completed / cancelled, optional bill.
- `acc_depreciation_runs`: entity, kind (depreciation / schedules / reversing_accruals), month, `version`, status draft / posted / waiting_ledger_start, total, line count, sha256, prepared by (null = the job), posted by, `posted_version`, journal.
- `acc_asset_run_lines`: one line per asset or schedule per run version; the database derives the accounts and dimensions from the class or schedule (never from the caller). Lines of the posted version stay until a newer version is posted: they ARE the books' accumulated depreciation per asset.

## The rules (SQL, every role)

- **Maker and checker.** `acc_asset_run_post` and `acc_asset_disposal_post` need `accounting.journals.approve`, a person other than the preparer (`same_person`) and the sha256 of what they reviewed (`hash_mismatch`; the run hash is recomputed from the stored lines). A CHECK repeats the different-person rule on the live version and on disposals.
- **One journal per run** via `acc_post_from_source('fixed_asset', <run id>, <version>, <last day of the month>, 'journal', ...)`: one debit and one credit per account pair, branch and department (depreciation: Dr expense, Cr accumulated depreciation, by class and branch; prepayment: Dr expense, Cr prepayment; accrual: Dr expense, Cr accrued; deferred revenue: Dr deferred revenue, Cr income).
- **Idempotent re-runs.** Preparing the same lines again changes nothing (`changed: false`). A posted month whose lines differ becomes version N+1 (a draft that needs a checker again); posting it reverses the old journal and posts the new one (22A's version replacement). An empty version reverses the previous journal and posts nothing.
- **Catch-up, and the latest month only.** A month's charge is the schedule's cumulative to that month minus what earlier posted months charged, so a back-dated asset or a missed month is caught up in the next run. Therefore a month before a later posted month of the same kind cannot be prepared or posted (`later_month_posted`). A future month is refused (`future_month`).
- **Never below the residual** (`over_depreciated`, counting every posted month and this run).
- **Figures lock once depreciated.** After the first posted depreciation an asset's cost, residual, life, method, dates, class and entity no longer change (`asset_in_use`); description, branch and department still can. An asset with run lines or a disposal is never deleted. Status and disposal columns change only inside the functions. A schedule with a posted release keeps its figures (cancel it instead, `schedule_in_use`). Runs and lines are written only by the functions (`posted_immutable`).
- **Bills.** The assets linked to a supplier invoice never cost more than its net amount (`invoice_over_capitalised`). The bill's own posting (Dr asset, Cr payables) is 22D's; 22H only links and records.
- **Ledger start.** If `acc_post_from_source` refuses with the hint `before_ledger_start` (the central ledger start date rule added by another slice), the run or disposal becomes `waiting_ledger_start`, shown on the page, and is posted again later by the same rules. Any other refusal (period closed or locked, CEO month lock) is shown as the ledger's sentence and nothing changes.

## Conventions (decisions)

- **Full-month convention.** An asset is depreciated for the whole month it goes into service, whatever the day, for `life_months` months. **The month of disposal gets no depreciation**: the disposal charges up to the end of the month before.
- **Straight line**: each month is the rounded cumulative minus the previous one (exact total). **Reducing balance**: double declining (2 / life per month on the opening net book value), switching to straight line over the remaining months once that is higher, so it lands exactly on the residual at the end of the life. There is no per-class rate field; say if the auditors want a different rate.
- **Disposal journal** (`fixed_asset`, source id `disposal:<asset id>`): Dr accumulated depreciation (opening plus what the runs posted), Dr depreciation expense (the schedule through the month before disposal minus that, when positive: a catch-up), Dr the proceeds ledger, Cr cost, Cr gain or Dr loss. **Posted depreciation is never written back**: if a run already charged the disposal month (or Tally's opening was higher than Pulse's schedule), the accumulated figure removed is what is in the books. If depreciation is posted after the disposal was prepared, posting is refused (`disposal_stale`) and it is prepared again. A disposed asset gets no new depreciation; re-running a month it was already in keeps exactly what that month had posted for it, so the version replacement does not disturb the disposal.
- **Schedules** release evenly (rounded cumulative). A reversing accrual has its own run whose journal carries `auto_reverse_on` = the 1st of the next month; `acc_post_from_source` has no parameter for it, so the run sets a transaction-local setting and the trigger `acc_journals_asset_auto_reverse` stamps that one draft journal before it is posted. The reversal itself is 22A's `acc_run_auto_reversals`, now called daily by this slice's job (idempotent; 22D can call it too).
- **Source kind.** Every 22H journal uses `fixed_asset` (runs by run id, disposals by `disposal:<id>`), as asked, so `acc_post_from_source` and its CHECK list did not need changing while other slices change that function. Schedule releases therefore also show source `fixed_asset`; a later migration can add a `schedule` kind.
- **The register is the books**: accumulated depreciation is what posted runs charged for months that have ended by the date (a run is dated its month's last day), not the theoretical schedule. The forecast starts the month after the latest posted month and includes any catch-up in its first month.
- **Leases: no IFRS 16 in this slice.** Whether the clinic reports under full IFRS (right-of-use asset, lease liability, interest) or IFRS for SMEs (operating lease expense) is **OQ-125** (reporting framework). Meanwhile a lease is entered as a prepayment (rent paid in advance) or an accrual schedule. Leasehold improvements are depreciated over the shorter of 60 months and the remaining lease term (set the asset's life).
- The UAE VAT capital-assets scheme is not built: it applies only with exempt supplies and very large assets (research §22H), probably not the clinic.

## The monthly job (`accounting_assets`)

Daily at 04:25 UTC, per organisation, short and idempotent, logged to `job_runs` (counts only): posts due automatic reversals; then, on or after the first working day of the month (the finance close calendar: weekend days and holidays), prepares last month's three runs for each active entity, **once** (a month that already has a run of that kind is left alone) and never posts; empty runs are not created. When it prepared something it notifies the people with `accounting.assets.manage` (`notify`, generic sentence, no amounts). A refused month (`later_month_posted`) is counted, not retried forever.

## How it was verified

- Unit (`tests/unit/accounting/assets.test.ts`, 23 tests): months; straight line (even, exact rounding, full-month start, residual floor, catch-up, never negative); reducing balance (first months, switch to straight line, lands on the residual, never below it, no residual); basis checks; disposal gain, loss, no write-back and in-service-month disposal; opening depreciation in runs and the register; schedule releases, rounding and catch-up; run planning (catch-up, not yet in service, disposed asset frozen, ordinary vs reversing schedules, payload); register at a date (month-end rule, disposed and not-yet-acquired assets, totals by class and branch); forecast; schedule status; error sentences. `tests/unit/accounting/nav.test.ts` (Assets section, guides).
- Database (`tests/db/accounting-assets.test.ts`, 17 tests, Postgres 16): seeding and idempotence for two orgs; class ledger check; branch guard, status only through the functions, history; bill over-capitalisation; prepare by one person, refused for the preparer, a non-approver and a wrong hash, posted by another as a balanced journal by class and branch; idempotent re-prepare, a version 2 that reverses version 1; the job-prepared run (no preparer) posted by an approver; `later_month_posted`, `future_month`, `over_depreciated`; direct writes to runs, lines and locked asset figures refused, delete refused; disposal refused when stale, refused for a non-approver, then posted with the exact journal and the ledgers back to zero; no new depreciation for a disposed asset; opening depreciation counted toward the residual floor and the fully depreciated status, then locked; schedule ledgers per kind; prepayment and deferred revenue released in one journal, then locked; a reversing accrual reversed by `acc_run_auto_reversals` on the 1st; `waiting_ledger_start` with a stand-in trigger raising that hint, then posted once it is gone; RLS (auditor reads, org B and a stranger see nothing, no direct writes) and service-role-only functions. `tests/db/security-guard.test.ts`: `PHASE22H_TABLES` in the cross-org sweep (`seedPhase22HRows`) and the six functions service-role only. `tests/db/jobs.test.ts`: the new cron job.
- Typecheck, lint, `pnpm audit:security` and the full unit and database suites.

## Not verified

- **Not clicked through in a browser** (no Supabase auth stack here): pages, forms and the Excel download were typechecked and linted only. `pnpm build` and the bundle budget were not run.
- The monthly job (`runAccountingAssetsJob`) has no test of its own against a real client; its database steps (`acc_asset_run_prepare` with no person, `acc_run_auto_reversals`) are covered by the database tests.
- The real `before_ledger_start` rule comes from a parallel slice; it was simulated with a trigger raising the same hint.
- `app.can_view_record_history` is redefined here (adds `acc_assets`); a parallel slice redefining it too must keep both lines when merging.

## Before first use

1. Apply `deploy/supabase-paste/48_accounting_assets.sql` (after 43 and 41). It seeds the ledgers and classes for the existing workspace.
2. Accounting, Fixed assets: check the class lives, methods and ledgers with the accountant; enter the existing assets with their depreciation before Pulse (Tally's accumulated depreciation per asset), so the first run does not charge the past again. The ledger balances themselves come from the 22I opening balances.
3. Accounting, Schedules: enter prepaid rent and insurance, known accruals and any deferred revenue; enter leases here until OQ-125 is decided.
4. From the next first working day Pulse prepares last month's runs; someone with journal approval posts them.
