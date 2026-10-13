# Phase 22J notes: the Tally bridge (TallyPrime kept in step with Pulse until the cut-over)

_Built 13 Oct 2026 on the 22J worktree branch (based on `claude/funny-clarke-6t7gee` at `c4314b2`). Plan:
`docs/22_ACCOUNTING_PLAN.md` principles 6 and 7, the 22J row and section 7. Builds on 22D (`buildJournalForSource`, the
preview, the ledger start), 22I (the Tally reader and the idempotent import by GUID / ALTERID) and 20H's Tally XML writer
(`lib/finance/tally-xml.ts`). Open questions: OQ-123 (which PC runs Tally, can a service be installed), OQ-124 (Unite
revenue as daily summaries), OQ-117 (cut-over date), OQ-127 (Tally release)._

## What it is

Until the ledger start Tally is the book of record and Pulse mirrors it. The bridge keeps the two in step without anyone
exporting files:

- **Push.** What Pulse originates and Tally must hold is sent to Tally as vouchers: approved supplier invoices and payment
  vouchers (20D), sales invoices, credit notes and receipts (22E), bank transfers, bank entries and cheques (22F),
  depreciation and schedule runs (22H) and Unite revenue as **one voucher per day and branch** (OQ-124 default; a setting
  sends one per invoice). Petty cash, Unite payments, remittances, denials, revenue share, lab statements, cash-ups and
  settlements can be ticked too (off by default: the team enters some of them in Tally by hand today).
- **Pull.** Every 15 minutes the masters (groups, ledgers, cost centres) and the vouchers changed in Tally since the last
  AlterID come back and go through the 22I import path, so Pulse's ledger mirrors Tally, **including the vouchers the
  bridge pushed** (they come back as Tally's and are linked to their Pulse source; they are counted once, as
  `tally_import` journals, because Pulse itself posts nothing before the ledger start).
- **Drift.** Once a day Tally's ledger closing balances are compared with the mirror (22I's reconciliation) and shown on
  the page.
- **From the ledger start** pushing stops by itself (Pulse is the book of record). Pulling continues, read-only, until it
  is switched off, and never imports a Tally voucher dated on or after the ledger start.

