# Phase 22E notes: receivables

_Built 13 Oct 2026 on the 22E worktree branch (based on `claude/funny-clarke-6t7gee` at `c1d3254`). Plan: `docs/22_ACCOUNTING_PLAN.md`, sections 1 to 5 and the 22E row. Builds on the 22A ledger (`docs/22_PHASE_22A_NOTES.md`) through `acc_post_from_source`._

## What it is

Pulse issues its own tax invoices and credit notes to **businesses**: insurers (claims summaries where needed), corporates (corporate medicals), tenants (the leased unit) and other customers, records what they pay and allocates it, and reports who owes what. **Patient invoices are issued by Unite and are never re-issued here**; there is no patient on any table of this slice. Insurer remittances stay in the Phase 18 remittance flow (posted by 22D); an insurer customer is linked to its payer (`payer_id`) so statements can include both later.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 45, needs 43 first) | `supabase/migrations/20261109000200_accounting_receivables.sql`, `deploy/supabase-paste/45_accounting_receivables.sql` |
| Pure rules (unit-tested) | `lib/accounting/sales.ts`: line amounts and VAT, totals, full or simplified tax invoice, due dates, the 14-day credit note warning, allocation oldest first, ageing buckets, statement running balance, the approval limit, error sentences (merged into `lib/accounting/errors.ts`) |
| Server loaders | `lib/accounting/receivables-server.ts` |
| PDF and Excel | `lib/accounting/sales-pdf.ts` (tax invoice / tax credit note, statement, balance-confirmation letter; pdf-lib like the voucher certificate), `lib/accounting/statement-xlsx.ts` |
| Pages (Accounting, Sales & receivables) | `app/(app)/accounting/`: `sales-invoices` (list, `new`, `[id]`, `[id]/edit`), `credit-notes`, `receipts` (list, `new`, `[id]`), `customers`, `receivables-ageing`, `statements`; Setup: `receivables-settings` ("Sales settings") |
| Routes | `GET /api/accounting/sales-invoices/[id]/pdf`, `GET /api/accounting/statements?customer&from&to&format=pdf\|xlsx`, `GET /api/accounting/balance-confirmation?customer&as_of` (each: receivables read key, `recordAudit` + `recordExport`) |
| Navigation and help | `lib/accounting/nav.ts` (section "Sales & receivables", `RECEIVABLES_READ`), guides `accounting-sales` and `accounting-receivables`, release note at the top of `lib/help/whats-new.ts` |

## Tables

All `public.acc_*`, `org_id` on every row, RLS on, **select policies only** (`app.acc_can_read_receivables`: `accounting.sales.manage`, `.receipts.manage`, `.ledger.view`, `.reports.view` or `.journals.approve`; the settings row also for `.settings.manage`). Every write is a SECURITY DEFINER function (service role only, `search_path = ''`) or a server action after `can()`.

