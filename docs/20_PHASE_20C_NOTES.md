# Phase 20C notes: bank and settlement reconciliation

_Built 13 Oct 2026 on `claude/funny-clarke-6t7gee`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20C (sections 1, 1.1 and 4.1)._

## What it does

Proves that every Unite collection reached the bank. Unite records each payment with a payment mode (cash, card, EPG, Tabby, rePG, MX, insurance credit). Card and EPG settle two working days later, Tabby six, cash is deposited the next working day, processors deduct a fee, and insurers pay in bulk against a remittance advice. For each bank account and month Pulse works out what should have arrived, finds it on the imported bank statement, and lists what did not arrive (aged, with a reason) and what arrived that nothing explains. Althaf can work the open month weekly by payment mode; Hardik reviews it at month end and a second person signs it.

The bank and processor file formats are not known yet (samples D3 and D4 in the plan), so the import is generic: a person maps each field to the header of its column once per bank or processor, without a code change.

## What exists

| Piece | Where |
|---|---|
| Accounts, import, reconciliations list, recent imports | `/finance/bank` (`app/(app)/finance/bank/page.tsx`, `forms.tsx`, `actions.ts`) |
| One reconciliation: summary, automatic matches ready to save, proposed matches (accept / reject, score and reasons), expected but not found (ageing, reason), bank credits with no match (reason), matched (undo), review and sign-off | `/finance/bank/[id]` (`[id]/page.tsx`, `[id]/run-forms.tsx`) |
| Accounts, file layouts (column mapping per kind), settlement rules, matching and calendar settings | `/finance/bank/settings` (`settings/page.tsx`, `forms.tsx`, `actions.ts`) |
| Field list per kind of file (generic, reusable for lab, referral and POS files) | `lib/finance/import-kinds.ts` |
| Parser (CSV and XLSX, mapped columns only, redaction) | `lib/finance/parse-import.ts`, `redactStatementText` in `lib/redact.ts` |
| The rules (pure, deterministic) | `lib/finance/bank-recon.ts` |
| Loader (service role after the permission check) | `lib/finance/bank-server.ts` |
| Migration | `supabase/migrations/20261028000100_finance_bank_recon.sql`, paste file `deploy/supabase-paste/27_finance_bank_recon.sql` |

**Permissions.** `finance.bank.view` (Finance, CEO) reads everything; `finance.bank.manage` (Finance) imports files, edits accounts, layouts, rules and settings, decides matches, gives reasons and marks a reconciliation reviewed; `finance.bank.signoff` (Finance) signs. A signer also needs `view` to open the page. Billing, Insurance, the Medical Director and Cost / Payroll see nothing.

**Tables** (all `public.fin_*`, RLS with a select policy for the three keys, no write policy: every change is a server action with `recordAudit`):

- `fin_bank_accounts`: name, bank, **last 4 digits only**, currency, Tally ledger name, `receives_insurance` (at most one account per org).
- `fin_import_formats`: kind (`bank_statement` or `settlement`), name, `mapping` jsonb `{field: header text}`, date format (`DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`), amount style (one signed column, or debit and credit columns), active.
- `fin_ref_settlement_rules`: payment mode exactly as Unite writes it, lag in working days, expected fee %, bank account, `settles_to_bank` (false for insurance credit), source (`collections`: Unite's collections with the lag and fee; `settlement`: the processor's settlement report).
- `fin_bank_imports`: one row per file: kind, account or payment mode, layout, the file's **extension only** (`csv` / `xlsx`; review fix: a file name can carry a person's name, so a trigger keeps the extension and a CHECK refuses anything else; names stored before `20261107000200` were cleared), **sha256** (unique: the same file twice is refused), row count, totals, first and last date. The file itself is never stored.
- `fin_bank_lines`: account, value date, signed amount (money in is positive), reference, redacted description, `match_status` (kept by a trigger).
- `fin_settlement_lines`: payment mode, transaction date, settlement (payout) date, gross, fee, net, reference.
- `fin_bank_recs`: one per account and month: period, status `open` -> `reviewed` -> `signed`, frozen `figures` and their `figures_sha256`, preparer and signer.
- `fin_bank_matches`: accepted, automatic and rejected pairs (expected item key, bank line, amounts, score, reasons). A bank line and an expected item are each matched at most once (unique indexes).
- `fin_bank_rec_notes`: the reason for an open item (closed list of codes, optional note, required for "other").
- Settings on `fin_ref_finance_settings`: `bank_weekend_days` (default Saturday and Sunday), `bank_date_window_days` (3), `bank_amount_tolerance` (1.00) and `bank_amount_tolerance_pct` (0; the larger applies), `bank_auto_accept_score` (80), `bank_cutoff_day` (30).

