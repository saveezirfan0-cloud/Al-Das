# Finance and insurance: status against the Integration Blueprint v2

Source: *Al Das Visual Integration Blueprint v2* (9 October 2026, 6 pages), on top of the original brief and the earlier
phases (F0 to F7, Phase 18). This page says, requirement by requirement, what is built, where it lives, and what still needs
a decision or a fact from a person. Nothing here has been seen with real data: Unite capture is OFF and no Diligence file has
been imported (see `go-live-runbook.md`).

## 1. Built

| Blueprint requirement | Where it lives |
|---|---|
| Permanent capture first: store every response before parsing, ledger, replay, alerting (p1, p6) | F2 to F6: `fin_raw_unite_batches`, `fin_process_batch`, `pnpm finance:replay`, `lib/finance/alerts.ts` |
| Validate and reconcile; quarantine mismatches, never silently discard (p1) | Failed batches keep the raw payload; invoice-number gap check (E09); Diligence validation (E10); `ins_staged_activities` |
| Appointment ↔ invoice via AppointmentId, invoices without a valid booking in an exception queue (p2) | E08 |
| Invoice ↔ claim by invoice number + claim activity; line ↔ claim line is a candidate match, repeats flagged (p2) | `lib/finance/match-claims.ts`, E03, **E13 (same service billed twice)**, **E14 (claim with no invoice line)** |
| Claim ↔ status ↔ settlement; keep original and resubmitted amounts, status events, payment allocations (p2) | `ins_claim_activity_events`; remittance reconciliation (Phase 18, `ins_remittance_lines`, each advice line stored once) |
| Branch P / M / G derived from the invoice's clinic; unknown or inconsistent locations flagged (p2) | `fin_ref_branches`, E07 |
| **Ordering and performing doctor kept separate; management chooses which governs; never overwrite** (p2) | `fin_invoices.ordering_doctor_*` / `performing_doctor_*` (filled when Unite sends them, mapped in `DOCTOR_ROLE_FIELDS`), `fin_ref_finance_settings.doctor_basis` (Workflow settings). Until it is set, reports use the invoice doctor **and say so** |
| **Recorded activity vs proven completion: billed without a visit, visit not billed** (p3) | **E11, E12** (review signals only, off until a start date is set) |
| Route → owner → due date → investigation → **escalation** → evidenced closure (p3) | `ops_exceptions` (owner, due date, comments, closure note) + **escalation** after N days to a configured role (`fin_escalate_exceptions`) |
| Separate measures, not stages: Generated, Claimed, **Accepted only if status is evidenced**, **Paid = allocated collections**, Outstanding (p4) | `v_fin_monthly_measures`; Monthly summary and Branches pages. Accepted counts a claim only with a remitted amount or a status listed in Workflow settings; claims with no status are counted apart, never assumed accepted |
| Self-pay bypasses claims; reconcile receipts without counting the same settlement twice (p4) | self-pay column; remittance lines unique per advice line |
| Month-end close, cut-off, closed-month views audited (p4) | Phase 18 `fin_period_closes` (finance + CEO sign-off, locked) |
| **Costs and profitability: contribution margin, then estimated profitability; zero cost = unavailable; provisional until approved** (p4) | `fin_cost_services`, `fin_cost_overheads`, `fin_cost_doctor_comp`, `fin_cost_periods`; `lib/finance/profitability.ts`; pages **Costs** and **Profitability** |
| **Separate access: cost/payroll without revenue or P&L; billing without cost; Medical Director without unrestricted cost; doctor compensation specifically authorised** (p4) | permissions `finance.costs.manage`, `finance.costs.view`, `finance.costs.compensation`, `finance.profit.view`, `finance.profit.approve`; role **Cost / Payroll**; RLS tests per role |
| **Pseudonymous reporting patient ID; names, Emirates ID, member numbers excluded from analytics** (p5) | `fin_invoices.patient_ref` (keyed hash, key in Vault); report functions return counts only |
| **Every measure shows source, refresh time, coverage and unresolved exceptions** (p5) | provenance strip (`lib/finance/provenance.ts`) on Summary, Branches, Doctors, Profitability |
| **Role dashboards:** Owner/CEO, Doctor/Department, Branch, Insurance and receivables (p5) | Summary (revenue stages), **Doctors**, **Branches**, Profitability; Insurance and receivables = Claims, Denials, Remittance, Scorecards, Forecast, ageing on Summary and Branches. The nav shows each role what it may open |
| Doctor comparisons with coverage before conclusions; free slots are not worked hours; "new patient" needs first-visit history (p5) | Doctors page: new / returning shown only when the range starts after the first invoice on record; completed appointments only where the doctor ids match; limits stated on the page |
| Minimise reporting data, encrypt, least privilege, audit access (p5) | RLS on every table; service-role functions return aggregates; `recordAudit` on every write |

## 2. Not built, and why

| Item | Why | What unblocks it |
|---|---|---|
| Real Unite and Diligence field names | Neither Make's current token (no permission to read data structures or scenarios) nor Airtable holds them, and reading patient records to infer them is not allowed | Unite's field list; Sharaf's Diligence header row (`diligence-header-request.md`). Until then the mappers fail closed |
| Payroll and cost file formats | "Systems and export formats unknown" (blueprint p1) | The Costs page takes a plain CSV Finance fills in (`cost-csv.md`); adapt when the real export is known |
| Lab / sample completion status | Only needed if the visit feed and Unite cannot show it (p3, step 2) | Decide after E11 / E12 have run on real data |
| Rota-based clinical-hour productivity | The rota is not available; free slots are not worked hours (p5) | A rota export |
| Finance-approved recognised revenue and the chart of accounts | A policy decision for Finance (p4) | Finance's recognition and allocation policy; profit figures stay "Provisional" until then |
| Clinical-continuity and patient-communication dashboards | They live outside Finance (`/dashboard`, `/reports`) | n/a |
| Click-through on real data | No Supabase auth stack in the build sandbox; the live site is not reachable from it | Someone with a login opens each page once |

## 3. Decisions the blueprint leaves to Al Das

1. Ordering or performing doctor for revenue, rejection and referral measures (management and the Medical Director). Workflow settings, "Doctor basis".
2. Which Diligence statuses count as accepted. Workflow settings, "Accepted claims".
3. The start date for the visit/billing checks (E11, E12), and the match window.
4. Month-end cut-off and accounting treatment of late insurance adjustments (Finance).
5. Who owns each queue (the blueprint marks insurance, revenue/billing and cost/payroll owners as "to confirm").

## 4. Turning on the pseudonymous reporting ID

The ID is a keyed hash of the Unite PIN. Without a key it stays empty (fail closed). In the Supabase SQL editor:

```sql
select vault.create_secret('<a long random string, at least 16 characters>', 'finance_ref_key');
select public.fin_backfill_patient_refs('<your organisation id>');   -- repeat until it returns 0
```

Keep the key safe. Changing it later changes every ID, so treat it like any other secret and do not rotate it casually.
