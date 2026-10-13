# Phase 20 and 21: finance control, reconciliation and the end of Make and Airtable

_Written 13 Oct 2026. Sources: the two finance meeting transcripts (Otter: "Financial Automation and Systems Integration" and "Financial Reconciliation and Automation Meeting") and their summaries (Saeed, Hardik, Krishna, Althaf, Mohammed Sharafadin, Vineetha, Abdul; "Irfan" / "Shaveez" in the transcripts is Saveez, who builds Pulse), the deck "The next stage of financial & management control" (September 2026), the CEO directive "Zero Paper. Full Accountability: TallyPrime digital payment approval workflow" (July 2026), five report screenshots (daily financial summary, doctor summaries, monthly revenue summary, daily sales summary for October 2026), and a code survey of `main` at `13aa60b`._

This document is the plan. Each slice below is built one at a time, starts with a short plan in its notes file, and finishes with typecheck, lint, tests, the security audit and its own notes (`docs/2x_PHASE_20x_NOTES.md`). The live status of each slice is in section 7.

---

## 1. What the clinic asked for

**The principle (deck, slides 2 to 5).** Every important transaction carries six things: source, owner, authority, deadline, reconciliation, audit trail. Each system has one purpose: **Unite** (patient activity, invoices, revenue), **Diligence** (insurance reconciliation), **approved schedules** (doctor revenue shares, employee incentives), **Tally** (accounting record), **Finance Pack** (monthly close output), **Management / Board** (one reliable picture). No parallel spreadsheets unless they reconcile back to an authoritative source.

**Owners (slide 6).** Hardik (Finance Manager: close, reviews, Tally treatment), Krishna Kumar (revenue, collections, receivables, Unite reconciliation), Althaf (costs, suppliers, payables, accruals, Tally entries), Mohammed Sharafadin (Diligence reconciliation, outstanding items), Vineetha (Diligence backup, ARP reporting), Abdul Azham (Unite invoices, discounts, cancellations, refunds), Merry Saquillo (HR commitments). Hardik consolidates; he does not originate.

**Trail for revenue shares and incentives (slide 7).** Source data, approved formula, exclusions and adjustments, calculation, finance verification, approval, accounting, payment, payment reference. Fully reconstructable.

**Maker, checker, approver beyond payments (slide 8).** For each material process: who initiates, who checks, who approves, which system records it, what evidence supports it, who reconciles it. Applies to Unite invoice changes (create, amend, discount, cancel, refund, credit) and HR commitments.

**Close timetable (slide 9).** Working day 5: principal reconciliations and departmental inputs. WD7: revenue shares and incentives, Tally close. WD8: draft management accounts. WD10: final Board pack.

**Board pack (slide 10).** P&L, balance sheet, cash and bank, receivables and ageing, payables, insurance position, doctor revenue-share liabilities, employee incentive liabilities, material variances, unusual transactions, unresolved reconciliations, matters needing attention.

**Measures (slide 11).** Close by WD10; inputs by WD5 (100%); open reconciling items falling, none over 60 days; zero unapproved invoice changes; 100% calculation trail; 100% critical processes with a trained backup.

**Zero paper (CEO directive).** Maker (Krishna / Althaf) creates, checker (Hardik) verifies, approver (CEO) authorises; delegation of authority:

| Tier | Amount (AED) | Examples | Approval |
|---|---|---|---|
| 1 | up to 5,000 | consumables, utilities, petrol / Salik, minor supplies | Finance Manager; no CEO |
| 2 | 5,001 to 15,000 | marketing, IT maintenance, training, minor equipment | Finance Manager + department head; no CEO |
| 3 | 15,001 to 50,000 | insurance premiums, revenue sharing, major vendor contracts | Finance Manager verifies, CEO authorises |
| 4 | over 50,000 | capital items, large contracts | Finance Manager verifies + CEO authorises |
| Special | any amount | payroll, intercompany transfers, related-party transactions | CEO always |

