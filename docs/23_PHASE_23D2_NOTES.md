# Phase 23D-2 — Insurance billed vs claimed

Plan: `docs/39_UNITE_REPORTS_PLAN.md` §4 (23D, collections and data quality). While the Unite finance capture is OFF, the
Unite collection report (`fin_report_visits`, Phase 23A) is the only record of what was **billed** to insurers; the
Diligence claim file (`ins_claim_activities`) is what was **submitted**. This page puts the two side by side for one month,
by invoice number, so an insurance invoice that was never claimed is found while it can still be sent.

## What was built

| Piece          | Where                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page           | `/finance/insurance-billing` (`app/(app)/finance/insurance-billing/page.tsx`), needs `finance.claims.view` (Insurance, Finance, Finance Manager, CEO; not Billing or the Medical Director)                           |
| Excel download | `GET /api/finance/insurance-billing?month=yyyy-mm&branch=CODE` (sheets Summary, Billed not submitted, Matched, Not in report, Ambiguous, Definitions; values only; `recordAudit` + `recordExport`)                  |
| SQL            | `public.fin_insurance_billing_recon_inputs(p_org_id uuid, p_month date, p_branch text default null, p_branches text[] default null) returns jsonb` and `app.fin_invoice_key(text)` (migration `20261208000200_finance_insurance_billing_recon.sql`); SECURITY DEFINER, `search_path = ''`, service role only |
| Pure rules     | `lib/finance/insurance-billing.ts` (`invoiceKey`, `classifyInvoice`, `difference`, `buildInsuranceBilling`, `reconSettingsSchema`)                                                                                  |
| Loader         | `lib/finance/insurance-billing-server.ts` (service role after the caller's `can()`); branch scope and default month reuse 23B's `loadPerfScope` / `latestReportMonth` / `chosenBranch` / `monthParam`               |
| Workbook       | `lib/finance/insurance-billing-xlsx.ts`                                                                                                                                                                              |
| Thresholds     | `fin_ref_finance_settings.ins_recon_tolerance` (AED, default 1.00) and `ins_recon_grace_days` (default 7), on Finance, Targets and report lines (`/finance/flash/settings#insurance-billing`, `finance.targets.manage`, audited as `finance.insurance_billing.settings_saved`) |
| Menu and help  | Finance, Billing and claims, Billed vs claimed (quick-search words: insurance billing, billed not submitted, claim reconciliation, money at risk); guide `finance-insurance-billing`                                 |

## The invoice-number rule

One rule, the Unite invoice key's: **upper case, every whitespace character removed** (`ins-syn 001` and `INS-SYN001` are
the same number; a dash is kept). TypeScript: `normalizeInvoiceNumber()` in `lib/finance/keys.ts` (re-exported as
`invoiceKey`); SQL: `app.fin_invoice_key()`, the same expression as `fin_invoices.inv_key` and the Diligence invoice index.
The DB test checks the two agree on ASCII whitespace (space, tab, CR, LF, VT, FF). Invoice numbers are ASCII; for exotic
Unicode spaces (no-break space) JavaScript and Postgres differ, exactly as they already do for `inv_key`.

## Definitions

For month M (report date = invoice date, else visit date, as 23A stores it):