**SQL functions** (SECURITY DEFINER, `search_path = ''`, service role only): `fin_bank_collections(org, from, to)` (Unite collections per payment mode and day across branches: paid by paid date, refunds by refund date, deleted invoices excluded, as the cash-up); `fin_bank_import(...)` (stores one parsed file atomically; refuses a duplicate sha256 and dates that overlap an earlier import of the same account, or of the same mode for a settlement report); `fin_seed_settlement_rules(org)` (starter rules, idempotent, never overwrites; also run by `pnpm finance:seed`). Guards (triggers, every role including the service role): run transitions, frozen figures, two people, signed is final, decisions only while open, a matched bank line cannot be deleted, and a **locked month (`fin_period_closes`) refuses every reconciliation change**.

## The rules

- **Period.** A month ends on the cut-off day (30th, or the month's last day when shorter) and starts the day after the previous month's cut-off: October is 1 to 30 Oct, November 31 Oct to 30 Nov. Set at the time the reconciliation is opened.
- **Expected receipts** for one account:
  - *Collections* (rule source "collections"): Unite's collections minus refunds per payment mode and paid date in the period; expected on paid date + lag **working** days (weekend from the settings); expected amount = gross minus the rule's fee %. A day of net refunds expects nothing.
  - *Payouts* (rule source "settlement"): the processor's payouts in the period, grouped by payout date and reference: net, gross and fee from the report. Each day's Unite total for that mode is compared with the processor's gross; a difference beyond the tolerance is a "Unite vs processor" item that needs a reason (it is never matched to the bank).
  - *Insurance*: each remittance batch (`ins_remittance_batches.sum_paid`, on its payment date, else its upload date) when the account receives insurance payments. Its reference is the remittance reference.
  - A payment mode with no rule, or a rule without a bank account, lag or fee % (0 is a valid fee), is listed as **not reconciled** on every run until Finance completes it. Insurance credit is left to the remittance matching.
- **Candidates**: bank credits on the account within the date window of the expected date and the amount tolerance. **Score 0 to 100**: amount up to 50 (exact 50, falling to 25 at the edge of the tolerance), date up to 30 (same day 30, falling with each day), reference found on the bank line 10, payment mode (or payer) named on the bank line 10. Each candidate shows its reasons.
- **Automatic match** only when the score reaches the threshold **and** it is the only candidate on both sides (the item has one candidate and that line is a candidate for nothing else). Everything else is proposed to a person; when two lines fit, both are marked "Several fit" and Pulse never picks. Rejecting a pair removes it; if one candidate is left and it scores enough, it becomes automatic.
- **Ageing** of expected items with no match: days from the expected date to the last imported statement date (to today for Unite vs processor items). Inside the date window an item is "waiting" (in transit); after it, 0-7, 8-30, 31-60 and over 60 days late, and it needs a reason. A bank line matched by another month's reconciliation is not offered again.
- **Review** is refused until: a statement covers the whole period, the automatic matches are saved, every proposal is decided, every late item and every unmatched bank credit has a reason, and no saved match points at an item that no longer exists or whose amount moved beyond the tolerance. The figures (summary, every matched pair, every open item with its bucket and reason; ids, codes, dates and amounts only) are frozen and the database stores their sha256. **The signer must be a different person** and signs the fingerprint they were shown. Reopening is possible before the signature; a signed reconciliation is final.

## How it was verified

- `tests/unit/finance/bank-recon.test.ts` (26 tests) on `tests/unit/finance/fixtures/bank.synthetic.json` (synthetic October): working days (T+2 Thursday is Monday, Tabby T+6), custom weekends, periods across year ends and February, ageing buckets, expected receipts (fee, refunds, case-insensitive modes, accounts, insurance, settlement payouts and the Unite vs processor gap), scoring and tolerances, the automatic-match uniqueness rule, ties proposed and never picked, rejection, ageing, every review blocker, orphaned and changed matches, determinism.
- `tests/unit/finance/bank-import.test.ts` (15 tests): field lists, mapping validation, dates per format (no two-digit years), amounts, header found below a preamble, unknown columns never read, a missing mapped header refusing the file with the list, duplicate headers, row errors without cell values, debit / credit columns, an .xlsx built in the test, settlement reports, and redaction (IBAN, card and account numbers, masked cards, phone numbers, e-mails; short references kept). Review fix: `redactStatementText` also masks UAE numbers written without "+" (`971...`, `00971...`) and local numbers with the trunk 0 (`050 123 4567`, `0501234567`, `04 123 4567`, also when letters touch them, `MOB0501234567`); a reference of 9 to 11 digits that starts with 0 is therefore masked too.
- `tests/unit/finance-bank-actions.test.ts`: each action refuses a member without its own permission before the service role exists; manage does not cover sign-off; the preparer cannot sign; bad files and input are refused before the database.
- `tests/db/finance-bank.test.ts` (14 tests, Postgres 16): who reads (Finance, CEO, nobody in another org, not Billing), nobody writes directly, service-role-only functions, the collections aggregate against the fixture, starter rules, atomic import with totals, duplicate and overlap refusals, match bookkeeping, review and sign-off rules, signed is final, locked-month refusal. `tests/db/security-guard.test.ts` lists the three functions; `tests/db/finance-phase18-rls.test.ts` knows the new keys.
- Typecheck, lint, the unit suite, the database suite and `pnpm audit:security` (0 unguarded; see the commit).

## Not verified

- No real bank statement, settlement report or Unite payment-mode values: the layouts, the rules' mode texts, lags and fees are unproven until the samples arrive.
- Not clicked through in a browser (no Supabase auth stack here).
- Matching is one bank line to one expected item. A processor that pays one day's card takings in several credits (one per terminal) or several days in one credit needs the settlement report (source "settlement"), whose payouts are the expected items; without it those days stay unmatched with a reason.
- Public holidays are not in the working-day calendar (weekends only); a T+2 over Eid shows as late until a reason is given. The 20G close calendar is the place for holidays.
- References of 12 digits or more are masked like account numbers, so they cannot score the reference points.

## Before first use

1. Apply `deploy/supabase-paste/27_finance_bank_recon.sql` to the **Pulse** project (not THC Portal).
2. Settings, Bank accounts and rules: add each bank account (name, bank, last 4 digits; tick "Insurers' payments arrive here" on the one that receives them).
3. **Map each bank's columns once the sample arrives (D3, D4):** add a file layout per bank statement export and per processor settlement report, typing each column header exactly as in the file, the date format and the amount style. Import the sample and check the totals against the bank.
4. Check the starter rules against what Unite really writes for each payment mode (Card, EPG, Tabby, Cash, rePG, MX, Insurance credit), then give each mode its bank account, lag and fee % (0 for cash). rePG and MX need a lag. Choose "settlement report" for a mode whose processor report you will upload.
5. Confirm the matching settings (window 3 days, tolerance 1.00, auto-accept 80, cut-off 30th, weekend Saturday and Sunday).
6. Open October's reconciliation per account, import the statements, save the automatic matches and work the lists.

## Decisions worth knowing

- **Imports are allowed into a locked month** (like the Unite and Diligence mirrors, delivered data is never refused); everything about the reconciliation itself is refused once the month is locked. A statement that overlaps an earlier one is refused rather than de-duplicated line by line (identical lines are legitimate on a statement); remove the earlier import or export only the new dates.
- The original file is not kept, as for remittance. The plan (4.3) suggests keeping bank statements as evidence once 20B's private `finance-documents` bucket exists; that is a 20B decision.
- Proposals are computed when the page opens, not stored; only decisions are stored. "Save automatic matches" is an explicit button so a person sees what is about to be matched.
- Payment-mode keys in saved matches use the rule's text; renaming a rule's mode turns its saved matches into "no longer exists" items to undo.
- Bank descriptions may hold a payer's name (a patient paying by transfer). The plan treats bank data as confidential, not health data; descriptions are masked for numbers, kept to 200 characters, and only Finance and the CEO can read them.
