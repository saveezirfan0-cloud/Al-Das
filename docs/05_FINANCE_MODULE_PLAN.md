# Finance & Insurance module — plan and status

Module of Pulse. Goal: every Unite invoice captured, matched to its appointment and insurance claim lines, tracked through to payment, with exceptions routed to the right person.

**Out of scope for now:** dashboards (tables and a monthly summary only), cost/profitability (needs Finance/payroll exports), clinical completion tracking. Existing Airtable/Make patient automations keep running until the platform replaces them.

Phases are named **F0–F6** so they do not clash with the platform phases in `02_CLAUDE_CODE_BUILD_PLAN.md`. Work one phase at a time, each starting in Plan Mode.

| Phase | Scope                                                                      | Status                                                              |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| F0    | Docs, reconciliation with CLAUDE.md, open items                            | done                                                                |
| F1    | Schema, RLS, roles, permissions, data-health skeleton                      | done                                                                |
| F2    | Unite capture: token manager, guarded handler, `fin_process_batch`, replay | not started (blocked on the human steps in `finance/open-items.md`) |
| F3    | Appointments sync, rule E08                                                | not started                                                         |
| F4    | Diligence upload, validation, preview, commit, matching                    | not started                                                         |
| F5    | Exception rules E01–E10, queue UI, invoices/claims/summary screens         | not started                                                         |
| F6    | Review with management, user guides, monitoring alerts                     | not started                                                         |

## 1. Sources and known behaviour

### Unite Finance API (live production, **deliver-once**)

- `POST https://ucexternalapiprod.uniteuae.care/gateway/GetFinanceDetails`, header `Authorization: Bearer <access_token>`, body `{"fromDate":"dd-MM-yyyy","toDate":"dd-MM-yyyy","count":<n>}`.
- Response: `MessageStatus`, `DetailMessage`, `DataBalancetoSync` (remaining in range), `OverallDataBalancetoSync`, `Data[]` (invoices with `ItemsDetails[]` and `PaymentDetails[]`).
- Confirmed by Unite (8 Oct 2026): each record is marked synced when fetched and never returned again; any edit (amendment, IsDeleted, credit, refund, later payment) re-queues the invoice; `fromDate`/`toDate` filter on **transaction date** so every pull must use a wide range (`01-01-2026` → today); Unite can re-queue any records (the 12 test records ADMC/C/44447–44458 need it); no other consumer and no rate limit; `AppointmentId` equals the Appointments API `appointmentid` and is empty for direct invoices (valid); `ActualCostPrice` is 0 everywhere (costs come from Finance later).
- Pending from Unite: field list and enums (`RefType`, `InvType`, `ItemType`, `PaymentMode`), payer/TPA/member/claim fields, an invoice line ID, whether a modified timestamp exists.

### Auth (copy the flow from Make scenario "Token", id 3576415)

- Authorize: `GET /gateway/authorize?app_id=…&app_key=…` with `Authorization: Bearer <current access token>`.
- Refresh: on `Message = "Token Expired"`, `POST /gateway/refreshtoken` with body `{app_id, app_key, token:<access>}` and `Authorization: Bearer <refresh token>`.
- Authorize and refresh use different app_id/app_key pairs. Store them encrypted (AES-256-GCM, `ENCRYPTION_KEY`), never in code or logs.
- **Token coexistence with Make** (shared Make data store 61544) must be tested by a human before F2 go-live; see `finance/open-items.md`.

### Unite Appointments API

`getallappointments` by clinic and date range, to validate `AppointmentId` and later for utilisation and no-shows.

### Diligence (insurance)

No API. Sharaf downloads the claims report ("Claim Details with Activity", sheet `DataSheet`, 70 columns, one row per claim activity) and uploads the `.xlsx`. Production uploads must be **unfiltered: all claims, all statuses, from 01-01-2026**, weekly and at month-end.

## 2. Architecture (adapted to the Pulse stack)

