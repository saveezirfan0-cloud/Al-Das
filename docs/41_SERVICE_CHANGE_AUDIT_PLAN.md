# 41: Services added after the visit (audit trail, alerts, follow-up): review and plan

Status: **review and recommendation, no code yet.** Asked for by management on 16 Oct 2026 after a lab test was added in
Unite six days after the visit and the nursing team was not told. Per CLAUDE.md, the build starts in Plan Mode, after
the workflow walk-through with Abdul and Krishnendhu (section 8) and the Unite answers (appendix A).

No patient details are in this file (rule 10). The incident is described by its shape only.

---

## 0. Summary

**What happened.** A doctor asked for two lab tests at a visit. Only the first one was entered in Unite that day. Six
days later the second test was added **to the same visit**, so Unite now shows both under the visit date. Nobody was
told. The report looked late when it was really ordered late, and only the insurance records showed the real history.

**What Unite gives us.** None of Unite's channels into Pulse says *when* a service line was entered. The Finance API
gives the invoice date and the user who created and last changed the invoice, but no line id and no line timestamp. We
asked for both in October and have had no answer (`docs/finance/open-items.md`). The appointments API carries no
services at all. So **only Unite can give a true entry-time audit trail.** Pulse can still *detect* a late addition
reliably by comparing what each feed showed at different times.

**Recommendation: detect in Pulse, prevent in Unite, and build no second order system.**
1. **Prevent (Unite, no code):** ask Unite whether it can stop lines being added to a past visit or ask for a reason
   when they are, and whether it keeps a line audit log we can read (appendix A). Back this with the clinic protocol the
   operations team already states: a service asked for later gets a new registration, not an edit of the old visit.
2. **Detect (Pulse):** a "late service" check that watches the feeds Pulse already receives (Diligence claim files,
   the Unite collection report, the in-house lab file, and the Finance capture once it is on). When a service shows up
   for a visit date earlier than the last time Pulse looked at that visit, Pulse opens one follow-up item, tells the
   right department, and keeps the evidence: visit date, first seen by Pulse, Unite user where known.
3. **Follow up (Pulse):** each item has an owner, a due date and a status, and shows on the dashboard. For insurance
   visits it also checks pre-authorisation and eligibility using what Phase 18 already built.

Nothing in this plan writes to Unite (rule 7), and no spreadsheet is involved: every fact comes from Unite's own
outputs.

---

## 1. The incident in data terms

| Step | What Unite showed | What staff saw |
|---|---|---|
| Visit day (D) | Invoice for the visit with one lab line | Nursing processed the one test |
| D + 6 | The same invoice now has a second lab line, dated D | Nothing: no alert, the visit looks unchanged |
| After | Both lines under D | The second test looks overdue (result "expected D + 2") |

The thing to detect: **a line on a past visit that was not there when we last looked.** Two facts are needed: the
visit date, and the earliest time Pulse saw the line. The gap between them is the delay. Who added it comes from Unite
where Unite gives it.

---

## 2. What Unite gives Pulse today

| Channel | Built in Pulse | State | Service lines? | Entry time of a line? | Who entered? |
|---|---|---|---|---|---|
| Appointments API (`getallappointments`) | Phase 6 sync (`lib/unite/sync.ts`) | Built, read-only, behind its flag | **No** (appointment, doctor, patient, status) | No | Appointment `createdby` only |
| Finance API (`GetFinanceDetails`) | F2 capture (`lib/finance/capture.ts`) | **Built, OFF** (OQ-94; deliver-once) | Yes: item code, CPT, amounts | **No** (no line id, no line timestamp; asked) | Invoice `CreatedBy` / `ModifiedBy` (mapped, `lib/finance/unite-mapping.ts`) |
| Daily Collection report (.xlsx upload) | 23A (`lib/finance/parse-unite-report.ts`) | Live by upload | Amount per service **category** per visit, not per line | No: visit date and invoice date only | `INVOICED BY` / `MODIFIED BY` columns exist but are **deliberately not read** (staff data, 23A) |
| Diligence claim file (.xlsx upload) | F4 (`lib/finance/diligence-mapping.ts`) | Live by upload | Yes: one activity per CPT, insurance only | Activity date, plus the **first file Pulse saw it in** (`ins_claim_activities.first_seen_file_id`) | No |
| In-house / send-out lab file | 20E (`lib/finance/labs.ts`) | Live by upload | Yes: tests done by the lab | Test date on the lab side | No |
| Unite screens | n/a | Staff use them | Yes | The insurance record shows the change (per the operations email) | Unknown: ask Unite whether it keeps a line audit log and whether a report or API exposes it |