A connector on the Tally PC does the talking: it reaches Tally on `127.0.0.1` only and Pulse over HTTPS only, outbound.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 50, needs 49 first) | `supabase/migrations/20261109000700_accounting_tally_bridge.sql`, `deploy/supabase-paste/50_accounting_tally_bridge.sql` |
| Pure parts | `lib/accounting/tally/bridge.ts` (REMOTEID, voucher numbers, tokens and pairing codes, the voucher for a journal, the daily summary, the job allow-list), `bridge-sources.ts` (sources and labels), `response.ts` (Tally's import answer, the trial balance from closing balances); `parse.ts` now also reads `REMOTEID` and `CLOSINGBALANCE`; the voucher XML is written by `buildBridgeVoucherXml` in `lib/finance/tally-xml.ts` |
| Server | `lib/accounting/tally/bridge-server.ts` (scheduler, claims, results, pulls), `bridge-route.ts` (the connector's token check); `buildJournalsForSources` added to `lib/accounting/posting/runner.ts` |
| Routes (connector only) | `app/api/tally-bridge/pair` (POST), `jobs` (GET), `results` (POST); in `UNGUARDED_OK` with their reasons and public in the middleware |
| Job | task `accounting_tally_bridge` (`lib/jobs/handlers/accounting-tally-bridge.ts`), pg_cron `pulse:accounting_tally_bridge` at minutes 4, 19, 34, 49 |
| Integration | `tally_bridge` in `lib/integrations/catalog.ts`: off by default, `integrations.manage` and the typed words **CONNECT TALLY** (new flag `writesBooks`), `sharesData` false (the data stays between the clinic's Tally and Pulse), the Tally company name as its one setting; calls recorded under `tally_bridge` |
| Page | Accounting, Setup, **Tally bridge** (`/accounting/tally-bridge`): `accounting.import` to view, `accounting.settings.manage` to pair, revoke, change settings and send again |
| Connector | `connector/tally-bridge/` (Node.js 20 ESM, no dependencies; its own `README.md` with every installation step) |
| Help | guide `accounting-tally-bridge`; release note at the top of `lib/help/whats-new.ts`; error sentences in `lib/accounting/errors.ts` |

## Setting it up at the clinic

The connector's README (`connector/tally-bridge/README.md`) has the commands; in short:

1. **Choose the PC (OQ-123).** The PC (or TallyPrime Server host) where Tally runs with the company open during working
   hours, where IT allows a Windows service and outbound HTTPS to Pulse.
2. **Tally's XML server, on this PC only.** F1 Help > Settings > Connectivity (older: F12 > Advanced Configuration):
   TallyPrime acts as **Server**, ODBC **Yes**, port **9000**. Tally's XML port has no password, so add a **Windows
   Firewall inbound rule blocking TCP 9000** from every remote address; the connector uses 127.0.0.1.
3. **The Pulse voucher types in Tally.** Create > Voucher Type, eight times: Pulse Journal (Journal), Pulse Payment
   (Payment), Pulse Receipt (Receipt), Pulse Contra (Contra), Pulse Sales (Sales), Pulse Purchase (Purchase), Pulse Credit
   Note (Credit Note), Pulse Debit Note (Debit Note); numbering **Manual**, **Prevent duplicates** Yes.
4. **Install the connector**: Node.js 20 LTS, copy `connector/tally-bridge` to `C:\PulseTallyBridge`, run it as a
   Windows service with **NSSM** (README step 3), protect `bridge.config.json` with `icacls`.
5. **Switch the integration on**: Settings, Integrations, Tally bridge: the Tally company name exactly as in Tally, then
   switch on and type `CONNECT TALLY` (an administrator, `integrations.manage`).
6. **Pair**: Accounting, Setup, Tally bridge, *Create a pairing code* (shown once, 30 minutes, single use), then on the
   Tally PC `node bridge.mjs pair --url https://<Pulse> --code XXXX-XXXX-XXXX-XXXX`. A new pairing revokes the old one.
7. **Pull first.** Tick *pull* only. Check the trial balance card shows no drift and the masters cursor moves. The first
   cursors start where the 22I file import got to (the highest ALTERID imported), so do the full history with the 22I
   import first.
8. **Then push**, from a chosen *Send items dated from* (items before it are never sent: Tally already holds them), and
   only the sources nobody enters in Tally by hand any more. Map every account the pushed items use to a Tally ledger
   first (Posting rules pointing at ledgers imported from Tally); otherwise the item waits with "No Tally ledger for".
9. **At the cut-over (OQ-117)** set the ledger start under Entities and fiscal years: pushing stops that day. Leave
   pulling on until the last Tally adjustments for earlier dates are in, then switch it off, revoke the connector, stop
   and remove the service. Keep Tally's backup and full XML export for at least seven years (22I notes).

## How pushing works

- **Sources.** The scheduler asks `acc_tally_bridge_candidates` what changed since its scan position (two-minute settle
  time): 22D items in **preview** (built before the ledger start; `withdrawn` or `nothing` means a pushed voucher must
  be reversed), 22E documents and receipts and 22F items **waiting for the ledger start**, 22H runs waiting for it. It
  also re-reads every held item each run (a mapping may have been added) and rebuilds the last three closed days of the
  daily summaries (a late invoice changes its day).
- **The journal.** 22D sources: the engine's own builders (`buildJournalsForSources`, nothing posted). 22E and 22F: the
  database runs the slice's **own posting function** with `app.acc_capture` on, inside a sub-transaction that is always
  rolled back; `acc_post_from_source` (patched in place, before its per-item lock) raises the journal it was given back as
  the error's detail, so the bridge sends exactly what the slice would post, and nothing the slice did on the way is kept.
  22H runs: built from their stored lines in SQL (the run's own post needs a second person), the same aggregation as
  `acc_asset_run_post`; a reversing-accruals run also sends its own reversal dated the 1st of the next month.
- **The voucher.** `resolveVoucher` nets the lines per account and dimension and maps each account to its **Tally
  ledger**: an account must carry a Tally GUID (from the 22I import or a pull); its name is the one Tally last sent
  (`acc_accounts.tally_name`, set by pulls), else the account's name. An account without a Tally ledger, an unknown
  account or unbalanced lines **hold** the item with the reason; nothing is guessed. Cost centres: the line's cost centre,
  else the branch's Tally cost centre from `fin_ref_tally_ledgers` (kind cost_centre), else none.
- **Identity.** REMOTEID and GUID are `pulse-<org>-<kind>-<id>-<version>`; a reversal adds `-r`. `remoteIdBase` builds the
  part before the version (a plain short id, a UUID without dashes or a day key keep their characters; anything else is
  hashed so `A/1` and `A-1` cannot meet); the database appends the version. Voucher number `PB-` + 10 hex of the
  REMOTEID's SHA-256 (`-R` for a reversal), in the Pulse voucher types (manual numbering, prevent duplicates).
- **Versions (`acc_tally_bridge_push_apply`, one lock per org).** New item: version 1, a job queued. Same journal
  (`journal_sha256`): nothing. Changed while Tally does not have it (held, queued, refused, withdrawn): changed **in
  place** (same REMOTEID). Changed once Tally has it: a **reversal voucher** (the same entries on the other side, the
  opposite type: payment and receipt, sales and credit note, purchase and debit note; the original's date) and the
  **next version** as a new voucher. Withdrawn: not sent yet, cancelled; in Tally, reversed. On its way or unknown: left
  alone until the answer. This is the research's "reversal vouchers keep Tally's audit trail cleaner" choice; the bridge
  never sends Alter for an existing voucher and **never Delete**.
- **Window.** Only items dated from *push from* and before the ledger start; nothing at all once the ledger has started
  (`ledger_started`), in a training workspace (`training`), or with the switch or push off.

## The connector's jobs

`acc_tally_jobs` is the outbox (queued, sent, done, failed, cancelled). The connector polls `GET /api/tally-bridge/jobs`
(device token; Pulse hands out jobs only while the connector reports that Tally answers) and posts each answer to
`POST /api/tally-bridge/results` (gzip-compressed Tally bytes, base64; body capped at 4.4 MB, 96 MB after
decompression).

- **Allow-list** (both sides): `export_masters_since`, `export_vouchers_since` (all voucher types plus the vouchers since
  the AlterID), `export_trial_balance` (every ledger's closing balance at a date), `import_voucher`. The connector builds
  the export requests itself from numbers, dates and the company name; the only XML it takes from Pulse is one import,
  checked by `checkImportXml`: one envelope, `Import Data`, report `Vouchers`, exactly one `VOUCHER` whose REMOTEID is the
  job's `pulse-` id, every GUID the same, ACTION Create or Alter, no Delete or `ISDELETED`, no masters, TDL or DOCTYPE.
- **Answers.** `CREATED` or `ALTERED` = 1 with no errors, exceptions or LINEERROR: done (Tally's LASTVCHID kept). Errors or
  LINEERROR: refused, with Tally's text through `lib/redact.ts`; a person sends it again after fixing the cause (often a
  missing voucher type or ledger). Tally not running (connection refused): asked again, the attempt does not count.
  **No readable answer or a timeout is ambiguous**: the next attempt first looks the voucher up by REMOTEID or GUID and
  imports only when Tally does not hold it. A job sent ten minutes ago without an answer is treated the same way; after
  five tries the voucher is **unknown** for a person to check in Tally and send again (then looked up first).
- **Ledger start.** Queued imports are cancelled and their items held (`ledger_started`); an unanswered import is still
  looked up (never sent) so the queue ends knowing what Tally holds.

## Pulling

- `export_masters_since` → `planTallyImport` → staged rows in an `acc_tally_imports` row with `source = 'bridge'` → 22I's
  `acc_tally_apply_masters` **without a person** (`app.acc_tally_import_for_update` now allows a null user for a bridge
  import only; a file import still needs `accounting.import`) → `acc_tally_bridge_pull_finish` (Tally's ledger names kept
  in `tally_name`, the cursor moved, the import row removed). A new Tally ledger with the name of an existing Pulse
  account is linked to it, as 22I's voucher path does by name (counted as `linked_by_name`). Opening balances are not
  posted by pulls: change them through the 22I file import.
- `export_vouchers_since` → vouchers dated on or after the ledger start are refused (`after_ledger_start`) → cancelled,
  optional or deleted vouchers reverse their mirror journal on its own date (`acc_tally_bridge_pull_cancelled`) → the plan
  (Pulse's own voucher types are always known, `withPulseVoucherTypes`) → `acc_tally_post_vouchers` (GUID and ALTERID:
  the same is unchanged, a higher one reverses and re-posts) → **`pull_finish` links each voucher whose REMOTEID is a
  pushed one to its `acc_tally_push` row** (`mirror_journal_id`; an unanswered push becomes done) and logs refusals once
  a day per voucher and code. The cursor moves to the highest ALTERID seen, but stays below a voucher refused for a
  ledger, cost centre or type Tally created after the masters pull, so it comes back next time. A pull that runs out of
  its 20-second budget is finished by the next scheduler run.
- `export_trial_balance` (once a day, the day before) → `acc_tally_bridge_record_tb` → 22I's `acc_tally_reconcile` (no
  person, only inside this function) stored with `source = 'bridge'`; the page shows the differing ledgers.

## Tables (RLS on)

| Table | Who reads it | Holds |
|---|---|---|
| `acc_tally_bridge_settings` | `accounting.import` or `accounting.settings.manage` | push / pull, push-from date, revenue mode, sources, cost category |
| `acc_tally_devices` | **service role only** (no policy) | connectors: name, state, version, last seen, SHA-256 of the pairing code and the token |
| `acc_tally_push` | `accounting.import` | one row per Tally voucher (each version and reversal): REMOTEID, date, type, amount, the voucher (ledger names, amounts, narration), status, reason, Tally MasterID, mirror journal |
| `acc_tally_jobs` | `accounting.import` | the outbox: kind, status, attempts, look-up flag, numbers and dates only |
| `acc_tally_sync_log` | `accounting.import` | per voucher, pull, check and pairing: outcome, code, REMOTEID or GUID, date, Tally's redacted error text, counts |
| `acc_tally_cursors` | `accounting.import` | AlterIDs applied (masters, vouchers) and the source scan position |

Columns added: `acc_accounts.tally_name`, `acc_tally_imports.source`, `acc_tally_reconciliations.source` (the 22I pages
show file imports and uploaded trial balances only). No write policy anywhere: 17 SECURITY DEFINER functions
(`acc_tally_bridge_*`, service role only, `search_path = ''`) after `can()` or the device-token check; the ones a person
triggers check `accounting.settings.manage` again. No new permission keys.

## Decisions worth knowing

- **Version in the REMOTEID, reversal vouchers for changes** (the task's id shape). The research also allowed an Alter of
  the same REMOTEID; reversing keeps Tally's audit trail and never relies on Tally's Alter semantics.
- **The 22E / 22F capture** patches `acc_post_from_source` in place (like 22F did for its source kinds). A later
  migration that redefines the function must keep the block (a database test fails without it).
- **Daily summaries per branch**: one voucher per day and branch per kind (Unite invoices as Pulse Sales, Unite payments as
  Pulse Receipt), lines netted per account and branch, so revenue stays per service category through 22D's revenue rule
  per category. The mode cannot change once Unite revenue was sent (`mode_locked`).
- **Push from date** is required: switching the bridge on never sends history Tally already has.
- **Deletions in Tally are not seen** (an AlterID filter cannot see them; the research's periodic GUID reconciliation is
  not built). The daily trial-balance check shows the drift.
- **One connector per organisation**; pairing a new one revokes the previous one and re-queues its unanswered jobs (an
  import only after a look-up).
- **Training workspaces never push.**

## How it was verified

- Unit (`tests/unit/accounting/tally/bridge.test.ts`, 19 tests): REMOTEID determinism, length and collision-proof
  hashing; voucher numbers; tokens, pairing codes and the bearer header; the voucher for a journal (Tally names, debits
  first, cost centres, holds for an unmapped or unknown account, a group, unbalanced lines, an opening); the fingerprint
  is independent of line order and mapping; the XML: ISDEEMEDPOSITIVE Yes with a negative AMOUNT for a debit, REMOTEID and
  GUID, the same bytes for the same input, parsed back by the 22I reader to the same entries, accepted by the connector's
  check; refusals to write; Pulse voucher types resolving to their base; the daily summary; swapping sides; captured
  journals; the job allow-list; part decoding and caps; Tally's import answers (created, altered, wrapped in IMPORTRESULT,
  LINEERROR, two created, unreadable, UTF-16); the trial balance from closing balances.
- Connector (`tests/unit/accounting/tally/connector.test.ts`, 8 tests) against a fake Tally XML server and a fake Pulse
  API started inside the test on 127.0.0.1: pairing; the export jobs send exactly the connector's own requests and post
  gzip answers the server reader parses; an import forwarded byte for byte; the look-up before a resend (found: exists, no
  import; not found: import; lookup-only: absent); refusals (unknown type, Delete, a ledger inside an import, someone
  else's id, two vouchers, a bad AlterID, a bad id); Tally not running; HTTPS only; logs without amounts, names, the
  company, XML, the REMOTEID or the token.
- Results (`tests/unit/accounting/tally/bridge-results.test.ts`, 6 tests, a fake database client): created with Tally's
  MasterID; refused with Tally's text redacted (a phone number in it is masked); an unreadable answer, a timeout, a
  look-up without the voucher or broken parts are ambiguous, never success; a look-up that shows it; Tally not running;
  the connector's refusal; an answer to a job not waiting for one; a failed export.
- Database (`tests/db/accounting-tally-bridge.test.ts`, 18 tests, Postgres 16): pairing (hashes only, single use, expiry,
  one connector per org, revoke with permission and org); push needs the switch, permission and a first date; a new item
  queued once with the TS base plus the version; out of range; changed in place; claim, waiting while sent, an answer from
  the wrong connector refused, done; reversal plus next version once in Tally; withdrawal; held then released; only the
  chosen sources and revenue form (an unknown source refused); ambiguous
  answers and the look-up; unanswered jobs, five tries, unknown, a person's retry, Tally's refusal text; the ledger start
  (out of range, stopped, imports cancelled and held, exports still handed out); a bridge pull of the 22I masters without a
  person (a file import still refused), Tally names and cursors; the pushed voucher pulled back posted once as Tally's and
  linked, unchanged on a second pull, the cursor never moving back, refusals logged once; a voucher cancelled in Tally
  reversed in the mirror once; the trial-balance check with and without drift; the 22F capture (journal returned, nothing
  posted, the item still waiting) and the candidates; who reads what. `tests/db/security-guard.test.ts` sweeps the five
  tables, `acc_tally_devices` service-only and the 17 functions service-role only.
- Typecheck, lint, `pnpm audit:security` (0 unguarded), the full unit and database suites.

## Not verified

- **Nothing was tried against a real TallyPrime.** The request envelopes (Collection exports with inline TDL, `$AlterID`,
  `$RemoteID`, `ClosingBalance`, `SVFROMDATE` / `SVTODATE`), the import answer's shape, whether Tally keeps a REMOTEID and a
  `pulse-` GUID as sent (community reports: yes, and a Create with an existing REMOTEID updates rather than duplicates) and
  how UTF-8 requests are taken follow the research (Tally's help pages and community sources, research addendum A and C)
  and Pulse's own exporter. **First use: a test company in Tally (a copy of the books), pull only, then push a handful of
  items and check them in Tally.**
- The connector was not installed as a Windows service or run on Windows; NSSM steps follow NSSM's documentation.
- Not clicked through in a browser (no Supabase auth stack here); the page and its forms were typechecked and linted.
- The 22D / 22E / 22F / 22H journals were not compared with what the clinic types in Tally today; the sources ticked by
  default must be agreed with Finance so nothing is in Tally twice.
- Performance of a large first pull was not measured (incremental pulls are small; history belongs to the 22I file import).

## Before first use

1. Apply `deploy/supabase-paste/50_accounting_tally_bridge.sql` (after 49). It adds the cron job.
2. The 22I file import of masters and history first, reconciled (22I notes).
3. The clinic's steps above, pull only, then push.
