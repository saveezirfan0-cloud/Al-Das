# Finance records from Unite, their links to patients and appointments, and the matching engine

_17 Oct 2026. Answers "how do we store what the Unite Finance API returns" and "how does Pulse match bank, card and
insurance money" after the 16 Oct meeting (docs/43). Counts and design only; no patient data._

## 1. Storing the Unite Finance API records (built in F1, one gap)

The model already exists (migrations `20261009000100_finance_raw.sql` and `20261009000300_finance_core.sql`, mapper
`lib/finance/unite-mapping.ts`, processor `fin_process_batch`):

```
fin_raw_unite_batches        one row per API answer (or file): the full payload, kept FIRST, service role only,
   │                         names/DOB/Emirates ID stripped once processed (payload_stripped_at); replayable
   ▼ fin_process_batch (idempotent, replayable with pnpm finance:replay)
fin_invoices                 one row per Unite invoice (current state): number, date, patient_pin, appointment_id,
   │                         clinic → branch_code, doctor DHA id, department, type (SELF PAID / INSURANCE), gross,
   │                         discount, net, VAT, total, write-off, credit note, referral, version + record hash
   ├── fin_invoice_versions  every delivery of the invoice (PII stripped): Unite changes are history, never overwritten
   ├── fin_invoice_lines     item code, CPT, qty, price, discount, net, VAT, package flag; never deleted (is_current)
   └── fin_payments          instalment, mode, collected, paid, date, receipt no, advance, refund, card type,
                             transaction ref no (the card / bank key), surcharge
```

**Links to the patient and the appointment.** Finance tables carry the Unite PIN and Unite's appointment id only
(CLAUDE.md: no names, DOB, Emirates ID or member ids in finance tables). The links are made by key, at read time:

| From | To | Key | Where it is used today |
|---|---|---|---|
| `fin_invoices.patient_pin` | `contacts.external_id` (the Unite PIN) | PIN | Patient 360 Invoices tab (`finance.invoices.view`) |
| `fin_invoices.appointment_id` | `appointments.external_id` where `source = 'unite'` | Unite appointment id | Exception rules E11/E12 (visit without invoice, invoice without visit; off until `evidence_start_date`) |
| `fin_invoices.inv_display_number` | `ins_claim_activities.invoice_no` (Diligence) | invoice number (`app.fin_invoice_key`) | Claim matching, insurance billed vs claimed. **Checked on September data: all 951 Diligence claims are Unite insurance invoice numbers (`ADMC/nnnnn`); self-pay invoices use their own series** |
| `fin_payments.txn_ref_no`, mode, date | card settlement lines, bank lines | reference + amount + date | Bank and settlement reconciliation |

**What to add (W1 and W2 of docs/43):**

1. **The saved export as a raw batch.** The clinic already holds a pull from the Finance API; those records are
   delivered once and will never come again, so the file is the only copy. Add `fin_raw_unite_batches.source`
   (`api` | `file`) and a guarded upload (`finance.revenue.import`, Finance Manager confirms): the file is stored as the
   batch payload first (sha256 kept, the same size and shape checks as an API answer), then `fin_process_batch` runs
   unchanged. The original upload is not kept apart from the batch (it is the same payload). Nothing calls Unite.
2. **A link view, not copied ids.** `v_fin_invoice_links` (`security_invoker`): invoice id → contact id (by PIN, the
   merged-into contact when the PIN moved), appointment id (by Unite appointment id), link state (`linked`,
   `no_patient`, `no_appointment`, `direct` for invoices Unite issues without an appointment). Read with the member's own
   rights, so a person without `finance.invoices.view` sees nothing. Exceptions for unlinked invoices stay review
   signals.
3. **Show it where people work.** Patient 360 (Billing tab, docs/45), the appointment drawer (its invoice, paid or not,
   with the finance key), and the doctor and branch reports already read the invoices.
4. **Appointments that Unite owns** reach Pulse through the Unite appointment sync (credentials, OQ-26) or the
   appointment export upload (W2); either fills `appointments.external_id`, which is what the link uses.

## 2. The matching engine today

Built in Phases 18 to 20 (pure TypeScript, deterministic, every threshold a setting):

| Matcher | What it pairs | Keys | Code |
|---|---|---|---|
| Claim ↔ invoice | Diligence claim lines ↔ Unite invoice lines | invoice number, CPT, amount (0.01) | `lib/finance/match-claims.ts` → `ins_apply_matches` |
| Remittance ↔ claim | Insurer payment-advice lines ↔ claim lines | claim activity number, invoice number, CPT, expected price | `lib/finance/match-remittance.ts` |
| Bank ↔ expected receipt | Bank credits ↔ card/cash collections, processor payouts, insurer remittance batches | amount (tolerance), date (window), reference text, payment mode | `lib/finance/bank-recon.ts` |
| Lab and provider files | Lab statements ↔ Unite lines | PIN, CPT, date window | lab matchers |
| AI reviewer | Explains and suggests on the bank run's leftovers | aliases, amounts, dates, modes only; may only pick from the matcher's shortlist | `lib/finance/bank-ai.ts` |

The rule everywhere: a pair is applied automatically only when its score reaches the threshold **and** it is the only
candidate on both sides; anything else is a proposal; a person's decision goes through the same path as the AI's
accepted suggestion (`applyMatchDecision`); every decision is kept.

