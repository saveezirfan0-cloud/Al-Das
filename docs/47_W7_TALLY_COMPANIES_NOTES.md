# W7: Tally path with several Tally companies (clinic plan of 16 Oct 2026)

Plan row W7: "After the partner call: enter the address and credentials (hosted Tally) or install the connector (Tally on a
clinic PC); pilot on a **test company**; **support several Tally companies**; gate review end Jan 2027. Done when: pilot
month pushes and pulls cleanly." Migration: `supabase/migrations/20261210000400_tally_company_per_entity.sql`. Builds on
`docs/22_PHASE_22J_NOTES.md` (the bridge, read it first) and 22I (the file import).

## 1. What was found (before this change)

The bridge served **one Tally company and one entity**. Nothing was multi-company, although the connector itself already
was.

| Question | Finding | Where |
|---|---|---|
| Where is the company name kept? | One value, the `company` field of the `tally_bridge` integration (required, one per org). | `lib/integrations/catalog.ts` (`tally_bridge`, `commonFields`); read in `claimJobs` (`bridge-server.ts:633` at HEAD) |
| Does an entity know its Tally company? | No. `acc_entities` had no such column. | `acc_entities` (22A) |
| Which entity did the bridge use? | Always the **default** one: pulls staged into it, the vouchers pull read its ledger start, pushing stopped on its ledger start, the daily trial balance compared it. | `bridge-server.ts:925-931` (`stageBridgeImport`), `:1108-1114` (`applyVouchersPull`); migration 20261109000700 lines 335 (`acc_tally_push_stop`) and 842 (`acc_tally_bridge_push_apply`); `acc_tally_reconcile` (20261109000600 line ~637) defaulted a missing entity to the default one |
| Could entity A and entity B (two companies) run on one installation? | **No.** Pushed items carry no entity: a sales invoice, receipt or bank item of a second entity was captured and sent to **the one company**. | `acc_tally_bridge_candidates` / `_capture` are org-wide (20261109001000:104-173); `acc_tally_bridge_push_apply` took no entity |
| AlterID cursors | One `masters` and one `vouchers` cursor per **organisation** (`primary key (org_id, cursor)`), updated by `on conflict (org_id, cursor)`. AlterIDs are counted inside one company, so a second company would have been read from, or skipped past, the first one's cursor. | 20261109000700 lines 187-195, 958, 1342 |
| Open export jobs | One open export of each kind per **organisation** (`acc_tally_jobs_export_open_uidx (org_id, kind)`). | 20261109000700 line 160 |
| REMOTEIDs | `pulse-<org>-<kind>-<source id>-<version>`; unique per org (`unique (org_id, remote_id)`, line 126). A source belongs to one entity, so two companies can never receive the same REMOTEID; only **changing a source's company** would split a voucher's versions between companies. | `lib/accounting/tally/bridge.ts` `remoteIdBase` |
| `SVCURRENTCOMPANY` | Written into every export request and every voucher import from the job's `company`. The connector built each request from `job.company` (not from its own config) and refused jobs without one, so **one connector can already serve several companies**; nothing checked that an import's XML named the job's company. | `connector/tally-bridge/lib/envelopes.mjs:42`, `core.mjs:224-266`, `validate.mjs`; `lib/finance/tally-xml.ts:355` |
| How did the 22I file import pick the company? | It did not: it staged into the default entity whatever company the XML named (the name was only stored for display). | `import-server.ts:99-105` (HEAD); `parse.ts` / `xml.ts:189` read `SVCURRENTCOMPANY` |
| Ledger start rule | Per entity in SQL (`app.acc_ledger_start_ok`), but the bridge read only the default entity's. | `acc_tally_push_stop`, `push_apply`, `applyVouchersPull` |
| 22D engine (Unite revenue, supplier invoices, vouchers, remittances ...) | Posts into the **default entity only** (`orgsWithLedger`, `readLedgerStart`). Only the 22E (sales, receipts), 22F (bank) and 22H (assets) sources carry their own entity. | `lib/accounting/posting/runner.ts:133`, `posting/server.ts:277` |
| Chart of accounts | **One per organisation**: unique account name and unique Tally GUID per org (`acc_accounts_name_uidx`, `acc_accounts_tally_guid_uidx`); accounts with no entity are shared by all entities. A second company's ledger named like an existing account is matched **by name**; its masters link is then refused (`link_changed`: the account already carries the first company's GUID), logged, and the pull carries on. Vouchers resolve ledgers by GUID, then name (`app.acc_tally_ledger_id`). | `plan.ts:460-467`, `acc_tally_apply_masters` (20261109000600:~315-325), `acc_tally_ledger_id` (:217) |
| Devices | **One paired connector per organisation**; a new pairing revokes the previous one. | 20261109000700 `acc_tally_bridge_pair_exchange` (line ~550) |
| The "hosted Tally HTTPS mode" | **Does not exist** in the repo. `docs/44` is not in the repo and nothing in code or docs mentions hosted Tally. The connector talks to Tally **only** at `http://127.0.0.1:<port>` and Pulse never calls out (22J notes). A partner-hosted Tally Pulse cannot reach needs either the connector installed on the hosting VM (if the partner allows it), or a new design. | `connector/tally-bridge/lib/core.mjs:3,97` |

