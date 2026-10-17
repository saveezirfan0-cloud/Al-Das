# W3 and W5: insurance chain (XML advice, one status per claim, case catalogue)

Plan of 16 Oct 2026. Chain: Unite invoice number = Diligence `InvoiceNo` (claim) -> `PaymentReference` (one insurer payment, many claims) -> bank deposit.

## What was added

| Piece | File |
| --- | --- |
| XML remittance advice reader (W3a) | `lib/finance/parse-remittance-xml.ts`; element names ONLY in `lib/finance/remittance-mapping.ts` (`REMITTANCE_XML`) |
| Upload accepts `.xml` (decided by bytes in `readRemittanceFile`, not file name) | `lib/finance/parse-remittance.ts`, `remittance-service.ts`, `app/(app)/finance/remittance/*` |
| Negative paid amount = payment taken back (was: file rejected); flag `taken_back`, never "short" | `parse-remittance.ts`, `match-remittance.ts` |
| Earlier payments on a claim (`paid_before`, optional) so a completing payment is not "short" | `match-remittance.ts` (pure only, see follow-ups) |
| One status per claim (W3b) | `lib/finance/claim-status.ts` |
| Deposit against payments, incl. one deposit = several references (W3c) | `lib/finance/deposit-match.ts` |
| Rejection origin and avoidable flag (W3f) | `rejectionOrigin` in `lib/finance/denials.ts` |
| Case catalogue (W5) | `tests/unit/finance/fixtures/insurance-cases.synthetic.json`, `tests/unit/finance/insurance-cases.test.ts` |

No migration, no new table, no new permission (the upload already needs `finance.remittance.manage`).

### XML reader
Reads the standard DHA / Shafafiya `Remittance.Advice`: `Claim/ID` (= invoice number), `IDPayer`, `PaymentReference`, `DateSettlement`, `DenialCode`; `Activity/Code` (CPT), `Quantity`, `Net`, `PaymentAmount`, `DenialCode`. It turns the file into the same header-plus-rows table the spreadsheet readers produce, so `parseRemittanceTable`, staging, `reconcileRemittance`, preview and commit run unchanged. Lines are matched by invoice number + CPT code (+ quantity and net to narrow); `Activity/ID` is not used (it may only be a sequence number). Denied amount = net - paid when a denial code is present, else 0 (an unexplained shortfall stays a short payment). Member, patient, card and clinician elements are never read (`REMITTANCE_XML.ignored` lists them; a test seeds them with values and checks none comes out).
Fails closed with a code and no value: `xml_unexpected_root`, `xml_truncated`, `xml_malformed` (every Claim/Activity tag opened and closed once; the Tally scanner is forgiving, so this is checked here), `xml_no_claims`, `xml_claim_incomplete`, `xml_activity_incomplete`, `xml_not_allowed` (DOCTYPE/ENTITY), `too_many_rows` (30,000), `file_too_large` (25 MB). Non-numeric amounts fail in the table parser (`invalid_number`). Reuses the Tally pull parser (`lib/accounting/tally/xml.ts`); no new dependency.

**Unverified:** the element mapping is from the public schema. No real advice file was available. First real file: check the preview's header report and correct names in `REMITTANCE_XML` only. Open questions: is `PaymentAmount` signed negative for a take-back? Is `DateSettlement` always `dd/MM/yyyy`? Does a claim-level `DenialCode` exist (it is read as a fallback)?

### One status per claim (`claimStatus`)
`submitted, under_review, partly_paid, rejected, resubmitted, taken_back, paid, closed, written_off, unknown`, plus `outstanding` and `overpaid`. Pure, tolerance passed in (the short-pay tolerance setting), blank or non-finite figures give `unknown`. `resubmitted` holds until an advice arrives after the last resubmission date. `closed` = paid in full AND bank receipt, or the denial case was lost. `settlementMonthOffset` says how many months after the service the money arrived (late advice is not an error; it only says which month the cash belongs to).

### Deposits (`matchDeposit`)
Candidates are single payments and groups (2 to `maxParts`) of one payer within the bank amount tolerance and date window. Decision: `matched` only if exactly one candidate, or exactly one whose reference(s) appear on the bank line; `ambiguous` otherwise; a lone group is `combination` (a proposal); a reference on the bank line with the wrong amount is `review`; else `unmatched`. Never guesses.