```
pg_cron (hourly) ─► /api/jobs/finance_capture        (job handler, queue finance_capture)   [F2]
                      0. org setting fin_capture_settings.enabled must be true (default false)
                      1. take the lease (fin_capture_try_lease): one consumer only
                      2. get a valid token (authorize/refresh)
                      3. call GetFinanceDetails (window_from → today, batch size N)
                      4. INSERT the raw payload into fin_raw_unite_batches BEFORE any parsing
                      5. fin_process_batch(batch_id): idempotent, replayable from raw
                      6. loop while DataBalancetoSync > 0 and the time budget allows; log to job_runs; alert on failure
pg_cron (daily)  ─► /api/jobs/unite_sync              appointments rolling window            [F3]
Portal upload    ─► server action: parse xlsx → validate → preview → confirm → import         [F4]
pg_cron (daily)  ─► exception rules                                                            [F5]
Next.js portal   ─► Supabase (RLS by permission) ─► v_fin_* views
```

Rules: raw first (if the raw insert fails, process nothing, raise a critical alert and ask Unite to re-queue that batch); all processing reads from raw so any batch can be replayed and the finance tables rebuilt; one consumer only (lease row, because session advisory locks do not survive pooled connections); small batches within the function time budget.

### Differences from the original brief

| Brief                                                                   | Built as                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge Functions                                                          | Job handlers on pgmq queues driven by pg_cron → `/api/jobs/<queue>` (CLAUDE.md stack)                                                                                |
| Schemas `raw/ref/appt/fin/ins/ops/rpt`, no org column                   | `public` tables with prefixes and `org_id` + RLS on every table (CLAUDE.md rule 1): `fin_raw_*`, `fin_ref_*`, `fin_*`, `ins_*`, `ops_*`, views `v_fin_*` / `v_ins_*` |
| Advisory lock                                                           | `fin_capture_lease` row, claimed through `fin_capture_try_lease`                                                                                                     |
| Fixed roles (admin, ceo, finance, billing, insurance, medical_director) | Role presets over `finance.*` permission keys (`FINANCE_ROLES` in `lib/auth/permissions.ts`; `pnpm finance:seed --org=<slug>` for existing orgs)                     |
| `ops.audit_log`                                                         | The existing `audit_log` table                                                                                                                                       |
| `appt.appointments`                                                     | Decided in F3: the platform `appointments` table if it exists, otherwise a thin reference table                                                                      |
| Feature flag                                                            | Per-org `fin_capture_settings.enabled`, default **false**                                                                                                            |

### F7 as built (UI polish)

- **Monthly summary:** headline cards with change against the previous period of equal length (rises in Rejected / Outstanding are not shown as good news), quick-range chips, branch / department / doctor selects, generated-vs-remitted trend, outstanding-by-age, top denial reasons, claims by payer, revenue grouped by department / doctor / service / branch, month rows that drill down to Invoices, and a "data as of" line. Charts are server-rendered bars (no chart library); every value is also in a table.
- **Setup checklist** (`lib/finance/readiness.ts`) on the empty Summary and on Data health: credentials, branch mapping, capture on, first invoices, first Diligence import, rules active.
- `v_fin_data_freshness` (migration `…001000`): dates, counts and yes/no flags only, gated by `finance.view`, so Summary users need no Data-health permission. Exceptions tab shows an open-count badge. Shared formatters in `lib/finance/format.ts`.
- Not yet click-tested in a browser against live data.

### F6 as built

- **Alerts** (`lib/finance/alerts.ts`, hourly `pulse:finance_alerts` → `finance_capture` queue kind `alerts`; never calls Unite): `capture_failed` (unprocessed / failed batch or open capture exception, critical), `capture_stalled` (balance not dropping, critical), `capture_silent` (no capture for more than 3 h = warning, more than 6 h = critical), `no_diligence_upload` (more than 8 days, warning; only once the module is in use), `overdue_exceptions` (info, above 20). Sent in-app to everyone with `finance.capture.manage`; critical ones and their "resolved" notices also by e-mail. Each problem is announced once, again if it gets worse, reminded after 24 h while it lasts (warning and critical), and a critical one that clears sends one resolved notice. State lives in `fin_alert_state` (service role only). Texts hold counts and times only.
- Data health shows the active alerts, and has an on / off switch for the daily exception digest.

### F5 as built

