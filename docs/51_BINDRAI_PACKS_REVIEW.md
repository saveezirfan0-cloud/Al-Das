# Bindrai group packs: review against Pulse (21 Oct 2026)

Saeed shared three workbooks on 21 Oct 2026. They were read and recalculated (LibreOffice) in the session scratchpad only. **Nothing from them is in the repo**: this note holds sheet names, structure and formula findings, never a figure from the workbooks. The questions they raise are OQ-183 to OQ-188 in `docs/audit/open-questions.md`.

| Workbook | What it is | Sheets |
|---|---|---|
| Bindrai Group Financial Reporting Pack | Blank monthly templates for every group entity (Bin Drai Capital, BDC Investment, Al Das, Park Developments, Asyas Nursery) | Read Me, Group Dashboard, Entity P&L, Cash 13W, KPI Scorecard, Working Capital, Commitments & Capex, Intercompany, Compliance, Close & Sign-off, Budget & Forecast |
| Bindrai All Company Finance Rollout and CEO Monitoring Pack | Who does what, line-by-line acknowledgement, a ten-question test, the CEO scorecard and the Al Das branch source data | Read Me, Acknowledgement Register, Query Register, Test Answer Key, Test Results, CEO Scorecard, CEO Alerts & Decisions, Rollout Calendar, All-Entity Acknowledgements, CEO All-Entity Scorecard, Clinic Branch Source Data |
| Park Developments, Real Estate Finance Tracker (sample data) | Project P&L, invoices, receipts, consultant cost and cash position for another group company | README, Setup, P&L MOM, Portfolio Summary, Fixed Expenses, Other Overheads, Invoices, Receipts, RW Costs, Cash Position |

The Park Developments tracker carries one named person's pay. Keep it to Finance; it is not Al Das data and is not loaded into Pulse.

## 1. What the packs ask of Al Das

- **Monthly rhythm.** Day 2 source data and bank statements; Day 3 reconciliations; Day 5 entity pack certified by the entity manager and finance preparer; Day 7 HoldCo consolidation and challenge; Day 8 management review; Day 10 CEO pack (scorecard, alerts, decision papers). Whether "Day" is a calendar or a working day is not stated (OQ-184).
- **Named duties.** Crishna (Krishna): revenue by branch, service line, clinician and payer, weekly and Day 2; reconcile revenue to billing, appointments and accounting. Althaf: costs by category and branch, commitments, same-day escalation of unapproved spend. Mohammad (Mohammed): payer-by-payer claim status, aged insurer receivables, claims vs billed vs cash by Day 3. Vineetha: Asyas Nursery data first, insurance support second. An Al Das manager certifies the clinic on Day 5. These match the Pulse roles of 16 Oct (Revenue & Collections, Costs & Expenses, Insurance, Finance Manager; docs/42).
- **Al Das KPIs** (KPI Scorecard and Clinic Branch Source Data): revenue by branch, completed appointments and procedures, new patients, repeat visits, cancellation and no-show rate, cash collections, claims submitted, denied or pending, aged insurer receivables, payroll and medical supplies as % of revenue, committed spend, material clinical or compliance exceptions.
- **CEO scorecard.** Five pillars of 0 to 20 (reporting accuracy, cash, operations, budget and commitments, compliance); Green 80+, Amber 60 to 79, Red below 60 or any automatic red event.

## 2. Where Pulse already has the figure

| Pack line | Pulse source | State |
|---|---|---|
| Revenue by branch, by doctor, by payer type | Unite report upload (23A), Daily flash, Doctor performance | Built; needs the daily upload while Unite capture is off (OQ-94) |
| New patients, repeat visits | Doctor performance (patients, follow-ups = visits − patients) | Built; definition differs from Unite's New / Revisit flag (OQ-186) |
| Completed appointments, cancellation and no-show rate | Appointments vs invoices (W2) | Built; waits on one real Unite appointment export (D16) |
| Cash collections | Unite collection report payment modes; cash-up | Built; the daily tie (OQ-181) is unanswered |
| Claims submitted, denied, pending; aged insurer receivables | Diligence upload, claim status, Receivables by age, denials | Built; waits on the weekly full export (D22) |
| Payroll and medical supplies as % of revenue | Costs (F8), Contribution | Built; no cost data loaded yet (Q20, D7, D8) |
| Entity P&L, budget vs actual | Tally mirror (22I/22J), accounting statements, budgets | Built; waits on the Tally connector (OQ-123, D8) |
| Working capital: receivables and payables ageing | Receivables by age; Accounting, Payables ageing | Built |
| Close & Sign-off checklist, preparer and reviewer | Close timetable (20G), month close with two signatures and CEO lock | Built; steps are data and can follow the pack's days (OQ-184) |
| Cash 13W | Collections forecast (insurer inflows by week) | Partial: no self-pay, payroll, supplier or rent outflows |
| Exceptions and error log, CEO alerts | Exceptions (E01 to E15), management alerts | Built for finance signals; decisions log is not |
| Compliance calendar | Staff and doctor licence and visa reminders | Partial: no trade licence, facility licence, VAT or corporate tax dates |
| Commitments & capex | Vouchers and payables (approved spend) | Not built: no commitment or PO register |
| Intercompany, other entities, acknowledgements, test | none | Out of Pulse's scope (OQ-183) |

## 3. Proposed build (not started; plan first, per CLAUDE.md)

