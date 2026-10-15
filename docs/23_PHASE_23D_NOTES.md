# Phase 23D-1 — Collections and data quality

Plan: `docs/39_UNITE_REPORTS_PLAN.md` §1.2 (data-quality findings) and §4 (23D). Built on the Unite collection report
rows of Phase 23A and the branch scoping of Phase 23B.

## What was built

| Piece          | Where                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page           | `/finance/collections` (`app/(app)/finance/collections/page.tsx`), needs `finance.revenue.view`                                                                                                                                                      |
| Excel download | `GET /api/finance/collections?month=yyyy-mm&branch=CODE` (sheets Daily, Branches, Doctors, Data quality, Definitions; values only; `recordAudit` `finance.collections.exported` + `recordExport` `finance:collections`)                              |
| SQL            | `public.fin_collections_inputs(p_org_id uuid, p_month date, p_branch text default null, p_branches text[] default null) returns jsonb` (migration `20261208000100_finance_collections.sql`); SECURITY DEFINER, `search_path = ''`, service role only |
| Pure rules     | `lib/finance/collections.ts` (`buildCollections`, `invoiceBucket`, `reconciliationOf`, `SIGNAL_TEXT`, `dqSettingsSchema`)                                                                                                                            |
| Loader         | `lib/finance/collections-server.ts` (service role after the caller's `can()`); branch scope and default month reuse `loadPerfScope` / `latestReportMonth` from `doctor-performance-server.ts`                                                        |
| Workbook       | `lib/finance/collections-xlsx.ts`                                                                                                                                                                                                                    |
| Setting        | `fin_ref_finance_settings.dq_late_invoice_days` (default 3, 0 to 60), edited under Finance, Targets and report lines (`/finance/flash/settings#data-quality`, `finance.targets.manage`, audited as `finance.collections.settings_saved`)             |
| Menu and help  | Finance, Overview, Collections and data quality; guide `finance-collections`                                                                                                                                                                         |

## Source

Only the current rows of the Unite collection report (`fin_report_visits where is_current`) whose report date (invoice
date, else visit date) falls in the chosen month. The default month is the latest month with rows the member may see.
Amounts are summed unrounded in SQL (Unite keeps three decimals); the pure rules add in thousandths and never round to
the fil; the page and workbook round to 2 decimals for display only. Cancelled rows count in every sum, as in Unite's own
totals, and are also a signal.

## Collections

By day (report date), by branch, by doctor and by invoice type, plus the month total: rows, cash, card, bank transfer,
payment gateway, other payment, **total collected** (= the sum of those five), patient share, insurance claim, net
billing, advance consumed, credit note consumed, outstanding credit, write-off, refund. The page's doctor table shows
net, collected, insurance claim and outstanding credit (the workbook the same).

**Self-pay and insurance.** SQL groups by the invoice type text (trimmed, upper case, whitespace collapsed); the pure
`invoiceBucket()` splits it on `, ; / & +` and accepts only `SELF PAID` and `INSURANCE`: Self-pay, Insurance, both,
blank, or "not recognised" (any other word; the text is listed so Finance can see it). Nothing is guessed.

**Reconciliation line.** Net billing against collected + insurance claim + patient share + outstanding credit + advance
consumed + credit note consumed, for the month in scope. The difference is shown; it is never asserted to be 0, since
Unite's columns are on different bases (VAT, consumption, credit) and Pulse does not guess why they differ.

## Data-quality signals

Counts and the rows' net billing, each with a fixed sentence and "what to do". Review signals, never proof; a row can
appear in more than one.

| Signal                          | Rule (current rows of the month in scope)                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Visits without an invoice       | no self-pay and no insurance invoice number, and net = 0                                                   |
| Late invoices                   | invoice date − visit date (Dubai) > `dq_late_invoice_days`                                                 |
| Invoices for an earlier month   | visit date (Dubai) before the first day of the invoice date's month                                        |
| Unknown branch                  | no branch from the current `fin_ref_branches` mapping nor the stored code; the Unite clinic text is listed |
| Unite category "NO"             | `categories` has the key `NO`                                                                              |
| Blank visit status              | `visit_status` is null                                                                                     |
| Blank invoice type with billing | invoice type blank and net > 0                                                                             |
| Cancelled rows                  | `is_cancelled`                                                                                             |

The visit date is the Dubai date of `visit_at` (the report is in Dubai wall-clock time, as in 23A), so a visit at 01:00
Dubai on the 1st is in that month.

## Branches

Exactly as 23B: the branch of a row is worked out when read (`coalesce(current mapping by clinic, stored code)`);
`p_branches` is the member's allowed finance codes (null = unrestricted); a row whose branch is unknown is visible only
to an unrestricted member, so the "unknown branch" signal and the clinic names appear only for them; `p_branch` is the
page's own filter. The page, the download and their default month use the same scope.

## Privacy

The function returns counts and sums only: no PIN, no patient ref, no invoice numbers, no names other than the doctor's
(most frequent spelling per doctor key) and unmapped Unite clinic names (a clinic is not personal data). The page logs a
sampled list access (`recordAccess`, entity `finance_invoice`), the download an export. Fixtures are synthetic
(`tests/unit/finance/fixtures/phase23-collections.synthetic.json`: "Dr Demo-0n", "Synthetic Clinic …", PINs 9000000nn).

## Tests

- `tests/unit/finance/collections.test.ts`: invoice buckets (closed list), bucket sums, total collected, reconciliation
  difference, signal sentences with the setting, parsing of empty or odd payloads, the setting schema.
- `tests/unit/finance/collections-xlsx.test.ts`: the five sheets, values, no formulas, no PIN, ref or invoice number.
- `tests/db/finance-collections.test.ts`: SQL output equals the fixture exactly and the fixture equals an independent
  reference (`tests/unit/finance/collections-reference.ts`); branch filter and allowed branches against the reference
  (unknown branch only when unrestricted; the current mapping wins over the stored code; mapping a clinic later moves
  its rows); months and only current rows; another org's rows; the late-invoice setting and its check; no PIN or
  patient ref; service role only.

## Deliberate differences from the plan (docs/39 §4 23D)

- Permission `finance.revenue.view` (as doctor performance), not `finance.view`: these are revenue figures.
- The signals are computed on the page from the report rows, not as `fin_run_exception_rules` entries: the report rows
  are not `fin_invoices`, so they cannot be exception records or link to the invoice list. The threshold lives in
  `fin_ref_finance_settings`.
- Not built (23D-2 or later): the Cash Receipt sheet (advances, refunds, PIN transfers; 23A never reads it),
  previous-due collections, "invoices without a visit", "visits without an invoice after N days", and the site tag
  against the Unite clinic (OQ-141).