Rejections carry mandatory remarks; bulk authorisation for routine items; every action logged with name, time and remarks; supporting documents stored digitally and linked to the voucher, never printed; digital signature certificates (DSC) for the CEO and Finance Manager; status reports (pending, approved, rejected, average approval time) and exception reports (unusual transactions, budget overruns, rejections).

**Meeting asks (Irfan sessions).** Four-stage pipeline: source data, raw-data structure, processing and reconciliation, final destination. Inputs by e-mail and manual file drop; match scores; human verification of exceptions; approval; transfer to Tally through an API. Reconcile: Unite revenue against bank receipts by payment method (card and EPG settle T+2, Tabby T+6, cash, insurance receipts; also "rePG" and "MX"); in-house lab tests under the fixed monthly arrangement (AED 25,000) and external send-out lab invoices against activity / CPT codes, with turnaround flags; external referrals (hospitals, radiology); lab and referral expenses allocated to branch and doctor before revenue share. Supplier invoices (under 100 a month) arrive by e-mail or on paper. Insurance has no usable Diligence API: reports are uploaded (remittance activity, remittance received, approvals, resubmissions, corrections), and insurance follow-up runs at 60, 90 and 120 days. Manual burdens to remove: doctor incentives, branch P&L, revenue reconciliation, insurance submissions and resubmissions, ARP reporting, payment follow-up.

**AI (Saveez).** Claude reviews each reconciliation, proposes matches with reasons and a score, writes the reconciliation report, and a person approves.

**Make and Airtable.** Everything they do today moves into Pulse; both are switched off afterwards.

### 1.1 What the transcripts add (details the summaries leave out)