Things Pulse already stores that matter here:
- `fin_invoice_lines.created_at` is set when Pulse **first** stores a line (re-deliveries update it, they do not
  re-insert it), next to `fin_invoices.transaction_date` and `first_received_at`. Lines are never deleted: a removed line
  becomes `is_current = false`.
- `fin_invoice_versions` keeps one row per delivery of an invoice, and the 20J invoice-change register
  (`lib/finance/invoice-changes.ts`) already compares deliveries for discounts and cancellations.
- `fin_report_visits` keeps every uploaded report row; a newer upload supersedes older rows (`is_current = false`)
  but never deletes them, so two uploads of the same day can be compared.
- `ins_claim_activities.first_seen_file_id` and `ins_claim_activity_events` record when each claim line first appeared
  and how it changed between Diligence files.
- `ops_exceptions` gives an owner role, assignee, due date, status, comments and an audited close; `notify()` handles
  people's channel preferences; `tasks` gives assignment and due dates.

---

## 3. The six asks: what is possible, and how

| # | Ask | Unite today | Pulse today | Proposal |
|---|---|---|---|---|
| 1 | **Audit trail**: who added or changed a service, the real entry time, the visit date | No line timestamp or line id in any feed; invoice `ModifiedBy` in the Finance API; staff columns in the report | Visit date, first-seen-by-Pulse time per line / claim activity / report row | Record **"first seen by Pulse"** next to the visit date and the Unite user where a feed gives one. Label it as Pulse's evidence, never as Unite's entry time. Ask Unite for a line `CreatedOn` / `CreatedBy` (appendix A): with it the trail becomes exact without changing anything else. |
| 2 | **Notifications** when a service is added, changed or cancelled, above all after the visit | None | `notify()`, the events catalogue, in-app / e-mail / push | New event `service.late_change`: generic text and ids only (Phase 13 rule). Recipients are chosen by **service category to team** (lab to nursing, radiology to radiology, insurance invoices also to insurance), set under Settings. |
| 3 | **Accountability**: who approves, processes and follows up | None | `ops_exceptions` (owner role, assignee, due date, close note), `tasks` | Each detection opens one item with an owning team, a named assignee once picked up, a due date and a closing note ("processed", "not needed", "entered in error"). The default owner per category is agreed in the walk-through (section 8). |
| 4 | **Insurance checks** on added services | Unite's own eligibility and authorisation screens | Phase 18 pre-auth tracker (`fin_pre_authorisations`), eligibility checks, `v_fin_billing_readiness`, Diligence matching (E01, E14) | For an insurance visit the item shows: pre-auth needed or not (CPT against the payer's rules and any open authorisation), cover valid on the visit date, and whether the line has reached the claim file. Reuse only; no new insurance logic. |
| 5 | **Dashboard** of requested, approved, pending, completed and delayed services | No order-status feed | Exceptions queue, management dashboard tiles, lab turnaround (20E) | Pulse can show the **late and changed services** board (new, acknowledged, processed, done, overdue) and lab turnaround for tests the lab file covers. A full order lifecycle for every service needs an orders / LIS feed from Unite that we do not have; it is listed as a question, not promised. |
| 6 | **Flag retrospective entries** automatically | None | The feeds in section 2 | The detection in section 4. This is the core of the build. |

---

## 4. Detecting a late service: signals, best first

Each signal answers the same question: *did a service appear on a visit after Pulse had already seen that visit?*
Where several fire for one line they make **one** item (same key: invoice number plus item code or CPT).

