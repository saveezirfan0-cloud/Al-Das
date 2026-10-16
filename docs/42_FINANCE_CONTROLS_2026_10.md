# Finance controls confirmed by management (16 October 2026)

Source: the revised guide "How finance works with Pulse (Revised)", page 3, "Finance controls and month-end reporting", confirmed by management on 16 Oct 2026. This note records the decision and how Pulse is set up to support it. The e-mail trail itself happens outside Pulse; Pulse enforces the parts it can.

## The agreed controls

| Control | Agreed rule |
|---|---|
| Deadline | The reporting and approval trail for the preceding month is complete **by the 10th of each month**. This replaces the earlier target of the 7th working day. |
| Separation | **Krishna** submits revenue and collections; **Althaf** submits costs and expenses. Each works within their own scope. Neither consolidates nor circulates the clinic-wide P&L. |
| Consolidation | **Hardik** (Finance Manager) alone prepares, consolidates and circulates the P&L. Management receives the approved report. |
| E-mail trail | 1. Krishna and Althaf → Hardik: their revenue and cost schedules, reconciliations and outstanding issues (separate inputs, not a P&L). 2. Hardik reviews both, owns corrections and unresolved items, consolidates the P&L and signs the finance review. 3. Hardik → Saeed: the reviewed P&L and management pack for final approval and month-end sign-off. 4. Saeed approves (kept in the e-mail trail); Hardik circulates the approved report to management. |
| Error accountability | Hardik owns revenue and cost errors, their correction, verification and unresolved follow-up. Krishna and Althaf provide supporting records within their scope. The issue, correction and verification are recorded in the month-end trail. |
| Reconciliations | Independent reconciliation sign-off still applies: a preparer does not approve their own reconciliation. |
| Other responsibilities | Vineetha: insurer receipts and insurance reconciliation, backup for Mohammed. Lab statements are Althaf's (costs). |

## How Pulse is set up (migration `20261209000300_finance_controls`)

| Control | In Pulse |
|---|---|
| Separation | Two new system roles. **Revenue & Collections** (Krishna): Unite uploads, revenue reports, daily flash, cash-ups, card and bank receipt matching, collections recovery, invoice-change view, the close checklist. **Costs & Expenses** (Althaf): costs, supplier invoices and payment vouchers (prepare, record payment), lab and referral statements, finance inbox, Tally export of approved items, the close checklist. Neither role holds a profit, doctor-pay, close-pack, close sign-off, report e-mail, accounting export, bank reconciliation sign-off or ledger report key (`tests/unit/finance/finance-controls.test.ts`). |
| Consolidation and circulation | Only the **Finance Manager** role holds the P&L (`finance.profit.*`), the finance close sign-off, the close pack and scheduled report e-mails among these three; the **CEO** role's sign-off locks the month. |
| Deadline | `fin_ref_finance_settings.close_deadline_day` = 10 (calendar day of the following month; blank uses the working-day deadline). The close timetable measures delivery against "the 10th", and steps due after it are flagged "after deadline" so the Finance Manager can move them earlier in the template. |
| E-mail trail | Three checklist steps: **Revenue and collections schedules sent to the Finance Manager** (WD4), **Cost and expense schedules sent to the Finance Manager** (WD4), **Reviewed consolidated P&L and management pack sent to the CEO** (WD6). The CEO sign-off remains the lock. Existing steps keep any edits Finance made. |
| Reconciliation sign-off | Unchanged: the bank reconciliation, lab posting and close already require a second person, enforced in the database. |

## What an administrator still has to do

1. **Settings → Users:** give Krishna the **Revenue & Collections** role, Althaf **Costs & Expenses**, Hardik **Finance Manager**, Saeed **CEO**. Do not give Krishna or Althaf the general **Finance** role: it still includes the P&L and the finance sign-off (it remains for a deputy finance manager).
2. **Finance → Month-end → Timetable:** check the deadline shows "the 10th", assign owners (Krishna, Althaf, Hardik) and backups to the steps, and move any step marked "after deadline" earlier. The steps due on WD7 and WD8 (lab and referral invoices, revenue shares, Tally close, draft accounts) usually fall on or after the 10th.
3. Keep Saeed's approval e-mail with the month's records; Pulse records the CEO sign-off when Saeed signs the close.