- `acc_ar_settings` (one row per org, seeded): approval limit (default **AED 50,000**), simplified invoice limit (default and maximum AED 10,000), credit note warning days (14), prefixes `SI`, `CN`, `RV`, the seller address and payment instructions printed on documents.
- `acc_customers`: kind (insurer, corporate, tenant, other), name (unique per org), TRN (blank = not registered), emirate, address lines, city, country, business e-mail (never logged; audit rows carry flags only), credit terms, `connected_person` (corporate tax), `payer_id` (insurers only, must exist in `fin_ref_payers`, one customer per payer), `receivable_account_id` (null = **1220 Customer receivables**, a new receivable control ledger), active.
- `acc_ar_number_series`: gap-free per entity, document kind (invoice, credit note, receipt) and fiscal year, under a row lock in the issuing transaction (a refused issue gives its number back): `SI/2026-27/00001`, `CN/...`, `RV/...`. A changed prefix applies to series created afterwards (the next fiscal year).
- `acc_sales_invoices` (+ `acc_sales_invoice_lines`): invoices and credit notes on one table (`kind`, a credit note's `original_invoice_id`). AED only. Totals stored per line and per document, CHECKed per line in SQL. Status draft -> issued -> part_paid / paid -> void. `posting_status` (not_posted, posted, waiting_ledger_start), `einvoice_status` (not_applicable, pending, sent, rejected; default not_applicable), `content_sha256`, maker / checker fields. An issued document never changes (trigger, every role) except its payment, void, posting and e-invoice fields; only a draft is deleted.
- `acc_receipts` + `acc_allocations`: customer, date, the bank / cash / clearing ledger, amount, mode, reference; allocations per invoice. A receipt never changes; it is voided.
- New ledgers seeded for every org (now, and for new orgs by `orgs_seed_finance_phase22e` after the chart): **1220 Customer receivables** (control receivable) and **4910 Rental income** (Indirect Incomes).
- `record_history` on `acc_sales_invoices` and `acc_receipts` (`HISTORY_TABLES`, `can_view_record_history()`); `record_access_log` accepts `accounting_receivable` (detail pages always, lists sampled).

## The rules

- **Totals and VAT (decision):** gross = quantity x unit price rounded to the fil; net = gross - discount; **VAT per line = net x rate, rounded to 2 decimals half away from zero**; the document VAT is the sum of the line VAT (FTA allows per line or per invoice; per line is what a line-level tax invoice shows and what the ledger posts per tax code). Quantities up to 3 decimals, prices and discounts 2. The action computes the total with `lib/accounting/sales.ts` and `acc_sales_doc_save` recomputes it in SQL; a difference is refused (`totals_mismatch`).
- **Tax codes are never guessed:** every line needs an active sales tax code (standard, zero-rated, exempt, out of scope; reverse charge and blocked VAT are purchase-side) and an active income ledger that is not a control account. Which service is zero-rated or 5% is still OQ-120 (and VATP016: B2B healthcare such as corporate medicals is 5%).
- **Full or simplified (decision):** Pulse prints a simplified tax invoice only when the customer has no TRN **and** the total is AED 10,000 or less; everything else is a full tax invoice. (The FTA also allows a simplified invoice to a registered recipient up to AED 10,000; Pulse does not use it, because a full invoice is always valid.) The simplified PDF omits the customer TRN.
- **Issue** (`acc_sales_doc_issue`): up to the approval limit, anyone with `accounting.sales.manage`; above it, a **different person from the preparer holding `accounting.journals.approve`**, quoting the content hash they reviewed (`approval_required`, `approved_by`; a CHECK repeats the different-person rule). Editing a draft makes the editor its preparer and changes the hash. Issue allocates the number, fixes the due date (invoice date + the customer's terms unless typed), the receivable ledger and the form, then posts: Dr the receivable (party customer, payer for insurers) / Cr income per line net (with tax code, branch, department, cost centre) / Cr output VAT per tax code, voucher type `sales`. A credit note posts the mirror with voucher type `credit_note`. Source kind `sales_invoice`, id = the document id, version 1.
- **Before the ledger start (the plan's rule 7, added by another slice):** when `acc_post_from_source` refuses with hint `before_ledger_start`, the document stays issued (numbered) and its posting is `waiting_ledger_start`: those dates belong to Tally and the document reaches it through the bridge. `acc_ar_retry_postings` (button "Post waiting documents" on the lists) tries again, each document on its own. Any other refusal refuses the whole issue with its reason.
- **Credit notes** refer to an issued, not void invoice of the same customer and entity, are not dated before it, and cannot exceed what is left to credit. The 14-day rule (FTA, credit note within 14 days of the event) is a **warning** on the form and the page (`event_date`), not a refusal.
- **Void** (`acc_sales_invoice_void`): a credit note in full is created and issued on the date given (reason required), the invoice becomes void and keeps its number. Refused while receipts are allocated (`has_receipts`) or another credit note exists (`has_credit_notes`: credit the rest instead). Above the approval limit only `accounting.journals.approve` may void. An invoice fully credited by credit notes also shows as void.
- **Receipts** (`acc_receipt_save`, `accounting.receipts.manage`): numbered (`RV`), posted at once (Dr the bank / cash / clearing ledger, Cr the customer's receivable, voucher type `receipt`, source `receipt`), then allocated **oldest invoice first** (date, then number) unless the person allocates by hand; what is left is **on account** (an advance). Allocations never exceed an invoice's open amount (total - credit notes - other active receipts) or the receipt; only to the same customer, entity and receivable ledger. `acc_receipt_allocate` replaces a receipt's allocations. Invoices move issued -> part_paid -> paid.
- **Void a receipt** (`acc_receipt_void`): allocations removed, its journal reversed through the 22A reversal (dated the later of the date given and the receipt date), invoices reopened. Decision: the receipts permission may do this (it is the sub-ledger's own correction), not only `accounting.journals.approve`.

## Reports

- `acc_ar_open_items(org, customer|null, as_of)`: each issued invoice dated on or before the date with what was open then (credit notes and active receipts dated on or before it), and each active receipt's unallocated part. Feeds the ageing (`buildAgeing`: current = not yet due, then 1-30, 31-60, 61-90, 91-120, 120+ days past due; on account shown negative), the receipt allocation list and the balance-confirmation letter. A receipt voided later is left out of earlier dates too (simplification).
- `acc_ar_statement(org, customer, from, to)`: the opening balance (everything before `from`) and each invoice (debit), credit note and receipt (credit); the running balance is `statementWithBalance`. A void invoice stays with the credit note that voided it; void receipts are left out. The DB test checks the closing equals the customer's balance in the ledger (account 1220, party customer).

## E-invoicing (OQ-122)

Only the `einvoice_status` column exists (default `not_applicable`). The PINT AE / PEPPOL data shape and an accredited service provider integration are **not built**. Insurer, corporate and tenant invoices are B2B and in scope of the UAE e-invoicing system (Ministerial Decisions 243 and 244 of 2025, amended by 66 of 2026: revenue of AED 50m or more go live 1 Jan 2027 with a provider appointed by 30 Oct 2026; below, 1 Jul 2027). OQ-122 (the revenue band, and whether Unite or Pulse issues the insurer invoice) must be answered before go-live.

## Decisions worth knowing

- One table for invoices and credit notes (`kind`), one number series each.
- Default approval limit AED 50,000 (a setting; Finance to confirm).
- The receivable is one control ledger (1220) with the customer as the line's party; a customer may use another receivable ledger, fixed on each document at issue.
- Packages and deposits (OQ-127) are not handled: a deposit is recorded as a receipt on account (no VAT on a zero-rated deposit; a 5% deposit's VAT at receipt is not posted automatically).
- No notification is sent when a document waits for approval (the list filter "Waiting for approval" shows them); add a `notify()` event if Finance asks.
- Bilingual heading: English only (the built-in PDF fonts have no Arabic glyphs).

## How it was verified

- Unit (`tests/unit/accounting/sales.test.ts`, 16 tests): line and per-line VAT rounding (0.005 -> 0.01, three lines of 0.10 give 0.03 VAT, not 0.02), fractional quantities, totals by rate, line problems, simplified vs full, due dates, the 14-day warning, allocation oldest first and on account, ageing buckets and totals, the statement running balance, the approval limit. `tests/unit/accounting/nav.test.ts` (new section, pages exist, guides).
- Database (`tests/db/accounting-receivables.test.ts`, 18 tests, Postgres 16): seeding (1220, 4910, settings; new orgs; idempotent); customer payer and receivable-ledger guards; totals re-checked against the TypeScript rules, sales tax codes and income ledgers, permissions; issue with SI/2026-27/00001 and a balanced journal (receivable, income per line, output VAT) against the customer; a refused issue gives its number back; 30 June in the previous fiscal year's series; due dates; simplified vs full; the approval limit (preparer, a second accountant without approval, a wrong or missing hash refused; the Finance Manager issues; the table CHECK); issued documents immutable; void (credit note in full mirrors the journal); partial credit notes, too much credit refused, fully credited = void, wrong customer refused; receipts oldest first (paid, part paid), the journal, allocation by hand, too much refused, wrong customer refused, on account, re-allocation, void with reversal and reopened invoices; the statement and the open items equal the ledger; the before-ledger-start path (simulated by a trigger raising the hint: issued and waiting, then posted on retry); who reads what (Accountant, Chief Accountant, Finance Manager, Auditor, CEO, admin read; Finance, a user without membership and another org's admin do not); nobody writes directly; record history. `tests/db/security-guard.test.ts`: `PHASE22E_TABLES` in the cross-org sweep (seeded by `seedPhase22ERows`) and the 11 functions service-role only.
- Typecheck, lint, `pnpm audit:security` and the full unit and database suites. When 22D's `ledger_start_date` column exists, the DB test sets it to 2020-01-01 for its org.

## Not verified

- **Not clicked through in a browser** (no Supabase auth stack here): pages, forms and the PDF / Excel downloads were typechecked and linted only. The PDF layout was not compared with a printed sample.
- The interaction with 22D's real ledger-start rule is tested with a stand-in trigger only.

## Before first use

1. Apply `deploy/supabase-paste/45_accounting_receivables.sql` (after 43; 44 may come before or after).
2. Accounting, Setup, Sales settings: the seller address, how to pay, and the approval limit. Check the entity's TRN under Entities and fiscal years.
3. Add the customers (with TRNs) and confirm the VAT code per service with the tax adviser (OQ-120) before the first invoice.