- **Rules engine** `fin_run_exception_rules(org)` (SQL, set-based, idempotent) reads thresholds from `fin_ref_exception_rules`. It opens what should be open (capped at 1,000 new per rule per run), and auto-closes whatever no longer applies. Daily in the maintenance job, after every Diligence commit, and from "Run rules now". E06 (import), E07/E09 (processing, capture failure) and E10 (invalid file) are raised where they happen; the engine adds a safety net for E07 and the invoice-number gap check for E09.
- **Guards, so a rule never floods the queue with false alarms:** E01 only when a Diligence file was committed in the last 14 days; E02 and the E09 gap ranges only when the last Unite batch left nothing waiting; E08 only for invoices dated after the first synced appointment. Insurance invoice = `fin_is_insurance_type()` (one SQL definition).
- **Due dates** come from `fin_ref_exception_rules.due_days` (default 7) via a trigger; overdue rows are highlighted. **Digest** (`fin_capture_settings.digest_enabled`, default off): one e-mail per member with counts per rule, no identifiers, queued on the `notifications` queue.
- **Screens:** `/finance/exceptions` (filters, overdue, mine / unassigned; detail with what it means, what to do, assign, take, comment, close with a required note), `/finance/invoices` (+ detail with lines, payments, claims, version history, appointment, patient link), `/finance/summary` (month × branch table with totals, revenue by department / doctor / category, CSV export). Views: `v_fin_invoice_list`, `v_fin_revenue_monthly`.
- **Data health** gains the AppointmentId resolution rate (target above 95%) and open exceptions per rule.

### F2.1 and F4 as built

- **F2.1 fixes.** A duplicate invoice inside one batch keeps the last occurrence (the count is reported, the batch is never blocked); a replay never blanks `txn_ref_name`; first live runs default to **1 batch per run**; a daily `pulse:finance_maintenance` message (kind `maintenance`, same queue) strips personal data from raw payloads older than 90 days (allowlist: only keys the mapper knows survive, replay-equivalence is tested), re-matches unresolved claims and purges unconfirmed staging older than 7 days. Reference data (branches with Unite clinic names, service categories, doctors, rule thresholds) is edited at `/finance/reference`.
- **Diligence import** (`lib/finance/diligence-*.ts`, `parse-diligence.ts`, `diff-claims.ts`, `match-claims.ts`): browser uploads straight to a private Storage bucket via a signed URL; the server reads it with `exceljs`, validates (required columns, per-row dates/numbers, duplicate claim numbers; errors carry row numbers and codes, never values), stages only the sanitised rows in `ins_staged_activities`, and **deletes the original file** (it holds names and Emirates IDs; only its sha256 is kept to block duplicates). The preview shows new / changed / unchanged / missing-since-last-file, sums, changed-field counts and warns when the file looks filtered (more than 20 % of the previous file missing). Confirm runs one atomic `ins_commit_import` (upserts, per-field change events, payers, E06 for missing claims unless switched off, E06 closes itself when a claim reappears). Limit: 30,000 rows per file (one atomic call).
- **Matching** is pure and deterministic (`match-claims.ts`): invoice by normalised number, line by code (claim CPT = line CPT or item code) and amount within 0.01 (compared in whole cents), duplicates paired in order with quantity first, otherwise `ambiguous`; `match_reason` (`no_invoice`, `invoice_deleted`, `no_line`, `amount_mismatch`, `ambiguous`, `quantity_mismatch`, `ok`) feeds E02/E03 in F5. It runs after every commit and daily for unresolved claims, so late-arriving invoices attach by themselves.
- **Screens**: `/finance/upload` (flow + history), `/finance/claims` (filters, paging) and `/finance/claims/[id]` (all fields, status-history timeline), `/finance/reference`.

### F2 as built

