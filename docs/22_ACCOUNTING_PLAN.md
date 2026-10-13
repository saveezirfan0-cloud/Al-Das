# Phase 22: Accounting (Pulse replaces TallyPrime)

_Written 13 Oct 2026 on `claude/funny-clarke-6t7gee`. Owner request (13 Oct): "replace Tally; Pulse acts as the accounting tool as a whole", with access per accountant, a chart of accounts, invoices, receipts, bills, reconciliation and bank statements, an ERP-style menu, and a digital signature on the approval certificate. The Tally overview and reports, the insurance history and the bank samples follow later; this plan is built so they slot in without redesign._

## 1. Principles

1. **One double-entry general ledger.** Every financial event, whether typed in or derived from Unite, Diligence, a bank file or a voucher, ends as a balanced journal (`acc_journals` + `acc_journal_lines`). Reports read only the ledger, so a figure is the same on every screen.
2. **Sub-ledgers stay where they are.** Unite invoices and payments, supplier invoices and vouchers (20D), bank imports (20C), lab charges (20E), revenue-share runs (20F), cash-ups, remittances and denials remain the operational records. A **posting engine** turns each approved item into a journal, idempotent on `(source_kind, source_id, source_version)`. A changed source reverses its journal and posts again, so nothing is edited in place.
3. **Posted means permanent.** A posted journal is never updated or deleted; it is corrected by a reversal. Numbers are gap-free per series and fiscal year. A locked period refuses postings (one lock with `fin_period_closes`).
4. **Maker, checker as elsewhere in Phase 20.** A manual journal is prepared by one person and posted by another (`accounting.journals.approve`), enforced in SQL. Automatic postings come from items that were already approved upstream.
5. **No patient identity in the ledger.** Lines carry accounts, amounts, dates and dimensions (entity, branch, department, doctor, payer, supplier, customer). The patient's balance stays in the Unite mirror (PIN only), and the ledger holds control accounts.
6. **Tally stays connected until cut-over, then retires.** Everything in Tally is imported (groups, ledgers, opening balances and the full voucher history), idempotent on Tally's GUID, with a dry run and a reconciliation report. While both run, a small on-premise **Tally connector** (22J) keeps them in step through Tally's XML/HTTP interface: Pulse pushes its posted journals to Tally and pulls masters and vouchers entered in Tally, each matched by GUID, so neither side holds a duplicate. The connector only makes outbound HTTPS calls to Pulse, so Tally is never exposed to the internet. After cut-over the connector is switched off and Tally is kept read-only for the record.

## 2. What Tally does and where it lands in Pulse

| Tally | Pulse |
|---|---|
| Companies | `acc_entities` (legal entities inside the org, each with a TRN, base currency AED, fiscal year start); branches map to an entity |
| Groups (28 predefined: 15 primary such as Capital Account, Current Assets, Current Liabilities, Direct/Indirect Incomes and Expenses, Fixed Assets, Loans (Liability), Sales/Purchase Accounts, Suspense; sub-groups such as Bank Accounts, Cash-in-Hand, Duties & Taxes, Sundry Debtors/Creditors, Provisions, Reserves & Surplus) | `acc_accounts` tree: `is_group`, `parent_id`, `nature` (asset / liability / equity / income / expense), `tally_group` for the import mapping; system groups seeded with the Tally names so imported ledgers land under the same parent |
| Ledgers (with opening balance, bill-wise, cost centres on/off) | `acc_accounts` leaves; `control` = receivable / payable / bank / cash / vat for accounts that only the sub-ledgers may post to |
| Voucher types: Payment, Receipt, Contra, Journal, Sales, Purchase, Credit Note, Debit Note | `acc_journals.voucher_type` with the same eight names and a numbering series per type, entity and fiscal year |
| Cost categories and cost centres | Fixed dimensions on each line (branch, department, doctor) plus free `acc_cost_centres` (projects, the leased unit) |
| Bill-wise details (New Ref / Agst Ref / Advance / On Account) | Allocations: receipts against sales invoices (`acc_allocations`), payments against bills (the 20D voucher links), advances as unallocated balances |
| Banking: BRS, cheque register, e-payments | 20C reconciliation on top of the GL bank account; cheque number on payment journals |
| VAT (UAE): tax ledgers, VAT return | `acc_tax_codes` (standard 5%, zero-rated, exempt, out of scope, reverse charge) and the FTA VAT 201 return boxes report |
| Budgets and scenarios | `acc_budgets` per account, month, dimension; budget against actual |
| Interest, ageing, outstanding | AR and AP ageing by party; statements of account |
| Reports: Day Book, Ledger, Trial Balance, P&L, Balance Sheet, Cash Flow, Funds Flow, Ratio Analysis | Same reports, all with comparatives, drill-down to the journal and the source document, Excel and PDF |
| Edit log / audit trail, security levels, TallyVault | `record_history`, `audit_log`, roles and `accounting.*` permissions, MFA, encrypted secrets |
| Inventory (stock items, godowns) | Not now (consumables are expensed); a later slice if the clinic wants pharmacy stock |
| Payroll | Not now: payroll journals are imported from the payroll file (WPS) as one journal per month |
| Transaction authorisation, DSC signing | 20D approvals; Phase 22 adds a PAdES digital signature on the approval certificate (organisation seal, and a personal certificate where the signer has one) |

