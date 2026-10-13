# Phase 22I notes: Tally import, opening balances, reconciliation and the year-end close

_Built 13 Oct 2026 on the 22I worktree branch (based on `claude/funny-clarke-6t7gee` at `2d1fa54`). Plan: `docs/22_ACCOUNTING_PLAN.md` §1 principle 6, §2, the 22I row and §7 ("bring everything in from Tally as it is"). Builds on the 22A ledger core (`docs/22_PHASE_22A_NOTES.md`)._

## What it is

Everything in TallyPrime comes into Pulse's ledger: groups, ledgers, cost centres, opening balances and the full voucher history, each matched on Tally's GUID so a second import (or an updated export) never posts anything twice. A dry run shows what will happen before anything is created. The result is proved against Tally's own trial balance, ledger by ledger. Opening balances can also be typed in. The year-end close moves a fiscal year's income and expenses to retained earnings and closes the year.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 49, needs 43 first) | `supabase/migrations/20261109000600_accounting_tally_import.sql`, `deploy/supabase-paste/49_accounting_tally_import.sql` |
| Tally XML reader (pure; the ONE place Tally XML is read; 22J's live bridge reuses it) | `lib/accounting/tally/xml.ts` (decoding, forgiving pull parser), `amounts.ts` (sign convention, amounts, dates), `parse.ts` (typed records) |
| Dry run (pure) | `lib/accounting/tally/plan.ts` (`planTallyImport`, `mergeParsed`, `resolveVoucherType`), `stage.ts` (the staged rows) |
| Tally trial balance file (pure) | `lib/accounting/tally/tb-file.ts` |
| Server | `lib/accounting/tally/import-server.ts` (stage, commit step) |
| Pages (Accounting menu) | Setup: `tally-import` (upload, dry run, commit, history), `opening-balances`, `tally-reconciliation`; Close: `year-end` |
| Help | guides `accounting-tally-import`, `accounting-opening`, `accounting-tally-reconciliation`, `accounting-year-end`; release note at the top of `lib/help/whats-new.ts` |
| Tests | `tests/unit/accounting/tally/parse.test.ts` with hand-written synthetic fixtures (`fixtures/`: UTF-8, UTF-16 LE and BE; fake company "Demo Clinic"); `tests/db/accounting-tally.test.ts`; the security sweep (`PHASE22I_TABLES`, `seedPhase22IRows`, `acc_tally_staged` service-only, 10 functions service-role only) |

## Permissions

`accounting.import` for the import, the reconciliation and the opening-balance page (Chief Accountant holds it). Locking the imported months also needs `accounting.periods.manage`. The year-end close and re-open need `accounting.periods.manage`. Typed opening balances also need `accounting.journals.prepare` (database check of 22A), and a different person with `accounting.journals.approve` posts them. Every function checks the person's permission again.

## Tables

- `acc_tally_imports` (select policy for `accounting.import`): status `staged` (dry run) -> `committing` -> `committed`, or `discarded`; the sha256 of each uploaded file, total size, `forced`, the company name, the dry-run `report` (counts, the group mapping, the opening trial balance, vouchers per month and type, refusals with codes; ledger names but no narration), `opening_date`, first and last voucher date, the commit `result` (counts per kind and outcome, up to 500 refusals with GUID, date, number, type and code), `reconciled_at/by`, `periods_locked_at`.
- `acc_tally_staged` (service role only, no policy): the sanitised rows between the dry run and the commit (names, amounts, dates, codes, narrations already masked by `cleanNarration`). Deleted when the commit finishes.
- `acc_tally_reconciliations` (select policy for `accounting.import`): the as-at date, the uploaded file's sha256, ledgers compared, differences, the total difference and the differing ledgers (code, name, Pulse, Tally, difference).
- `acc_fiscal_years` gains `closed_by`, `closed_at`, `closing_journal_id` (and a check: closed needs `closed_at`).
- Storage bucket `accounting-imports` (private, 200 MB, no policies): the upload lands there by signed URL and is deleted in the same request that reads it.

## The Tally XML reader

- **Encodings:** UTF-8 (with or without BOM), UTF-16 LE and BE (with or without BOM, recognised by the `<\0` pattern). UTF-16 BE is byte-swapped first, so it does not depend on full ICU.
- **Invalid XML:** `&#4;` (Tally's blank marker, as in `&#4; Primary` / `&#4; Not Applicable`) and every other character XML 1.0 cannot carry are dropped, raw or as a character reference. Unbalanced closing tags are tolerated.
- **Size:** 200 MB per file, 400,000 objects per file, 450 entries per voucher. The parser builds a tree for one Tally object at a time (GROUP, LEDGER, COSTCENTRE, CURRENCY, VOUCHERTYPE, VOUCHER; stock items, units and the like are counted and ignored), so memory follows the largest voucher, not the file. Objects are accepted inside `TALLYMESSAGE` (file export) or anywhere else (Tally's HTTP collection responses, for 22J).
- **Names:** the `NAME` attribute, else `NAME.LIST/NAME`, else `LANGUAGENAME.LIST/NAME.LIST/NAME`. A parent of "Primary", blank or the blank marker means a primary group.
- **Vouchers:** GUID, ALTERID, MASTERID, DATE (YYYYMMDD), VOUCHERTYPENAME (or the VCHTYPE attribute), VOUCHERNUMBER, NARRATION, ISCANCELLED, ISOPTIONAL, ISPOSTDATED, ISDELETED / ACTION="Delete"; entries from `ALLLEDGERENTRIES.LIST`, `LEDGERENTRIES.LIST` and, in invoice mode, the `ACCOUNTINGALLOCATIONS.LIST` of `ALLINVENTORYENTRIES.LIST` / `INVENTORYENTRIES.LIST`. Zero-amount entries are skipped. Cost centres from `CATEGORYALLOCATIONS.LIST/COSTCENTREALLOCATIONS.LIST` (and the older form straight under the entry); bills from `BILLALLOCATIONS.LIST`.
- **Amounts** are read in fils (integer cents); more than two decimals is refused, never rounded. A foreign-currency amount such as `-100.00 USD @ AED 3.6725/USD = -367.25` posts the base amount after `=`; the currency (when it is an ISO code), the rate and the foreign amount go on the line as information.

### The sign convention (`lib/accounting/tally/amounts.ts`, `TALLY_DEBIT_SIGN = -1`)

In Tally a **debit is negative** and a credit positive: a voucher's debit entry is `ISDEEMEDPOSITIVE = Yes` with a negative `AMOUNT`, and a ledger's `OPENINGBALANCE` of -50000 is 50,000 Dr. Pulse keeps balances as debit minus credit, so every conversion goes through that one constant. Checked three ways: the unit test parses the output of Pulse's own exporter (`lib/finance/tally-xml.ts`) back and gets the same sides; a voucher whose `ISDEEMEDPOSITIVE` disagrees with its sign is refused (`sign_mismatch`); opening balances that do not net to zero are refused (`opening_unbalanced`, in the dry run and again in SQL). The opening-balance rule is not in Tally's documentation (research 22I); the reconciliation against Tally's Excel trial balance (explicit Dr and Cr columns) settles it per ledger on the first real import.

## The dry run

- **Groups:** Tally's 28 predefined groups map onto the seeded system groups by name (their GUID is recorded on them). A custom group is created under its Tally parent (a predefined group, another custom group or a Pulse group of that name) and takes its nature; a custom primary group takes its nature from `ISREVENUE` and `ISDEEMEDPOSITIVE` (revenue + deemed positive = expense, revenue = income, deemed positive = asset, else liability; equity is never guessed) and `AFFECTSGROSSPROFIT`. Parents always come before children.
- **Ledgers:** matched by GUID first, else by exact name (case-insensitive; the dry run lists these and the commit needs a tick to link them), else created under their group with a code `T-<8 hex of md5(GUID)>` (groups `TG-...`, cost centres `T...`). Tally's predefined **Profit & Loss A/c** (accumulated profit, no parent) is linked to Pulse's retained earnings control account (`3100`), whose name is kept. A name that is both a group and a ledger, a missing parent, a name over 120 characters or a primary group without nature flags is refused, and any refused group or ledger blocks the commit (fix it in Tally and export again).
- **Imported ledgers are not control accounts** ("as they are"): bank, cash, debtor and creditor ledgers from Tally keep `control` empty, so manual journals can still post to them. The Chief Accountant can mark them as control accounts in the chart once the posting engine (22D) takes over.
- **Voucher types:** a custom type maps through its `PARENT` chain to one of Tally's eight accounting types (Payment, Receipt, Contra, Journal, Sales, Purchase, Credit Note, Debit Note); anything else (Memorandum, Reversing Journal, Payroll, stock types, or a custom type whose master is not in the files) is refused and listed. Upload the masters with the vouchers so custom types resolve.
- **Vouchers:** cancelled, optional and deleted ones are skipped and counted; post-dated ones are imported on their date. Refused: no GUID, unreadable date or amount, sign disagreement, unknown type, a ledger neither in the files nor in Pulse, debits not equal to credits, fewer than two lines. Refusals do not block the commit, but it needs a tick ("import the rest without them") and they are listed with their reason.
- **Lines:** one Tally entry is one line; a cost-centre allocation in one category becomes one line per cost centre (an unallocated remainder gets its own line). Allocations in several categories at once (for example by branch and by doctor) cannot be represented on one line: the amount is imported whole without a cost centre and counted as a warning (never split by guess). Bill allocations go into the line description (`Agst Ref CLM-...`); opening bills (bill-wise opening balances) are counted but **not imported yet** (the ledger totals are) until receivables (22E) have allocations. The narration is `Tally <type> <number>: <narration>`, masked by `cleanNarration`.
- **Opening date:** the day before the first voucher's month unless chosen; it must be before the first voucher.
- **Re-import:** a voucher already posted at the same ALTERID is "unchanged" and not staged; a higher ALTERID is staged again; a lower one is "older" and skipped.

## The commit (idempotent, in steps)

1. `acc_tally_apply_masters`: groups, cost centres, ledgers in the staged order (by GUID; a higher ALTERID updates the name; link rows set the GUID on the Pulse account). Each row succeeds or is refused on its own.
2. `acc_tally_post_opening`: one `opening` journal per entity (`acc_post_from_source(.., 'opening', 'tally-opening:<entity>:1', version, date, 'opening', ..)`), dated the opening date. **Idempotent by content:** when the live opening journal already holds exactly these lines on that date nothing is posted; otherwise the next version replaces it (the old one is reversed). More than 450 lines are split into parts of 400, each balanced through "Opening balance difference" (9100), which nets to zero over the parts. It runs on every step (cheap when unchanged), so a step that failed after the masters still posts it.
3. `acc_tally_post_vouchers` (250 per call; the page repeats the step until nothing is left): `acc_post_from_source(org, entity, 'tally_import', GUID, ALTERID, date, base type, narration, lines)`. The same GUID and ALTERID returns the existing journal; a higher ALTERID reverses the live journal and posts again; a lower one is "older". A locked or closed period, a CEO-signed month or a closed fiscal year refuses the voucher (listed with the code).
4. `acc_tally_finish`: the counts and refusals are kept on the import; the staged rows are deleted.

The same file (sha256) is refused a second time unless "import a file that was imported before" is ticked; even then nothing already posted is posted twice. Tally's voucher numbers stay in the narration; Pulse numbers each journal in its own gap-free series (the imported history consumes Pulse numbers per fiscal year, by design of 22A).

## Reconciliation

Upload Tally's trial balance (Excel or CSV: a Particulars column and Debit and Credit columns, the header found automatically, totals and blank rows skipped). `acc_tally_reconcile` compares it with `acc_trial_balance` at the as-at date, ledger by ledger by name: Tally's "Profit & Loss A/c" is compared with retained earnings plus the earlier years' profit not yet closed (that is what Tally shows on it); rows naming a Pulse group (Tally's subtotals) are ignored; a Tally ledger that Pulse does not have, or a Pulse balance Tally does not show, is a difference. Zero differences mark the import reconciled. Then **Lock the imported months** (typed LOCK, `accounting.periods.manage`) closes and locks every month from the opening date to the last voucher. The adjustment periods stay open so the year-end close can still post.

## Opening balances typed in

A grid of every active ledger with a debit or credit at the opening date; it must balance. It is saved and submitted as a manual `opening` journal (22A rules: control accounts allowed, maker and checker) and posted from the journal's page by someone else. A second opening journal adds to the first.

## Year-end close

- `acc_year_end_preview` lists the twelve months, drafts dated in the year, earlier open years that have income or expense postings, the retained earnings account, the adjustment period and each income and expense balance with the result. Problems: `periods_open`, `drafts_waiting`, `previous_year_open`, `no_retained_earnings`, `adjustment_locked`, `year_closed`.
- `acc_year_end_close_months` creates any missing month and closes the open ones (the page's "Close the twelve months").
- `acc_year_end_close` posts the closing journal: source `year_end` (added to the journals' source-kind check), id = the fiscal year, voucher type Journal, dated the year's last day **in the adjustment period** (so month 12 can stay closed or locked; posted by the person, who manages periods), every income and expense balance to zero and the net to retained earnings. Then the adjustment period is closed and the fiscal year set to closed.
- **A closed year refuses every posting** (trigger `acc_journals_year_guard`, every role), including the Tally import and reopened months. Only the reversal of its own closing journal passes, inside the re-open.
- `acc_year_end_reopen` (typed REOPEN and a reason; later years must be re-opened first) reverses the closing journal on the same date and opens the year. Closing again posts version 2.
- **Trial balance:** no change was needed in 22A's `acc_trial_balance`. Once a year is closed its income and expenses net to zero, so `earlier_years_pl` no longer includes it and the amount sits in retained earnings (a database test checks both, before and after, and after a re-open). Within the closed year itself, the trial balance up to the last day shows income and expense accounts at zero after the closing journal (a post-closing trial balance); the P&L of 22G should leave `year_end` journals out.

## Parties

Tally's Sundry Debtors and Sundry Creditors ledgers (insurers, corporates, suppliers, and any patient ledgers the clinic kept in Tally) are imported as ordinary ledgers. Customers (22E) and suppliers (20D, `fin_suppliers`) are linked to them later: the plan is a nullable `acc_account_id` on `fin_suppliers` and on the 22E customer table, set by a small mapping screen (matched by name first, confirmed by a person). It was not added here because nothing reads it yet; 22D/22E add it with the code that uses it. If the clinic's Tally holds ledgers named after patients, they come in as they are (owner decision "as is"); they are ledger names only, never in a log, push or e-mail.

## How to export from TallyPrime

Menu names move a little between releases (OQ-127: the clinic's exact release); these are TallyPrime 2.x to 5.x.

1. **All Masters (XML):** open the company, then press **Alt+E (Export) > Masters**. Press **C (Configure)** and set *Type of Masters* = **All Masters**, *Include dependent masters* = Yes, *File Format* = **XML (Data Interchange)**, the folder and the file name (default `Master.xml`). Press **E (Send)**.
2. **Day Book / vouchers (XML):** **Alt+E (Export) > Transactions** and choose the Day Book (all vouchers). Press **C (Configure)**: *File Format* = **XML (Data Interchange)**; press **F2 (Period)** (Alt+F2 in older releases) and set the period from the first day of the books to the last date to import. Press **E (Send)** (default `DayBook.xml`). For a very large history export one fiscal year at a time; each file is imported on its own or together with the masters.
3. **Trial balance (Excel) for the reconciliation:** **Gateway of Tally > Display More Reports > Trial Balance**, press **F2** for the as-at date (the last voucher date of the import), press **Alt+F5 (Detailed)** so every ledger is shown, then **Alt+E (Export) > Current**, *File Format* = **Excel (Spreadsheet)**, and **E (Send)**.

Upload the masters and the Day Book files together (custom voucher types need the masters). Keep Tally's own backup and the XML export for at least 7 years after cut-over (research: corporate tax and VAT record keeping); Pulse keeps only their fingerprint.

## Decisions

- **The original files are never kept**, nor the narrations in raw form: the uploaded XML is deleted in the request that reads it; staged rows hold masked narrations and are deleted after the commit.
- **Masters refusals block the commit; voucher refusals do not** (they need a tick and are listed). Opening balances that do not net to zero block it.
- **Imported history consumes Pulse's journal numbers** (JV/2026-27/... per voucher type and fiscal year) and keeps Tally's number in the narration; 22A has no external-number column. If the auditors want Tally's numbers searchable, add `external_number` in a later slice.
- **Linking by name needs a tick**: a Pulse account and a Tally ledger with the same name are linked (the GUID is written on the Pulse account), never merged silently.
- **The closing journal lives in the adjustment period**, so the close works with month 12 closed or locked, and re-opening reverses it there. Locking the adjustment period by hand makes a re-open impossible (the page warns through `adjustment_locked`).
- **Years close in order** (earlier open years with income or expense postings block), and re-open in reverse order.

## How it was verified

- Unit (`tests/unit/accounting/tally/parse.test.ts`, 28 tests): the sign constant and the round trip with Pulse's exporter; amounts (plain, bracketed, blank, over-precise, foreign currency with ISO code and with symbols), dates; `&#4;` and control characters; UTF-8 / UTF-16 LE / UTF-16 BE give identical records (with and without BOM); oversized and non-XML files; masters (primary markers, nature flags, opening signs, P&L A/c, currencies, voucher types, ignored objects); vouchers (flags, bills, cost centres, foreign currency, zero rows, invoice mode, sign mismatch); custom voucher types; the dry run (group mapping and order, ledger creation and links, cost centres, the opening trial balance by group, refusals, staged lines and masked narrations, balanced lines, re-import states, GUID-then-name linking, an unbalanced opening, the opening date rules, vouchers without masters, an orphan ledger); the trial-balance file parser.
- Database (`tests/db/accounting-tally.test.ts`, 16 tests, Postgres 16): the dry run creates nothing; permission and org checks; who reads the import and the staged rows; the commit (chart, codes, GUIDs, P&L A/c on retained earnings, cost centres, one opening journal of 177,000, seven vouchers with split cost centres and foreign currency, masked narration, staged rows gone); the trial balance nets to zero with the expected bank balance; a second import changes nothing; an altered voucher is reversed and re-posted, an older one skipped; a changed opening replaces the opening journal (version 2); an unbalanced opening refused in SQL; reconciliation with differences and with none; locking only after a clean reconciliation; the year-end preview problems, closing an earlier year then this one, the closing journal's lines, number, date and adjustment flag, `earlier_years_pl` dropping to zero and the retained earnings balance, a reopened month in a closed year still refusing postings, re-open rules (permission, reason, later year) and closing again (version 2).
- `tests/db/security-guard.test.ts`: the two new tables in the cross-org sweep, `acc_tally_staged` service-only, the ten functions service-role only. The full database suite, typecheck, lint, `pnpm audit:security` and the full unit suite pass.

## Not verified

- **No real Tally export was available.** The element names, the opening-balance sign, the UTF-16 output and the export menu paths follow the research (help.tallysolutions.com summaries and community sources) and Pulse's exporter, not a file from the clinic's Tally (OQ-92, OQ-127). The first real import must be a dry run on a staging workspace, then reconciled against Tally's Excel trial balance before anything is committed in production.
- **Not clicked through in a browser** (no Supabase auth stack here): the pages, the signed upload and the commit loop were typechecked and linted only. The project's global Storage upload limit must allow 200 MB files (Supabase default is 50 MB); otherwise export one year at a time.
- **Performance** of a full history was not measured. Each voucher is one `acc_post_from_source` call (validation, hash, numbering, history row); the commit runs in 20-second steps of 250 vouchers per call, so a large history takes several steps (the page continues by itself). Parsing a 200 MB UTF-16 file needs roughly 1 GB of memory in the server function.
- Bill-wise opening bills and multi-category cost-centre splits are counted, not imported.

## Before first use

1. Apply `deploy/supabase-paste/49_accounting_tally_import.sql` (after 43). It creates the bucket `accounting-imports` when Storage exists.
2. Check Storage's global upload limit (Settings, Storage) is at least the size of the largest export, up to 200 MB.
3. Review the chart with the Chief Accountant first (22A step 4), then: dry run on staging, reconcile, then production.
