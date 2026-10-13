# Phase 20K notes: doctor billing mix and seasonal trends

_Built 13 Oct 2026 on `claude/funny-clarke-6t7gee`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20K._

## What it answers

Saeed, finance meeting: "understand the trends of the doctors, the trends of the season, the characteristics of how various doctors bill". Each bill splits into consultation, lab, radiology, procedures and so on; each doctor has a cash (self-pay) and insurance side; revenue moves with the season.

## What exists

| Piece | Where |
|---|---|
| Page with two sections: **Doctor billing mix** (per doctor: revenue, patients, revenue per patient, lines per invoice, a stacked bar of service-category shares, insurance share, the category where the doctor differs most from the clinic; an "All doctors" row) and **Seasonality** (net per month or week with the same period last year, change %, invoices, patients) | `/finance/analytics` (`app/(app)/finance/analytics/page.tsx`) |
| CSV downloads (mix with every category's net, share and difference; trend) | `GET /api/finance/analytics?kind=mix\|trend&from=&to=&branch=&grain=` (`app/api/finance/analytics/route.ts`), with `recordAudit` (`finance.analytics.exported`) and `recordExport` |
| The rules (pure, unit-tested) | `lib/finance/billing-mix.ts` |
| SQL | `fin_billing_mix(org, from, to, branch)` and `fin_revenue_trend(org, from, to, grain, branch)` in `supabase/migrations/20261030000100_finance_analytics_mix.sql`, paste file `deploy/supabase-paste/29_finance_analytics_mix.sql` |

**Permission.** `finance.revenue.view`, as for Revenue and Doctors (Finance, CEO, Medical Director). Billing, Insurance and Cost / Payroll do not see it. No new permission, no new table, no setting.

**SQL.** Both functions are SECURITY DEFINER with `search_path = ''`, service role only (listed in `PHASE20_SERVICE_FUNCTIONS` in `tests/db/security-guard.test.ts`), return jsonb with counts and amounts only: no PIN or `patient_ref` leaves them.

## The rules

- **Doctor** is the configured `doctor_basis` (ordering or performing, falling back to the invoice doctor), as on the Doctors page and the flash report. The page shows the same note about which doctor is counted. The name comes from Reference data (doctors); failing that, from invoices on which that doctor is the invoice's own doctor (never from an invoice where they only ordered or performed); otherwise the DHA id shows.
- **Mix revenue** is the net of current invoice lines of invoices not deleted, by transaction date: the same base as the Revenue page, so the category shares add up to 100 %. The category is `fin_ref_services.service_category`; an item with no service row, or a blank category, is **Unmapped**. Invoices with no current lines are not in the mix.
- **Payer type** comes from `inv_type` with the existing rule (`fin_is_insurance_type`: contains INSUR; self-pay: starts with SELF; anything else is Other), as in the accounting export.
- **Patients** are distinct (by `patient_ref`, else PIN) per doctor and for the clinic; the clinic figure is not the sum of the doctors'. **Revenue per patient** = revenue / patients. **Lines per invoice** = current lines / invoices.
- **Differs most**: the doctor's category share minus the clinic's, in percentage points; the largest absolute difference is shown. A share with no revenue is shown as a dash, never 0 % or infinity.
- **Trend net** is the invoice net (as on the flash report and the Doctors page), so monthly totals tie to the flash. Patients are distinct within each period, so they are not totalled across periods.
- **Last year**: weeks compare with the week 52 weeks earlier (same weekdays); months with the same calendar month (29 Feb counts in the following year's February). Periods at either end are cut to the chosen range, and last year is cut the same way. When the first invoice on record is later than the start of last year's window, last year is shown as a dash and the totals are not compared, rather than showing a misleading drop from zero.
- **Range**: default the last 12 calendar months to today; at most 1,100 days (longer ranges keep their end date and are shortened); branch is a branch code.

## How it was verified

- `tests/unit/finance/billing-mix.test.ts` (15 tests): a synthetic fixture (`tests/unit/finance/fixtures/billing-mix.synthetic.json`) checks parsing, category order (Unmapped last), revenue per patient, lines per invoice, insurance share, shares and differences in points, no division by zero, the CSVs (formula cells neutralised), last-year coverage, change %, totals, labels and the filters.
- `tests/db/finance-analytics-mix.test.ts` (11 tests, Postgres 16): service role only (a signed-in user gets 42501); per-doctor and clinic figures from current lines (superseded lines, deleted invoices, other dates and the other org excluded; missing and blank categories are Unmapped); the performing-doctor basis; branch filter; empty period; monthly and weekly last-year comparison (clipped month end, deleted last-year invoice excluded, 52-week alignment, 29 Feb onto 28 Feb, not 1 Mar); coverage flag; input validation.
- `tests/unit/finance/nav.test.ts`: Finance, the CEO and the Medical Director see the page; Billing, Insurance and Cost / Payroll do not.
- Typecheck, lint, the unit suite, the database suite and `pnpm audit:security` (0 unguarded).

## Not verified

- Not clicked through in a browser (no Supabase auth stack here).
- No real Unite data: Unite finance capture is still OFF, so the page shows "No invoices in this period yet" until capture runs with history (OQ-94; ask Unite for the January backfill so last year can be compared).

## Before first use

1. Apply `deploy/supabase-paste/29_finance_analytics_mix.sql` to the **Pulse** project (not THC Portal). It needs `20_finance_blueprint.sql` and nothing from 21 to 28.
2. Check that billed items have a service category (Finance, Reference data). The page shows the unmapped share; the mix is only as good as that mapping. The category names (Consultation, Lab, Radiology, Procedure, ...) are Finance's choice; the page uses whatever is there.
3. Decide the doctor basis (Workflow settings) if not done yet; it changes who a lab or radiology line counts for.

## Decisions worth knowing

- Two revenue bases on one page, on purpose: the mix needs lines to split by category (as the Revenue page), the trend uses the invoice net to tie to the flash. They differ only where Unite's invoice header and lines disagree.
- No chart library: plain server-rendered bars (`components/finance/bars.tsx`, which now accepts a missing last-year value), so no bundle growth.
- Not built: per-doctor trend lines, payer-level (insurer) mix, procedure-code detail. The CSV has every category's figures for further analysis in Excel.