## 3. Clinic specifics

- **Revenue** from Unite invoice lines by service category, branch, department and doctor; split into the patient share (self-pay receivable) and the insurer share (insurance receivable per payer). Discounts and write-offs post to their own accounts (20J register).
- **Insurance:** claims receivable per payer; remittance (Phase 18) posts the receipt; a denial accepted as final posts a write-off; a resubmission keeps the receivable. Ageing per payer reconciles to the Diligence receivables report (20I).
- **Doctors:** the revenue-share run (20F) accrues the doctor payable each month and the payout clears it. Lab and referral costs (20E) post to cost of sales by doctor and branch.
- **Labs, hospitals, referrals:** provider bills through 20D payables, matched charges from 20E.
- **Card, Tabby and EPG settlements:** clearing accounts per channel, cleared by the 20C settlement match; fees post as bank charges.
- **Cash-ups** post cash takings to the branch cash account.
- **VAT:** most healthcare services are zero-rated (preventive and basic healthcare); cosmetic and some other services are standard-rated at 5%. The tax code comes from the service category (`fin_ref_services`) and is never guessed; a service without a tax code stops its posting with a reason (OQ-120).
- **UAE corporate tax (9%):** reporting only (taxable income bridge from the P&L); not computed automatically.

## 4. Access

New permission keys, each shown in the role editor under "Accounting":

| Key | Lets the person |
|---|---|
| `accounting.view` | open the Accounting module and the chart of accounts |
| `accounting.ledger.view` | see journals, the general ledger and the day book |
| `accounting.reports.view` | see the trial balance, P&L, balance sheet, cash flow, budgets and ratios |
| `accounting.coa.manage` | add and edit accounts, groups, cost centres and tax codes |
| `accounting.journals.prepare` | prepare manual journals (Journal, Contra, Debit/Credit note) |
| `accounting.journals.approve` | post a journal someone else prepared, and reverse posted journals |
| `accounting.sales.manage` | raise sales invoices and credit notes to insurers, corporates and tenants |
| `accounting.receipts.manage` | record receipts and allocate them |
| `accounting.banking.manage` | bank accounts, transfers, bank charges, petty cash |
| `accounting.assets.manage` | fixed assets and depreciation runs |
| `accounting.budgets.manage` | budgets |
| `accounting.periods.manage` | open, close and lock periods, and run the year-end close |
| `accounting.tax.manage` | VAT settings and the VAT return |
| `accounting.settings.manage` | entities, fiscal years, numbering and posting rules |
| `accounting.import` | the Tally import and opening balances |

Presets: **Accountant** (view, ledger, reports, prepare, sales, receipts, banking, assets, budgets), **Chief Accountant** (all keys), **Auditor (read-only)** (view, ledger, reports). The Finance Manager also gets view, ledger, reports and approve; the CEO gets view and reports. Every person's access is set in Settings, Roles, as today; nothing about access lives in code except the presets.

## 5. Navigation (ERP-style)

The sidebar becomes a tree. Each module (Finance, Accounting, Settings) expands to its sections and pages, and each group can be expanded or minimised, remembered per person (cookie). The collapsed rail opens a flyout per module. Ctrl+K finds every page. On phones the in-page menu stays. Module entries come from one registry so the sidebar, the in-page menu, the landing redirect and quick search agree.