**What is missing, against the meeting (references first, open items, partial and late payments):**

- In the bank score the **amount is a gate** and the reference is worth only 10 of 100 points. A partial payment, or one
  deposit paying several remittances, never becomes a candidate even when the reference is on the bank line.
- A bank run looks at **one account and one month** (with a short look-back and look-ahead); an insurer payment that
  arrives three months later, or a resubmission paid in a later month, falls outside it.
- An insurer remittance batch is one expected item: **one deposit = one batch** only. In the Diligence data one payment
  reference covers a median of 2 and up to 471 claims, 335 of 913 payment totals equal another payment's total, and
  5,545 lines were paid more than once.
- **Nothing learns.** Accepted and rejected AI suggestions are counted, but a confirmed match teaches the matcher nothing
  (the next deposit from the same insurer with the same narrative is scored from zero).
- There is no **receipt register** (Mohammed's Remittance Receipt Report: one row per insurer payment with its bank
  receipt) and no **e-claim XML** import.

## 3. Matching engine v2 (W3)

**3.1 One open-item register.** Every item that is not yet closed, whatever its month:

- *Money in the bank:* bank credits not yet explained (all accounts, all months until reconciled).
- *Money expected:* card and Tabby settlements, cash deposits, insurer payments (one per **payment reference**, from the
  payment advice or the receipt register, with its claims), patient balances, other receivables.
- *Claims:* claim lines submitted and not fully paid or written off (Diligence `ClaimStatus` not remitted, rejected open,
  resubmitted).

An item leaves the register only when it is matched in full, written off with a reason or cancelled; partly matched
items stay open with the remainder. Month-end reports read the register as at the month end, so the close still works.

**3.2 Matching by keys, strongest first** (each a pure rule with a score and its reasons; ties never guessed):

| Level | Rule | Result |
|---|---|---|
| 1. Reference | The bank line's narrative or reference holds a known key: the insurer's payment reference, a settlement batch id, a cheque number, a card terminal batch, a Unite receipt number. Exact after normalising (case, spaces, leading zeros) | Auto when the key is unique in the open register and the amount agrees (or the difference is explained, level 4) |
| 2. Payer + amount | The payer is recognised from the narrative (learned aliases, 3.3) and the amount equals one open payment of that payer, or **the sum of a small set of its open payments** (same payer, dates inside the window, at most N items, one set only) | Auto only if exactly one combination fits; otherwise a proposal listing the combinations |
| 3. Amount + date | Amount within tolerance, date within the window, no reference or payer | Proposal only, never automatic |
| 4. Differences | Bank charges, FX, withholding, a short payment: a known charge rule explains the difference, else the remainder stays open | Remainder stays open with its reason |

One bank credit can close several items (an insurer paying many payment references at once) and one item can be closed
by several credits (an insurer paying in parts); every allocation is a row (`fin_match_allocations`: item, bank line,
amount, rule, score, reasons, who or what decided, when), so a partial payment is visible and can be undone.

**3.3 Learning, under control ("training").** The matcher does not change itself:

- **Learned aliases.** When a person confirms a match, the narrative words that identified the payer are proposed as an
  alias (for example the abbreviation an insurer's bank uses). The Finance Manager approves an alias before it is used;
  each alias shows how many matches it made and how many were later undone.
- **Rules measured on history.** The September and October manual reconciliation (Hardik, Vineetha) is loaded as the
  answer key. Each rule's precision (how often its pair is the manual one) and coverage are computed on that history,
  and a rule may match automatically only above an agreed precision (for example 99%) on at least two months. Below it,
  the rule only proposes.
- **The AI reviewer** keeps its current limits: it sees aliases, amounts, dates and modes, picks only from the
  shortlist, and nothing it says is applied without a person. Its accepted and rejected suggestions are part of the
  measured history.
- **Case catalogue (W5).** Each case from the insurance sessions (partial payment, resubmission, late RA, duplicate
  amount, unmatched deposit, taken back, write-off) becomes a synthetic test the engine must pass, so a change to a
  rule cannot quietly break an agreed case.

**3.4 New inputs.** Receipt register import (one row per insurer payment: payment reference, amount, bank receipt date,
number, bank and amount); e-claim submission and remittance advice XML (the standard DHA e-claim schema, line level;
originals deleted after parsing like every other upload); bank statements for every account (already supported:
`fin_import_formats`).

**3.5 Insurance control (Saeed's matrix).** From the register: Diligence receivable = Finance receivable each month with
preparer, reviewer and signer; one status per claim from submission to closure (submitted, paid, partly paid, rejected,
resubmitted, written off, closed); unmatched deposits and receipts pending in the bank as exceptions with owners and
ages.

## 4. Order of work

1. Saved Unite export as a raw batch, the link view, invoices on Patient 360 and the appointment drawer (needs the file).
2. Receipt register import and the open-item register with allocations (needs a month of the receipt register and the
   bank statements of the insurance account).
3. Reference-first and payer-sum rules; learned aliases with approval.
4. The answer key from the manual Sep and Oct reconciliation; rule precision report; auto-match switched on rule by rule.
5. e-claim XML import (needs sample submission and RA files).