- **Scheduling.** `pulse:finance_capture_tick` (hourly, `fin_capture_enqueue_ticks`) enqueues one `{kind:'tick', org_id}` per org with capture enabled and no tick already queued; `pulse:finance_capture` pings the queue every 30 s. The F1 hourly ping alone would never have run anything because the handler drains queued messages.
- **Handler** `lib/jobs/handlers/finance-capture.ts` → `runCaptureForOrg` → `runCapture` (`lib/finance/capture.ts`, all effects injected). It does nothing unless `fin_capture_settings.enabled`, takes the lease, **first reprocesses any unprocessed raw batch and refuses to pull while one still fails**, then loops: call → store raw (3 attempts) → process. It stops at balance 0, an empty page, `max_batches_per_run`, the time budget (45 s), a failed process or raw insert, an unknown call outcome (E09 "lost response"), or two consecutive non-decreasing balances (E09 "stalled balance").
- **Mapping is TypeScript, not plpgsql** (`lib/finance/unite-mapping.ts` aliases + `map-invoice.ts`), because Unite's real field names are still unknown. Required fields (invoice number, transaction date, gross, net, total, IsDeleted; line item code and net) that are missing, blank or unparseable fail the whole batch closed; the raw payload is kept and `pnpm finance:replay` (or "Reprocess" on the Data health page) recovers it after the mapping is fixed. Blank never becomes 0 or false. Only normalised fields reach `fin_invoice_versions` (no patient names, no `txn_ref_name`).
- **SQL** `fin_apply_invoices` applies one batch in one transaction: version bump only when the record hash changes, lines and payments upserted by key and flagged not current when absent (never deleted), reference data filled blank-only, E07 opened/auto-closed, a replay of an older batch never overwrites newer state, an unchanged re-delivery touches nothing.
- **Unite client** (`lib/unite/`): token manager (authorize → refresh on `Token Expired`, cached for at most 240 s, safety margin 30 s), and the only code that calls `GetFinanceDetails`. It never retries the finance call except once after a body-level token rejection; a transport failure after sending is reported as an unknown outcome, not retried.
- **Credentials** live encrypted (AES-256-GCM, `lib/crypto.ts`) in `integration_accounts`; the Data health page has a write-only form, capture settings, the enable switch (type ENABLE) and maintenance buttons. Every call is logged to `unite_api_calls` (no bodies).
- **Tests never reach Unite**: `tests/setup.ts` makes `fetch` throw for the Unite host.

## 3. Data model (built in F1)

Migrations `20261009000100`–`500`. Natural keys are per org (`unique (org_id, …)`).

- **Raw (service role only: RLS on, no policies):** `fin_raw_unite_batches` (payload, sha256, counts, `process_status`), `fin_raw_diligence_files` (unique `file_sha256` per org blocks duplicates), `fin_capture_settings`, `fin_capture_lease`.
- **Reference (admin-maintained, `finance.reference.manage`):** `fin_ref_branches` (seeded P/M/G; Unite clinic names to be confirmed from the first pull), `fin_ref_doctors`, `fin_ref_services` (new codes default to `Unmapped`; internal codes such as `T-100007` are not CPT), `fin_ref_payers`, `fin_ref_exception_rules` (E01–E10 seeded with owner role and thresholds). Seeded for every org by trigger.
- **Invoices:** `fin_invoices` (current state, `version` bumps only when `record_hash` changes, generated `inv_key` for case/whitespace-insensitive matching), `fin_invoice_versions` (one row per delivery, PII stripped), `fin_invoice_lines` (`line_key = inv|item_code|occurrence`; never deleted, `is_current=false` when absent from a re-delivery), `fin_payments` (`payment_key = inv|instalment|receipt`).
- **Insurance:** `ins_claim_activities` (current state; EmiratesID, MemberID, Resubmission/Remittance comments are **not** imported; DenialComment is kept), `ins_claim_activity_events` (one row per change).
- **Exceptions:** `ops_exceptions` (one open exception per `(rule_code, entity_key)`; a manual close needs a note), `ops_exception_comments`.
- **Views (single definition of every number):** `v_fin_revenue_daily` (line grain so service category is exact), `v_fin_adjustments_daily` (write-offs, credit notes at invoice grain), `v_fin_collections_daily`, `v_fin_claims_status`, `v_fin_receivables_ageing` (0–30 / 31–60 / 61–90 / 90+), `v_fin_denials`, `v_fin_monthly_summary`, plus `v_ins_invoice_match` / `v_ins_invoice_line_match` (the invoice fields Insurance needs). Current, non-deleted invoices and current lines only.

### Access (RLS, via `app.has_perm`)

| Permission                  | Grants                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `finance.view`              | `v_fin_*` aggregates                                             |
| `finance.invoices.view`     | invoices, versions, lines, payments, billing exceptions          |
| `finance.claims.view`       | claims, events, insurance exceptions, `v_ins_*` matching views   |
| `finance.claims.import`     | Diligence upload (F4)                                            |
| `finance.exceptions.manage` | comment on and close exceptions in the queues the member can see |
| `finance.reference.manage`  | edit reference data                                              |
| `finance.capture.manage`    | data health, admin-owned exceptions                              |

Presets: **Finance** (reports, invoices, claims, reference), **Billing** (invoices, exceptions), **Insurance** (claims, upload, exceptions), **CEO** (read-only everything), **Medical Director** (reports). Admin (`*`) holds everything. An exception is visible to members who can see its owner role's data (insurance → claims, billing → invoices, finance → reports, admin → capture).