1. **Al Das entity submission** as one Excel file in the pack's layout: Entity P&L (month, YTD), the Al Das KPI rows, Clinic Branch Source Data for all three branches, receivables and payables ageing and the close sign-off, from the existing loaders, with a Definitions sheet and "Provisional" until the CEO lock. Only the Finance Manager can download it (it is a clinic-wide P&L, docs/42).
2. **Close timetable** steps moved to the pack's days once OQ-184 is answered (data only).
3. **13-week cash view:** add self-pay, approved vouchers and payables by due date, and typed recurring lines (payroll, rent) to the collections forecast.
4. **Compliance register** for Al Das (facility and trade licences, VAT and corporate tax dates) using the HR reminder pattern.

Steps 1 and 2 need no new data; 3 and 4 depend on D3, D7, D8 and Q20.

## 4. Formula faults found

Checked by recalculation, not by eye, where marked (R). Every fix is small; the packs are otherwise clean (no error values).

**Rollout and CEO Monitoring Pack**

| # | Sheet | Fault | Fix |
|---|---|---|---|
| R1 | Test Results | (R) `SUMPRODUCT(--(G10:P10='Test Answer Key'!D10:D19))` compares a row with a column, which builds a 10 × 10 grid: ten correct answers score 38 (380%), and ten "A" answers (2 correct) score 20 and PASS | Hold the key as a row (10 cells) and compare row with row, or add the ten single comparisons |
| R2 | Test Results | (R) Someone who has not sat the test shows "RETAKE REQUIRED"; "No Score" counts blank scores, which never occur (the score cell holds 0) | Leave the result blank until an answer is entered |
| R3 | Test Answer Key | The ten test questions are not in the workbook, only the key and the topics | Keep the questions in a separate file from the key |
| R4 | CEO Scorecard, CEO All-Entity Scorecard | (R) An unscored company totals 0 and shows RED; before scoring the summary reports every company RED | Show "Not scored" until all five pillars are filled |
| R5 | Acknowledgement registers | A status of Acknowledged becomes "Pending Test" and never moves on: the final status does not read Test Results | Look up the person's PASS |
| R6 | Clinic Branch Source Data | Columns for Meadows and Golden Miles only; Shoreline, the main site, is missing (OQ-185). The "Combined Check" adds the two cancellation / no-show rates | Add Shoreline; combine rates from counts, not by adding |
| R7 | Several | Spellings differ from the rest of the clinic's records: Crishna, Mohammad, Golden Miles | Use one spelling so filters match |

**Group Financial Reporting Pack**

| # | Sheet | Fault | Fix |
|---|---|---|---|
| G1 | Commitments & Capex | Formulas sit one column to the right: "Variance to Budget" holds Actual + Committed + Estimate to complete, "Funding Source" holds Forecast − Budget, and "Forecast Total Cost" is left to type | Forecast = G + H + I; Variance = Forecast − Budget; Funding Source typed |
| G2 | Cash 13W | The 13-week total's Opening Cash is week 13's opening, not week 1's | Point it at week 1 |
| G3 | Budget & Forecast | FY Total of Ending Cash adds the 12 month-end balances; the EBITDA row is typed, not calculated | Use month 12 for ending cash; EBITDA = Revenue − Direct − Payroll − Opex |
| G4 | Group Dashboard | Described as linked, but nothing links to the entity tabs (every figure retyped); the Management Group Total adds Al Das at 100% while HoldCo's share is 60% (OQ-188) | Link the cells; show the 60% view beside the total |
| G5 | Entity P&L, KPI Scorecard | Variance is Actual − Budget for every line, so a positive cost or no-show variance is bad while a positive revenue variance is good | Label favourable / adverse, or reverse the sign for costs and "lower is better" KPIs |
| G6 | Intercompany | The certification compares each entity's total due from with its total due to, which is not a reconciliation | Reconcile pairwise: A's receivable from B against B's payable to A |
| G7 | Working Capital | The summary by entity is not linked to the ageing tables above it | Link it |

**Park Developments tracker** (another company; reported back, not loaded)

| # | Sheet | Fault | Fix |
|---|---|---|---|
| P1 | P&L MOM | Corporate tax `IF(P17>375000, (375000−P17)×9%, 0)` is negative once profit passes AED 375,000, so after-tax profit would exceed pre-tax profit. The 14-month column range also spans two tax periods | `(P17 − 375000) × 9%`, per financial year |
| P2 | P&L MOM | (R) Revenue and consultant cost run to Dec-26, but owner charge, office overheads, insurance, benefits, other overheads and direct expense stop at Aug-26: a September invoice will show without its costs. Subtitles say both "to Jul 2026" and "to Oct 2026" | Extend the fixed lines; one period label |
| P3 | P&L MOM | (R) Employee benefits: April reads gratuity + flight allowance, May to August read gratuity only | Read the total row for every month |
| P4 | P&L MOM | Nov-25 collects every invoice up to 30 Nov 2025 and consultant cost from 1 May 2025 | Label it as the catch-up column or split the months |
| P5 | Receipts | A receipt's amount is copied from the invoice, so an invoice shows PAID when a receipt row exists, not when the bank shows the money | Type receipts from the bank statement |
| P6 | Cash Position | "Total Invoiced (AED Net)" sums the gross column; two projects use shorter ranges | Fix the label; one range for all |
| P7 | Portfolio Summary | Per-project GP % is profit ÷ cost (mark-up); the total is profit ÷ revenue (margin) | Use one measure |