| Signal | Source | Available | What it proves | Delay to detect |
|---|---|---|---|---|
| **S1 Finance capture diff** | A line first stored (`fin_invoice_lines.created_at`) in a later delivery than the invoice's first, and more than N days after `transaction_date`. Carries Unite `ModifiedBy`. | When capture is switched on (OQ-94), **and** if Unite re-delivers an invoice when a line is added (to confirm, appendix A Q3) | Added between two deliveries; who last changed the invoice | About an hour (capture runs hourly) |
| **S2 Claim file diff** | A Diligence claim activity whose invoice already had activities in an earlier file, first seen in a later file, with an activity date before that earlier file's date | **Now**, insurance only | Added between two claim files | As often as the file is uploaded |
| **S3 Collection report diff** | A later upload shows a new service category, or a higher category amount, on a visit already present in an earlier upload | **Now**, any payer, category level | Added between two uploads | As often as the report is uploaded (daily upload needed) |
| **S4 Lab done, not billed** | The 20E reconciliation already finds tests on the lab file with no Unite line, then the line appears later | **Now**, tests the lab file covers | The lab did the test before it was billed | As often as the lab file is uploaded |
| **S5 Unite line audit** | Line `CreatedOn` / `CreatedBy` from Unite | Only if Unite adds it | The exact entry time and user | Same as S1 |

What N is ("late" = entered more than N days after the visit) is a setting, not code (OQ-161). The rule fails closed:
a line with no visit date, or a feed whose history does not reach back far enough, is never flagged; before the
check's start date nothing is flagged (the same start-up guard as E11 / E12).

**Being honest about S2 to S4.** They prove a line appeared *between two snapshots*, not when it was typed. If a file
is uploaded late, the bracket is wide. The item says "added between 9 Oct and 15 Oct (files)", never "added on 15 Oct".
S5 is the only exact answer and only Unite can give it.

**Cancellations and changes.** The same diffs catch a line that disappears (already `is_current = false` in the
capture; superseded report rows) or changes amount. These reuse the 20J change register for the money side; the new
item is about the *service* (someone must act), not the discount approval.

---

## 5. Design sketch (for the Plan Mode session, not built)

- **Pure rule** `lib/finance/late-services.ts`: inputs are snapshots (visit date, first seen, source, item code / CPT,
  category, payer type), output is detections with reasons. Thresholds come from `fin_ref_finance_settings`. Unit tests
  with synthetic fixtures; parity-tested against SQL like the other Phase 18 rules.
- **SQL**: a SECURITY DEFINER function (`search_path = ''`, service role only) that builds the snapshots from
  `fin_invoice_lines`, `ins_claim_activities`, `fin_report_visits` and the lab matches, and opens or closes exceptions
  through the existing `app.fin_reconcile`. New rule code **E15 "Service added or changed after the visit"** in
  `fin_ref_exception_rules` (E13 and E14 are taken). Run as a step of the daily `finance_workflows` job, and after each
  upload or capture batch.
- **Routing**: `ops_exceptions.owner_role` only knows insurance, billing, finance and admin. Nursing, lab and radiology
  are not finance roles, so the clinical notice goes through `notify()` to the team mapped to the category (new setting
  `late_service_routes`: category to team), while the exception stays in the finance queue for the billing and
  insurance side. Alternative to decide in Plan Mode: a task per detection on the clinical team (`tasks` already has
  owner, due date, branch and notifications).
- **Data rules**: PIN and codes only on finance tables (the module rule); the notice text is fixed ("A service was
  added to a past visit. Open Pulse to review."), with ids only. Reading the report's `MODIFIED BY` column would put
  staff names in Pulse: a policy decision (OQ-164). The Finance API's `ModifiedBy` is already mapped.
- **Permissions**: exceptions are read through the owning role's permission (`app.fin_owner_perm`: billing items need
  `finance.invoices.view`, insurance items `finance.claims.view`) and closed with `finance.exceptions.manage`. Clinical
  teams who must see the list without finance access need a new key (for example `services.audit.view`) and a view
  without amounts: OQ-163. Every close is audited.
- **Backfill guard**: when capture is first switched on with the January backfill, every line is "first seen" that day.
  The start date (nothing before it is flagged) stops that from opening thousands of false items.
- **Dashboard**: a tile "Late services this week" (counts, links to the filtered exceptions queue), and per branch on
  the management dashboard (`loadManagementSummary()`).

