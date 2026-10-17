# Plan after the 16 October 2026 finance, insurance and accounting meeting

Source: the meeting summary (Otter transcript, 16 Oct 2026). Counts and decisions only; no patient data.

## 1. What the meeting agreed

- **One hub, no big bang.** Pulse brings Unite (appointments, invoices, payments), Diligence and e-claims, card and cash settlements and bank deposits together. **Existing manual processes stay** until Pulse has been tested in parallel against historical and current months and the users are confident.
- **Files first.** Data arrives by upload at the start; bank and Diligence integrations are limited.
- **Unite invoice detail is enough.** Hardik confirmed the Unite finance fields (patient and invoice identifiers, dates, clinic, doctor, **appointment ID**, line items, CPT codes, quantities, discounts, VAT, payments, advances, refunds, references) capture nearly all invoice information.
- **Appointments ↔ invoices** are matched so the patient journey connects to revenue, room use, doctor schedules and operational reporting.
- **Insurance chain clarified.** Eligibility and the first claim submission happen in **Unite and the government e-claim portal**; **Diligence downloads the submission XML and the remittance advice** and is used for tracking and reconciliation. Bank receipts must be matched to insurer payments, including partial payments, resubmissions, late remittances, duplicate amounts and payments whose amount or reference matches more than one claim.
- **Insurance needs case-by-case sessions** (Mohammed, Vineetha, Hardik, Irfan) before rules are fixed.
- **Accounting: no decision.** TallyPrime (desktop) runs **several companies**. Its API and e-invoicing capability are to be confirmed. UAE e-invoicing was raised for 31 Mar 2027 (provider appointment); Hardik noted it does not apply yet. Keep Tally or replace it with a custom tool is open (familiarity, history, accounting needs, integrations, change management, paperless).
- **Room-level revenue and cost formulas** and doctor contract revenue-share rules to be mapped into one model with Hardik.

Action items: introduce Irfan to the Tally partner (API details); map room formulas and contract rules with Hardik; run the insurance reconciliation in parallel (sandbox) for an agreed test period; case-by-case insurance sessions; circulate the notes (Saeed).

## 2. Tally: integrate or replicate in Pulse?

Both paths already exist in Pulse, so this is a choice of **which system is the book of record, and when**, not of what to build:

- **Integrate (built, off):** the Tally bridge (22J, `docs/22_PHASE_22J_NOTES.md`). A small connector on the Tally PC talks to TallyPrime on that PC only and pushes Pulse's approved items as Tally vouchers, and pulls Tally changes back every 15 minutes. One-way export files also exist (`/finance/tally`).
- **Replicate (built, not started):** the Pulse ledger (22A–22K): chart of accounts with Tally's groups, all voucher types, receivables, payables, banking, fixed assets, statements, budgets, VAT 201 figures, period locks, full Tally history import with a trial-balance check.

| Consideration | Keep Tally + bridge | Pulse as the books |
|---|---|---|
| Familiarity, change management | No change for Accounts | Training; new screens |
| Historical data | Stays in Tally | Imported (built), Tally kept read-only |
| Several Tally companies | Native in Tally | Pulse has entities; each company needs its own setup |
| Paperless approvals and audit trail | Approvals in Pulse, books in Tally (two places) | One place, documents attached to the journal |
| Branch, doctor and room P&L | Needs cost centres coded in Tally | Straight from the source dimensions |
| Real-time figures | Every 15 minutes, while the Tally PC is on | Real time |
| UAE e-invoicing | Depends on Tally's own UAE e-invoicing support (to confirm with the partner) | Pulse must integrate an accredited provider (not built) |
| Dependency | The Tally PC and connector must run | Pulse becomes business-critical (backups, access, fallback) |
| Effort now | Partner call, connector install, ledger mapping | Data feeds on, VAT codes, parallel months, auditor sign-off |

**Recommendation: integrate now, decide replacement at a gate.** Keep Tally as the book of record and use the bridge during the parallel run (the run needs it either way). Decide replacement at **a gate at the end of January 2027**, against written criteria:

1. Three month-ends where Pulse's would-be journals agree with Tally's trial balance (to the fils, differences explained).
2. The Unite feed (or the invoice-line upload) and bank files flowing without manual fixes.
3. Tally's e-invoicing answer: if Tally covers UAE e-invoicing for Al Das and the other companies, staying is cheaper; if not, the provider integration is needed anyway, which favours Pulse.
4. The auditor and the tax adviser accept Pulse's reports and VAT figures.
5. Accounts (Althaf) and Hardik are confident.

If the gate passes, cut over at **1 July 2027** (fiscal year start, aligned with e-invoicing go-live below AED 50m); otherwise keep Tally and the bridge permanently.