Accounting menu:
- **Overview:** Dashboard (cash, receivables, payables, period status, items waiting to post or approve)
- **Ledger:** Chart of accounts, Journals, Day book, General ledger
- **Sales & receivables:** Sales invoices, Credit notes, Receipts, Customers, Receivables ageing
- **Purchases & payables:** Bills (the 20D supplier invoices), Payments (20D vouchers), Suppliers, Payables ageing
- **Banking:** Bank accounts, Bank statements and reconciliation (20C), Transfers, Petty cash
- **Assets:** Fixed assets, Depreciation
- **Reports:** Trial balance, Profit and loss, Balance sheet, Cash flow, Budget against actual, VAT return, Ratios
- **Close:** Periods, Year-end close
- **Setup:** Entities and fiscal years, Tax codes, Cost centres, Posting rules, Numbering, Tally import, Opening balances

## 6. Slices

| Slice | Content | Migration | Paste |
|---|---|---|---|
| 22A | Ledger core: entities, fiscal years and periods, account tree with Tally groups, tax codes, cost centres, numbering series, journals and lines with the balance check, post / reverse / approve functions, period lock tied to `fin_period_closes`, permissions and presets, default clinic chart of accounts seeded for new and existing orgs; pages: dashboard, chart of accounts, journals (prepare, approve, reverse), day book, general ledger, trial balance | `20261108000100_accounting_core` | 41 |
| 22B | ERP navigation: module tree, minimise per group, collapsed flyouts, registry, quick search | none | none |
| 22C | Digital signature: PAdES seal on the voucher approval certificate and the close pack (organisation certificate in the integrations catalogue, encrypted), personal certificate per signer where available, verification on the page | `20261108000200_finance_signing` | 42 |
| 22D | Posting engine: rules (`acc_posting_rules`), journals from Unite invoices and payments, remittances and denials, supplier invoices and vouchers, revenue share, lab and referral charges, cash-ups, settlements and bank fees; queue, retry, "waiting to post" list with reasons | 2026110900xxxx | 43+ |
| 22E | Receivables: customers (insurers from payers, corporates, tenants), sales invoices with VAT and PDF, credit notes, receipts and allocations, statements, ageing | | |
| 22F | Banking and cash: GL bank accounts linked to 20C, transfers (Contra), bank charges, petty cash, cheque numbers | | |
| 22G | Statements and budgets: P&L, balance sheet, cash flow (indirect), comparatives, branch and doctor views, budget against actual, VAT 201, ratios, Excel and PDF | | |
| 22H | Fixed assets and depreciation, prepayments and accruals | | |
| 22I | Tally import (groups, ledgers, opening balances and the full voucher history, by GUID) and opening balance entry, with dry run and reconciliation report; year-end close | | |
| 22J | Tally connector: an on-premise agent (outbound HTTPS only) that talks to Tally on the clinic's machine (XML over HTTP, port 9000): pushes Pulse's posted journals as Tally vouchers, pulls masters and vouchers changed in Tally (by AlterID), each matched by GUID; a sync log with errors per voucher; switched off at cut-over | | |

22A, 22B and 22C run in parallel; 22D to 22J start from 22A.

## 7. Decisions and open questions

Decided by the owner on 13 Oct 2026:
- **One legal entity, three branches** (Golden Mile, Meadows, Palm Jumeirah). Pulse keeps the entities table (one row) so a second company could be added later without redesign; entity pickers stay hidden while there is one.
- **Fiscal year July to June**, with calendar year as a setting per entity.
- **Bring everything in from Tally** (ledgers as they are, opening balances, voucher history), and **keep Tally connected through its API** until cut-over (22J).

Still open:
- **OQ-117 Cut-over date.** The date Pulse becomes the book of record; until then Tally is the book of record and Pulse mirrors it through the connector.
- **OQ-119 Branch-level access.** Should an accountant be limited to one entity or branch? (Default: no; access is by role.)
- **OQ-120 VAT treatment per service category.** Which categories are zero-rated, exempt or standard-rated (the clinic's tax adviser to confirm).
- **OQ-121 Personal digital certificates.** Do the CEO and Finance Manager have a certificate that can be exported as a .p12 file (soft certificate)? A USB token (the Tally DSC) cannot be used by a web application; then Pulse seals with the organisation certificate and records the approver.