Effort once the answers are in: S2 + S3 + S4 with E15, routing, tile and tests about one session each for the rule and
SQL, the routing and settings, and the UI. S1 and S5 are a small extension once capture is on or Unite adds the fields.

---

## 6. What is not proposed, and why

- **No order entry in Pulse.** Doctors and nurses keep entering services in Unite. A second place to record orders is
  the parallel system management asked us to avoid, and it would drift from Unite.
- **No writes to Unite** (rule 7). Pulse cannot block or correct a Unite entry; prevention has to be Unite
  configuration or protocol.
- **No spreadsheets.** Every signal comes from a Unite output (API, report, claim file) or the lab's own file.
- **No calling the Finance API to check.** It is deliver-once; S1 waits for the guarded capture to be switched on.

---

## 7. Steps and owners

| Step | What | Owner | Needs |
|---|---|---|---|
| 0 (now) | Restate the protocol: a later request gets a new registration, not an edit of the past visit | Operations | none |
| 0 (now) | Send the Unite questions (appendix A) | Irfan | none |
| 0 (now) | Walk through today's flow with Abdul and Krishnendhu (section 8) | Irfan, Abdul, Krishnendhu | 30 to 45 min |
| 1 | Agree "late" (N), the category-to-team routes, owners and due dates | Operations, Medical Director | step 0 |
| 2 | Upload the Collection report daily (S3 needs it) and the Diligence and lab files on a fixed day | Finance, Insurance | step 1 |
| 3 | Build E15 with S2, S3, S4, routing, tile (Plan Mode first) | Pulse | steps 1 and 2 |
| 4 | Add S1 when capture is switched on (OQ-94) and S5 if Unite adds line audit fields | Pulse | Unite answers |

---

## 8. Questions for the workflow walk-through (Abdul, Krishnendhu)

1. Who enters lab, radiology and procedure services in Unite today: the doctor, nursing, reception, billing? Who is
   allowed to add a service to a past visit?
2. How does nursing learn about a new lab request today (Unite screen, paper, verbal)? Which screen do they watch?
3. When a service is added later, who should know: nursing, lab, radiology, insurance, billing, the doctor? Is that
   different per branch?
4. What counts as "late": same day but after the patient left, the next day, or more?
5. Who closes the loop: who confirms the sample was taken, the test was sent, the result came back?
6. For insurance visits, who checks pre-authorisation for an added service, and before or after it is done?
7. How often can Finance upload the Daily Collection report, and Insurance the Diligence file?
8. Should clinical staff (nursing, lab) see the follow-up list without seeing any amounts?
9. Should Pulse show who in Unite made the change (staff names from the report), or only that a change happened?

---

## Appendix A: questions for Unite (draft e-mail)

**Subject:** Al Das Medical: audit trail for services added to a past visit

Hello,

We have had several cases where a service (for example a lab test) was added to a visit some days after the visit, and
then shows under the original visit date. We would like to understand what Unite supports before we change our
process. Could you help with the following?

1. **Line audit.** Does Unite record, for each service line on a visit or invoice, the date and time it was added and
   the user who added it, and the same for changes and cancellations? Where can we see it (screen, report, API)?
2. **API fields.** Can `GetFinanceDetails` include, per line, a line id, `CreatedOn`, `CreatedBy`, `ModifiedOn` and
   `ModifiedBy`? (We asked about a line id and a modified timestamp earlier and are still waiting.)
3. **Re-delivery.** When a line is added to an invoice that `GetFinanceDetails` has already delivered, is the invoice
   delivered again with all its lines? Is the same true for changes and cancellations?
4. **Controls.** Can Unite be set to stop services being added to a visit after a set time (for example after the
   day ends or after the invoice is submitted to the insurer), or to require a reason when they are?
5. **Notifications.** Can Unite itself alert a user group (for example nursing) when a service is added to a visit
   after the visit date?
6. **Orders and results.** Is there an API for lab and radiology orders and their status (ordered, sample taken,
   sent, result received), separate from billing?
7. **Report.** Can the Daily Collection report include the date and time each line was added?

We read Unite only; we do not write to it. Thank you,

Saveez Irfan
Al Das Medical

---

## Appendix B: open questions added

OQ-161 to OQ-166 in `docs/audit/open-questions.md`.