**Questions for the Tally partner call** (TallyPrime has no cloud API key; integration is Tally's XML server on the Tally PC itself):
1. TallyPrime release and edition (Silver or Gold), and is TallyPrime Server used?
2. Which PC hosts each company, and is it on during working hours? Can a Windows service be installed?
3. How many companies, their exact names, and which belong to Al Das?
4. Can the XML server (port 9000) be enabled on that PC only, with the firewall blocking other machines?
5. Is Transaction Authorisation or Edit Log in use (approvals must not be duplicated, OQ-90)?
6. UAE e-invoicing: does TallyPrime support it (PINT AE through an accredited provider), from which release, at what cost, and for which companies?
7. Backups and support contract: who restores Tally, how often is data backed up?

## 3. Build plan

| # | Workstream | What is built | What to build | Needs from the clinic | Done when |
|---|---|---|---|---|---|
| W1 | **Unite data by upload** | Unite finance mapping (`lib/finance/unite-mapping.ts`, every field above incl. appointment ID), invoice model, capture (off), collection report upload, `pnpm finance:replay` | **Update 17 Oct: the clinic already holds an export taken from the Unite Finance API.** That API is deliver-once, so those records will never reach Pulse's own capture: load the saved payload as a raw batch (`fin_raw_*`, stored first, then `fin_process_batch`, the same mapper and checks), never by calling Unite. Needs the file exactly as received (JSON, not re-typed into Excel), who pulled it and the date range | The saved export file; confirmation nobody else calls the API | A month of invoices loads and agrees to the collection report to the fils |
| W2 | **Appointments ↔ invoices** | Pulse diary, check-in, capacity page, Unite appointment sync (waiting for credentials) | An **appointment export upload** and matching by Unite appointment ID (then by patient, doctor and day): seen-not-billed, billed-not-seen, room and doctor utilisation | Unite appointment export (sample received for one day) | Utilisation per doctor and room for a month; review list of unmatched |
| W3 | **Insurance reconciliation** | Diligence import, claims, denials, remittance import, bank matching of remittances | (a) **e-claim XML import**: submission and remittance advice XML as Diligence downloads them (line level, standard schema); (b) one status per claim, treatment to closure; (c) partial, delayed, resubmitted and duplicate payments; a deposit that fits several claims shown, never guessed; (d) unmatched deposits as exceptions; (e) monthly Diligence receivable = Finance receivable with preparer, reviewer, signer; (f) rejection origin and avoidable flag | Sample submission and RA XML; the case sessions (W5) | Test period reconciled in Pulse matches the manual result, differences explained |
| W4 | **Parallel-run comparison** | Close timetable, month lock | A **comparison view**: for each area (revenue, collections, bank, insurance receivable, labs) Pulse's figure next to the manual figure for the month, the difference and its explanation; the decision to rely on Pulse recorded per area | The manual figures per month (Hardik) | Two consecutive months agree in an area → that area can switch |
| W5 | **Insurance case sessions** | Matching engine, denial cases | Each case documented as a **synthetic test case** (partial payment, resubmission, late RA, duplicate amount, unmatched deposit, taken back, write-off) that the rules must pass | Sessions with Mohammed, Vineetha, Hardik | Every case in the catalogue passes |
| W6 | **Room and doctor model** | Rooms and capacity, contribution, recruitment calculator, revenue share engine (rules closed), doctor pay held until basis approved | Hardik's room-level revenue and cost formulas and the contract revenue-share rules entered as settings and rules (no formulas in code); one consolidated view per room, doctor and branch | Hardik's formulas; decisions D1–D6 | Pulse reproduces Hardik's model for one month |
| W7 | **Tally path** | Bridge, ledger, Tally import; **17 Oct: the hosted-Tally connection over HTTPS is ready for the partner's credentials (docs/44)** | After the partner call: enter the address and credentials (hosted Tally) or install the connector (Tally on a clinic PC); pilot on a **test company**; support several Tally companies; gate review end Jan 2027 | Partner call; credentials or PC access | Pilot month pushes and pulls cleanly |
| W8 | **E-invoicing readiness** | Placeholder only | Decide the route at the gate: Tally's own support, or a provider integration in Pulse | Revenue threshold confirmed (OQ-122) | Provider appointed by 31 Mar 2027 |

**Order:** W1 and W5 first (they unblock everything and need only one sample file and the sessions), then W3 and W2, W4 alongside from the first full month, W6 with Hardik in parallel, W7 after the partner call, W8 at the gate.

**Sandbox:** the parallel run uses the live Pulse workspace with nothing posted to the books (the ledger start is not set and the bridge stays off), because the comparison needs the real figures; experiments with made-up data use the training workspace.

## 4. Files received for insurance (17 Oct)

Mohammed's three Diligence exports (15 Oct) are what the insurance analysis used: **ACTIVTY** (claim lines with
activity, 70 columns, Jan to Sep 2026, 19,341 lines, 6,995 claims), **Claim Summary - Monthwise** (control totals) and
**Remittance Receipt Report (New) format** (3 sample rows: one row per insurer payment with the bank receipt columns).
**Not received yet:** a bank statement, the insurer payment-advice (remittance) XML, the e-claim submission XML, the
manual bank reconciliation workbook and Mohammed's receipt register for a whole month. The matching chain these files
prove is in docs/41 and the 17 Oct reply: Unite invoice number = Diligence `InvoiceNo` (claim) → `PaymentReference`
(one insurer payment, many claims) → the receipt register's `PaymentAmount` (equals the sum of `RemittedAmt` of that
reference's lines) → the bank deposit (amount, date, payer, reference text).

## 5. Status of earlier items
- Finance controls (Krishna revenue, Althaf costs, Hardik consolidates, Saeed approves, by the 10th): built and live (docs/42); roles still to be assigned in Settings, Users.
- Insurance–Finance control matrix (Saeed's request): drafted for Hardik.
- Unite feed switch-on: still the owner's decision; W1 removes the dependency for the parallel run.