Writes to finance data come only from capture/import jobs (service role after `can()` checks); members cannot write invoices, claims or raw data directly.

## 4. Processing logic (F2 / F4)

### `fin_process_batch(batch_id)` (idempotent)

For each element of `payload->'Data'`: derive `branch_code` from `fin_ref_branches` by clinic long name (unknown → null, rule E07); upsert the invoice on `inv_display_number`, bumping `version` only if the hash changed; insert the version row; upsert lines on `line_key` and mark missing ones not current; upsert payments on `payment_key` and mark missing ones not current; upsert doctors and services (new services `Unmapped`). Mark the batch processed with per-table counts. Invoices processed must equal `record_count`, otherwise rule E09.

### Diligence import

Validate (70 expected headers, extra columns logged, no duplicate `ClaimActivityNumber`, dates parse, totals) → preview (rows, date range, totals, new / changed / unchanged / missing-since-last-file; nothing written) → on confirm: upsert activities, write events for changed fields, raise E06 for rows missing from the latest file, run matching.

Matching: claim → invoice by normalised `InvoiceNo` = `inv_display_number` (`lib/finance/keys.ts`); claim → line by invoice + CPT (or item) code + amount within 0.01; one candidate → matched, several → assign in order by quantity and position, still ambiguous → `ambiguous` (E03), none → `unmatched`. `Clinician` (DHA id) should equal the invoice doctor; `OrderingClinician` is kept separately; reports default to the performing doctor (management decision pending).

Appointment link: `appointment_id` must exist in appointments, otherwise E08; empty is valid.

## 5. Exception rules (daily; thresholds in `fin_ref_exception_rules`)

| Code | Rule                                                                      | Owner                              |
| ---- | ------------------------------------------------------------------------- | ---------------------------------- |
| E01  | Insurance invoice with no claim activity after N days (default 30)        | Insurance                          |
| E02  | Claim activity with no matching Unite invoice                             | Insurance + Billing                |
| E03  | Claimed amount differs from invoiced line amount, or ambiguous line match | Billing                            |
| E04  | Rejected / partially rejected, not resubmitted after N days               | Insurance                          |
| E05  | Outstanding balance older than N days                                     | Insurance (Finance has visibility) |
| E06  | Claim in the previous Diligence file but missing from the latest          | Insurance                          |
| E07  | Unknown clinic / branch on an invoice                                     | Admin                              |
| E08  | AppointmentId not found in appointments                                   | Admin                              |
| E09  | Capture failure, count mismatch, or gap in the invoice number sequence    | Admin                              |
| E10  | Diligence file failed validation                                          | Insurance                          |

Rules auto-close when the condition clears; a manual close requires a note; overdue exceptions are highlighted. Defaults seeded: E01 30, E04 14, E05 60 days (to be agreed with Sharaf and Finance in F5).

## 6. Portal screens (no dashboards in v1)

Under `/finance`: Monthly summary, Invoices, Claims, Insurance upload, Exceptions, Data health, Reference data. F1 ships the shell and a working Data health page; the others are placeholders gated by their permission.

## 7. Security and data handling

- Finance and insurance tables hold the **Unite patient PIN only**; names, DOB, contacts and Emirates ID stay in the raw payload (service role only). Patient identity lives in `contacts` (PIN in `external_id`).
- After a batch is processed and reconciled (about 90 days) PII keys are stripped from the payload, keeping the financial fields so replay still works (`payload_stripped_at`).
- Diligence files go to a private Storage bucket; excluded columns are dropped at parse time.
- **No real patient data anywhere in the repo** (CLAUDE.md rules 10 and 16): fixtures are hand-built synthetic records. The two full Unite test records in Make data store 167670 and the 445-row Diligence sample are used only locally to confirm shapes, never committed.
- Audit log (`audit_log`) for uploads, mapping changes and exception closures.

## 8. Testing

`tests/db/finance-rls.test.ts` (tenant isolation, role matrix, raw invisibility, constraints, views, lease) and `tests/unit/finance/*` run in F1. F2 adds: idempotent re-processing, kill-after-raw replay, synthetic edits (amended amount, deleted, refund, extra instalment). F4 adds matching unit tests (single, duplicate, missing line; CPT vs internal code; amount tolerance) and the duplicate-upload block.
