# Phase 20J notes (part 1): the Unite invoice-change register with Operations approval

_Built 13 Oct 2026 (what's-new dated 31 Oct, the planned release) on a worktree of `claude/funny-clarke-6t7gee` at `0b96ff2`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20J. Part 2 (HR commitments register, OQ-97) is not built._

## What it answers

Deck slide 8: "who may create, amend, discount, cancel, refund or credit an invoice, and what approval each requires?" and slide 11: "unapproved changes (invoice discounts, cancellations or refunds without approval): target zero". Operations (Abdul Azham) owns Unite invoices, discounts, cancellations and refunds. The authority matrix itself is not agreed (OQ-96), so every threshold is a setting and the default is "every change needs an approval".

## What exists

| Piece | Where |
|---|---|
| Invoice changes: every change in a period, unreviewed first, totals per kind (click to filter), kind filter, the unapproved-changes line, bulk approval | `/finance/invoice-changes` (`app/(app)/finance/invoice-changes/page.tsx`) |
| Change drawer: invoice, type, branch, doctor id, amount, date, Unite user, lock flag; review form (decision + reason) or the recorded review | same page, `?change=<key>` (`change-controls.tsx`, `actions.ts`) |
| CSV download | `GET /api/finance/invoice-changes?from=&to=&kind=` (`app/api/finance/invoice-changes/route.ts`), audited with `recordAudit` and `recordExport` |
| Settings: start date, minimum amount, bulk limit | Finance, Workflow settings, "Invoice-change review" (`saveChangeReviewSettings`, `finance.reference.manage`) |
| The rules (pure, unit-tested) | `lib/finance/invoice-changes.ts` (parse, needs approval, unapproved, measure, totals, bulk eligibility, order, period, CSV) |
| Loader (service role after the permission check) | `lib/finance/invoice-changes-server.ts` |
| Migration | `supabase/migrations/20261031000100_finance_invoice_changes.sql`, paste file `deploy/supabase-paste/30_finance_invoice_changes.sql` (after 25) |

**Permissions.** `finance.changes.view` (Finance, CEO, Operations) opens the page and downloads the CSV. `finance.changes.review` (Finance, Operations) records decisions and bulk approvals. A new **Operations** system role holds just these two keys (no revenue, claims or invoice access); the migration creates it in every existing org and grants the keys to the existing Finance and CEO system roles (idempotent; custom roles untouched). Billing, Insurance, the Medical Director and Cost / Payroll see nothing. "Open the invoice" shows only to holders of `finance.invoices.view`.

**Table.** `fin_invoice_change_reviews`: org, `change_key` (unique per org), invoice, kind, amount, change date, decision (`approved`, `rejected` shown as "Not approved", `explained` shown as "No approval needed (explained)"), reason (required, at most 500 characters, passed through `redactText`; the form asks for no patient names), `bulk`, `month_locked`, reviewer, time. RLS: select for either key; no write policy (the actions use the service role after `can()`); `check_parent_org` on the invoice. One review per change, final: there is no edit or delete. Three columns on `fin_ref_finance_settings`: `change_review_start_date`, `change_review_min_amount`, `change_bulk_approve_max`.

**SQL.** `fin_invoice_changes(org, from, to)`: SECURITY DEFINER, `search_path = ''`, service role only, jsonb; ids, codes and amounts only. Nothing calls Unite or writes to it; the Unite Finance API is untouched.

## The rules

Change events are **derived from data Pulse already stores**: the delivery history `fin_invoice_versions` (one row per Unite delivery, PII-stripped `record`) and `fin_payments`. Deliveries of an invoice are compared in the order they were taken from Unite (`received_at`, then version, then id), each with the one before it.

| Kind | Raised when | Amount |
|---|---|---|
| Discount | first delivery has discount > 0, or the discount rose since the previous delivery | the discount, or the rise |
| Credit note | the same for `credit_note` | the same |
| Write-off | the same for `write_off` | the same |
| Cancellation | `is_deleted` became true, or the first delivery was already deleted | net before the cancellation (net delivered when first seen deleted) |
| Amount reduced | a later delivery's net fell by more than its discount rose | the fall less the discount rise (a discount is never counted twice) |
| Refund | a current payment row with refund > 0 | the refund |

- A delivery in which the invoice is (or stays) cancelled raises only the cancellation, once.
- Decreases are not changes against the clinic: a discount cut, a net increase or a restored invoice raise nothing.
- **Change date**: the transaction date for a first-delivery change (it was made when the invoice was raised); the delivery date in the clinic's time zone (`orgs.timezone`) for later ones; refund date, else paid date, else the transaction date for refunds.
- **Unite user**: `modified_by` of the delivery (first delivery: `modified_by`, else `created_by`); refunds carry none. There is no mapping from Unite users to Pulse people, so the reviewer is simply the Pulse member who decided.
- **change_key** = md5(invoice id | kind | delivery or payment id | amount). Stable across calls and periods; because the amount is part of it, a change whose amount later moves (a refund edited in Unite, a late re-delivery slotting in between two others) is shown as not reviewed again rather than silently keeping an approval for a different amount.
- **Needs approval**: amount at or above `change_review_min_amount` (default 0, so every change).
- **Unapproved** (the measure): needs approval, dated on or after `change_review_start_date`, and no review or "Not approved". "Explained" and "Approved" count as resolved. With no start date the page says "not measured" (never zero). The line shows the count and amount awaiting review and not approved.
- **Bulk approval**: unreviewed changes in the period (and kind filter) up to `change_bulk_approve_max` (0 = off), at most 500 per click, one reason for all; the action re-reads the register itself and never takes the list from the browser.
- **Locked months**: reviews stay allowed after the CEO sign-off locks a month (a review is evidence, not a figure, and the Unite mirror is never refused), and `month_locked` records that it was made after the lock. Locked changes are flagged in the drawer and the CSV.
- A period is at most 366 days; the default is the month so far. The page lists the first 500 changes in review order; totals, the measure and the CSV cover all of them.

## How it was verified

- `tests/unit/finance/invoice-changes.test.ts` (10, fixture `tests/unit/finance/fixtures/invoice-changes.synthetic.json`): parsing (unknown kinds dropped, unknown decision read as no review), kinds and decisions equal to the migration's check lists, needs approval, unapproved, the measure (start date, minimum, rejected vs explained), totals per kind, bulk eligibility (limit, kind, off, 500 cap), review order, periods, CSV (headers, decimals, formula neutralising).
- `tests/unit/finance-invoice-changes-actions.test.ts` (6): both actions refuse without `finance.changes.review` (also with view or every other finance key) before the service role is created; validation of key, date, decision, reason, period and kind; settings refuse without `finance.reference.manage` and refuse bad amounts and dates; the CSV route answers 401 / 403 / 400.
- `tests/db/finance-invoice-changes.test.ts` (13, Postgres 16): the nine expected events from synthetic invoices with several deliveries (unchanged re-delivery, discount rise with lines removed, credit note dated across midnight in Dubai, cancellation, first seen cancelled, write-off, current / not current / out-of-period refunds, a September invoice changed in October, a discount cut); period rules; org B excluded both ways; stable keys; a review attaches to exactly its change; an edited refund gets a new key and loses the review; the measure on real output; RLS (Finance, CEO, Operations read; Billing, Insurance, Medical Director do not; org B only its own); no direct writes; uniqueness and checks; service-role only with `search_path = ''`; the lock flag; the grant block and the Operations role (idempotent, matches the code preset).
- `tests/db/security-guard.test.ts`: `fin_invoice_change_reviews` is in the Phase 20 cross-org sweep (`PHASE20_TABLES`, `seedPhase20Rows`) and `fin_invoice_changes` in the Phase 20 service-function list. `tests/db/finance-phase18-rls.test.ts` knows the keys arrived later; `tests/unit/permissions.test.ts` and `tests/unit/finance/nav.test.ts` know the Operations role and who sees the page.
- Typecheck, lint, the unit suite (194 files, 2,646 tests), the database suite (45 files, 645 tests; the PostgREST suites skip), `pnpm audit:security` (449 entry points, 0 unguarded). The paste file applied in one transaction on a database built from the earlier migrations gives the same `pg_dump` schema as the full build.

## Not verified

- Not clicked through in a browser (no Supabase auth stack here): the page, drawer, bulk form and settings form were typechecked and linted only.
- No real Unite data: capture is still OFF (OQ-94), so the register is empty on the live system until it runs. Whether Unite fills `ModifiedBy`, sends `IsDeleted` for cancellations, and how it represents credit notes and write-offs (separate fields vs a lower net) is untested; the rules follow the mapping as it stands.

## Before first use

1. Apply `deploy/supabase-paste/30_finance_invoice_changes.sql` to the **Pulse** project (after 25).
2. Give Abdul the **Operations** role (Settings, Users), or add the two keys to his existing role.
3. With Abdul and Saeed, agree the authority matrix (OQ-96), then in Finance, Workflow settings, "Invoice-change review": the minimum amount that needs an approval, the bulk limit, and the date from which unapproved changes are counted (go-live). Until a start date is set the page shows "not measured".

## Decisions worth knowing

- **Derived, not captured.** No new Unite call, no Unite write, no change to the capture job: events are worked out from the delivery history Pulse already keeps. The cost: a change made and undone between two deliveries is invisible, and a later change is dated by the delivery that revealed it, not by when it was keyed in Unite.
- **One threshold for all kinds.** The matrix may end up per kind (discount vs refund vs cancellation) or per person; that waits for OQ-96. The open sub-questions (contractual insurance discounts, whether "explained" is acceptable for billing-error corrections) are added to OQ-96.
- **Reviews are final and allowed after a month lock**, with the lock recorded. There is no edit or undo: a mistaken decision stays on record with its reviewer and audit row, and only an administrator working in the database can remove it. If the clinic wants a correction path (for example a second review that supersedes the first), that is a small follow-up.
- **No notification or task** is raised for unreviewed changes yet: the page and its measure are the control; a daily nudge can follow once capture runs daily and the matrix is agreed.