| Topic | What was said | Consequence for Pulse |
|---|---|---|
| Unite finance API | Each record is delivered once, but Unite **can re-queue records on request, including a full backup from January**. Saeed: "we're just going to save everything" | The guarded capture (F2) is the intended revenue source; ask Unite for a January backfill when it is switched on (OQ-94) |
| Daily reception reconciliation (Abdul) | Each day: card machine (POS) total against Unite's card collection, cash against Unite's cash collection report, insurance credit total against the day's insurance invoices | Cash-up (Phase 18) already does counted vs Unite by payment mode; add the POS terminal batch total as an input (20C) |
| Finance bank reconciliation (Hardik) | Card and EPG settle T+2, Tabby T+6 working days; month-end cut-off is the 30th; everything Unite shows as revenue must be found in the bank; what has not arrived is aged with a reason | 20C settlement rules in working days, cut-off setting, ageing of unreceived items with a reason code |
| Insurance receipts (Mohammed, Saeed) | Insurers pay in bulk; the only proof is the bank statement, matched monthly against "remittance received" | 20C matches bank credits to remittance batches (`ins_remittance_batches`) |
| Insurance changes (Mohammed) | Values change with every resubmission; a resubmission in "correction" mode sends the whole amount back to the RA, including what was paid | Claim history must be sequence-aware (first, second, third submission); 20I builds the sequence view from Diligence uploads |
| Insurance close (Hardik) | All submissions and resubmissions for a month are done by the 5th | WD5 dependency in the close timetable (20G) |
| Diligence into Unite (Saeed) | Saeed would like Diligence figures to appear in Unite so Unite shows the whole financial picture; Mohammed does not trust Unite's insurance module; Hardik says Sharaf is working with Unite on it | Pulse must not write to Unite (CLAUDE.md rule 7). Pulse already holds Unite revenue and Diligence claims side by side; the combined view lives in Pulse (OQ-100) |
| Accounting | All accounting is in Tally; Unite has no accounting module; Zoho Books is integrated with Unite but only for invoices (judged too weak). Tally is not connected to the bank and "not set up properly yet" | Tally stays; 20D includes a Tally set-up checklist (ledgers, cost centres, authorisation) |
| Supplier invoices (Hardik) | Fewer than 100 a month; most arrive by e-mail to a **dedicated accounts mailbox**, some come with the goods to one of the three branches and are carried to the central office | 20B: forward or connect the accounts mailbox; a phone photo upload for paper invoices |
| Althaf's pain | Report structure; payment modes card, rePG, Tabby, MX reconciled **weekly**; Unite data re-keyed into Tally | 20C payment-mode rules; 20D Tally XML replaces re-keying |
| Krishna's pain | Downloads the Unite revenue data, prepares the reports, reconciles the figures with reception | 20A flash report (done) and 20C daily reconciliation |
| Hardik's pain | 1: doctor incentives (each doctor's offer is designed uniquely); 2: branch-level P&L; also cash-flow projections | 20F formula per doctor contract; 20G branch P&L and a cash-flow projection |
| Mohammed's pain | Submissions, resubmissions, approvals all manual with a person on each claim; follow-up at 60, 90 and 120 days; final reconciliation | 20I |
| Vineetha's pain | The ARP report is completely manual; supports Mohammed's requests | 20I once ARP is defined (OQ-95) |
| Labs (Hardik, Mohammed, Abdul) | Biggest expense. In-house lab: AED 25,000 a month, unlimited investigations. Send-out lab: separate invoice. Reports arrive monthly, branch-wise, by the 7th or 8th. **Each test is matched (patient, day, doctor) against what Unite billed before the cost is charged to that doctor's account** and before revenue share | 20E: per-test matching both ways (lab did it but Unite did not bill it = revenue leakage; Unite billed it but the lab has no record); cost charged to the doctor feeds 20F |
| Lab turnaround (Saeed) | Wants a "barometer of service": the expected turnaround per test, with late results flagged | 20E turnaround table per test and an overdue list (needs result dates; Unite activity or the lab report) |
| Third parties (Saeed, Abdul) | Hospitals (deliveries at another hospital, King's Hospital) and radiology (one in Jumeirah). These reports have no connection with Unite today. Unite has internal referrals and an unused external-referral feature that Unite has not finished explaining | 20E referral providers and invoices; follow up with Unite (Saeed's escalation e-mail) |
| Unite branch separation | Unite will release separate billing codes ("PM" for Palm, Meadows and Shoreline) on **10 Nov**; Saveez to send Saeed a technical note that it should take days, not a month | The branch codes on invoices change from that date: update the flash reporting lines and `fin_ref_branches` the same day (checklist item in the 20A notes) |
| Analysis Saeed wants | Doctor trends, seasonality, each doctor's billing characteristics (consultation vs lab vs radiology, cash vs insurance) | A later analytics slice on `fin_invoice_lines` and service categories (20K) |
| Service standards | Doctors are asked to define the service and standard of each department and agree price ranges | Not a Pulse feature; price lists can later live in `fin_ref_services` |
| Irfan's four steps | Source; raw data; processing; final look and destination. Learn from the team how they decide a match is 100% vs 90% and when they call it verified | Each slice starts from one raw sample and one reconciled sample per report (section 6) and records the team's match rules as tests |

## 2. What Pulse already has (do not rebuild)

| Area | Built | Where |
|---|---|---|
| Unite invoice capture (deliver-once, guarded, OFF) | Raw batch store, idempotent processing, versions, lines, payments | F2, `lib/finance/capture.ts`, `process-batch.ts`, `fin_invoices*`, `fin_payments` |
| Diligence uploads | Parse, sanitise, stage, match to invoices, commit | F4, `/finance/upload`, `parse-diligence.ts`, `match-claims.ts` |
| Exceptions | E01 to E14, daily, thresholds in SQL | `fin_run_exception_rules`, `/finance/exceptions` |
| Insurance workflow | Pre-auth, eligibility, denials and appeal drafts, remittance matching, payer scorecards, forecast, insurance overview | Phase 18 and F9 |
| Cash-up | Per branch and day, counted vs Unite by payment mode, variance reasons | `/finance/cashup`, `cashup.ts` |
| Month-end close | Snapshot pack (XLSX, PDF), two signatures bound to the sha256, database lock | `/finance/close`, `close-*.ts` |
| Revenue views | By doctor, department, branch, service, category, month; branches and doctors pages; profitability (provisional) | `/finance/revenue`, `/branches`, `/doctors`, `/profitability` |
| Accounting export | One-way journal CSV (sales, receipts, refunds by day and branch), account map, refuses when unmapped | `/finance/export`, `accounting-export.ts` |
| Costs | Service unit costs, overheads, doctor compensation (CSV) | F8, `/finance/costs` |
| Make replacements | Unite token, appointment reminders, birthday, chronic update built; chronic recall and acute MRD sync partial (section 5) | Phases 6 to 8 |
| Airtable replacement | Importer for all five bases, portal objects, Follow-Up Queue, clinical settings | Phases 6 and 9 |