| Term | Definition |
| --- | --- |
| Billed | `insurance_claim` of the current, **not cancelled** report rows in M, summed per invoice number. Cancelled rows are left out of the pairing and shown as a count and amount in the footer, so billed + cancelled = the report's insurance claim. Rows with a claim but no insurance invoice number are billed but cannot be paired (footer). |
| Submitted | Diligence `net` (`initial_net` when `net` is blank) of **every** activity with the invoice number, whatever its date. `ins_claim_activities` holds one current row per activity (each upload upserts it by claim activity number; earlier values are in `ins_claim_activity_events`), so "current" is simply the row. |
| Ambiguous | M's report rows give the number more than one (branch, doctor), counted over **every** branch. Listed, never paired, whatever Diligence holds. |
| Matched | Not ambiguous and Diligence has at least one activity. Difference = billed − submitted, in fils; flagged when its size is **more than** `ins_recon_tolerance`. |
| Billed, not submitted | Not ambiguous, no Diligence activity, billed > 0, and **more than** `ins_recon_grace_days` days from the invoice's latest report date to today (org time zone). The money-at-risk list, oldest first. Inside the grace days it is "awaiting" (a count on the page, rows at the end of the Excel sheet), not at risk. |
| Submitted, not in the report | Diligence activities dated in M (activity start date, else transaction date) whose number is on no current, not cancelled row of M. Labelled "check the month": in another month's report (the latest such month is shown), cancelled in the report, or not in any uploaded report. Activities with no date are not placed in any month. |
| Billed AED (tile) | Billed over the member's rows in M (all rows, numbered or not). |
| Submitted AED (tile) | Submitted on M's billed numbers (matched and ambiguous). |
| Matched % (tile) | Billed AED on matched numbers (any difference) ÷ billed AED; blank when nothing was billed. |
| At risk AED (tile) | Billed on the "billed, not submitted" list. |

Only invoice numbers, dates, amounts, payer ids, finance branch codes and doctor names leave the database: no PIN, no
patient ref, no patient names, no card numbers. Invoice numbers are not personal data.

## Branches

As 23B: the branch of a report row is worked out when read (Unite clinic through the current `fin_ref_branches` mapping,
the stored code as fallback); `p_branches` is the member's allowed finance codes (`null` = unrestricted) and `p_branch` the
page's filter. A row with an unknown branch is visible only to an unrestricted member. An ambiguous number is judged over
every branch, but a restricted member sees only the (branch, doctor) pairs and billed amount of their own branches, plus
the number of pairs. Diligence activities carry no branch, so the "submitted, not in the report" list (and the count of
activities without an invoice number) is returned only with no restriction and no branch filter; the page says so.

## Privacy and logging

The page logs a sampled list access (`recordAccess`, entity `finance_claim`); the download logs the export
(`finance.insurance_billing.exported`, `recordExport` dataset `finance:insurance-billing`). Fixtures are synthetic
(`INS-SYN-*` numbers, "Dr Demo-0n" doctors, PINs 9000000nn that must never appear in the output).

## Tests

- `tests/unit/finance/insurance-billing.test.ts`: the invoice-number rule, every bucket, the grace-day and tolerance edges
  (exactly at the threshold is not flagged / not at risk; compared in fils), latest report date, nothing to claim,
  summary sums and matched %, settings from the database, the hidden unreported list, settings validation.
- `tests/unit/finance/insurance-billing-xlsx.test.ts`: sheets, values, no formulas (an invoice number that looks like a
  formula stays text), no PIN, the branch-filter note.
- `tests/unit/finance/nav.test.ts`: who sees the menu entry.
- `tests/db/finance-insurance-billing.test.ts`: SQL and TypeScript key rule agree; each bucket from synthetic report rows
  and Diligence activities (case/space variants, initial net fallback, superseded and cancelled rows, another month's
  report, no invoice number, another org's same numbers); tolerance and grace days read from the settings and the range
  check; branch scoping (allowed branches, the filter, an unknown branch, a clinic mapped later); no PIN or patient field
  in the output; authenticated cannot execute; SECURITY DEFINER with a pinned `search_path`.

## When Unite capture is ON (out of scope now)

Once `fin_capture_settings.enabled` is true and the capture tables fill, `fin_invoices` (with `inv_key`, the same rule)
becomes the billed source for the months it covers, and Diligence is already matched to it per line by
`lib/finance/match-claims.ts` (`matched_invoice_id`). The same page can then read billed per invoice from `fin_invoices`
(insurance invoices only) instead of the report, keeping the buckets, thresholds and branch rules here; which source a
month uses should follow the `revenue_source` choice planned in docs/39 §4 (23A, "capture wins"), so nothing is counted
twice. Not built: today the report is the only billed record.

## Deferred

- No exception rows (`ops_exceptions`) are raised from this page; the lists are review signals. Turning "billed, not
  submitted" into an E-rule with its own owner and due date is a follow-up once Insurance has used the page.
- No per-payer view: the report does not keep the insurer text (23A never stores it), so payers come from Diligence only.
