# Phase 20I notes: insurance follow-up, submission sequence and receivables by age

_Built 13 Oct 2026 (what's-new dated 26 Oct, the planned release) on a worktree of `claude/funny-clarke-6t7gee` at `72147a6`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20I._

## What it replaces

Mohammed Sharafadin's and Vineetha's manual insurance work (finance meeting): following up unpaid claims at 60, 90 and 120 days with a person on each claim, keeping track of submissions and resubmissions whose values change every time (a resubmission in correction mode sends the whole amount back to the RA, including what was paid), and the fully manual "ARP report" (definition still open, OQ-95). Insurer payments are still verified only against the bank and the remittance received: nothing here marks a claim paid.

## What exists

| Piece | Where |
|---|---|
| Insurance follow-up: every unpaid claim, oldest first, age, age bucket, stage reached (60 / 90 / 120), payer, branch, outstanding, rejected, last resubmission, last follow-up, the raised task; stage chips and payer / branch filters | `/finance/followup` (`app/(app)/finance/followup/page.tsx`) |
| Claim drawer: the submission sequence (1st, 2nd, 3rd submission; correction vs resubmission; claimed, remitted in the step, remitted so far, rejected), the follow-up form and the follow-up history | same page, `?claim=<id>` (`followup-controls.tsx`, `actions.ts`) |
| Receivables by payer and age (candidate ARP report): payer x bucket amounts and counts, a "No date" column, totals, branch filter | `/finance/receivables` (`app/(app)/finance/receivables/page.tsx`) |
| CSV download | `GET /api/finance/receivables?branch=` (`app/api/finance/receivables/route.ts`), audited with `recordAudit` and `recordExport` |
| Settings: ageing buckets, follow-up stages, task start date, on/off, role, due days | Finance, Workflow settings, "Insurance follow-up and ageing" (`saveFollowupSettings`) |
| Daily job step | `lib/finance/workflows.ts` step 4, `lib/finance/followup-server.ts` (runs in `finance_workflows`, 03:50 UTC) |
| The rules (pure, unit-tested) | `lib/finance/followup.ts` (buckets, stages, open claims, receivables matrix, CSV), `lib/finance/submission-sequence.ts` |
| Migration | `supabase/migrations/20261026000100_finance_insurance_followup.sql`, paste file `deploy/supabase-paste/25_finance_insurance_followup.sql` |

**Permissions.** `finance.followup.manage` (new; Finance and Insurance presets, granted to the existing system roles by the migration) records follow-ups. Reading the worklist, the drawer and the receivables report (and downloading the CSV) reuses `finance.claims.view` (Finance, Insurance, CEO). Billing, the Medical Director and Cost / Payroll see neither page. The settings need `finance.reference.manage`, like every other workflow setting.

**Tables.**
- `ins_claim_followups`: org, claim activity, the stage reached when recorded, outcome (`contacted`, `promised`, `resubmitted`, `disputed`, `write_off_proposed`, `paid_elsewhere`, `other`), note (at most 1,000 characters, passed through `redactText` so numbers and e-mail addresses are masked; the form asks for no patient names), next action date, created by. Append-only.
- `ins_claim_followup_stages`: one row per claim and stage the job raised (unique), the crossing date, the task and assignee, `superseded`.
- Both have RLS with select policies (`finance.claims.view` or `finance.followup.manage`) and no write policy: the action and the job use the service role after `can()`. Both carry `check_parent_org` triggers. Six new columns on `fin_ref_finance_settings`.

**SQL** (SECURITY DEFINER, `search_path = ''`, service role only, jsonb): `fin_followup_open_claims(org, today)` (the one definition of an open claim), `fin_followup_worklist(org, today, stage, payer, branch, limit)`, `fin_receivables_by_payer_age(org, today, branch)`, `fin_followup_create_tasks(org, today, now, limit)`. Pure helpers `app.fin_valid_day_steps`, `app.fin_bucket_index`, `app.fin_stage_reached` (immutable).

## The rules

- **Open** = outstanding above zero, where outstanding = net - remitted - an **approved** write-off (exactly `fin_insurance_overview`). **Evidenced** = a remitted amount or a status in `accepted_claim_statuses`, as everywhere else. A fully rejected claim stays open (it is still unpaid) and shows its rejected amount; denial cases (Phase 18) keep working it separately.
- **Age** = days from the claim's transaction date to today in the clinic's time zone (the page and the job pass the date; SQL never uses the server clock for it). A claim with no transaction date has no age: it is shown in a "No date" column and never reaches a stage. A future date counts as the first bucket.
- **Buckets** come from `ageing_bucket_days` (default `{30,60,90,120}`: 0-30 / 31-60 / 61-90 / 91-120 / 120+). **Stages** come from `followup_stage_days` (default `{60,90,120}`); the stage reached is the highest one the age has passed. Both must be strictly increasing whole days (1 to 3650; at most 8 buckets and 6 stages), checked in the database and in the form.
- **The existing ageing is unchanged.** The monthly summary, `fin_insurance_overview` and the frozen close packs keep 0-30 / 31-60 / 61-90 / 90+ (`AGEING_BUCKETS`, `parseInsuranceOverview`); a test pins that. The new buckets apply only to the two new pages.
- **Branch** is the matched Unite invoice's branch; an unmatched claim has none (it still counts in "All branches").

### Follow-up tasks (daily, OFF until a start date)

`fin_followup_create_tasks` runs inside the existing `finance_workflows` job for every org:

1. Nothing happens until `followup_start_date` is set. A stage whose crossing date (transaction date + stage days) is before the start date is never raised, so switching on does not flood historic claims.
2. Each crossed stage is claimed by inserting a `ins_claim_followup_stages` row (`unique (org, claim, stage)`, `on conflict do nothing`). The task is created in the same transaction, so the claim and the task exist together or not at all, and a retry or a second run at the same moment never raises a stage twice (tested with two concurrent connections).
3. When one run raises several stages of a claim (the job was off, or a claim arrived late), only the highest gets a task; the lower ones are stored as `superseded`.
4. **Assignee**: the person who had the claim's previous follow-up task, while still an active member of the configured role (`followup_task_role`, default "Insurance"); otherwise the role member with the fewest open follow-up tasks (ties by user id). No member in the role: the task is unassigned and counted.
5. The task subject is "Insurance claim follow-up: N days unpaid"; the notes carry the claim activity id only. No payer, amount or patient detail. Due after `followup_task_due_days` (default 3).
6. Open follow-up tasks of claims that are no longer open (paid, approved write-off) are closed.
7. `notify()` once per org and run (`finance.followup_due`, new in `lib/notify/events.ts` and `push-payload.ts`) to the holders of `finance.followup.manage`, fixed sentence and the first task id. Counts only in the audit row and the job log.

Recording a follow-up with "Close this claim's open follow-up task" ticked closes that claim's open follow-up tasks (as the person, through `createAdminClient(member.userId)` so `record_history` names them).

### Submission sequence (what the stored data supports)

Diligence's "Claim Details with Activity" report has **one row per claim activity** (its latest state). Pulse keeps that row and, for every later upload that changed it, the changed fields with old and new values (`ins_claim_activity_events`). `buildSubmissionSequence` rebuilds:

- the state before the first stored change (undoing every change, newest first);
- submission 1 at the transaction date with the initial net; one more step each time `resubmission_count` rises (dated by `last_resubmission_date`); a rise of more than one between two uploads adds steps marked "known only from the count";
- remitted per step = the rise in cumulative `remitted` while the step was current; a remittance in the same upload as a resubmission belongs to the earlier step unless its remittance date is after the resubmission date;
- **correction vs resubmission is inferred**: after something was paid, a resubmission that claims more than the unpaid balance is a correction (whole amount re-sent); one that claims the balance is a plain resubmission; with nothing paid yet the two look the same and the mode says "not in the data";
- a flag when cumulative remitted exceeds anything claimed (a correction RA may repeat what was paid), pointing the user to the bank and the remittance received.

A claim first seen after resubmissions shows submission 1 from `initial_net` / `initial_rejected`, the middle steps as unknown, and the current one from the first upload. The drawer says when the history is incomplete.

**To make the sequence exact** (OQ-102; Mohammed will send samples), a Diligence export with one row per submission / RA, with these columns (names to be confirmed against the sample; they would go into a new `lib/finance/*-mapping.ts`, never guessed):

| Needed | Why |
|---|---|
| ClaimActivityNumber (or ClaimID + ActivityID) | key to `ins_claim_activities` |
| Submission number or SubmissionDate / ResubmissionDate | order of the steps |
| ResubmissionType (eClaimLink: correction, internal complaint, legacy, reconciliation) | correction vs resubmission without inference |
| Net (claimed) per submission | amount per step |
| PaymentReference, RemittanceDate (settlement date), PaymentAmount per RA | remitted per step; ties to `ins_remittance_batches` and the bank (20C) |
| DenialCode per RA | why each step was cut |
| Optionally the RA file id / transaction id | duplicate RA detection |

No patient name, Emirates ID or member id is needed; any such column would be dropped as today.

## Receivables by age (candidate ARP report, OQ-95)

Open claims as of today, grouped by payer and age bucket: amount and count per cell, a "No date" column, payer totals and a totals row, largest balances first. The CSV has one row per payer plus TOTAL, the as-of date, both the amount and the count per bucket, and no formulas (`toCsv` neutralises `=`, `+`, `-`, `@`). It is labelled a proposal on the page until Vineetha confirms what the ARP report is.

## How it was verified

- `tests/unit/finance/followup.test.ts` (19): buckets at every edge, settings-driven labels, list validation, stages, the job's due stages, outstanding and evidence, the worklist rows of the shared fixture `followup.synthetic.json`, the receivables matrix (totals tie by payer and by bucket), CSV (headers, totals row, formula neutralising), parsing; and that the existing four-bucket ageing is unchanged.
- `tests/unit/finance/submission-sequence.test.ts` (10): five fixture histories (paid first time; balance resubmitted; correction with a repeated RA; first seen after two resubmissions; two resubmissions between uploads) plus RA dated after the resubmission, amendments, an empty claim, event order and numbering.
- `tests/unit/finance/followup-server.test.ts` (4): one notification with ids and the fixed sentence, none when nothing was raised or on error.
- `tests/unit/finance-followup-actions.test.ts` (6): the action refuses without `finance.followup.manage` (also with claim access or every other finance key) before the service role is created, validates ids, outcome, note length and dates; settings refuse without `finance.reference.manage` and refuse bad lists; the CSV route answers 401 / 403.
- `tests/db/finance-followup.test.ts` (18, Postgres 16): worklist and receivables parity with the pure rules on the fixture, filters, the bucket setting and its database check, the grant block (right roles, idempotent), RLS (Finance, Insurance and CEO read, Billing and the Medical Director do not, org B sees only its own), no direct writes, cross-org claim refused, service-role-only functions, the task step (off until a start date, 7 stages raised / 5 tasks / 2 superseded on the fixture, balanced 3 and 2, idempotent, two concurrent runs raise once, a month later the claim stays with its person, paid claims' tasks closed, tasks off, empty role leaves the task unassigned, other orgs untouched).
- `tests/db/security-guard.test.ts`: the Phase 20 tables (20A and 20I) are now in the cross-org sweep (`PHASE20_TABLES`, `seedPhase20Rows`) and the six Phase 20 functions are checked as service-role only. `tests/db/finance-phase18-rls.test.ts` knows the new key arrived later.
- `tests/unit/finance/nav.test.ts`: who sees the two pages.
- Typecheck, lint, the unit suite (191 files, 2,623 tests), the database suite (44 files, 632 tests; the PostgREST suites skip), `pnpm audit:security` (445 entry points, 0 unguarded). The paste file applied in one transaction on a database built from the earlier migrations gives the same `pg_dump` schema as the full build.

## Not verified

- Not clicked through in a browser (no Supabase auth stack here): the two pages, the drawer and the settings form were typechecked and linted only.
- No real Diligence history: the sequence rules were built from the meeting description and synthetic histories. The first real uploads will show whether `remitted` is cumulative and whether Diligence resets `rejected` on resubmission, as assumed.
- pg_cron and the delivery of the new notification (push / e-mail) were not exercised.

## Before first use

1. Apply `deploy/supabase-paste/25_finance_insurance_followup.sql` to the **Pulse** project (after 22).
2. Finance, Workflow settings, "Insurance follow-up and ageing": check the buckets and stages, choose the role that gets the tasks (default Insurance), then set "Create follow-up tasks from" to the go-live date. Leave it blank to use the list without tasks.
3. Ask Vineetha to compare Receivables by age with the manual ARP sheet (OQ-95) and Mohammed for the submission-level Diligence sample (OQ-102).

## Decisions worth knowing

- Stages and buckets age from the **transaction date** (the only date the report carries), not the submission date (OQ-103).
- One task per claim per stage, but only the highest stage when several are raised at once, so a long-off job does not create three tasks for one claim.
- A follow-up records what a person did; it never changes the claim's figures or status (Diligence stays the source) and never marks anything paid.
- The overview's and close pack's 90+ ageing were left alone so frozen packs and parity tests do not move; the configurable buckets are new and used only by the new pages.
- Follow-up notes are free text: masked with `redactText`, capped, never written to the audit log, never put in a task, push or e-mail.
