# Phase 23E — Management alerts (M1)

Plan: `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §4 (M1 alerts: revenue behind target, revenue per patient below band, data
late) and §5 (thresholds are settings). Built on 23A (Unite collection report upload) and 23B (doctor performance).

## What was built

| Piece         | Where                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure rules    | `lib/finance/management-alerts.ts` (`reportIsLate`, `revenueProgress`, `revenueBehindScopes`, `isBehind`, `doctorsBelowBand`, `alertTransitions`, settings schema, in-app copy)                                                                                         |
| Runner        | `lib/finance/management-alerts-server.ts` (`runManagementAlerts`, service role, no caller input)                                                                                                                                                                        |
| Job           | step 7 of the daily `finance_workflows` job (`lib/finance/workflows.ts`, pg_cron 03:50 UTC); runs in its own `contained` step, so a failure never stops the other steps and is retried the next day                                                                     |
| SQL           | migration `20261208000300_finance_management_alerts.sql`: four settings columns, `fin_mgmt_alert_state` (service only, no policies), `fin_mgmt_alert_claim()` and `fin_mgmt_alert_inputs()` (SECURITY DEFINER, `search_path = ''`, service role)                        |
| Notifications | events `finance.report_late`, `finance.revenue_behind`, `finance.band_below` in `lib/notify/events.ts` (people choose their channels under Settings, Notifications); fixed push/e-mail sentences in `lib/notify/push-payload.ts`; centre links in `lib/notify/links.ts` |
| Settings      | Finance, Targets and report lines (`/finance/flash/settings#alerts`, `finance.targets.manage`), audited as `finance.management_alerts.settings_saved`                                                                                                                   |
| Tests         | `tests/unit/finance/management-alerts.test.ts`, `tests/unit/finance/management-alerts-server.test.ts`, `tests/unit/notify-push-payload.test.ts` (M1 block), `tests/db/finance-management-alerts.test.ts`                                                                |

## The three alerts

| Rule (event)                              | Active when                                                                                                                                                              | Scope / period                       | Recipients                                                | Clears                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Unite report late (`finance.report_late`) | at least one upload was ever committed, and no committed upload covers any of the `alert_report_late_days` days before today (today − N … today − 1, org timezone)       | `all` / `-`                          | `finance.revenue.import`                                  | when an upload covering one of those days is committed |
| Revenue behind (`finance.revenue_behind`) | month-to-date net revenue below `alert_revenue_target_pct` % of the time-scaled target on each of the last `alert_revenue_target_days` covered days of the current month | `total` or `line:<code>` / `yyyy-mm` | `finance.flash.view`                                      | when the latest covered days are no longer all behind  |
| Below band (`finance.band_below`)         | the previous month is fully covered by committed report data and at least one doctor with `alert_band_min_patients` or more patients is in the Below Target band         | `all` / `yyyy-mm`                    | `finance.revenue.view`, members who see every branch only | never: one notification per month                      |

**One alert per rule, scope and period until it clears.** The runner reads the open keys, works out what to raise and
what to clear (`alertTransitions`), then claims each new key with `fin_mgmt_alert_claim()`: an insert, or a reopen of a
cleared row, that returns true for exactly one caller. Only a won claim is notified, so a retried or overlapping run
never notifies twice. A rule whose inputs could not be read is left alone (its open alerts neither clear nor repeat).

### Revenue behind target: definitions

- Revenue: Unite Net Billing from the current rows of the Unite collection report (`fin_report_visits where is_current`),
  per day, branch and department (`fin_mgmt_alert_inputs`; the branch is worked out when read from the current
  `fin_ref_branches` mapping, as in 23B). Cancelled rows count, as in 23B.
- Lines and targets follow `lib/finance/flash.ts` exactly (nothing is re-implemented): department lines take their rows
  first (Chiro), the total is the flash "Total" (the core lines) and its target is the explicit total row, otherwise the
  sum of the core lines' targets. Each covered day is one flash period, so the per-day target is the daily rate.
- **Time-scaling uses covered days, not calendar days.** Month-to-date target = daily target × the number of days in the
  month covered by committed report uploads (the union of their ranges). A day the report does not cover adds neither
  revenue nor target, so a late upload never looks like a revenue shortfall (the late-report alert covers that). This
  differs from the flash page, which scales by calendar days elapsed on invoice data.
- Scopes: the total, and each branch line (`match_kind = 'branch'`) that has a daily revenue target that month.
  Department lines are not alerted on. With only a total target, only the total is checked; with no target the rule is
  silent.
- "Behind for D consecutive covered days": the month-to-date figure after each of the last D covered days (gaps in
  coverage are skipped) is strictly below P % of the month-to-date target (exactly at P % is not behind; compared in
  integer fils). Fewer than D covered days in the month: no alert.
- The rule looks at the current month (org timezone). Last month's open alert clears at the turn of the month.

### Revenue per patient below band: definitions

- Read through `fin_doctor_performance_inputs` / `buildDoctorPerformance` for the previous calendar month, all branches.
  Only once that month is fully covered (one committed range from the 1st to the last day; `coverage.full`).
- A doctor counts when any of their (department, doctor) rows, as the page shows them, has at least
  `alert_band_min_patients` patients and `bandOf(revenue per patient, the 23B thresholds)` is Below Target. A doctor in
  two departments counts once. No alert when nobody qualifies.
- Only the previous month is checked: a historical backfill never fires a burst of old alerts. A month covered more than a
  month late is not announced.
- Recipients see every branch: the count covers all branches and the doctor performance page is branch-bound, so a
  branch-restricted member is not told about doctors they cannot open.

## What a notification says

- In-app: a fixed title and a sentence with counts, the threshold settings and the month only ("3 doctors were below
  the revenue-per-patient band in September 2026"; "Month-to-date revenue for the total and 1 branch line has been below
  90% of the target … for the last 3 covered days"). No doctor, no branch code, no amount, no patient data. The payload
  holds the rule, a count and the month; the band alert opens `/finance/doctor-performance?month=yyyy-mm` (the month is
  validated before it reaches the link).
- Push and e-mail: the catalogue's fixed sentence and the page (`/finance/upload`, `/finance/flash`,
  `/finance/doctor-performance`) only, through `notify()`. The push payload takes ids only, so the month is not in the
  push or e-mail link.
- Recipients are picked as every finance reminder picks them (`memberIdsWithPermission`); the finance access window
  applies when they open the page (`can()` there). Defaults: in-app on, push and e-mail off until the person turns them
  on.

## Thresholds

`fin_ref_finance_settings`: `alert_report_late_days` (3, 1–60), `alert_revenue_target_pct` (90, >0–100, two decimals),
`alert_revenue_target_days` (3, 1–31), `alert_band_min_patients` (10, 1–100000). The band edges are the 23B settings
(`perf_arpp_target`, `perf_band_near`, `perf_band_moderate`). Nothing is hardcoded; the code's defaults equal the table
defaults and apply only to an org with no settings row.

## Not done

- No "resolved" notice when an alert clears, and no page listing open alerts (`fin_mgmt_alert_state` is service only).
- Department-line revenue targets are not alerted on; neither are patient or ARPP targets.
- No management dashboard tile for open alerts.
- Paste file: `deploy/supabase-paste/87_finance_management_alerts.sql`.
