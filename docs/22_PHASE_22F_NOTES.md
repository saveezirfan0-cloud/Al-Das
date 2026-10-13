# Phase 22F notes: banking and cash

_Built 13 Oct 2026 on the 22F worktree branch (based on `claude/funny-clarke-6t7gee` at `2d1fa54`). Plan: `docs/22_ACCOUNTING_PLAN.md` §1–5 and the 22F row; the Tally research (post-dated cheques, cheque books, Bank OD). Builds on 22A (ledger core, `acc_post_from_source`) and 20C (bank accounts, statement imports, reconciliation), which it does not rebuild._

## What it is

The books' side of the bank and the cash. Each 20C bank account points at its ledger; money moved between bank and cash accounts posts as Contra; bank charges, interest and direct debits post as bank entries (also straight from an unmatched statement line); each branch can keep a petty cash float with receipts and a monthly count that a second person signs; the cheque register holds cheques issued and received, posts post-dated cheques on their date and reverses bounced, cancelled and stale ones. The bank position compares the books with the bank statement per account.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 46, needs 43 and 41 first) | `supabase/migrations/20261109000300_accounting_banking.sql`, `deploy/supabase-paste/46_accounting_banking.sql` |
| Pages (Accounting, Banking) | `app/(app)/accounting/banking/`: `page.tsx` (bank accounts: ledger link, position, uncleared cheques), `transfers/`, `entries/`, `petty-cash/`, `cheques/`; `forms.tsx`, `actions.ts`, `ui.tsx` |
| Pure rules (unit-tested) | `lib/accounting/banking.ts`: transfer validation, VAT split, the cheque status machine, stale and post-dated rules, petty cash count, book to bank, error sentences |
| Loaders | `lib/accounting/banking-server.ts` |
| Navigation | five entries in section "Banking" of `lib/accounting/nav.ts` (between Ledger and Reports, as plan §5) |
| Daily job | step 6 of `lib/finance/workflows.ts` (pg_cron `finance_workflows`, 03:50 UTC) calls `acc_banking_sweep` per org with the org's date |
| 20C hook | Finance, Bank reconciliation, Settings: adding a bank account offers to create its ledger (only for someone who also holds `accounting.banking.manage`) |
| Help | guide `accounting-banking` in `lib/help/guides.ts`; release note at the top of `lib/help/whats-new.ts` |

## Permissions

Every action needs `accounting.banking.manage` (22A key; Accountant and Chief Accountant), checked in the server action and again inside each SQL function for the named person (`app.user_has_perm`). The pages are readable with `accounting.banking.manage`, `accounting.ledger.view` (Auditor) or `accounting.journals.approve` (Finance Manager); row level security says the same (`app.acc_can_read_banking`). The CEO (view, reports) and Finance roles see none of the registers. Nothing has a write policy; every write is a SECURITY DEFINER function (service role only, `search_path = ''`).

## Tables

All `public.acc_*` plus one column on `fin_bank_accounts`; `org_id` on every row; RLS on.