## 3. Gaps this plan closes

1. **No intake**: no inbound e-mail at all; uploads exist only for Diligence, remittance and cost CSVs; no bank statements.
2. **No bank or settlement reconciliation**: nothing knows T+2 / T+6, fees, deposits or insurance receipts.
3. **No lab or referral reconciliation**, no turnaround tracking, no cost allocation to doctor.
4. **No payables**: no suppliers, supplier invoices, payment vouchers, delegation of authority, approval chain or document attachment.
5. **No Tally link**: the CSV export is generic; no TallyPrime XML, ledgers or vouchers.
6. **No revenue share or incentive engine** with a trail.
7. **No targets** and no daily flash report (the five screenshots are built by hand today).
8. **Close** has no working-day timetable, no P&L / balance sheet / payables / liabilities in the pack and no close KPIs.
9. **AI** in finance is limited to appeal-letter drafts.
10. **Insurance ageing** stops at 90+; no 60 / 90 / 120 follow-up; ARP report undefined.
11. **Make / Airtable**: chronic recall selects nobody (no writer for `contact_chronic_conditions`), no Unite visits sync, antibiotic sequence not wired, two undocumented Airtable automations ("Lab Result Ready", "Lab Follow Up"), three message-log importers pending, data-quality screens missing, nothing parallel-run.

## 4. Target design

### 4.1 One pipeline for every source

```
 SOURCE                 RAW (service only)            PROCESS + RECONCILE                 DESTINATION
 e-mail inbox  ─┐                                     parser per document type            fin_* tables
 manual drop   ─┼─► fin_intake_documents ─► staged ─► (mapping file per format) ─► match ─► review queue ─► approve ─► Tally XML / pack
 Unite API     ─┤    sha256, type, status     rows     pure matchers, scores 0-100        AI explanation             (one-way, audited)
 Diligence     ─┘    original deleted or kept                                              person decides
                     per document policy
```

- **Intake** (`fin_intake_documents`): every file, whichever way it came in, gets one row: source (e-mail, upload, API), detected type, sha256 (duplicate refused), status (received, parsed, staged, committed, rejected), owner and deadline. Inbound e-mail arrives through the Phase 19 webhook helper (`receiveIntegrationWebhook`, a new `finance_mailbox` integration): the provider posts the message, Pulse keeps attachments from allow-listed senders only, drops the body, and files each attachment as an intake document. Manual drop is a single page that accepts any supported type and routes it.
- **Retention follows the document**: patient-identifying files (Diligence, remittance, lab reports with names) are parsed and deleted at once, as today. Supplier invoices and bank statements contain no patient data and are kept, because they are the evidence the CEO directive asks for (private bucket `finance-documents`, signed links, `recordAccess`).
- **Mapping files**: column names for each external format live only in one `lib/finance/*-mapping.ts` per format (rule already used for Unite, Diligence and remittance). A file whose headers do not match is refused with the list of missing columns, never guessed.
- **Matchers are pure** (`lib/finance/match-*.ts`), deterministic, parity-tested against SQL fixtures, and give each candidate a score from 0 to 100 with the reasons (amount, date window, reference, method). Auto-accept only above a threshold set in `fin_ref_finance_settings`; ambiguous matches are never guessed.
- **AI reviews, people decide.** A reconciliation agent (Claude, `ANTHROPIC_MODEL`, behind the Phase 17 gates `openCopilot()` and `recordCalls()`) sees ids, amounts, dates, methods and references only, never names. It explains unmatched items, proposes candidate pairs from the deterministic shortlist (it cannot invent a pair), groups exceptions and drafts the reconciliation narrative. Its output is parsed and validated against a closed list; nothing it says is applied until a person accepts it.
- **Approval** uses the pattern already proven in the close sign-off: approvals are bound to the sha256 of what was approved, two different people where required, audited, and immutable after the month is locked.