## Gap analysis (W3 b to f)
| Item | Status |
| --- | --- |
| (b) Denial workflow open / in progress / appealed / resubmitted / won / lost / written off | EXISTED: `ins_denial_cases`, `lib/finance/denials.ts` (case status only, per denied activity) |
| (b) Claim-level payment view, follow-up ageing and stages | EXISTED: `claimProgress` (display), `fin_followup_open_claims`, `ins_claim_followups` |
| (b) ONE status per claim | MISSING, now `claim-status.ts`. Not wired to a page or column |
| (c) Short, over, denied, duplicate-in-file lines | EXISTED in `match-remittance.ts` |
| (c) Same advice uploaded twice | EXISTED: file sha256 + unique `line_key` |
| (c) Partial then completing payment, duplicate payment across files, take-back | MISSING, now `paid_before`, `overpaid`, `taken_back` (lines) and `claimStatus` (claims) |
| (c) Late advice | Needed no flag; `settlementMonthOffset` |
| (c) Deposit = one payment: score, tolerance, window, ties not auto-matched | EXISTED: `bank-recon.ts` `reconcileRun` |
| (c) Deposit = several payment references | MISSING, now `matchDeposit` (not wired) |
| (d) Unmatched deposit needs a reason | EXISTED in 20C bank reconciliation: unmatched credits and items past the window block the review ("Explain N unmatched bank credit(s)") with reason codes. NOT built: rows in `ops_exceptions` (its `entity_type` has no deposit; adding one means redefining `fin_run_exception_rules`). Say so if you want them |
| (e) Monthly Diligence receivable = Finance receivable, preparer / reviewer / signer | PARTLY EXISTS: the close pack holds Diligence claimed / remitted / rejected / outstanding and receivables ageing, with two sign-offs bound to the snapshot hash (`fin_close_sign_*`). NOT built: the comparison against the ledger's insurance receivable account. It needs a new figure in the close snapshot (SQL) and a new check; more than a few lines, so left |
| (f) Rejection origin and avoidable | MISSING (category and owner role existed). Now `rejectionOrigin` from the category, a proposed table to be confirmed; unknown stays `null`, not "not avoidable" |

## Case catalogue (W5)
`insurance-cases.synthetic.json`: 12 cases, each with a title, steps (input and expected result) and a `confirm` field. The header says the expectations are PROPOSED and unconfirmed. `requiredKinds` lists the kinds; the test fails if a kind is missing from the catalogue, or if the plan's 11 kinds are dropped from the required list (plus `duplicate_payment`).

| Case | Kind | Who confirms |
| --- | --- | --- |
| C01 | fully_paid_exact (paid, then closed on bank receipt) | Mohammed, Vineetha |
| C02 | short_paid (no reason given) | Mohammed |
| C03 | paid_and_denied_explained | Mohammed |
| C04 | partial_payment (second advice completes it) | Hardik, Mohammed |
| C05 | resubmission_after_rejection (rejected, resubmitted, paid) | Mohammed |
| C06 | late_remittance (two months after visit) | Vineetha, Hardik |
| C07 | duplicate_amount (two identical claims; two equal payments; bank text names one) | Mohammed, Vineetha |
| C08 | duplicate_payment (paid twice) | Mohammed, Hardik |
| C09 | deposit_several_references (group, group confirmed by references, two groups = ambiguous) | Vineetha, Mohammed |
| C10 | unmatched_deposit (and reference found with the wrong amount = review) | Vineetha |
| C11 | taken_back (negative line) | Mohammed, Hardik |
| C12 | write_off (counts only once approved) | Vineetha, Mohammed |

## Follow-ups (not done)
1. Bank reconciliation expects one item per remittance FILE (`ins|<batchId>`). A deposit is one payment REFERENCE. Group `ins_remittance_lines` by `remittance_ref` in the bank loader and call `matchDeposit` for deposits no single item fits; `maxParts` / `maxPool` need two columns in `fin_ref_finance_settings`.
2. Supply `paid_before` from earlier committed `ins_remittance_lines` (excluding the file being previewed) in `claimsFor`/`ins_claims_for_remittance`.
3. Show `claimStatus` on the claims page (needs `takenBack` summed from negative advice lines, and to know whether Diligence `remitted` already nets take-backs: Hardik).
4. Unmatched-deposit rows in `ops_exceptions`; the receivable comparison in the close pack; origin/avoidable on the denial pages (and, if Finance wants it editable, as columns of `fin_ref_denial_codes`).