- `fin_bank_accounts.gl_account_id`: the ledger of the bank account (unique; a trigger insists on a bank-control ledger of the same org). `acc_bank_create_ledger()` creates it under "Bank Accounts" (`G-BANK`, asset) or "Bank OD A/c" (`G-BOD`, liability; an overdraft keeps the bank control, its balance is negative when drawn).
- `acc_bank_statement_balances`: the closing balance printed on a statement for a date (20C stores lines, not balances), typed in.
- `acc_bank_transfers`: kind `transfer` / `cash_deposit` (cash to bank) / `cash_withdrawal` (bank to cash) / `petty_cash_topup` (to a float); posts Dr to, Cr from, voucher type `contra`, source `bank_transfer`.
- `acc_bank_entries`: kind `bank_charge`, `interest_paid`, `direct_debit` (money out: Dr ledger, Cr bank, voucher `payment`) or `interest_received`, `direct_credit` (money in: Dr bank, Cr ledger, voucher `receipt`); source `bank_entry`. The other side is a plain ledger (no control account). A standard-rated tax code splits the VAT-inclusive amount (net rounded to the fils, VAT the rest) to the VAT input or output account; zero, exempt, out-of-scope and blocked codes keep the whole amount on the ledger; reverse charge is refused (enter it as a journal). Optional `bank_line_id`: the 20C statement line it explains (same account, date, amount and direction, and still unmatched).
- `acc_petty_cash_floats` (one cash ledger each, created under "Cash-in-Hand"; float amount, branch, custodian), `acc_petty_cash_expenses` (Dr expense and VAT, Cr the float; source `petty_cash`; receipt in `fin_documents`, kind `voucher_backup`, through the 20D prepare / upload / finalise flow), `acc_petty_cash_counts` (one per float and month: counted, book balance on the count date, difference, explanation, sha256, preparer and signer).
- `acc_cheque_books` (bank account, first / last / next leaf, width for leading zeros), `acc_cheques` (issued or received; bank account; book; number; cheque date and the day written or received, `post_dated` generated; party; the other side of the posting; optional 20D voucher; status and posting state; dates of each step), `acc_party_flags` (a bounced cheque's party, until cleared with a reason).
- `record_history` on transfers, entries and cheques (`HISTORY_TABLES` and `app.can_view_record_history`).

## The rules (all in SQL, for every role)

- **Posting** goes through `acc_post_from_source(kind, item id, version 1, ...)` with the new source kinds `bank_transfer`, `bank_entry`, `petty_cash` and `cheque`, so every 22A rule applies (balance, control accounts, periods, the CEO month lock, numbering). The journal is built from the stored row (`app.acc_banking_post_item`), so a retry posts the same journal.
- **Waiting for the ledger start.** When `acc_post_from_source` refuses with hint `before_ledger_start` (the central rule another slice adds), the item is kept with status `waiting_ledger_start` (cheques: posting `waiting_ledger_start`), the person's action succeeds and the page says so. `acc_banking_sweep()` retries them. Any other refusal (closed or locked period, month lock, an unknown account) fails the action with its sentence.
- **Nothing changes after saving.** A trigger refuses any update of an item's content and any delete, for every role; only the status, journal and cancellation columns move, through the functions. Cancelling (`acc_banking_cancel`, a reason of at least 3 characters) reverses a posted journal on the date given (on or after its own date) or simply stops a waiting one. A cancelled transfer, entry or expense, and a bounced, cancelled or stale cheque, is final. Cancelling a bank entry frees its statement line.
- **Statement lines.** A 20C line is `matched` when a reconciliation matched it **or** a live bank entry explains it (`app.fin_bank_line_refresh`, which now backs the 20C trigger too). The 20C run treats such a line as matched elsewhere, so it is no longer an unexplained credit; a matched line still cannot be deleted with its import.
- **Petty cash count.** The book balance is the float ledger's balance on the count date; a difference needs an explanation. The preparer (whoever saved it last) cannot sign; the signer quotes the sha256 of what they were shown; if a posting moved the book balance since, signing is refused (`count_stale`) and the count is prepared again. Signed is final. The difference is not posted automatically: write off a shortage with a journal.
- **Cheques.** Status machine (the same table in SQL and `CHEQUE_TRANSITIONS`): issued / received -> presented -> cleared; any of those -> bounced; issued / received -> cancelled; issued / received -> stale strictly after six months from the cheque's date (months added as Postgres does, 31 Aug + 6 months = 28 Feb). A cheque dated today or earlier posts at registration, dated the cheque; a post-dated one stays `not_due` and the sweep posts it on its date (journal dated the cheque date). Presenting, clearing or bouncing before the cheque's date is refused; no step is dated in the future. Bounce, cancel and stale reverse the journal on the step's date (never before the cheque's date) or, when it never posted, leave it `not_posted`. A bounce flags the party and may book the bank's charge as a bank entry (default account 6500). A cheque already stale cannot be registered. An issued cheque's number is used once per bank account (also when cancelled); a book gives the next leaf with its leading zeros and its next number only goes up; ranges of one account never overlap. Issued cheques: Dr the other side (supplier payables by default for a 20D voucher), Cr bank, voucher `payment`, the supplier on the line; received: Dr bank, Cr the other side, voucher `receipt`.
- **Patients.** A cheque from a patient records the Unite PIN only (`party_ref`, letters, digits and dashes, at most 20); a name is refused by the function and by a CHECK. The journal narration says "(patient)" and carries no PIN.
- **Bank position** (`acc_bank_position`, amounts and counts only): per bank account the ledger balance today; the latest statement balance on or before the date; on that statement date the ledger balance, the cheques in the books that the bank has not cleared yet (issued and received, as they stood on that date), the unmatched statement lines; post-dated cheques not yet due; the latest 20C reconciliation. The arithmetic is `bookToBank()`: book + issued not yet paid - received not yet credited = what the bank should show; the rest is the difference.

## Contract for other slices