### 4.2 Tally

TallyPrime runs on the clinic's own computer and speaks XML over HTTP (port 9000) on the local network; it is not reachable from Vercel. Plan:

1. **XML file first (no infrastructure):** Pulse produces a TallyPrime import file (`ENVELOPE / IMPORTDATA / TALLYMESSAGE / VOUCHER`) for approved items: sales and receipt journals (replaces the CSV for Tally users), payment vouchers, supplier purchase vouchers. Ledger names come from a mapping table (extends `fin_ref_account_map` with Tally ledger names, cost centres per branch and doctor). Althaf imports it (Gateway, Import, Transactions). Every export is checksummed and audited, as the CSV is today.
2. **Connector later (optional):** a small agent on the Tally computer polls Pulse's public API (read-only key) for approved, not-yet-posted vouchers, posts them to `localhost:9000`, and reports back the Tally voucher number. Pulse never opens a connection into the clinic.
3. **Authorisation in one place.** The CEO directive switches on Tally's own Transaction Authorisation. If Pulse also approves, the CEO would approve twice. **Decision needed (OQ-90):** either Pulse is the approval workflow (documents, delegation of authority, AI checks, signatures) and Tally receives vouchers already authorised; or Pulse only prepares and attaches evidence and Tally keeps the approval. Recommendation: approve in Pulse (phone-friendly, documents attached, rules enforced, measures reported), post to Tally as authorised, and keep Tally's authorisation for vouchers created directly in Tally.
4. **Digital signatures.** A DSC is a hardware token used on the signer's own computer; a web app cannot use it. Pulse records each approval cryptographically (sha256 of the voucher and every attachment, signer, time, remarks) and issues an approval certificate PDF. Where a DSC signature is legally required, the PDF is signed in Tally (Ctrl+E) or through the Phase 19b e-signature provider (OQ-91).

### 4.3 Data protection

All new tables follow the finance rules in `CLAUDE.md`: `fin_*` / `ins_*` / `ops_*` names, RLS on `org_id`, select-only policies for staff with `finance.*` permissions, writes through server actions after `can()` with `recordAudit`, raw tables service-only. Bank lines keep amount, date, reference and a redacted description (card numbers and account numbers masked by `lib/redact.ts` before storage). No patient name, Emirates ID or member id in any finance table; the Unite PIN only, and `patient_ref` in analytics. Supplier and bank documents are not health data but are confidential and use signed links and the access log.

## 5. Slices

Each slice is independently useful, ships behind its own permission and, where it can touch money or messages, its own OFF switch.