Bottom line: a second Tally company was **not** supported, and with a second entity the old code could have written its
vouchers into the first company. It is now.

## 2. What changed

**Rule: one Tally company per accounting entity.** An entity's company is its own `tally_company`; the **default
entity without one falls back to the integration's company**, so a single-company installation behaves exactly as before
(all 35 existing bridge/import database tests and the 19+8+6 unit tests pass unchanged). Any other entity without a
company is **not bridged**: its items wait (`held`, reason `no_tally_company`), nothing is pulled for it, nothing is ever
sent to another company. Two active entities that would resolve to the same name (case-insensitive) both resolve to
**no company** (fail closed). One SQL rule, `app.acc_tally_company(org, entity)`; `lib/accounting/tally/companies.ts` is
its twin (page, import routing) and both run on the same synthetic scenarios
(`tests/unit/accounting/tally/fixtures/company-scenarios.synthetic.json`).

| Piece | Change |
|---|---|
| `acc_entities.tally_company` | New, nullable, unique per org (case-insensitive), 1-120 characters. Set under **Accounting, Setup, Entities and fiscal years** (`accounting.settings.manage`, audited as `has_tally_company`). A trigger refuses changing it once the bridge has exchanged anything for the entity (a cursor, a voucher sent / in Tally / unknown, a mirrored `tally_import` journal): `tally_company_in_use`. Setting the company the entity already resolves to (the default entity naming the integration's company, or going back to it) is allowed. |
| `acc_tally_push.entity_id`, `acc_tally_jobs.entity_id` | New, not null (back-filled with the default entity), org-checked by `app.check_parent_org`. An item without `entity_id` belongs to the default entity (the 22D builders' journals) or to its earlier voucher's entity (a withdrawal); captured 22E/22F/22H items carry their journal's entity. The reversal and the next version keep the entity. |
| `acc_tally_cursors.entity_id` | AlterID cursors `masters` and `vouchers` are **per entity**, i.e. per company (unique `(org, entity, cursor)`). The `sources` scan position stays per organisation (`entity_id` null; a check ties it). The default entity's first cursors still start where the 22I file import got to; any other entity starts from the beginning of its company. A surrogate `id` is the new primary key. |
| Export jobs | The tick queues masters, vouchers and the daily trial-balance check **per bridged entity**; one open export per `(org, entity, kind)`. An entity that loses its company has its queued exports cancelled (`no_tally_company`). |
| Company on the wire | `acc_tally_bridge_claim` hands each job out with its `entity_id` and its `company`, worked out at claim time; a job whose entity has no company is not handed out. `claimJobs` no longer reads the integration config. One connector serves every company loaded in that Tally. |
| Ledger start | Per entity: items of an entity dated on/after its start are `out_of_range`; from the start day its items are skipped (`entity_stopped`) and its queued imports are held and cancelled (`ledger_started`) at the claim; a person's retry is refused for it. The whole organisation stops (`stopped: ledger_started`) only when **no entity has anything left to send**; with no company anywhere it stops with `no_tally_company`. |
| Pulls | `stageBridgeImport` stages into the job's entity, `applyVouchersPull` reads that entity's ledger start, `acc_tally_bridge_pull_finish` moves that entity's cursor, `acc_tally_bridge_record_tb` reconciles that entity's books (`acc_tally_reconcile` now defaults an import's reconciliation to the import's own entity; patched in place as 22J did). |
| 22I file import | The company named inside the XML picks the entity (`pickImportEntity`). A file naming no company, or any file while no entity has its own company, goes to the default entity as before. Once an entity has its own company, a file from an **unknown** company is refused (`company_not_linked`), and files of different companies in one import are refused (`mixed_companies`). The manual trial-balance reconciliation gets an entity picker when there are several entities. |
| Connector | Dependency-free change: `checkJob` refuses an import whose `SVCURRENTCOMPANY` is not the job's company (`wrong_company`, reported as `refused_job`). README paragraph added. |
| Pages | Entities page: a Tally company column and field. Tally bridge page: a **Tally companies** table (entity, company, ledger start, masters / vouchers AlterID). The Tally reconciliation page names the entity of each import when there are several. |

Untouched on purpose: `acc_tally_bridge_candidates`, `_capture`, `acc_post_from_source` (22K's definition), the posting
engine, pairing, the sync log (not per entity: rows carry the REMOTEID or GUID), `fin_ref_finance_settings.tally_company_name`
(the one-way `/finance/tally` export keeps its own single name).

## 3. Limits you should know (nothing here is hidden)

1. **Shared chart of accounts.** Several companies work when their ledger names agree with Pulse's one chart. A ledger
   in company B that has the name of an account already linked to company A's GUID is matched by name; its masters link
   is refused with `link_changed` in the sync log (once per ledger and day), and pushes name the account's ledger by the
   name Tally last sent (`tally_name`, from the first company). If B names that ledger differently, Tally refuses the
   voucher and it shows as "Refused by Tally" with Tally's text. This follows from reading the code (`plan.ts`,
   `acc_tally_apply_masters`); **it was not exercised with two real charts**. A per-company ledger mapping is the next step
   if the real companies differ.
2. **The 22D engine posts the default entity only.** A second bridged company carries sales documents, receipts, bank
   items and depreciation runs (22E/22F/22H) and what is pulled from Tally; Unite revenue, supplier invoices and vouchers
   stay with the default entity. The posting preview (`/accounting/posting-preview`) is likewise default-entity.
3. **One connector per organisation.** It serves every company loaded in the Tally on its PC. Companies on **different
   PCs** are not supported (a second pairing revokes the first). Whether TallyPrime keeps several companies loaded at
   once on the clinic's edition is unverified (question 1 and 2 below).
4. **Hosted Tally** (HTTPS to a partner's server) does not exist; see section 1.
5. **Pilot to live.** An entity's company cannot be changed once data was exchanged (the AlterID cursors, the REMOTEIDs
   and the mirrored journals belong to that company). A pilot on a test company therefore belongs in a **separate
   workspace** or a separate entity that is deactivated afterwards; moving the live entity from a test company to the real
   one needs a decision (a reset action is not built). The integration's own company setting, which the default entity
   falls back to, is **not** guarded; do not rename it once the bridge has run.
6. **Nothing was tried against a real TallyPrime**, as in 22J. Multi-company behaviour in Tally itself (`SVCURRENTCOMPANY`
   with several loaded companies, per-company AlterID) follows Tally's documentation and community reports.

## 4. How it was verified (all run here)

- Unit: `tests/unit/accounting/tally/companies.test.ts` (16: the company rule on 8 scenarios, the import routing on 6,
  blank / case handling); `connector.test.ts` +2 (two companies served in one run with each request naming its own
  company and AlterID; a voucher naming another company than its job is refused, with an XML-escaped name still
  matching). The existing 19 + 8 + 6 bridge unit tests and the other accounting unit tests pass unchanged.
- Database (`tests/db/accounting-tally-companies.test.ts`, 13, Postgres 16): `app.acc_tally_company` agrees with
  `companies.ts` on every shared scenario; uniqueness per org (any case), the same name allowed in another org, never
  blank; vouchers and jobs keep the item's entity and the claim hands out each entity's company; an entity without a
  company waits and goes once it has one; an item naming another org's entity (or none) is refused and a row cannot be
  pointed at it; the ledger start stops one entity while the other keeps pushing, a retry is refused for it, the whole org
  stops only when none is left, and with no company anywhere; masters / vouchers / trial-balance jobs per bridged entity,
  none for an entity without a company, one open export each, cursors per entity and the next pull from its own cursor,
  an entity that loses its company has its exports cancelled; a pulled voucher lands in the second entity, links the voucher
  it pushed and moves only that entity's cursor; the daily trial-balance check compares that entity's books (and the default
  entity's, not equal); a file import's reconciliation compares the import's own entity; the company-change guard;
  RLS: another organisation sees none of the entities, companies, vouchers, jobs or cursors, and nobody writes directly.
- Existing: `tests/db/accounting-tally-bridge.test.ts` (19), `accounting-tally.test.ts` (16) and the rest of
  `tests/db/accounting*` pass; `tests/db/security-guard.test.ts` passes except `fin_appt_rows is in SERVICE_ONLY but does
  not exist`, which is W2's table (its migration was not in this database; not mine). `tests/db/helpers.ts`
  `seedPhase22JRows` now sets the entity on the three seeded rows.
- `pnpm typecheck` clean, eslint clean on the touched files, `pnpm audit:security` 0 unguarded. `lib/supabase/types.ts` was
  edited by hand (the new columns on `acc_entities`, `acc_tally_push`, `acc_tally_jobs`, `acc_tally_cursors`); regenerate
  it after the merge.
- Paste file for the SQL editor (`deploy/supabase-paste/`) was **not** created; add it with the other migrations.

## 5. Tally partner call checklist

What Pulse needs from each answer, and where it goes. Steps already written are in `docs/22_PHASE_22J_NOTES.md`
("Setting it up at the clinic", steps 1-9) and `connector/tally-bridge/README.md`; this table only links to them.

| # | Question to ask | What Pulse needs from the answer | Where it goes / what it decides |
|---|---|---|---|
| 1 | TallyPrime release and edition (Silver or Gold)? Is TallyPrime Server used? | Release (menu names, XML server availability, whether several companies can be **loaded at the same time**, Edit Log / Authorisation / e-invoicing support by release). Server edition runs as a service. | Answers **OQ-123**; README step 1 (menu path by release); decides limit 3 above. No Pulse setting. |
| 2 | Which PC hosts each company? Is it on during working hours? Can a Windows service be installed? | Whether **all** Al Das companies sit in one Tally on **one** PC (one connector serves them) or on several PCs (not supported today: needs a design change before the pilot). On during working hours, Windows service allowed (NSSM, 22J README step 3) or run-at-logon fallback. If the partner **hosts** Tally remotely: whether the connector may be installed on that server, else there is no way in today. | Accounting, Setup, Tally bridge: *Create a pairing code*, then `node bridge.mjs pair` on that PC (22J step 4-6); `--port` if not 9000. OQ-123. |
| 3 | How many companies, their exact names, which belong to Al Das? | The exact spelling of every Al Das company (a non-Al Das company is simply never entered). One Pulse **entity** per Al Das company, each with legal name, TRN, fiscal year, branch mapping and, at cut-over, ledger start. Which one is the default. A test company's name for the pilot. | Settings, Integrations, Tally bridge: *Tally company name* (the default entity's). Accounting, Setup, **Entities and fiscal years**: each entity's *Tally company*; branches mapped to entities there. Decide the pilot's home first (limit 5). |
| 4 | Can the XML server (port 9000) be enabled on that PC only, with the firewall blocking other machines? | Yes/no and who does it; the port if not 9000; that the connector's PC and Tally's PC are the same machine. | 22J README steps 1-2 (inbound block rule); `--port` at pairing. No Pulse setting. |
| 5 | Is Transaction Authorisation or Edit Log in use? Will pushed vouchers wait for authorisation? | Whether the Pulse voucher types (Pulse Payment etc.) can be created without authorisation, or Tally should treat pushed vouchers as authorised; whether Edit Log changes how an AlterID moves on a pushed voucher. Approvals must not be duplicated (**OQ-90**; owner direction 13 Oct: approvals live in Pulse). | Tally bridge settings: which **sources** are pushed (leave payment vouchers and supplier invoices unticked while approval stays in Tally); `approval_mode` (`pulse` or `tally`) under Finance workflow settings (20D). OQ-90. |
| 6 | Does TallyPrime support UAE e-invoicing (PINT AE through an accredited provider)? From which release, at what cost, for which companies? | Yes/no, the release, the price, the companies it applies to, and whether Tally or Unite/Pulse issues the insurer / corporate invoices. | **OQ-122** (deadlines in `docs/22_PHASE_22E_NOTES.md`: ASP by 30 Oct 2026 if revenue is AED 50m or more, else 31 Mar 2027, live 1 Jul 2027). Nothing is built in Pulse (only `einvoice_status`); gate criterion 3. |
| 7 | Backups and the support contract? | Who backs up each company and how often; that a **copy of the books** can be made for the pilot; a support contact for XML / connectivity problems; keep Tally's backup and full XML export for 7 years (22I notes). | No Pulse setting. Pilot company: restore the copy as the test company (name it clearly different). |

## 6. January 2027 gate: the five written criteria and their evidence

Proposed cut-over: **1 July 2027** (start of FY 2027-28; OQ-117). **The `ledger_start_date` of each entity is the
switch** (Accounting, Setup, Entities and fiscal years, typed `START`); nothing was set here. If two companies cut over
the same day, set both entities. Pushing then stops for that entity by itself; pulling continues until it is switched
off (22J notes, step 9).

| # | Criterion | Evidence Pulse produces | Gap |
|---|---|---|---|
| 1 | Three month-ends where Pulse's would-be journals agree with Tally's trial balance to the fils, differences explained. | **Posting preview** (`/accounting/posting-preview`, 22D): per account and month, Pulse's would-be journals against the ledger (the Tally mirror before the ledger start) and the difference, differences only by default. **Tally reconciliation** (`/accounting/tally-reconciliation`, 22I): Pulse's trial balance against a Tally trial balance exported to Excel / CSV, ledger by ledger, "Reconciled" at zero differences. **Tally bridge** (`/accounting/tally-bridge`): the daily trial-balance check (Tally's closing balances against the mirror) with the differing ledgers listed. The chain is would-be vs mirror (preview), mirror vs Tally (reconciliation / daily check). | No screen **records an explanation** of a ledger difference: the differing ledgers are listed, the reason is written outside Pulse (W4's *Parallel run*, `/finance/parallel-run`, holds explanations only for the five finance areas, not for ledgers). The preview covers the **default entity only** (limit 2). Nothing runs against a real Tally yet. |
| 2 | Unite feed or invoice-line upload and bank files flowing without manual fixes. | **Finance data health** (`/finance/health`): Unite capture batches (received / processed / failed), freshness and alerts. **Uploads** (`/finance/upload`) for report files, and the W1 loader for the saved Unite export (`pnpm finance:load-export`, `docs/47_W1_LOAD_EXPORT_NOTES.md`; no screen); **Bank reconciliation** (`/finance/bank`) for the bank files and their matching; **Exceptions** (`/finance/exceptions`); **Waiting to post** (`/accounting/waiting`): items that could not post, by reason; the bridge's own list of vouchers Tally refused. "Without manual fixes" reads as: no failed batches, no growing exception or waiting lists, over three months. | No single "fixes done by hand" counter exists: the evidence is these lists staying empty or small, month by month. |
| 3 | Tally's e-invoicing answer. | **None.** It is the Tally partner's written answer (question 6), recorded against OQ-122 (`docs/audit/open-questions.md`, `docs/TODO_FOR_AL_DAS.md`). | No screen. Pulse has only the `einvoice_status` column (22E notes); the PINT AE data shape and a provider integration are not built. |
| 4 | Auditor and tax adviser accept Pulse's reports and VAT figures. | **Trial balance** (`/accounting/trial-balance`), **Profit and loss**, **Balance sheet**, **Cash flow** (`/accounting/reports/...`), **Day book**, **General ledger**, **VAT return** (`/accounting/reports/vat-return`, with its missing-tax-code list under **Ledger exceptions**), **Corporate tax bridge**, each with Excel / PDF. Before the ledger start they read the Tally mirror (22G), so they show Tally's own numbers; Pulse's own would-be figures are in the posting preview. | No screen records the auditor's or tax adviser's acceptance. Whether the VAT boxes fill from a Tally-mirrored month (the mirror's lines carry the tax codes Tally gave them) was **not checked here**; ask the tax adviser to review the VAT return on a preview-covered month. |
| 5 | Accounts (Althaf) and Hardik confident. | Closest records: **Parallel run** (`/finance/parallel-run`, W4, built by another stream): per area, the manual figure beside Pulse's, the difference, the explanation and the recorded decision to rely on Pulse (Finance Manager only); **Month-end close** (`/finance/close`): the finance sign-off and the CEO sign-off per month, bound to the snapshot. | "Confident" is a human judgement; no screen records it as such. The parallel-run decision covers the five finance areas, not the accounting ledger. |

## 7. Open decisions this raises

- Which Tally companies become Pulse entities, and whether the test company for the pilot gets its own workspace (limit 5).
- Whether all companies share one chart of accounts (limit 1); if not, a per-company ledger mapping is needed before the
  second company is bridged.
- Companies on separate PCs or a partner-hosted Tally (limits 3 and 4): a design change, not a setting.