- **Source kinds.** The migration adds `bank_transfer`, `bank_entry`, `petty_cash` and `cheque` by patching the `acc_journals` CHECK (union with whatever is there) and the list inside `acc_post_from_source` in place (it fails loudly if the 22A list is not found). A later migration that rewrites `acc_post_from_source` with a literal list must keep these four kinds.
- **`before_ledger_start`.** 22F only reads the hint; the rule itself is the other slice's.
- **22D (posting engine): vouchers paid by cheque.** The register posts the bank side of a cheque (Dr payables, Cr bank, dated the cheque date) for a 20D voucher registered here (`acc_cheques.voucher_id`). The engine must not also post the payment of such a voucher (it posts the supplier invoice or expense side only), or the bank is credited twice. Likewise 22E receipts by cheque: register the cheque here, or post the receipt there, not both.
- **20C.** `app.fin_bank_line_status()` now calls `app.fin_bank_line_refresh()`; the 20C rules are unchanged.

## Decisions worth knowing

- **One person posts banking items.** Transfers, bank entries, petty cash expenses and cheques post when saved by someone with `accounting.banking.manage` (as a Contra or payment entry in Tally); they are audited, in the record history, never edited and cancelled by reversal. The two-person rule is on the petty cash count. If the clinic wants a checker on transfers, they become 22A manual journals instead.
- **Statement balances are typed in.** 20C keeps no running balance; the accountant types the closing balance from the statement. When the bank samples (D3) show a balance column, the import can fill it.
- **Ledger link can change.** Relinking a bank account to another ledger affects postings from then on; posted journals stay where they are.
- **Received cheques post to the deposit account** on their date (no separate "PDC receivable" account): a post-dated cheque is a memo until its date, as in Tally.
- **Receipts** reuse `fin_documents` (kind `voucher_backup`); they open through `openReceipt` (a document attached to an expense of the org, banking or ledger permission; the open is logged by `signedFinanceDocumentUrl`).
- **Vouchers with a special category** (payroll, intercompany, related party) are not offered for registration; register such a cheque by hand.

## How it was verified

- Unit: `tests/unit/accounting/banking.test.ts` (transfer validation, VAT split and rounding, the transition table, final statuses, post-dated and future-date refusals, available steps, month arithmetic and the stale boundary, PIN rule, next leaf, petty cash count and top-up, book to bank including an overdraft, error sentences); `tests/unit/accounting/nav.test.ts` (Banking section in plan order, guides for every page).
- Database: `tests/db/accounting-banking.test.ts` (24 tests, Postgres 16): ledger link and refusals (non-bank ledger, cash ledger, another org's account, a ledger in use, the trigger for every role), a new ledger under Bank OD A/c; a Contra posting and its lines, direction / same-account / non-money / precision refusals, immutability, cancellation by reversal (dated as asked), history rows; a bank charge with VAT from a statement line (line matched, not usable twice, freed on cancel), interest received, line mismatches, control accounts refused, an unlinked account refused; a float with its ledger, a top-up, an expense with VAT and a receipt (another org's receipt refused), the count (explanation required, same person, wrong fingerprint and a reader refused, signed final, the table's two-person CHECK, a stale book balance refused); cheque books (overlap, next leaf, duplicate leaf), a current cheque posted dated the cheque with the supplier dimension, a post-dated cheque posted by the sweep on its date (not before, once only, no PIN in the narration), a bounce (reversal dated the bounce, flag, charge entry, final, warning on the next cheque, clearing the flag), cancelling a post-dated cheque without posting, stale by the sweep with a reversal, stale registration refused, patient PIN rules, an unknown voucher refused; the bank position and book to bank at the statement date; every banking journal balanced; `waiting_ledger_start` with a stand-in `acc_post_from_source` that raises the hint (transfer and cheque wait, another refusal still fails, the sweep posts both once allowed); who reads (Accountant, Auditor yes; CEO, Finance, another org no), nobody writes directly, the functions are service-role only, history visibility. `tests/db/security-guard.test.ts`: `PHASE22F_TABLES` with `seedPhase22FRows` in the cross-org sweep and the 17 functions service-role only.
- Typecheck, lint, `pnpm audit:security` (0 unguarded) and the full unit and database suites.

## Not verified

- **Not clicked through in a browser** (no Supabase auth stack here): pages and forms were typechecked and linted only; the receipt upload uses the 20D component's flow untested here.
- The `before_ledger_start` rule is simulated in the test; the real rule's exact behaviour (hint text, which dates) comes from the other slice.
- No real bank statement or cheque book: charges, VAT on bank fees and the six-month validity follow UAE practice and the research, to be confirmed by the accountant.

## Before first use

1. Apply `deploy/supabase-paste/46_accounting_banking.sql` (after 43 and 41).
2. Accounting, Banking, Bank accounts: link each bank account to its ledger (the seeded `1150 Bank - current account` for the first one) or create one; mark an overdraft account under Bank OD A/c.
3. Add a petty cash float per branch that keeps one, then top it up with a petty cash transfer.
4. Add the cheque books in use; register outstanding post-dated cheques (issued and received) with their dates.
5. Type the latest statement closing balance per account and check the position.
