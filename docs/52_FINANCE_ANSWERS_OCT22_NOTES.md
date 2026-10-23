# Finance's answers of 22 Oct 2026 and the files sent with them

Finance answered the 19 Oct requests document ("What we need from each team") in a tracker workbook and sent five files on 22 Oct 2026. Everything was read in the session scratchpad only. **Nothing from the files is in the repo**: this note holds structure, counts and rules, never a patient, a doctor's name or pay, or an amount from a ledger. The answers are recorded against their questions in `docs/audit/open-questions.md` (marked "Answered 22 Oct 2026"); new questions are OQ-189 to OQ-196.

## 1. What arrived

| Ref | File                               | What it is                                                                                                                                                                                                                                                      | Used for                                                                                                                                                             |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D8  | Tally general ledger, FY 2025      | Tally "Ledger Vouchers" report of the Shoreline company, 1 Jan to 31 Dec 2025: 537 ledgers, about 18,000 entries, 15 voucher types (Journal, Purchase, bank payment and receipt per bank, Contra, Sales, Payroll, Debit and Credit Note, Receipt, Cash Payment) | Ledger and voucher-type list; not importable (Pulse's 22I import reads the XML export). It raises OQ-189 (company per branch?) and OQ-194 (calendar financial year?) |
| D10 | Revenue sharing                    | 3 signed terms letters and 3 monthly calculation sheets                                                                                                                                                                                                         | The scheme shapes (section 3); differences in OQ-193                                                                                                                 |
| Q8  | Longevity services                 | 213 service codes (LG, QT) with prices and 55 package codes (LGP), updated 30 Sep 2026                                                                                                                                                                          | The Longevity code list; needs the item-wise export (D15) to split revenue by code                                                                                   |
| Q41 | Lab costs, March 2026              | The Al Das internal cost list (519 tests by CPT) and the FML price list (451 tests)                                                                                                                                                                             | The agreed price list; quality points in OQ-195                                                                                                                      |
| –   | The requests document with answers | The same answers as the tracker                                                                                                                                                                                                                                 | –                                                                                                                                                                    |

Still not received: D6 (one outside referral invoice; the 15 Oct lab email had none, and no histopathology invoice), D7 supplier invoices, D11, D3, D4, D15, D16, every insurance file, and the answers to Q21 to Q38.

## 2. Changes in Pulse

| Answer                                                                                                                            | Change                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6: the AED 750 target is per paid patient; zero-invoice visits (follow-ups) are left out                                         | Revenue per patient divides by **paid patients** (patients − unbilled patients). Expected revenue is paid patients × target, so the gap, achievement and band follow. The flash report counts paid patients per row (`paid_patients` from SQL, patients whose net in the row is above 0); a payload without it counts every patient as paid                          | `lib/finance/doctor-performance.ts` (`paidPatientsOf`), `lib/finance/flash.ts` (`arppOf`), `fin_flash_inputs` (migration `20261227000100`), the group pack |
| Q7: the daily target is the month's target ÷ the branch's operating days (Shoreline 30, Meadows 30, Golden Mile 26, Longevity 26) | `fin_ref_revenue_targets.operating_days` per line and month (blank = every calendar day). Month target = daily × operating days; one day is measured against the daily target, the whole month against the month target, a part month pro rata by calendar days (which days a branch is closed is not known). Without operating days the result is exactly as before | `monthTargetOf`, `periodTargetOf`, `monthTotals` in `lib/finance/flash.ts`; Flash settings form ("Operating days"); `fin_flash_set_targets`                |
| Q7: chiropractic/physiotherapy at Shoreline and rental arrangements are not revenue                                               | No code: set them up as non-core reporting lines (Finance, Flash settings, Reporting lines), as the flash already does for Chiro and leased units                                                                                                                                                                                                                    | Finance's setup                                                                                                                                            |
| Q39: lab request and bill match up to 5 days apart                                                                                | `lab_date_window_days` defaults to 5; an organisation still on the old default (2) moves to 5                                                                                                                                                                                                                                                                        | migration `20261227000100`                                                                                                                                 |
| Q42: lab cost follows the branch on the Unite bill                                                                                | The cost row takes the matched Unite line's branch; the lab file's branch only when the line is unmatched or the bill has no branch                                                                                                                                                                                                                                  | `lib/finance/labs.ts`                                                                                                                                      |

Built as a separate update (OQ-196, migration `20261228000100`): the voucher route by amount (Q2). `approval_mode` gains `split`: a voucher of no special category at or below `fin_ref_finance_settings.tally_approval_max` (default 5,000.00) goes to Tally on submission ("Sent to Tally for authorisation"); larger vouchers and payroll, intercompany and related-party vouchers at any amount follow the Pulse tiers. `pulse` and `tally` are unchanged. The rule is in `fin_voucher_act` and its twin `voucherRoute()` (`lib/finance/vouchers.ts`), run on the shared scenarios in `phase20d-vouchers.synthetic.json`. Nothing is switched on: the Finance Manager chooses Split under Finance, Voucher settings (typed SPLIT, audited; changing the limit in split mode needs the same word) and, because Finance said every Pulse voucher above AED 5,000 needs the CEO, edits the Tier 2 rule (5,000.01 to 15,000) to include the CEO; the tiers are Finance's data, not code.

Recorded without a code change: Q1 (e-invoicing from March 2027), Q3 (what goes to Tally), Q5 (Main Insurance ledger, AED 1; the setting already is 1.00), Q10 (shared costs by OPD room area), Q11 (cash invoices locked after the 8th), Q12 (no bank charges on insurer receipts), Q14 (doctor pay on billed revenue: Pulse's revenue share already is), Q15 to Q19.

## 3. Revenue-share schemes in the sheets (D10)

All three sheets split each doctor's month into self-pay and insurance, and per category (consultation, laboratory, radiology, procedures, vaccine or retail, others):

```
net(category)   = revenue − direct cost − payment gateway (self-pay; spread by revenue share) − patient facilitation
                  − 10% provision (insurance only)
share(category) = net × the category's rate
payable         = Σ share (+ the provision, booked separately in Tally until released)
```

Lab cost is split between self-pay and insurance by their revenue. The shapes Pulse's 20F rule cannot express yet: a **slab** (one rate on all revenue, chosen by the month's total: 50 / 55 / 60 % at AED 100k and 150k), and a **monthly minimum** of a rate × scheduled hours, pro rata, paid as the higher of the minimum and the share. A licence and malpractice cost shared 50 / 50 from the final payment appears in the terms but not in the sheets. Differences between the sheets and the terms are OQ-193. No pay is calculated by Pulse until Finance approves the basis (docs/finance/contract-rules-alignment.md).

## 4. Insurance receipts in the bank (received later on 22 Oct)

A workbook of insurer receipts (credits only) into the two insurance accounts, Emirates NBD and Commercial Bank of Dubai, from 3 January 2022 to 29 September 2026: 5,175 rows with transaction date, bank receipt number, bank, amount and narration (plus a balance column filled on 108 rows and a system amount on 7). It is the substance of D21 (the insurance bank statements), compiled rather than the bank's own export, so it has no debits or balances to reconcile against.

What it showed:

- 60 rows write the date as text like "05-Jan-2026" (the rest are Excel dates or "23-09-2026"), and Pulse's import refused the whole file for them. **Changed:** `readDate` (`lib/finance/parse-import.ts`) now also reads a day, an English month name and a four-digit year in any layout; the month name cannot be mistaken for a day, and two-digit years are still refused.
- The two banks are mixed in one sheet, while Pulse imports one statement per bank account; 140 rows spell the bank "Commerical bank of Dubai" and one row (20 Sep 2024) has no bank. The sheet is not in date order.
- The bank receipt number is blank on every 2022 to 2024 row and filled from 2025; numbers repeat across years.
- The narration carries the bank's own reference (about 4,000 rows: "TT REF" on Emirates NBD, the CBD transfer id), not the insurer's payment reference, so the file is a bank statement for Pulse, not a receipt register.

The file was split per bank, sorted by date, with one date format (one CSV per account, 3,291 and 1,883 rows) and checked against Pulse's bank statement parser; it was returned to Finance, not kept.

## 5. Tracker

The tracker was returned with corrected statuses (what actually reached Pulse), a "Pulse check (22 Oct)" column and a "Changes 22 Oct" sheet listing every status change and the owners that differ from the 19 Oct document. It is not kept in the repo.

## 6. The Remittance Receipt Report (D17), received 23 Oct 2026

The full Diligence Remittance Receipt Report (facility DHA-F-0000419), with the insurance receipts workbook again (the same 5,175 credits as §4; only the date cells are stored differently) and a "report formats" zip (ACTIVTY, Claim Summary, the 3-row register sample and Book3: the same files and totals as 15–16 Oct and 22 Oct). Read in the scratchpad only; nothing from the files is in the repo.

| | Count | AED |
| --- | ---: | ---: |
| Payment advices (one row each, `Downloaded RA`) | 967 | |
| Received: a bank receipt date, number and bank (22 May 2024 to 11 Sep 2026, mostly Dec 2025 to Aug 2026) | 750 | bank 3,472,907.38 (paid 3,461,954.11) |
| Pending: bank amount 0, no bank receipt yet | 217 | paid 231,781.84 (claim net 330,174.94) |
| Insurers (receivers) | 14 | |

**Pulse refused the real file; three changes make it import** (750 rows, 217 pending skipped):

- **Dates.** Diligence writes "Jan 13 2026 12:00AM". `readDate` now also reads a month name first ("Jan 13 2026", "January 5, 2026", with or without a time) in any layout.
- **Pending advices.** A row whose amount is 0 (nothing in the bank yet) is skipped whatever its date, before the date is required. The layout maps **Amount received = `BankAmount`**; mapped to `PaymentAmount`, a pending advice has an amount and no date and is still refused, as before. The receipt register's field hints now name the Diligence column for each field.
- **Payment references.** 241 of the 967 references are long insurer numbers ("1234567-12345", "12-123456789012-3-45", a 16-digit number after an insurer prefix), which the statement redaction masks as card or account numbers, so the file was refused. The same `PaymentReference` already reaches Pulse unmasked through the remittance advice and Diligence imports, and a masked reference could never meet its own advice. New `redactReferenceText` (`lib/redact.ts`) keeps long reference numbers and still masks IBANs, cards the bank already masked, phone numbers standing on their own, e-mail addresses and a value that is itself a card number (card-shaped: 13 to 19 digits together or in groups of four, and passing the Luhn check); any of those still refuses the row. Bank narratives keep the stricter `redactStatementText`.

**How the register meets the bank (Jan to Aug 2026).** Joined on Finance's bank receipt number and date, 709 of the 729 receipts agree with the bank credits to the fils (receipt numbers repeat across years, so the number alone is not a key); 17 receipts carry 2 to 4 advices (one transfer, several payments: Q36). Pulse's matching engine v2 run on the parsed register and the 867 insurer-account credits, with no payer names approved yet, using those receipt-number links as the answer key:

| Rule | Single proposals | Agree with Finance's link | Disagree | No link to check | Several options (right one among them) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference written on the bank line | 172 | 163 | 7 | 2 | 0 |
| Amount and date (never automatic) | 461 | 432 | 0 | 29 | 117 (73) |

Every credit Finance linked got a proposal. The 7 disagreements are not engine errors: in 3, Finance linked two or three advices to one receipt while the credit equals the single advice Pulse proposed; in 4, the bank narrative carries the reference of the advice Pulse proposed while Finance's link names another advice of the same amount on another date. The payer rule proposed nothing because no payer name is approved yet (`finance.matching.approve`).

**For Finance to check** (OQ-197): the 7 disagreements; 15 receipts where the register total differs from the bank credit (14 with the register higher) and 5 with no credit of that number on that date; 9 rows with a number in BankName ("16", "11") and one misspelt; 6 rows whose bank amount differs from the paid amount (one about 16 times it); one payment reference listed twice (once pending, once received, different amounts); 179 insurer-account credits (AED 103,525.65, Jan to Aug 2026) with no register row (E15 candidates once the bank statements are in Pulse). The receipts workbook is still a compiled list of credits, not the bank's own statement (D21).

## 7. Insurance answers (call with Sharaf, 23 Oct 2026)

Sharaf (Insurance) went through the open insurance items by phone. What he said and what it changes:

| Item | Answer | In Pulse |
| --- | --- | --- |
| D20, Q26 How insurer money is reconciled | In Diligence: from the bank statement, find the remittance advice by its payment reference, match its amount to the bank receipt, record the receipt. The Remittance Receipt Report is the result: Received = reconciled, Pending = not yet. There is no separate workbook | D20 is the receipt register (D17); its links were already checked against the bank (§6) |
| D21 | Book3 is the consolidated insurance bank statement (2022 to Sep 2026); Finance adds each month on the 5th | Received; monthly |
| D22 | Diligence data comes monthly after each month's submission (September now, October next month); the full activity report is being sent by e-mail | Partial; monthly, not weekly |
| D9 | A separate resubmission report exists; Sharaf will see how to share it | Partial |
| Q13 Patient share | Not in Diligence (insurer share only); it is in Unite's daily or insurance sales report | Pulse already reads PATIENT SHARE from the Unite collection report |
| Q23 Branch | Insurance is handled at Shoreline only; Unite's appointments are all at Shoreline | Every insurance claim is Shoreline until the 10 Nov split |
| Q28, Q29 Take-backs | Remove: a take-back is a correction (resubmission as correction or internal complaint) that reverses the RA, while the bank amount is not touched | Never treated as cash leaving the bank; `diligence_remitted_nets_takebacks` stays unconfirmed |
| Q30, Q31 Rejections | The denial codes in the full activity report identify the reasons | Pulse already reads LastDenialCode, DenialCategory and DenialType; the origin/avoidable proposal stays for Finance |
| Q32 Agreed prices | Not needed for these reports | Closed; short-payment checks against a payer price list stay unused |
| Q33 Follow-up | From the submission date; most RAs arrive about 90 days after submission, red flag at 120 days | **Changed** (below) |
| Q34 Accepted, write-off | Diligence is an accounts application: nothing is marked approved or written off there. A partly paid claim that will not be resubmitted is a write-off decided outside the system | Closed; the `approved` write-off assumption never applies |
| Q36 One transfer | Each insurer pays separately | 7 of 729 register receipts list two insurer codes (third-party administrators or entry slips): in the checks file |
| Q37 Submission history | One RA row can hold several payment references and Diligence consolidates them, sometimes doubling a payment | Deferred to a final cleansing step |
| Payers | AXA puts its payment reference on the bank line and matches easily; NextCare, Neuron and some others are harder | Expected: the reference rule covers AXA; the others need the payer and amount rules |

**Follow-up from the submission date (migration `20261229000100`).** `fin_ref_finance_settings.followup_age_basis` is `submission` by default (or `visit`, the old behaviour). Diligence has no first-submission date, so "submission" is the last resubmission date when the claim was resubmitted (the insurer's clock restarts) and the visit date otherwise (a first submission goes out about 15 days after the visit, so a claim is never flagged late). The stage and the day a stage is crossed follow it; the receivables ageing buckets still count from the visit. `followup_stage_days` defaults to one stage, 120 days, and an organisation still on 60, 90, 120 moves to 120. `app.fin_followup_from` and `followupFrom()` are the one rule (shared fixture `followup.synthetic.json`, `submissionBasis`). Task subjects say "N days since submission". Finance can change both under Finance workflow settings.

## 8. Unite Patient Register Report (sent as D16, 23 Oct 2026)

Sent as "the Unite appointment export, 1 to 22 Sep", but it is Unite's **Patient Register Report** for **1 to 22 October 2026**: one row per visit (1,613 visits, 1,110 patients, 25 doctors), 44 columns, most of them patient identity (name, date of birth, phone, e-mail, Emirates ID, emergency contact). Read in the scratchpad only, counts kept; nothing is in the repo.

- **Not the appointment export.** It has no appointment number, appointment status or time, so the W2 import (`lib/finance/appointment-mapping.ts`) refuses it, as it should. D16 stays open: Unite's appointment list report for one week, with the fewest columns.
- **Branch per visit (OQ-161, Q22, Q23).** Unite already names each visit's clinic: Shoreline 1,389, Meadows 123, Golden Mile 101. Seven of the 25 doctors work in more than one clinic, so a visit's branch cannot come from the doctor alone; the clinic column (already read from the Unite collection report) is the right source.
- **Insurance at Shoreline only** (confirms Sharaf, §7): all 627 visits with an insurance invoice amount are at Shoreline.
- **Visit types (OQ-140, OQ-190, Q9).** NEW 303 and REVISIT 1,310 only: Unite has no follow-up visit type.
- **Booked or walk-in.** 1,529 visits carry an "Appointment Created By", 84 do not (walk-ins).
