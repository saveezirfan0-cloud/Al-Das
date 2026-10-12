# Phase 18 notes: Finance and insurance upgrades

Built on branch `claude/nifty-brown-y9l5ry` (from `main` at `8d2e19e`, Phase 16 merged), 12 to 13 Oct 2026 session. Spec: `docs/10_NEXT_PHASE_PROMPTS.md`, Prompt 18, on top of `docs/05_FINANCE_MODULE_PLAN.md` and the Finance section of `CLAUDE.md`. Everything was built in a cloud sandbox with a plain Postgres 16 (pgvector, PostgREST), no browser, no Supabase Auth stack, no Unite and no WhatsApp. **Unite was never called**: no code, script or test in this phase reaches it, and `tests/setup.ts` still blocks the host.

## What exists

Each feature has its own `finance.*` permission. The Finance side menu (`lib/finance/nav.ts`) shows an entry only to a member who holds one of its permissions; the shell's Finance item appears for any of them.

| Spec item | Permission | Where it lives |
|---|---|---|
| Pre-authorisation tracker | `finance.preauth.manage` | `/finance/preauth`; table `fin_pre_authorisations` (PIN, payer, status, requested / approved / expiry dates, approved amount, links to appointment, invoice and claim); rules in `lib/finance/preauth.ts`. The nightly `finance_workflows` task expires lapsed approvals and opens one task per authorisation before it expires (lead days in settings, atomic claim of `expiry_notified_at`). Services can be flagged "requires pre-authorisation" in Reference data |
| Eligibility step, "not ready to bill" | `finance.eligibility.manage` | `/finance/eligibility`; `fin_eligibility_checks` (payer, validity window, status, the insurance card as a Phase 16 document id), view `v_fin_billing_readiness`. The rule is pure (`lib/finance/bill-readiness.ts`) and parity-tested against the SQL with `phase18-readiness.synthetic.json`. Blank or unknown data is not ready (fails closed). Listing a patient's cards also needs `documents.view` |
| Denial management | `finance.denials.manage` | `/finance/denials`, `/finance/denials/[id]`; `ins_denial_cases`, `ins_denial_notes`, `ins_appeal_drafts`; reason-code taxonomy `fin_ref_denial_codes` (exact code, then family, then default; starter rows are placeholders); owner, status workflow, resubmission deadline countdown; a deadline task (atomic claim of `deadline_notified_at`) |
| AI-drafted appeal | `finance.denials.manage` (and the org's AI switch, `ai.use` rate limit) | `lib/finance/appeal.ts`, `appeal-server.ts`, `lib/ai/prompts/appeal.ts`. The prompt carries only claim and invoice numbers, payer id, CPT, denial code, amounts and dates. The app, not the model, adds the DRAFT banner. A deterministic template is used when the model is off, fails or the rate limit is hit. **Nothing sends the letter**: "Mark as sent" only records that a person did it elsewhere |
| Remittance reconciliation | `finance.remittance.manage` | `/finance/remittance`, `/finance/remittance/[batchId]`; upload `.xlsx` or `.csv` (`parse-remittance.ts`, columns named only in `remittance-mapping.ts`), sanitised lines staged in `fin_staged_remittance_lines`, original deleted at once (`fin_raw_remittance_files` is service-only, sha256 kept), preview, atomic commit into `ins_remittance_batches` / `ins_remittance_lines`. Pure matcher `lib/finance/match-remittance.ts` (activity number, else invoice + CPT narrowed by quantity and amount; ambiguous is never guessed). Short payments are measured against `fin_ref_payer_prices` (the lesser of billed and agreed) with an amount tolerance AND a percentage tolerance. Payer prices are imported from pasted CSV in Workflow settings |
| Payer scorecards | `finance.scorecards.view` | `/finance/scorecards`; SQL function `fin_payer_scorecard` (denial rate, days to pay, top reasons, by doctor and department), traffic lights in `lib/finance/scorecard.ts`; a payer with fewer claims than the minimum is never coloured |
| Collections forecast | `finance.forecast.view` | `/finance/forecast`; `lib/finance/forecast.ts` (pure): per-payer payment lag percentiles and collection rate from history, remaining slices re-weighted by claim age, org defaults (marked "assumed") for thin history. Weekly buckets over the configured horizon. No machine learning |
| Self-pay WhatsApp reminders | `finance.recovery.manage` to run, `finance.recovery.approve` to approve the tone | `/finance/recovery`; `lib/finance/recovery.ts`, `recovery-server.ts`, `recovery-approval.ts`; `fin_recovery_reminders` (unique per invoice and sequence). **OFF by default.** Needs an approved template mapped, a finance tone approval bound to a hash of the template wording (a changed wording resets it), then an administrator switches it on. Recipient through `resolveRecipient()` (a guardian for a dependant), only with `promotions_opt_in` and not `stop_marketing`, template only, through `queueOutbound`, so the 24 h guard, rate limit and training mode apply. Preview ("dry run") and "Run now" are separate buttons |
| Month-end close pack | `finance.close.view`, `finance.close.manage`, `finance.close.signoff.finance`, `finance.close.signoff.ceo` | `/finance/close`, `/finance/close/[month]`, `GET /api/finance/close/[month]/pack?format=xlsx|pdf`; `fin_period_closes`, `lib/finance/close-pack.ts`, `close-xlsx.ts` (exceljs), `close-pdf.ts` (pdf-lib, new dependency, loaded only inside the route). The snapshot is aggregates only and is hashed. Finance signs, then the CEO signs the same hash, a different person, and that locks the month. The files are always rendered from the stored snapshot |
| End-of-day cash-up per branch | `finance.cashup.manage` | `/finance/cashup`; `fin_cashups`, `fin_cashup_lines`, `lib/finance/cashup.ts`; expected amounts by payment mode from stored payments, counted amounts, a reason required when the difference is beyond the tolerance, submit freezes it, reopen is audited |
| Revenue views | `finance.revenue.view` | `/finance/revenue` and `GET /api/finance/revenue` (CSV, audited); by doctor, department, branch, service and payer, with the previous period; SQL aggregates return jsonb (no row cap) |
| One-way accounting export | `finance.export.run` | `/finance/export`, `GET /api/finance/export/accounting`; `lib/finance/accounting-export.ts` builds balanced journals (one per day, branch and invoice type: sales, receipts, refunds) as CSV; account mapping in `fin_ref_account_map`; the VAT rate and rounding go to visible accounts, never hidden; `recordExport` and a row in `fin_accounting_exports` per file; nothing is read back |

### What "locked" means

Enforced in the database for every role including the service role (`20261016000600`): a close row, its snapshot and its sign-offs cannot change or be deleted once signed by the CEO; the hash is re-checked at lock time; the CEO cannot be the person who signed for finance; cash-ups dated in a locked month cannot be inserted, changed or deleted. **The Unite and Diligence mirrors are deliberately not blocked.** Unite delivers each record once and may re-send an amended invoice, so refusing it would lose data. A late change to a locked month is stored but never alters the frozen pack; the close page shows the drift between the live figures and the snapshot.

### Settings

One row per org in `fin_ref_finance_settings` (Finance, Workflow settings; `finance.reference.manage`). Every threshold in this phase reads from it; none is hardcoded in a rule. Defaults are placeholders, listed under "Open questions".

### Migrations (new, `20261016000100` to `…700`)

| File | Content |
|---|---|
| `…100_finance_upgrades_foundation` | 15 new permission keys granted to the existing finance roles (idempotent), `fin_ref_finance_settings`, `fin_ref_denial_codes`, `fin_ref_payer_prices`, `fin_ref_account_map`, `requires_preauth` on `fin_ref_services` |
| `…200_finance_preauth_eligibility` | pre-authorisations, eligibility checks, `v_fin_billing_readiness`, state machine and expiry functions |
| `…300_finance_denials` | denial cases, notes, appeal drafts, `fin_sync_denial_cases` |
| `…400_finance_remittance` | raw and staged remittance files (service only), batches, lines, preview / commit functions, `ins_claims_for_remittance` |
| `…500_finance_analytics` | scorecard, forecast inputs, revenue and journal source functions (SECURITY DEFINER, `search_path = ''`, service role only, jsonb) |
| `…600_finance_close_cashup` | close and cash-up tables, the lock triggers, build / sign / withdraw functions |
| `…700_finance_recovery_export` | reminder and export tables, the `pulse:finance_workflows` cron entry (daily 03:50 UTC) |

Every table has RLS and an `org_id` policy (select only for browsers; every write is a server action or job using the service role after `can()`); the three raw or staging tables have RLS and no policies and are in the service-only list of `tests/db/security-guard.test.ts` with a reason. `record_history` is attached to pre-authorisations, eligibility checks, denial cases and period closes (`lib/security/history.ts`, `can_view_record_history()`), and the actions that write them use `createAdminClient(member.userId)`.

### Other changes outside the new files

`lib/notify/events.ts` and `push-payload.ts` have two new events (pre-authorisation expiring, denial deadline) with fixed generic text and ids only. `lib/jobs/handlers/finance-workflows.ts` registers the `finance_workflows` task. `lib/ai/types.ts` gains the `appeal_draft` feature (content-free usage rows). `components/shell/nav.ts` lists the new permissions. `app/(app)/finance/layout.tsx` and `page.tsx` use `lib/finance/nav.ts`. A help guide (`finance-workflows`) and a what's-new entry were added. `pdf-lib` is a new dependency (small, pure JS, no network, no native build); `exceljs` and `unpdf` were already present.

## How it was verified

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm test` | **161 files / 2,087 tests pass** (was 147 / 1,824); 50 database test files are skipped without `TEST_DATABASE_URL` |
| `bash scripts/test-db.sh` then `pnpm exec vitest run tests/db` with PostgREST | **50 files / 708 tests pass** (was 43 / 613). New: `finance-phase18-rls`, `finance-preauth-eligibility`, `finance-denials`, `finance-remittance`, `finance-analytics`, `finance-close-cashup`, `finance-workflows-service` (20 tests through PostgREST), plus additions to `security-guard` and `jobs` |
| `pnpm build` (placeholder Supabase env) and `pnpm bundle:check` | Build passes; budgets OK with **no budget raised**. The heaviest new page is `/finance/remittance` at 203 kB first load (default budget 215); PDF and XLSX libraries are imported only inside the download route and server code |
| `pnpm audit:security` | 398 entry points, 0 unguarded and unreviewed (every new action calls `requirePerm` or `can` through a `gate()` function declaration; every mutating one calls `recordAudit`) |
| Paste file | `deploy/supabase-paste/18_phase_18_finance_upgrades.sql` applied in one transaction on a database built from the 61 pre-Phase-18 migrations; its `pg_dump` schema equals the full build's |

What the tests cover:

- **Pure rules with synthetic fixtures** (`tests/unit/finance/fixtures/phase18-*.synthetic.json`): readiness, denial taxonomy and deadlines (parity with SQL), remittance matching and short-pay boundaries, forecast percentiles and re-weighting, journal balancing and rounding, close snapshot and drift, recovery eligibility, tone-approval hash.
- **Output files**: the XLSX is written and read back with exceljs; the PDF is rendered and its text extracted again with `unpdf` to prove the DRAFT/sign-off wording and figures are in the file.
- **Permissions**: every action is refused before the service role is created for a member who holds every other finance key (`tests/unit/finance-phase18-actions.test.ts`, 116 cases), finance and CEO sign-off keys are not interchangeable, tone approval is not the same key as running reminders, download routes answer 401 and 403, the nav shows exactly what each preset may open.
- **Database**: cross-org RLS for every new table (seeded so the sweeps are not vacuous), browser writes refused, the close lock and the two-person rule (including as the service role), cash-up locking, the permission data migration (idempotent, right roles only), SQL state machines, the nightly task, recovery guards and idempotence, a payment advice built in the test, the appeal service with a fake model.

## NOT verified

- **Nothing was seen in a browser or on a phone.** Twelve new pages and their forms were typechecked, linted, built and rendered to markup in a few tests, not clicked. Please click through each as Finance, Billing, Insurance, CEO and Medical Director.
- **Unite**: never called, by design. How the real invoice, payment and refund fields look is still the F2 mapping question. The journal export and revenue views read what is already stored.
- **Real payer files**: no payer payment advice and no real price list was available. The column names in `lib/finance/remittance-mapping.ts` are guesses from common Diligence-style layouts; an unknown header fails the file closed with a message naming the column. The first real file will probably need a mapping edit.
- **Real PDF fidelity**: the PDF text and figures are checked by extracting text; the layout (page breaks, wrapping of long payer names, fonts, Arabic) was not looked at. Standard Helvetica is used, so non-Latin names would not render.
- **Real WhatsApp**: reminders ran against the outbound queue with a stub; no template was approved by Meta, and a payment-reminder template may be classified by Meta as Utility or Marketing, which changes cost and the opt-in rule.
- **AI quality**: the appeal prompt was exercised with a fake model only. No real model output was read.
- **Accounting package import**: the CSV was balanced and parsed back, but never imported into Zoho Books, QuickBooks or any ledger. Column order and date format may need a one-line change.
- **pg_cron** for `pulse:finance_workflows` (the harness has a stub) and push or e-mail delivery of the two new events.
- **Performance** with a full year of real invoices: the analytics are SQL aggregates returning jsonb, measured only on small synthetic data.
- **Types** were not produced by the Supabase CLI (generated from the test database and formatted with prettier). Run the drift check on a real stack.

## Decisions and deviations worth knowing

1. **The lock does not stop Unite or Diligence mirrors** (see above). A frozen pack is immutable; live figures can still drift and the page says so.
2. **The original remittance file is deleted** after parsing, as with Diligence, because it can carry names. Only sanitised rows and the sha256 stay.
3. **Appeal drafts are never sent** and there is no send button. "Mark as sent" is a record that a person sent it by their own means.
4. **Recovery uses `promotions_opt_in`** (the same opt-in as campaigns), not a separate payment-reminder consent. If the clinic's legal view is that an overdue-invoice notice is transactional, that is a policy change (OQ-76).
5. **Cash-up expectations come from stored Unite payments by payment mode** for the branch and day. A mode the cashier counts that Unite did not record gets a line with expected 0; a mode with nothing counted must be entered as 0 before submitting.
6. **Scorecards, forecast and revenue use the claim and invoice dates stored in the mirrors**; they are as accurate as the mirror.
7. **Starter denial codes and payer price rows are placeholders** (`is_placeholder`) and are labelled as such in the UI until finance replaces them.
8. **Migration `…400` was amended once** after its first commit (adding `ins_claims_for_remittance`) because it had not been applied anywhere; the paste file contains the final version.
9. **Not built from the roadmap wording:** payment links, instalment tracking and the patient estimate generator are listed in `docs/09` section 4 but not in Prompt 18, so they are still open.
10. **Eligibility is a manual step.** There is no payer portal integration and no automatic card reading.

## Open questions

OQ-72 to OQ-77 in `docs/audit/open-questions.md`. The ones that change behaviour: **who owns each denial reason's resubmission window (OQ-72)**, **the real denial code lists per payer (OQ-72)**, **payer price lists and who maintains them (OQ-73)**, **whether overdue-invoice reminders need the marketing opt-in (OQ-76)**, and **the chart of accounts for the accounting export (OQ-75)**. Placeholder values Sharaf and finance must confirm (all editable at Finance, Workflow settings):

| Setting | Placeholder |
|---|---|
| Pre-authorisation task lead time | 7 days before expiry |
| "Not ready to bill" grace after the visit | 1 day; the check is off until a start date is set |
| Default resubmission window, warning before it | 30 days, warn 7 days before; denial cases are off until a start date is set |
| Short payment tolerance | more than 1.00 AND more than 1 % |
| Scorecard minimum sample, denial rate warn / alert | 20 claims, 10 % / 20 % |
| Scorecard days to pay warn / alert | 60 / 90 days |
| Forecast horizon, default lag, default collection rate, minimum history, tail | 13 weeks, 60 days, 90 %, 30 paid claims, 4 weeks |
| Cash-up variance that needs a reason | 5.00 |
| Reminders: minimum balance, days overdue, gap, maximum, batch | 50.00, 14 days, 14 days, 3 reminders, 50 per run |

## Before first use on the real stack

1. Apply `deploy/supabase-paste/18_phase_18_finance_upgrades.sql` to the **Pulse** project only (check the project name first), or `supabase db push`. Run it after the Phase 16 file.
2. The migration grants the new keys to the existing Finance, Billing, Insurance, CEO and Medical Director roles; `pnpm finance:seed --org=<slug>` creates them in an org that lacks them. Check Settings, Roles once; custom roles need the new keys added by hand.
3. Open Finance, Workflow settings and review every value above; set the start dates for "not ready to bill" and denial cases only when you want them to begin. Replace the placeholder denial codes and load the payer price lists.
4. Leave self-pay reminders OFF until finance has read the template wording and pressed "Approve tone", and the template is approved in Meta.
5. Click through each page as the five finance roles, build a close pack for a past month with synthetic or test data first, and open the PDF and XLSX by eye.
6. Do not run any Unite call for this work. Finance capture stays OFF until the F2 go-live runbook is done.
