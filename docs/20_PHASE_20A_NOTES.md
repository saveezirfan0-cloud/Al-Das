# Phase 20A notes: daily flash report, targets and reporting lines

_Built 13 Oct 2026 on `claude/funny-clarke-6t7gee`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20A._

## What it replaces

The hand-built Excel sheets Krishna sends each day: **Daily Financial Summary** (KPIs, branch revenue against target, top five doctors), **Doctor performance summary** (all branches excluding Chiro, and Chiro), **Monthly revenue summary** (month to date) and **Daily sales summary** (one row per day per branch, with the previous month's same days alongside).

## What exists

| Piece | Where |
|---|---|
| Daily flash page: Daily summary, Month to date, Daily sales (this month and the same days of last month side by side, with a comparison table) | `/finance/flash` (`app/(app)/finance/flash/page.tsx`) |
| Targets and reporting lines, display settings | `/finance/flash/settings` (`settings/page.tsx`, `forms.tsx`, `actions.ts`) |
| Excel download in the sheets' layout (Daily summary, Month to date, Doctors, Daily sales, Daily sales of the previous month) | `GET /api/finance/flash?date=` (`app/api/finance/flash/route.ts`, `lib/finance/flash-xlsx.ts`) |
| The rules (pure, unit-tested) | `lib/finance/flash.ts` |
| Loader (service role after the permission check) | `lib/finance/flash-server.ts` |
| Migration | `supabase/migrations/20261023000100_finance_flash.sql`, paste file `deploy/supabase-paste/22_finance_flash.sql` |

**Permissions.** `finance.flash.view` (Finance, CEO, Medical Director) reads the report and downloads it; `finance.targets.manage` (Finance) edits lines, targets and display settings. Billing, Insurance and Cost / Payroll do not see it.

**Tables.** `fin_ref_report_lines` (code, label, match by branch codes or department names, in the main total or separate, order, active) and `fin_ref_revenue_targets` (month, line or total, daily revenue, daily patients, ARPP). Both have RLS with select policies for the two permissions and no write policies: every change is a server action with `recordAudit`. Two settings columns on `fin_ref_finance_settings`: `flash_share_basis` and `flash_top_doctors`.

**SQL.** `fin_flash_inputs(org, from, to)` returns per day, branch, department and doctor: net revenue, patient visits and invoices (no patient identifier). `fin_flash_set_targets(org, month, rows, user)` replaces a month's targets in one transaction. Both are SECURITY DEFINER with `search_path = ''`, service role only.

## The rules (OQ-93; defaults chosen to match the current sheets)

- **Net revenue** is the invoice `net` (after discount, before VAT) of invoices not deleted, by transaction date.
- **Patient count** is distinct patients per day, branch, department and doctor, summed. A patient seen by two doctors on the same day counts twice, as the sheets do (branch and doctor totals both come to 64 on 12 Oct).
- **Lines.** A department line (Chiro) takes its invoices from every branch and wins over a branch line. Lines can be in the main total ("Total excl. Chiro") or separate (Chiro, the leased Dental unit). Revenue that matches no line is shown as **Unassigned**, counted in the main total and flagged, so totals always tie to the invoices. With no lines configured, each branch code is its own line.
- **Targets** are daily rates per line and month. The month-to-date target is the daily rate times calendar days elapsed (Palm 32,593 x 12 = 391,116, as on the sheet). The total target is the explicit total row if set, otherwise the sum of the main lines. Patient and ARPP targets are set on the total row.
- **ARPP** = revenue / patients. **Variance %** = (actual - target) / target.
- **Doctor % of total**: against the doctor table's own total (default) or the grand total (setting). The sheets mix both; one rule now applies everywhere.
- **Comparison**: the month so far against days 1 to N of the previous month (clamped to its length).

## How it was verified

- `tests/unit/finance/flash.test.ts` (32 tests): a synthetic fixture with the 12 Oct sheet's branch figures and targets reproduces every KPI, variance and ARPP on the sheet (51,031 vs 58,667, -7,636, -13%; 64 vs 78, -18%; ARPP 797 vs 750, +6%; Palm -28%, Golden Mile -71%, Meadows +87%, Longevity -89%; total including Chiro 53,121), month-to-date targets (391,116 and 704,004), the grid, the comparison, line assignment and edge cases.
- `tests/unit/finance/flash-xlsx.test.ts`: the workbook has the five sheets, Pulse's totals, and no formulas.
- `tests/db/finance-flash.test.ts` (11 tests, Postgres 16): who reads lines and targets, that nobody writes them directly, service-role-only functions, aggregation parity with the pure report on the same fixture, exclusion of deleted invoices, other days and other orgs, atomic target replacement.
- `tests/unit/finance/nav.test.ts`: who sees the two pages.
- Typecheck, lint, the unit suite, the database suite and `pnpm audit:security` (see the commit).

## Not verified

- Not clicked through in a browser (no Supabase auth stack here).
- No real Unite data: Unite finance capture is still OFF, so on the live system the page shows "No invoices in this period yet" until capture runs (OQ-94) or a Unite report upload exists (20B).

## Before first use

1. Apply `deploy/supabase-paste/22_finance_flash.sql` to the **Pulse** project (not THC Portal).
2. Settings: Finance, Targets and report lines. Add the lines as on the sheets. Suggested, to be confirmed against Unite's real values (OQ-93):

   | Code | Name | Match | Values | Main total |
   |---|---|---|---|---|
   | PALM | Palm | branch | P | yes |
   | GM | Golden Mile | branch | G | yes |
   | MTC | Meadows | branch | M | yes |
   | LONGEVITY | Longevity | branch or department | (Unite's code or department name) | yes |
   | CHIRO | Chiro | department | (Unite's Chiropractic department name) | no |
   | DENTAL | Dental (leased unit) | branch or department | (Unite's value) | no |

3. Enter October's daily targets (Palm 32,593; Golden Mile 9,402; Meadows 13,037; Longevity 3,635; total patients 78.25; ARPP 750) and use "Copy last month's targets" each new month.
4. **On 10 Nov** (Unite branch separation, OQ-101): add the new branch codes to the lines the same day, and to `fin_ref_branches`.

## Decisions worth knowing

- Lines were not seeded: a wrong guess at the Chiro department name would quietly put Chiro revenue into the branch totals. With nothing configured the page still works (one line per branch code).
- The flash report is not e-mailed yet. Push and e-mail may carry ids and a generic sentence only (Phase 13 rule), so a "flash ready" notification makes sense once Unite capture runs daily; the figures stay in Pulse.