| Slice | Name | Delivers | Depends on |
|---|---|---|---|
| **20A** | Targets and flash reports | Reporting lines (Palm, Golden Mile, Meadows, Longevity, Chiro as a department, Dental leased unit), daily targets per line and month, **Daily financial summary**, **Month-to-date summary**, **Daily sales grid**, doctor rankings (core and Chiro), XLSX export in the clinic's layout, "flash ready" notification | `fin_invoices` (Unite capture or a Unite report upload) |
| **20B** | Finance intake | `fin_intake_documents`, private bucket, Finance inbox page (drop zone, history, duplicates refused), inbound e-mail through `finance_mailbox` (allow-listed senders, attachments only), routing to existing Diligence / remittance / cost parsers, Unite daily revenue report upload (if Unite capture stays OFF) | Sample files (section 6) |
| **20C** | Bank and settlement reconciliation | Bank accounts, statement upload (CSV / XLSX per bank mapping), settlement rules per payment mode (lag days, fee %, card / EPG T+2, Tabby T+6, rePG, MX, cash deposit), expected-vs-received matcher with scores, insurance receipts matched to remittance batches, review queue, reconciliation report and sign-off | 20B, bank and processor samples |
| **20D** | Payables and zero-paper approvals | Suppliers, supplier invoices (from intake, document kept), payment vouchers with maker, checker, approver; delegation-of-authority tiers and special categories in a settings table; mandatory rejection remarks; bulk approve for tier 1; approval certificate PDF; status and exception reports; TallyPrime XML export | 20B, OQ-90 / 91 |
| **20E** | Lab and referral reconciliation | Providers (in-house lab under fixed fee, send-out labs, hospitals, radiology) with contract terms, provider invoice upload, line matching to Unite activity by CPT / item code, PIN and date, turnaround expectations and overdue flags, cost allocation to branch and doctor | 20B, lab invoice and activity samples |
| **20F** | Revenue share and incentives | Schemes with versioned, approved formulas; exclusions (lab and referral costs from 20E, discounts, write-offs); monthly calculation run with the nine-step trail; verification and approval; liability in the pack; payment reference | 20E, current doctor contracts |
| **20G** | Close timetable and Board pack | Working-day calendar (UAE weekends and holidays), close checklist with owner, due day and dependency; inputs-on-time and open-item-age KPIs; pack extended with P&L, cash and bank, payables, liabilities, variances, unresolved reconciliations, matters needing attention | 20C, 20D, 20F |
| **20H** | Reconciliation agent | Claude reviews each reconciliation run (bank, lab, referral, insurance): explanations, proposed pairs from the shortlist, grouped exceptions, draft narrative; accept / reject per proposal; quality report (accepted vs rejected) | 20C, 20E |
| **20I** | Insurance follow-up | Ageing buckets 0-30 / 31-60 / 61-90 / 91-120 / 120+, follow-up tasks at 60, 90, 120 days, resubmission sequence view, ARP report (once defined, OQ-95) | none |
| **20K** | Doctor and seasonal analytics | Billing mix per doctor (consultation, lab, radiology, procedures; cash vs insurance), seasonality by week and month, trends against last year | Unite capture with history |
| **20J** | Invoice-change control and HR inputs | Authority matrix for Unite invoice changes (discount, cancel, refund, credit) and a daily "changes without approval" report from Unite versions; HR commitments register (joiners, leavers, package changes, visas, incentives) with cut-off | OQ-96 / 97 |
| **21** | Make and Airtable retirement | (1) Unite visits / diagnoses / prescriptions sync; (2) writer for `contact_chronic_conditions` so chronic recall selects patients; (3) antibiotic and probiotic sequence wiring; (4) the three Campaigns message-log importers (coordinate with PR #28); (5) Data quality, Unclassified medications and clinical feedback screens; (6) reminder stats and recall KPIs on the management dashboard; (7) lab orders and the two Airtable lab automations; (8) screening eligibility views; (9) parallel run, reconciliation and switch-off | Unite endpoints (OQ-23 / 26), Make export access |

Build order: 20A now; 20B to 20D as soon as the sample files arrive; 20I and 21 (items 2, 3, 5, 6, 8) can run in parallel because they need no new files.

**How the work is split between agents.** Each slice is built in its own branch by one build agent with a written brief (this section plus the slice notes). A second agent reviews the diff against `CLAUDE.md` (RLS, `can()`, audit, redaction, no PHI) before merge. Pure libraries and their tests can be built in parallel; migrations, permissions and navigation are edited by one agent at a time to avoid conflicts.

## 6. What we need from the clinic

Send anonymised or synthetic copies where a file contains patient details; headers and two or three rows are enough to build a parser.

| # | File | Used by | Owner |
|---|---|---|---|
| D1 | Unite daily revenue download (the one Krishna uses) and the month-end revenue report, cash vs insurance | 20A / 20B | Krishna |
| D2 | Reception daily collection sheet per branch | 20B / 20C | Krishna |
| D3 | Bank statement export for each account (CSV or XLSX), one month | 20C | Krishna / Hardik |
| D4 | Card / EPG settlement report, Tabby payout report, rePG and MX reports | 20C | Krishna |
| D5 | In-house lab monthly statement and one send-out lab invoice with test list | 20E | Althaf |
| D6 | One external referral invoice (hospital, radiology) | 20E | Althaf |
| D7 | Supplier invoice examples and the current payment voucher template | 20D | Althaf |
| D8 | Tally: ledger list (Chart of accounts export), cost centres, voucher types in use, TallyPrime version and whether it runs on a server | 20D / Tally | Althaf / Hardik |
| D9 | Diligence reports: remittance activity, remittance received, approvals, resubmissions, corrections | 20I, existing parsers | Mohammed / Vineetha |
| D10 | Doctor revenue-share and incentive calculation sheets with the contract rules | 20F | Hardik |
| D11 | Branch P&L template and the Board pack template | 20G | Hardik |
| D12 | The targets sheet (daily revenue and patient targets per branch, ARPP target) | 20A | Hardik / Saeed |
| D13 | ARP report example | 20I | Vineetha |
| D14 | The full finance meeting transcript | all | Saveez |

## 7. Status

| Slice | Status |
|---|---|
| 20A | Built on `claude/funny-clarke-6t7gee` (see `docs/20_PHASE_20A_NOTES.md`): flash report, targets and lines, comparison with the same days of last month, Excel export |
| 20I | Built (see `docs/20_PHASE_20I_NOTES.md`): Insurance follow-up worklist with 60 / 90 / 120-day stages and a follow-up record per claim, daily follow-up tasks (off until a start date), submission sequence per claim (reconstructed; exact once Diligence sends a submission-level report, OQ-102), Receivables by payer and age with CSV (candidate ARP report, OQ-95), configurable ageing buckets |
| 20K | Built on `claude/funny-clarke-6t7gee` (see `docs/20_PHASE_20K_NOTES.md`): doctor billing mix (service categories, insurance vs self-pay, revenue per patient, difference from the clinic), seasonality by week or month against last year, CSV export |
| 20G | Close timetable and close measures built on `claude/funny-clarke-6t7gee` (see `docs/20_PHASE_20G_NOTES.md`): working-day calendar, checklist with owner, backup, due day and dependencies, daily tasks and reminders (off until a start month is set), inputs by WD5, close by WD10, open items, backups. Part 2, Board pack controls: a control summary frozen into the close pack and its sha256 (bank reconciliation status and unexplained credits per account, payables at month end by age and the voucher queue, revenue-share run and liability, unapproved invoice changes, insurance receivables over 90 days, timetable, exceptions) with matters needing attention derived from settings thresholds, on the page, in Excel and in the PDF; the P&L stays the provisional profitability view and the balance sheet comes from Tally; employee incentives are not in Pulse |
| 21, part 1 | Built (see `docs/21_PHASE_21A_NOTES.md`): item 2 (`visit_diagnoses` and a signed-off rule that derives `contact_chronic_conditions`, plus the Airtable import of visit diagnoses and Unite's chronic list; chronic recall now selects patients once OQ-01 and OQ-104 are signed), item 3 (antibiotic / probiotic sequences created once and scheduled in `scheduled_jobs`; nothing is sent while the clinical messaging gate is off), item 5 (Data quality, Unclassified medications with an audited classify action, Clinical feedback), item 6 (Appointment reminders, Recall performance and Clinical operations reports, and the same KPIs on the Management dashboard and digest). Parallel-run seed rows corrected. Two Airtable lab automations ("Lab Result Ready", "Lab Follow Up") stay with item 7 (OQ-98) |
| 21, remaining | Item 1 (Unite visits sync: needs the endpoint, OQ-23 / OQ-26), item 4 (message-log importers), item 7 (labs, OQ-98), item 8 (screening eligibility views), item 9 (parallel run and switch-off) |
| 20D | Built (see `docs/20_PHASE_20D_NOTES.md`): suppliers, supplier invoices with their documents (private `finance-documents` bucket, sha256, access log), payment vouchers with maker / Finance Manager / department head / CEO by the delegation-of-authority tiers and special categories, approvals bound to the content sha256, mandatory rejection remarks, Tier 1 bulk verification, month lock, approval certificate PDF, status and exception report, TallyPrime XML export (unverified against a real Tally, OQ-92), approval mode setting (OQ-90, default Pulse) |
| 20C | Built on `claude/funny-clarke-6t7gee` (see `docs/20_PHASE_20C_NOTES.md`): generic statement import (column mapping per file layout), bank accounts, settlement rules per payment mode (working-day lags, fees), expected-vs-received matching with scores, insurance receipts against remittance batches, ageing with reasons, review and two-person sign-off. Waiting for bank and processor samples (D3, D4) to map the layouts |
| 20J part 1 | Built (see `docs/20_PHASE_20J_NOTES.md`): Invoice changes register (discounts, cancellations, credit notes, write-offs, reduced amounts and refunds derived from the Unite deliveries Pulse already stores), review per change by Operations or Finance (approved, not approved, explained) with a reason, bulk approval up to a limit, unapproved-changes measure from a start date, CSV; thresholds are settings until the authority matrix is agreed (OQ-96) |
| 20F | Built (see `docs/20_PHASE_20F_NOTES.md`): doctor charges (lab, referral, consumables, other; typed in or CSV), versioned schemes with a closed rule (share of net revenue, category rates, threshold pro rata, deductions per charge kind, minimum guarantee) approved by two people on the rule's sha256, monthly runs with the nine-step trail (snapshot bound to its sha256, Finance verification, CEO approval by a different person, accounting reference, payment and reference per doctor), liability, trail CSV. Lab and referral costs are entered by Finance until 20E feeds them; the vocabulary awaits one real contract per scheme type (D10, OQ-115) |
| 20B | Built (see `docs/20_PHASE_20B_NOTES.md`): Finance inbox (`/finance/inbox`, `finance.inbox.manage`) with a multi-file drop zone, labels, "Make a supplier invoice" and discard; the `finance_mailbox` integration (Postmark inbound webhook, OFF by default, typed confirmation) keeps attachments (PDF, JPEG, PNG, CSV, Excel, judged by content) from allow-listed senders as `fin_documents` (sender domain only, sha256 duplicates skipped, scan hook). Reuses 20D's `fin_documents` instead of a separate intake table; no routing to the patient-report parsers (they keep their own pages); the Unite daily revenue upload was not built |
| 20E, 20H | In progress |

## 8. Things noticed in the current reports

- The monthly sheet is titled "MONTHLY REVENUE SUMMARY - SEPTEMBER- 2026 As on 12-10-2026" but holds October 1 to 12 figures; the doctor sheet repeats "SEPTEMBER".
- Daily sales grid, 1 Oct: the branch columns add up to 45,721, the TOTAL column says 45,652 (69 less). Palm's month-to-date on the monthly sheet (228,852) is 68 below the sum of Palm's daily column (228,920), which suggests one figure was corrected in one sheet but not the other. Four other days differ by 1 (rounding).
- The doctor table (all branches, excl. Chiro) totals 526,499 and 669 patients against 543,684 and 693 on the branch table: some revenue has no doctor or a doctor missing from the list.
- "% of Total" uses the total excluding Chiro for the daily doctor table but the total including Chiro for the monthly one and for Chiro rows.
- The month-to-date target equals the daily target times calendar days elapsed (for example Palm 32,593 x 12 = 391,116); patient target 78.25 a day.
- September grid (1 to 12 Sep): column totals differ from the rows by 1 or 2 in three places (Palm 201,861 vs 201,862; Longevity 46,805 vs 46,803; two daily totals off by 1), which is rounding in hand-copied cells.

Pulse computes all of these from one set of rules, so the sheets cannot disagree with each other.
