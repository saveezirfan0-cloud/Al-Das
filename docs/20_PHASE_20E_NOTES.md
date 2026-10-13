# Phase 20E notes: lab and external-referral reconciliation

_Built 13 Oct 2026 (what's-new dated 5 Nov, the planned release) on a worktree of `claude/funny-clarke-6t7gee` at `230e258`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20E (section 1.1 rows "Labs", "Lab turnaround", "Third parties")._

## What it replaces

Labs are the clinic's biggest expense. The in-house lab costs a fixed AED 25,000 a month for unlimited tests; send-out labs invoice per test; hospitals (deliveries elsewhere) and radiology providers invoice too. Reports arrive monthly, branch-wise, by working day 7 or 8. The finance meeting asked that **each test (patient, day, doctor) is matched against what Unite billed before the cost is charged to that doctor's account** and before the revenue share, by CPT or activity code, and Saeed asked for a turnaround "barometer of service". Until now the costs were typed into the doctor charges by hand (20F).

## What exists

| Piece | Where |
|---|---|
| Providers, upload per provider and month, statements with their summary | `/finance/labs` (`app/(app)/finance/labs/page.tsx`, `forms.tsx`, `actions.ts`) |
| One statement: summary, review and posting, cost by doctor and branch, done but not billed, billed but not on the file, price differences, turnaround, matched pairs (score and reasons), files | `/finance/labs/[id]` |
| Providers, their tests (expected days, agreed price), file layouts, matching settings | `/finance/labs/settings` (`settings/page.tsx`, `forms.tsx`, `actions.ts`); the layout form is the 20C one with the lab kinds |
| Field lists of the two new file kinds | `lib/finance/import-kinds.ts` (`lab_activity`, `provider_invoice`) |
| Parser (mapped columns only, each value checked for its shape) | `parseProviderLines` in `lib/finance/parse-import.ts` |
| The rules (pure, deterministic) | `lib/finance/labs.ts` |
| Loader (service role after the permission check) | `lib/finance/labs-server.ts` |
| Migration | `supabase/migrations/20261105000100_finance_labs.sql`, paste file `deploy/supabase-paste/35_finance_labs.sql` |

**Permissions.** `finance.labs.view` (Finance, Finance Manager, CEO) reads everything; `finance.labs.manage` (Finance, Finance Manager) sets up providers, tests and layouts, uploads, gives reasons, reviews, posts and reopens. Posting needs a second person: whoever marked the statement reviewed cannot post it (action, function and CHECK constraint). Billing, Insurance, the Medical Director, Cost / Payroll and Operations see nothing.

**Tables** (all `public.fin_*`, RLS with a select policy for the two keys, no write policy: every change is a server action with `recordAudit`):

- `fin_providers`: name, kind (`in_house_lab`, `send_out_lab`, `hospital`, `radiology`, `other`; fixed once saved), `fixed_monthly_fee` (in-house only), `allocation_basis` (`test_count` default, or `revenue`), active.
- `fin_ref_provider_tests`: per provider and code (CPT or Unite item code), `expected_days` and `agreed_price` (either may be blank).
- `fin_provider_statements`: one per provider and month: status `open` -> `reviewed` -> `posted`, frozen `figures` with their `figures_sha256`, preparer and poster.
- `fin_provider_files`: one row per uploaded file: kind, layout, file name, **sha256** (unique: the same file twice is refused), row count, total, first and last service date. The file itself is never stored.
- `fin_provider_lines`: service date, code, Unite PIN, ordering doctor's DHA id, branch code, result date, amount, invoice number. **No name, date of birth, Emirates ID or member id column exists.** The table's CHECKs refuse a PIN, doctor id or code that does not have the shape of one (a name cannot get in even past the parser).
- `fin_provider_notes`: the reason for an unmatched line (`line|<id>`) or a billed test missing from the file (`unite|<invoice line id>`), closed list of codes, optional note (required for "other", masked with `redactText`).
- Settings on `fin_ref_finance_settings`: `lab_date_window_days` (default 2), `lab_price_tolerance` (default 1.00).
- `fin_import_formats.kind` accepts the two new kinds, and its select policy now also admits the lab keys. The bank pages and actions only list and save the bank kinds; the labs pages only the lab kinds.

**SQL functions** (SECURITY DEFINER, `search_path = ''`, service role only, in `PHASE20_SERVICE_FUNCTIONS`): `fin_lab_unite_lines(org, from, to, codes)` (current lines of live invoices whose item code, line CPT or reference-data CPT is one of the codes; doctor per the configured doctor basis, as the revenue share); `fin_provider_import(...)` (opens the provider's statement for the month when missing and stores one file atomically; refuses a duplicate file, a layout of the wrong kind, a statement that is not open, an invoice line without an amount, and service dates after the month or before the previous month); `fin_lab_post(org, statement, sha256, user)`; `fin_lab_reopen(org, statement)`. Guards (triggers, every role including the service role): statement transitions and frozen figures, two people, files, lines and reasons change only while the statement is open, lines never change once stored, a statement cannot be deleted, and **a locked month (`fin_period_closes`) refuses every change** (upload, reason, review, posting, reopening; the charges guard of 20F refuses as well).

## The rules (`lib/finance/labs.ts`)

- **Candidates**: a provider line and a current Unite invoice line with the same Unite PIN (case and spaces ignored), the same code (the Unite line's item code, its CPT, or the CPT of its item in Reference data) and dates no further apart than the window.
- **Matching** in two passes: same day first, then within the window, each time pairing a line with a Unite line **only when each is the other's only candidate**. Anything else is never guessed: "several fit" lines stay unmatched and need a reason. A line without a PIN is never matched. Score 0 to 100 for the reader: 60 for PIN and code, up to 30 for the date (minus 10 per day), 10 when the file's doctor equals Unite's; a different doctor is shown as a reason, not a refusal.
- **Done but not billed**: every unmatched line (no PIN, nothing in Unite, or several fit). This is the revenue leakage.
- **Billed but not on the file** (send-out labs only): unmatched Unite lines dated in the month whose code is in the provider's test list and that are not a candidate of any open line.
- **Price differences**: invoice lines further than the tolerance from the test's agreed price.
- **Turnaround**: lines whose test has expected days; late when result date minus service date exceeds them, or, without a result, when today minus the service date does. The page shows the on-time count and the late list.
- **Cost per doctor and branch**: the doctor is the one Unite billed the matched test under (doctor basis), otherwise the ordering doctor on the file; the branch is the file's, otherwise the invoice's. Invoices: the line amounts. In-house lab: the fixed fee shared by number of tests (default) or by the billed net of the matched tests, by largest remainder so the shares add up to the fee to the fils. Lines with no doctor are shown as "no doctor (not charged)".
- **Review** is refused until there is at least one line, every unmatched line and every billed test missing from the file has a reason, the in-house fee is set and (by revenue) there is revenue to share by. The figures (summary, allocation, per-doctor costs, matched pairs by id, open items with their reason codes; no PIN) are frozen and the database stores their sha256.
- **Posting** (a different person, bound to that sha256) writes one `fin_doctor_charges` row per doctor with a cost: kind `lab` (in-house and send-out labs) or `referral` (hospital, radiology, other), source `lab_recon` or `referral_recon`, reference = the statement id, month = the statement's month. Posting again replaces only that statement's rows; reopening a posted statement removes them. Once the month's revenue share is verified (20F) or the month is locked, both are refused by the charges guard.

## How it was verified

- `tests/unit/finance/labs.test.ts` (23): unique pairs with score and reasons, code through the line CPT and the reference CPT, case and spaces, the window (inclusive edge, outside, zero), ambiguity both ways never guessed, same-day first, no PIN, doctor mismatch, leakage both ways (send-out only, provider codes only, month bounds, candidates of ambiguous lines excluded), price tolerance, turnaround (late, waiting past the days, on time, no expectation), invoice costs per doctor and branch, the in-house fee by test count (exact to the fils) and by revenue, the review blockers, largest remainder, determinism under reordering, figures without PINs, the test-list parser, PIN masking.
- `tests/unit/finance/labs-import.test.ts` (7): the field lists (no name, birth, Emirates, passport, national, member, insurance, phone, e-mail or address field), a typed `patient_name` mapping is dropped, only mapped columns read (names, Emirates IDs and dates of birth in the file never come out), a missing mapped column refuses the file, a name column mapped as PIN refuses the file without echoing it, code / amount / date / invoice-number checks.
- `tests/unit/finance-labs-actions.test.ts` (5): each of the 11 actions refuses without `finance.labs.manage` (view, bank and revenue-share keys are not enough) before the service role is created; the reviewer cannot post; a changed fingerprint is refused; bad files and input are refused before the database; bank and lab layout actions refuse each other's kinds.
- `tests/db/finance-labs.test.ts` (14, Postgres 16): who reads (Finance, CEO; not Billing, not another org), nobody writes directly, service-role-only functions, the Unite lines (CPT mapping; deleted invoices, superseded lines, other dates and other orgs excluded), the import (second branch file into the same statement, duplicate file, wrong layout, dates outside, missing amount, another org's provider, nothing half-stored), the table refusing a name as PIN, code or doctor id, a full month through the pure rules on the database rows (matched, not billed, not on file, price difference, reasons, review sha256 = sha256 of the stored figures), review refused with problems, frozen children, posting by the preparer refused (function, guard and CHECK), wrong hash refused, charges written, re-posting idempotent with manual charges untouched, reopening removes the charges, a hospital posts referral charges, the locked month, the grant block (idempotent, right roles, matches the presets). `tests/db/security-guard.test.ts` sweeps the six tables (`PHASE20_TABLES`, `seedPhase20Rows`) and lists the four functions; `tests/db/finance-phase18-rls.test.ts` knows the keys arrived later; `tests/unit/finance/nav.test.ts` covers who sees the pages.
- Typecheck, lint, the unit suite (2,878 tests), the database suite (759 tests; the PostgREST suites skip), `pnpm audit:security` (514 entry points, 0 unguarded; every new action guarded and audited).

## Not verified

- No real lab file, provider invoice or referral invoice yet (samples D5, D6): the layouts, the PIN format and whether the files carry the PIN, the doctor id and a result date at all are unproven.
- Not clicked through in a browser (no Supabase auth stack here).
- No real Unite data (capture is OFF, OQ-94): matching has only been exercised on synthetic invoices.
- The paste file was not applied separately; it is the migration plus the migration-history line.

## Before first use

1. Apply `deploy/supabase-paste/35_finance_labs.sql` to the **Pulse** project (not THC Portal), after `34_finance_bank_ai.sql`.
2. Finance, Lab providers and tests: add the in-house lab with **its monthly fee (AED 25,000)** and how to share it (number of tests, or billed revenue), each send-out lab, the hospitals and the radiology provider.
3. **Map each provider's file once the samples arrive (D5 in-house statement and send-out invoice, D6 referral invoice):** add a layout per file, typing each column header exactly as in the file. Map the Unite PIN only if the file has one; never map a name column (there is no field for it). Upload the sample and check the totals.
4. Add each provider's tests: **the expected turnaround in days** and the agreed price (one per line: `code, days, price`). For a send-out lab this list also decides which billed Unite tests are expected on its file.
5. Check the matching settings (window 2 days, price tolerance 1.00) and, in Finance, Workflow settings, the doctor basis (it decides which doctor a matched test's cost goes to) and Reference data (item CPT codes let a file's CPT match a Unite item code).
6. Each month after WD7: upload the files, work the lists, review, and have a second person post before the revenue share is built.

## Decisions worth knowing

- **One statement per provider and month**, holding one or more files (branch-wise reports go into the same statement); the in-house fee is shared across all of them at once.
- The doctor charged is Unite's (the doctor basis) for a matched test, the file's ordering doctor otherwise; costs with no doctor are shown and never posted. Charges are posted per doctor (the branch split is in the frozen figures; `fin_doctor_charges` has no branch).
- Unmatched lines are still charged when the file names a doctor: the lab still has to be paid, and the "done but not billed" list is the place to fix billing.
- A Unite line already matched by another provider's statement is not excluded from "billed but not on the file" (a code on two providers' lists shows on both); give it the reason.
- Credit lines (negative amounts) are refused; a corrected invoice replaces the file (remove it while the statement is open and upload the new one).
- Uploads into a locked month are refused (unlike the 20C bank import), because a statement exists only to post costs into that month.
- The PIN is shown masked (last three characters) on the pages; the stored figures carry ids and codes, never a PIN. File names are kept as uploaded (as for bank and remittance files).
