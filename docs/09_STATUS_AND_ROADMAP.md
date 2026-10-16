# Pulse: status, gaps and product roadmap

_Snapshot: 10 Oct 2026. Branch `claude/compassionate-mayer-fx0usn`. Written for Saveez (owner) and for Claude Code, which reads it at the start of each new session._

This is the single document to work from. Section 1 says where we are, 2 says what engineering work is left, **3 is the list of things only you can supply (keys, accounts, answers)**, 4 and 5 are the product improvements and the plan to deliver them, and 6 to 9 cover going live, demos, training recordings and the next actions. The copy-paste prompts for the next phases are in `docs/10_NEXT_PHASE_PROMPTS.md`. Client-facing material is in `docs/pitch/`.

---

## 0f. Update, 14 Oct 2026: Phase 23 sprint 2 built

Built on the uploaded Unite collection report (no Unite API call anywhere):
- **23D-1 Collections and data quality** (`/finance/collections`): payment modes, patient share vs insurance, consumption and credit by day, branch, doctor and invoice type; data-quality signals; Excel.
- **23D-2 Insurance billed vs claimed** (`/finance/insurance-billing`): Unite-billed insurance invoices against Diligence submissions by invoice number; billed-not-submitted, amount differences, ambiguous numbers.
- **M1 Management alerts**: report late, revenue behind target, doctors below the revenue-per-patient band; daily, once per alert, through Notifications.
- **M2A Contribution** (`/finance/contribution`): doctor, department and clinic contribution from the pay and overheads Finance loaded (never calculated pay), Provisional until the month is approved.
- **M3A Rooms and capacity** (Settings, Rooms; `/finance/capacity`): available hours and revenue per available hour; room occupancy needs the staff rota's free-text room linked to these rooms (follow-up in the M3A notes).
- **M4A Recruitment calculator** (`/finance/recruitment`): candidate viability against the clinic's own doctors, one engine for page, saved scenario and Excel; Ramadan and Eid calendar.
- Migrations `20261208000100` to `000600` (after main's `20261207`); paste files `85_` to `90_`. New questions OQ-158 and OQ-159 (OQ-160, one doctor key, answered by the Doctors page link).
- **Still blocked on answers, deliberately not guessed:** Longevity revenue (OQ-139), contract-rule doctor pay (OQ-148 to OQ-157), the revenue forecast (needs 13 months of history), room occupancy (linking rota rooms to rooms), and OQ-49 (data residency) before the first real report upload.

## 0e. Update, 14 Oct 2026: Phase 23 (M1) built

- **23A Unite collection report upload** (`/finance/upload`, `finance.revenue.import`): sanitised rows only, reconciled to the report's own totals before commit; tested end to end against the real September export locally (reconciles to the fils: net 1,839,005.80, 1,362 patients; the file is not in the repository). Notes: `docs/23_PHASE_23A_NOTES.md`.
- **23B Doctor performance** (`/finance/doctor-performance`, Excel download, target and bands under Finance, Targets and report lines, tiles on the Management dashboard): reproduces the corrected revenue comparison workbook (e.g. Dermatology 123,626.24 / 160 patients / 772.66). Notes: `docs/23_PHASE_23B_NOTES.md`.
- **Contract Generator alignment** (`docs/finance/contract-rules-alignment.md`): how the HR contract terms feed doctor pay in M2; OQ-148 to OQ-157.
- Database: production (`dljdxwgmstxfxyhbpntz`) has every migration up to `20261125000100_finance_access_window` (the `db-migrate` run of 14 Oct 18:35 UTC succeeded); Phase 23's three migrations apply when this merges to `main` (paste files `66_` to `68_` for a manual run).
- **Data residency answered (15 Oct 2026):** the owner accepts hosting in the United States (OQ-49), so real Unite report uploads may start. The remaining business questions went to the owner as a decisions form with a recommendation for each (finance and accounting policy: OQ-138 to 159 except OQ-147); OQ-68 (patient documents), OQ-94 (Unite switch-on date) and OQ-147 (who sees doctor pay) stay open as system decisions.
- **Clinic reports reviewed (16 Oct 2026, docs/41):** insurance (Diligence), lab (FML and Unite investigations), daily and monthly revenue, and operations exports. Fixed: the real Diligence file's misspelt denial-code header (no denial case would have opened), insurer names, one-day Unite collection exports, and the lab's composite codes and voucher numbers. New questions OQ-161 to OQ-180 for the finance meeting; build backlog in docs/41 §6 (branch aliases before Unite's clinic rename comes first).

## 0d. Update, 14 Oct 2026: management platform plan

The owner's May 2026 models (turnaround template, department benchmarking and recruitment calculator) were reviewed against Pulse. Plan in `docs/40_MANAGEMENT_PLATFORM_PLAN.md`: one data layer and one metric register (six profit levels from net revenue to profit after allocation) feeding Group, Clinic, Department and Doctor views; phases M0 (turn on the data), M1 (revenue, = Phase 23A/23B), M2 (costs and contribution), M3 (capacity and rooms), M4 (forecasts and scenarios), M5 (cockpit). 13 defects in the May models are listed so they are not carried into code. New questions OQ-143 to OQ-147.

## 0c. Update, 14 Oct 2026: Unite collection report analysed, Phase 23 planned

Al Das sent the Unite "Daily Collection Multi-Clinic Report" for September (data request D1, also covers D2) and the hand-built "Revenue comparison" workbook. Findings and the plan are in `docs/39_UNITE_REPORTS_PLAN.md`:
- the workbook reconciles to Unite's net billing (1,839,005.80) to the fils, but has 13 formula and reference errors (the worst: change % divided by the current month, follow-up % using the wrong month, a phantom doctor row, a department variance total that drops two departments);
- every Pulse revenue page is empty while Unite capture stays OFF (OQ-94), because the planned report upload was never built;
- Phase 23: **23A** import the Unite collection report (bridge while capture is OFF, capture wins later), **23B** doctor performance and month comparison (replaces the workbook: revenue per patient vs 750 with bands, follow-ups, department roll-up, reconciliation footer), **23C** Longevity and service lines (needs OQ-139 and D15), **23D** collections and data-quality view.
- New questions OQ-138 to OQ-142; new data request D15.

## 0b. Update, 14 Oct 2026: Phase 22 (Pulse replaces Tally) merged

**Everything the clinic still has to do, decide or send is in one list: `docs/TODO_FOR_AL_DAS.md`.**

Merged to `main` through PR #45 (Phases 20 and 21 part 1), PR #46 (Phase 22A to 22I, 22K integration, 21B chronic recall alignment) and PR #49 (22J Tally bridge). Plan: `docs/22_ACCOUNTING_PLAN.md`; one notes file per slice (`docs/22_PHASE_22*_NOTES.md`, `docs/21_PHASE_21B_NOTES.md`).

| Slice | What it gives the clinic |
|---|---|
| 22A | General ledger: one entity with three branches, fiscal year July to June (calendar year as a setting), Tally-compatible chart, tax codes, journals with maker and checker, gap-free numbering, day book, general ledger, trial balance; Accountant, Chief Accountant and Auditor roles |
| 22B | ERP-style menu: modules open as a tree, sections and groups can be minimised and are remembered, flyouts on the narrow rail, every page in Ctrl+K |
| 22C | Digital signatures: organisation seal (PAdES) on the voucher approval certificate and the locked close pack, optional personal certificate per approval step |
| 22D | Posting engine: ledger start date, posting rules, journals from Unite invoices and payments, remittances, denials, bills, vouchers, revenue share, labs, cash-ups and settlements; waiting list and posting preview |
| 22E | Receivables: customers, UAE tax invoices and credit notes, receipts and allocations, statements, ageing, balance confirmations |
| 22F | Banking and cash: bank ledgers and position, transfers, bank entries, petty cash, cheque register with post-dated cheques |
| 22G | Statements: P&L in Tally's layout, balance sheet, cash flow, budgets, VAT 201 working paper, ratios, exceptions, corporate tax bridge |
| 22H | Fixed assets, depreciation runs, disposals, prepayment / accrual / deferred revenue schedules |
| 22I | Tally import (masters, opening balances, voucher history) with dry run and reconciliation; year-end close |
| 22J | Tally bridge: on-premise connector that keeps Tally and Pulse in step until cut-over |
| 22K | Integration pass: one journal per event (cheques), one meaning per account code, shared SQL functions reconciled |
| 21B | Chronic recall selects patients the way Airtable did (chronic-flagged diagnoses only, Unite last-visit date, booked patients off the call list) |

Database: paste files `deploy/supabase-paste/21a_`, `21b_` and `22_` to `53_`, in number order (24 unused; 52 must follow 51). **None is applied to the live project yet**, so the new Finance and Accounting pages need them before they work in production. Every merge passed typecheck, lint, `pnpm audit:security`, the unit suite, the database suite (with PostgREST, as CI) and the build; nothing has been clicked in a browser or run against Unite, Postmark, TallyPrime, a real certificate or a model.

## 0a. Update, 13 Oct 2026: Phase 20 (finance control) and Phase 21 part 1

Branch `claude/funny-clarke-6t7gee` (not merged to `main`, no pull request yet). Built from the finance meeting transcripts, the deck "The next stage of financial & management control" and the CEO's zero-paper directive; the plan, the files still needed from the clinic (D1 to D14) and the slice table are in `docs/20_FINANCE_CONTROL_PLAN.md`; each slice has its notes file (`docs/20_PHASE_20*_NOTES.md`, `docs/21_PHASE_21A_NOTES.md`).

| Slice | What it gives the clinic |
|---|---|
| 20A | Daily flash: daily financial summary, month to date, daily sales grid against the same days last month, targets and reporting lines (Chiro and the leased unit separate), Excel in the old layout |
| 20B | Finance inbox: accounts mailbox (Postmark inbound, allow-listed senders, attachments only) and a drop zone; documents become supplier invoices |
| 20C | Bank and settlement reconciliation: generic statement import with per-bank column mapping, settlement rules (card / EPG T+2, Tabby T+6 working days), scored matching, reasons for unmatched items, two-person sign-off |
| 20E | Lab and external-referral reconciliation: provider statements imported per lab or hospital, scored matching to Unite lines, charges posted after a second person checks |
| 20D | Zero-paper payables: suppliers, supplier invoices with documents, payment vouchers with the delegation-of-authority tiers, maker / checker / approver, approval certificate PDF, TallyPrime XML export |
| 20F | Doctor revenue share: closed rule vocabulary per contract version, doctor charges, monthly run with the nine-step trail, Finance Manager verifies, CEO approves |
| 20G | Close timetable by working day (WD5 / 7 / 8 / 10) with owners, backups, dependencies, reminders and the close measures; the Board pack control summary |
| 20H | AI reviewer for bank reconciliation (suggestions from the matcher's shortlist only; a person accepts each) |
| 20I | Insurance follow-up at 60 / 90 / 120 days, submission sequence per claim, receivables by payer and age (candidate ARP report) |
| 20J | Unite invoice-change register (discounts, cancellations, credit notes, refunds) with Operations approval and the "unapproved changes" measure |
| 20K | Doctor billing mix and seasonality against last year |
| 21 part 1 | Chronic recall can select patients (visit diagnoses and chronic conditions, rule awaiting sign-off), antibiotic sequences scheduled (messages stay off), data-quality and unclassified-medication screens, reminder and recall reports on the management dashboard |

Every merge was checked with typecheck, lint, the unit suite, the database suite on Postgres 16 and `pnpm audit:security`. Nothing has been clicked in a browser or run against Unite, Postmark, Tally or a model; the new migrations are paste files `deploy/supabase-paste/21a_` and `21b_` (the Sanoflow migration from PR #44) and `22_` to `40_`, applied in number order (24 is unused). The flash migration was renumbered to `20261023000300` when PR #44 took `20261023000100`. Open questions OQ-90 to OQ-104 and OQ-115 are in `docs/audit/open-questions.md`; the decisions most worth making first are OQ-90 (approve vouchers in Pulse or Tally), OQ-91 (is the approval certificate enough without a DSC), OQ-94 (switch Unite capture on with the January backfill) and OQ-101 (new branch codes from 10 Nov).

**Live Supabase project (read-only check, 13 Oct).** The Pulse project is **"Al Das"** (ref `gtskozdnvprinmatjymm`, Tokyo region), which replaces the 12 Oct warning below that no Pulse database could be found. It has every migration up to `20261022000100` (paste 21) and holds no patient data yet (one org, one member, no contacts). RLS is on every table. Pastes 21a, 21b and 22 to 40 are not applied, so none of the Sanoflow import tables, Phase 20 or 21 part 1 is live. Its history also lists five early migrations twice under generated versions (`20261009065417` and the four after it); that does no harm with the paste route, but `supabase db push` will stop on them until they are marked reverted (`supabase migration repair --status reverted 20261009065417 20261009065455 20261009065508 20261009065520 20261009065639`). Advisor notes: the 14 finance views run with the owner's rights on purpose (each filters on `app.has_perm`, covered by the cross-org tests); six read-only SQL helpers have no fixed search_path (low risk, they run with the caller's rights, and a fixed path would stop Postgres inlining them); **turn on leaked-password protection** under Authentication in the Supabase dashboard. The Make organisation is connected too: 7 active scenarios, unchanged since the 8 Oct audit (OQ-99 closed).

## 0. Update, 12 Oct 2026 (read this first)

**Merged.** `main` (`0ea2a27`) now contains Phase 12 (PR #20: new menu, quick search, mobile tabs, Activity log, loading and error pages, installable app manifest, CI) and Finance F7 (PR #21: monthly-summary redesign, setup checklist, data-freshness view, nav badge, paste-ready SQL in `deploy/supabase-paste/`). There are no open pull requests. Production on Vercel (project `al-das`, `al-das.vercel.app`) is deployed from that commit and is READY.

**One warning before anyone pastes SQL.** The `deploy/supabase-paste/*.sql` files are meant for the **Pulse** Supabase project. The only Supabase project visible to the assistant's account is named **THC Portal**: a different, live product (230 staff records, bank details, 84,000 job runs, its own migrations). It has tables with the same names as Pulse's (`profiles`, `roles`, `audit_log`, `job_runs`, `push_subscriptions`, `settings`). **Do not run any Pulse SQL there.** Create a separate Pulse project, check the project name in the Supabase header before every paste, and keep the two apart. (Unrelated to Pulse, that project also reports one table without row-level security, `public.spatial_ref_sys`, a PostGIS system table; worth a look by whoever owns it.)

**Still not confirmed:** I could not find a Pulse database from the assistant's accounts. If you have already created one elsewhere and set its keys in Vercel, the deployment may already work; if not, the deployed app cannot sign anyone in. Everything in sections 2 and 3 still applies.

**Phase 15 (security, audit and access) is built** on branch `claude/nifty-brown-y9l5ry` and waits for review and merge: two-step verification by role, login history, session list, record access log, access review, off-boarding, anomaly alerts, History tabs, Activity log export, patient data export and erasure, and the Phase 10 security gaps. What was and was not verified is in `docs/12_PHASE_15_NOTES.md`. The three new migrations (`20261011000100` to `…300`) are in `deploy/supabase-paste/12_phase_15_security.sql` for the same paste route as before.

**Phase 13 (mobile, notifications and speed) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phase 15) and waits for review and merge: installable app with service worker, offline page and update prompt; phone inbox (full-screen thread above the keyboard, pull to refresh, swipe to take or close, camera and gallery upload), card grids and an agenda list on phones; notification preferences with quiet hours, Web Push, escalation ladder, daily and weekly digest e-mails and a notification centre with snooze; and the speed work (one-call dashboard tiles, query-free layout, local token checks for page navigations, lazy FullCalendar, React Flow and Recharts, bundle budgets in CI, four new indexes). Before and after bundle numbers, what was verified and what was not (no browser, no real push service, no Lighthouse) are in `docs/13_PHASE_13_NOTES.md`. The three new migrations (`20261013000100` to `…300`) are in `deploy/supabase-paste/13_phase_13_notifications_speed.sql`.

**Phase 14 (front desk, help and training mode) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phases 13 and 15) and waits for review and merge: the `/front-desk` workspace (Today board, check-in states kept in Pulse only, patient card beside the inbox, walk-in registration, desk QR, end-of-day sheet and handover notes), the waiting list with timed WhatsApp slot offers (first YES wins under the same per-specialist lock as booking), household links with guardian addressing and shared-phone matching, bilingual quick replies, the Help menu (training page, "?" guides, what's new, feedback, shortcuts), training mode (blocks all real WhatsApp) and `pnpm demo:reset`. What was verified and what was not (no browser, no phone, no real WhatsApp) is in `docs/14_PHASE_14_NOTES.md`. The four new migrations (`20261014000100` to `…400`) are in `deploy/supabase-paste/14_phase_14_front_desk.sql`.

**Open work from other sessions.** The Airtable clinical importer from `claude/upbeat-brown-n1q8nq` was merged as PR #22 on 12 Oct, and a follow-up (PR #28: Appointment Messages, Birthday, Chronic Recall and the `FU_` templates are still to come) is open from another session. Do not merge or reset that branch from here. Of the other `claude/*` branches, eleven carry nothing main lacks and five are older versions of work main already has in another form (`magical-planck-nx16wi` is an early Phase 5 that would add about 16,000 duplicate lines). Delete the stale ones once you agree; none should be merged.

**Phase 16 (Media Library and patient documents) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phases 13, 14 and 15) and waits for review and merge: an org-wide Media Library (folders, tags, search, WhatsApp limit checks, in-browser compression, camera capture, rotate and trim) used as template header media, in campaigns, quick replies and conversations, with "where is it used" and a delete block; a Documents tab on each patient (categories, expiry date, reminders before insurance cards expire, who opened or downloaded each file) behind new `documents.view` / `documents.manage` permissions; a malware-scan hook (no provider yet, files are flagged "not scanned"), retention policy per category, a storage usage dashboard, a picture viewer in the inbox, and erasure and export that cover documents. **Patient documents stay OFF until an administrator confirms where the files may be stored (OQ-68).** What was verified and what was not (no browser, no real Supabase Storage, no scanner) is in `docs/15_PHASE_16_NOTES.md`. The four new migrations (`20261015000100` to `…400`) are in `deploy/supabase-paste/16_phase_16_media_documents.sql`.

**Phase 18 (Finance and insurance upgrades) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phase 16) and waits for review and merge: pre-authorisation tracker with expiry tasks, an eligibility step that marks visits "not ready to bill", denial management with a deadline countdown and an AI-drafted appeal letter that is marked DRAFT and never sent, remittance reconciliation with short-payment flags against the payer price list, payer scorecards, a collections forecast, self-pay WhatsApp reminders (OFF, opt-in, template only, tone approved by finance), a month-end close pack (XLSX and PDF) that finance and the CEO both sign and that locks the month in the database, an end-of-day cash-up per branch, revenue views and a one-way accounting CSV export. Each part has its own `finance.*` permission. **Unite was not called.** All thresholds are placeholders for Sharaf and finance (OQ-72 to OQ-77). What was verified and what was not (no browser, no real payer file, no real WhatsApp, no real PDF viewer) is in `docs/16_PHASE_18_NOTES.md`. The seven new migrations (`20261016000100` to `…700`) are in `deploy/supabase-paste/18_phase_18_finance_upgrades.sql`.

**Phase 17 (AI copilots for flows and campaigns) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phase 18) and waits for review and merge: a **Flow Copilot** (describe a bot, get an unpublished draft that has passed the engine's own validators and cannot be published until a person marks it reviewed, enforced by a database trigger) with a **dry run** that replays sample messages through any flow on the real engine with every send stubbed; a **Campaign Copilot** (a sentence becomes a validated audience filter with its size and a sample of ids, and English and Arabic template wording is linted against Meta's rules; nothing is sent or submitted); **intent detection** on inbound messages into `conversations.ai_tags` (AI labelling is OFF by default and needs its own switch); a deterministic English and Arabic **emergency wording check that works with AI off** and alerts the team at once; **AI tags starting flows only after the clinical lead types a confirmation** (OQ-61, OFF); and a **weekly reply-quality report** (suggestions accepted, edited, replaced, and topics the knowledge base could not answer; counts and ids only). **No model was called anywhere in the build or the tests**, so output quality is unknown; the switch for AI itself stays OFF until OQ-57 is answered. What was verified and what was not is in `docs/17_PHASE_17_NOTES.md`. The three new migrations (`20261017000100` to `…300`) are in `deploy/supabase-paste/17_phase_17_ai_copilots.sql`.

**Phase 19a (integrations foundation and the first three integrations) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phase 17) and waits for review and merge: a shared foundation every later integration reuses (encrypted credentials and an on/off flag per integration, a typed client with timeouts, back-off and a circuit breaker, a call log without bodies, an inbound-webhook helper with signature checks and idempotency, health on System health, a Settings, Integrations hub); **private read-only calendar feeds for doctors** (times and the clinic location only, never patient details); an **SMS fallback** that texts a short generic reminder when WhatsApp could not deliver one (its own queue and rate limit, consent rules, delivery receipts); and **payment links in WhatsApp** (Stripe Checkout and a PayTabs-style gateway; the gateway's status is recorded, an amount that does not match is never applied, and nothing is ever marked paid in Unite). **All three are OFF**, SMS and payments need a typed confirmation, and **no real provider was called**: the adapters are written from documentation and must be proved in a sandbox first (OQ-83 to OQ-85). What was verified and what was not is in `docs/18_PHASE_19A_NOTES.md`. The four new migrations (`20261018000100` to `…400`) are in `deploy/supabase-paste/19a_phase_19a_integrations.sql`.

**Phase 19b (four more integrations) is built** on branch `claude/nifty-brown-y9l5ry` (on top of Phase 19a) and waits for review and merge, which completes Phase 19 except the Instagram and Messenger inbox (candidate 6, not built). **Google review requests**: after a completed visit, one approved WhatsApp message with the location's Google review link, only to patients who opted in, at most once per person per period (the cap is claimed in the database), never filtered by how the visit went; no Google service is called. **Meta ad attribution and the Conversions API**: records which Meta ad each WhatsApp conversation came from (report only by default, with an Ad attribution report) and can send Contact, Lead and Schedule events through a queue, carrying only the event name and the ad click id (never a service, doctor, diagnosis or value) and only for consenting patients. **Video visits**: a private per-appointment video link (a generic address template or a Daily.co-style API), a Join button for staff, a template variable for reminders, revoked on cancel and replaced on reschedule. **E-signature for consent forms**: a consent PDF goes to a Dropbox Sign-shaped provider for one signer and the signed copy is stored on the patient through the Phase 16 document checks. **All four are OFF**, each needs a typed confirmation, and **no real provider was called**: the Meta payload, Daily and Dropbox Sign shapes are written from documentation and must be proved in a sandbox first (OQ-86 to OQ-89). Erasure and the subject-access export were extended to the new records. What was verified and what was not is in `docs/19_PHASE_19B_NOTES.md`. The five new migrations (`20261019000100` to `…500`) are in `deploy/supabase-paste/19b_phase_19b_integrations.sql`.

**Phases 20b to 20e (Sanoflow parity) are built** and merged together: native flow CRM nodes (G0, fixed: they failed closed before), new flow triggers and nodes and question validation (20b, `docs/23`); routing with a fallback team, open-chat limits, office-hours auto-reply, idle auto-away and a restricted enquiry view, plus assignment and presence reports (20c, `docs/24`); booking buffers, group capacity, per-specialist slot length and weekly blocks (20c, `docs/25`); template retry, time limit, carousel sending and performance, recurring campaigns, a monthly message budget and close-with-enquiry (20d, `docs/26`); website chat, Instagram and Messenger in the Inbox and Google Calendar busy sync (20e, `docs/27`, all OFF and unverified against live Meta and Google). The parity matrix in `docs/20` §4 shows what is closed and what remains (G11, part of G12, G14). Their migrations (`20261023000100`, `20261023000200` for 20a, and `20261110000100` to `…900`, numbered after the finance and accounting migrations) are in `deploy/supabase-paste/54_phase_20_sanoflow_parity.sql` (20a is in `21a` / `21b`; checked: it applies in one transaction on a database at the previous level).

**Sanoflow parity follow-ups (20f to 20i) are built**: inbox extras (forward, contact card, catalogue product, call link, move a chat to a new contact; `docs/28`), ShowBusy and campaign A/B tests (`docs/29`), a generic HTTP SMS gateway and Meta Marketing Messages Lite (`docs/30`), and Meta ads spend on the Ad attribution report (`docs/31`). Every row of the parity matrix (`docs/20` §4) is now closed except G14 (lead-gen forms, booking page, payment-required booking), which waits for a decision. Migrations `20261112000100`, `20261113000100`, `20261115000100`; paste file `deploy/supabase-paste/55_sanoflow_parity_followups.sql`. The live database (project "Al Das") had every migration up to `20261111000100` applied on 14 Oct 2026.

**Portal bulk edit and tags are built** (`docs/33`): select rows in a portal list and change one field on all of them, or add and remove portal tags; tags in the record drawer, a tag filter and a Portal tags tab in Settings, Tags (`portal.tags.manage`). Per-object custom fields are deliberately not built. Migration `20261117000100`; paste file `deploy/supabase-paste/57_portal_bulk_edit_tags.sql`.

## 1. Where we are

### 1.1 The short version

Phases 1 to 11 and Finance F0 to F6 are **built, tested and merged**. Pulse already contains everything the original spec asked for: WhatsApp inbox, patient CRM, enquiries and tasks, appointments with reminders, templates, campaigns, the flow builder, recall programmes (the Make replacements), the back-office portal (Airtable replacement), the clinical rules engine, AI assist, dashboards and reports, public API and webhooks, and the finance and insurance module.

**What is not yet true:** nothing has run against the real world. There is no confirmed Pulse Supabase project (see section 0), no Meta credentials, no Unite credentials and no real data. Every external call is tested against fakes. The UI has never been clicked through in a browser in a build environment (there was no auth stack). So the honest status is **"feature-complete in code, not yet proven live"**. Sections 2 and 3 are the path from here to proven.

### 1.2 Numbers (measured this session)

| Measure | Value |
|---|---|
| SQL migrations | 44 |
| Tables in `public` | 126 |
| App pages | 59 (58 + the new Activity log) |
| HTTP routes (public API, webhooks, exports, jobs) | 18 |
| Background job handlers | 20 |
| TypeScript | about 108,000 lines |
| Permission keys | 42 (plus wildcards); Phase 15 added `security.manage` and `privacy.manage` |
| Unit test files / tests | 107 files / **1,245 passing** (includes the 19 added this session) |
| Database test files | 32 files, **423 tests passing** on Postgres 16 with pgvector and PostgREST (run 11 Oct 2026, see `docs/11_PHASE_12B_NOTES.md`) |
| After Phase 15 (branch `claude/nifty-brown-y9l5ry`) | 48 migrations, 134 tables in `public`, 64 app pages, **119 test files / 1,395 tests in `pnpm test`** and **35 database test files / 476 tests**, all passing |
| After Phase 13 (branch `claude/nifty-brown-y9l5ry`) | 53 migrations, 138 tables in `public`, 66 app pages, **129 test files / 1,497 tests in `pnpm test`** and **38 database test files / 511 tests**, all passing |
| After Phase 14 (branch `claude/nifty-brown-y9l5ry`) | 57 migrations, 143 tables in `public`, 73 app pages, **139 test files / 1,619 tests in `pnpm test`** and **41 database test files / 570 tests**, all passing |
| After Phase 16 (branch `claude/nifty-brown-y9l5ry`) | 61 migrations, 147 tables in `public`, 75 app pages, **147 test files / 1,824 tests in `pnpm test`** and **43 database test files / 613 tests**, all passing |
| After Phase 18 (branch `claude/nifty-brown-y9l5ry`) | 68 migrations, 165 tables in `public`, 90 app pages, **161 test files / 2,087 tests in `pnpm test`** and **50 database test files / 708 tests**, all passing |
| After Phase 17 (branch `claude/nifty-brown-y9l5ry`) | 71 migrations, 168 tables in `public`, 93 app pages, **172 test files / 2,274 tests in `pnpm test`** and **51 database test files / 736 tests**, all passing |
| After Phase 19a (branch `claude/nifty-brown-y9l5ry`) | 75 migrations, 174 tables in `public`, 96 app pages, **179 test files / 2,411 tests in `pnpm test`** and **53 database test files / 798 tests**, all passing |
| After Phase 19b (branch `claude/nifty-brown-y9l5ry`) | 80 migrations, 179 tables in `public`, 97 app pages, **183 test files / 2,508 tests in `pnpm test`** and **58 database test files / 878 tests**, all passing |
| Browser (Playwright) specs | 6 |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | **all clean** on a fresh install |

Not run: the browser tests and any click-through (no Supabase auth stack in the sandbox). The database tests were run on 11 Oct 2026 and all pass.

### 1.3 Scorecard

| # | Module | Built | Not proven / missing |
|---|---|---|---|
| 1 | Foundation: auth, orgs, RLS, roles, teams, invites, jobs framework | Yes | Presence inactivity timeout. MFA is enforced per role since Phase 15 but the enrolment flow has not been run against a real Supabase Auth |
| 2 | Patient CRM: grid, views, segments, filters, import/export, merge, custom fields, tags | Yes | Sanoflow export header names are guessed (`--map` / `<step>.map.json` overrides); real export needed. Phase 20a imports the whole Sanoflow export set (docs/22) |
| 3 | WhatsApp ingress and shared inbox | Yes | Never tested with real Meta traffic; BSUID (username) contract unverified; coexistence events only logged |
| 4 | Templates: builder, Meta submit and sync, 26 starter templates (13 in English and Arabic) | Yes | Needs `META_APP_ID` and a real WABA; named, one-time code and catalogue templates since docs/32 (unverified live); no flow-button templates |
| 5 | Enquiries and tasks: pipelines, Kanban, SLA, assignment, reminders, first-touch | Yes | No enquiry tags join table, no CSV import, no AI summary |
| 5b | Tasks API, booking conversion, failed reminder becomes a call task | Yes | None |
| 6 | Appointments, slot engine, reminders, button replies; read-only Unite sync; clinical rules engine; Follow-Up Queue; Clinical settings | Yes | Bookings and moves re-check the slot under a per-specialist lock (`book_appointment` / `move_appointment`); clinical messaging deliberately OFF until sign-off; Unite sync OFF until credentials |
| 7 | Campaigns: audience snapshots, fan-out, throttling, funnel, retries | Yes | No recurring campaigns, A/B variants, per-recipient media headers |
| 8 | Flows (21 node types), recall programmes, parallel-run tooling | Yes | Live path untested; recall in Test mode only; Token and MRD-sync parallel runs need Make exports |
| 9 | Back-office portal and complete Airtable importer | Yes | Clinical importer mappers now write the real Phase 6 tables (dry-run first, then a real run against a real base is still to do); portal bulk edit and tags added later (`docs/33`) |
| 10 | AI assist and knowledge base, metrics, dashboards, reports, public API, webhooks | Yes | AI switch OFF until legal answer (OQ-57); WhatsApp cost report built but never run against live Meta (OQ-62); `ai_tags` are written only by Phase 17 intent detection (OFF by default); no scheduled digests |
| 11 | Hardening, load tests, reconciliation, cut-over tooling | Yes | Load tests only run against a mock Graph; live rehearsal not done |
| 15 | Security and audit: MFA by role, login history, session list, record access log, anomaly alerts, access review, off-boarding, History tabs, Activity log CSV, patient data export and erasure, API read counter | Yes | Never clicked in a browser or run against Supabase Auth (see `docs/12_PHASE_15_NOTES.md`); clinical records are kept on erasure pending OQ-63; enrolment and sign-out scopes need a real-stack check |
| 13 | Mobile, notifications and speed: installable app (service worker, offline page, update prompt), phone inbox, card grids, agenda, notification preferences, Web Push, escalation ladder, digests, notification centre, query and bundle cuts, budgets in CI | Yes | Never seen in a browser or on a phone; no real push service or Supabase Auth was available (see `docs/13_PHASE_13_NOTES.md`); push needs `pnpm push:keys` and an installed app on iOS; the speed-up from local token checks needs asymmetric JWT signing keys; no Lighthouse or Speed Insights numbers yet |
| 16 | Media Library and patient documents: library with folders, tags, usage and delete guard; header media in templates, campaigns, quick replies, conversations; Documents tab with expiry reminders and a view/download log; `documents.*` permissions; scan hook; retention; usage dashboard; picture viewer | Yes | Never seen in a browser or on a phone; no real Supabase Storage or malware scanner was available (`docs/15_PHASE_16_NOTES.md`); documents OFF until OQ-68 (storage region) is answered; appointment reminders and flows do not use library headers yet |
| F0-F6 | Finance and insurance: Unite capture, Diligence upload and matching, exceptions E01-E10, summary | Yes | Unite capture is OFF by design; closed-month review with Saeed is a human step |
| 18 | Finance upgrades: pre-auth, eligibility, denials and appeal drafts, remittance, scorecards, forecast, self-pay reminders, month-end close with lock, cash-up, revenue, accounting export | Yes, unproven in a browser | Thresholds, denial codes, payer prices and remittance headers are placeholders (OQ-72 to OQ-77); reminders OFF; payment links, instalment tracking and the patient estimate generator were not built (`docs/16_PHASE_18_NOTES.md`) |
| 17 | AI copilots: Flow Copilot with a review gate and dry run, Campaign Copilot (audience and template wording with a policy lint), intent detection and `ai_tags`, emergency wording alert, AI tags starting flows behind a clinical sign-off, weekly reply-quality report | Yes, unproven with a real model or in a browser | AI stays OFF until OQ-57; labelling and tag-started flows have their own OFF switches (OQ-57, OQ-61, OQ-79); the emergency word lists need clinical review (OQ-78); thresholds and the policy lint are starting values (OQ-80, OQ-81); one reviewer for AI flows (OQ-82) (`docs/17_PHASE_17_NOTES.md`) |
| 19a | Integrations foundation (flag, encrypted credentials, typed client with back-off and circuit breaker, call log, inbound-webhook helper, health, hub), doctor calendar feeds, SMS fallback for failed reminders, payment links in WhatsApp | Yes, unproven against any real provider or in a browser | All three OFF; adapters written from documentation (Twilio-style SMS, Stripe Checkout, PayTabs-style) and never called; ICS never opened in a calendar app; no staff switch for "do not SMS" yet; payment amount is checked against the invoice total, not the outstanding balance (OQ-83 to OQ-85, `docs/18_PHASE_19A_NOTES.md`) |
| 19b | Google review requests (opt-in, capped, no review gating), Meta ad attribution and Conversions API (report only by default, event allow-list), video visit links (static address or Daily.co-style rooms, Join for staff, `appointment.video_link` variable), e-signature for consent forms (Dropbox Sign-shaped, signed copy stored as a patient document); erasure and export extended | Yes, unproven against any real provider or in a browser | All four OFF; adapters written from documentation (Meta business-messaging payload, Daily, Dropbox Sign) and never called; no "deceased" field (the Do-not-ask switch is used); not built: Instagram and Messenger inbox (OQ-86 to OQ-89, `docs/19_PHASE_19B_NOTES.md`) |

### 1.4 Changes made in this session

A first slice of the UX, mobile and audit work (this is "Phase 12a" below):

- **Grouped menu.** The sidebar is now organised as Today, Patients, Growth and Insight and back office, with Dashboard on top and Settings at the bottom. Group headers collapse to dividers when the sidebar is collapsed.
- **Quick search (Ctrl/Cmd + K).** Jump to any page you may open, including every Settings page. Search matches names and keywords (for example "calendar" finds Appointments).
- **Mobile bottom tab bar** (Inbox, Appointments, Tasks, Contacts, More) with safe-area padding; the inbox height was adjusted so the composer is not hidden behind it.
- **Installable app (PWA manifest and icon)** so staff can add Pulse to a phone or front-desk PC.
- **Loading skeletons, an error page and a not-found page** for the whole signed-in app, so navigation never looks frozen and one failing page no longer takes the sidebar with it.
- **Settings reorganised** into Personal, Workspace, Channels and integrations, Clinic operations, and Security and audit. One list now feeds the Settings menu and quick search so they cannot drift apart.
- **Activity log** (`/settings/activity`): who changed what and when, filterable by period, person, area and action, with expandable details, paginated, read-only, and visible only with `settings.manage`. Times show in the clinic timezone.
- **CI workflow** (`.github/workflows/ci.yml`): typecheck, lint, unit tests and a production build on every pull request. There was no CI before.
- 19 new unit tests (navigation rules, quick-search ranking, activity-log filter parsing).

Still to do on these: click through them on a real stack (section 2.2).

---

## 2. Engineering work still open

### 2.1 Blocked on something external (nothing to code until you act)

| Item | Blocked on | Details |
|---|---|---|
| Real data import (Airtable, Sanoflow) | Supabase project, `AIRTABLE_PAT`, UAE residency opinion (OQ-49) | Tooling is dry-run verified. `pnpm import:airtable --dry-run` then for real, then `pnpm reconcile` |
| Live WhatsApp on the new inbox | Meta System User token, WABA ownership (OQ-38) | `pnpm cutover:preflight` checks everything read-only |
| Unite sync (appointments, doctors, patients) | New Unite credentials (OQ-26) | Read-only, conservative rate limits, circuit breaker already built |
| Unite finance capture (deliver-once) | Token-coexistence test with Make, Unite field list, 2026 queue size | Stays OFF. Follow `docs/finance/go-live-runbook.md` exactly |
| Clinical messages to patients | Clinical sign-offs (OQ-01 to 06, 36) | Gate is built and fails closed |
| AI replies | Legal answer on sending text to Anthropic and Voyage (OQ-57) | Switch is OFF per org |
| Make parallel run | Make-side exports for Token and MRD sync | `/recall/parallel-run` is ready |

### 2.2 Verification that was never done

These are the most valuable things to do before any client sees the product, because every one is a likely source of embarrassing first-demo bugs.

1. **Run the whole app once on a real Supabase stack** (`supabase start`, `pnpm db:reset`, `pnpm dev`) and click every page as three different roles (admin, receptionist, finance). The phase notes all say the UI "was type-checked and built but not driven in a browser". Expect cosmetic and flow bugs.
2. **Run the Playwright suite** (`pnpm e2e`) on that stack. The database tests were run on 11 Oct 2026 (423 pass) and now run in CI (`.github/workflows/ci-db.yml`).
3. **Real Meta round trip** on a test number: signed webhook in, message in the inbox in under 2 seconds, template out, ticks back. `pnpm wa:simulate` has only simulated this.
4. **Load rehearsal on staging**: `pnpm load:webhook`, `pnpm load:outbound` (20,000 messages against the mock Graph, then a small real batch).
5. **Accessibility pass** (WCAG 2.1 AA) and a **real-phone pass** (iOS Safari and Android Chrome).

### 2.3 Known gaps carried over from the phase notes

| Area | Gap |
|---|---|
| Appointments | Google Calendar busy sync built in 20e (OFF, unverified live). (The double-booking race is closed: `book_appointment` / `move_appointment` re-check under a per-specialist advisory lock) |
| Inbox | Idle auto-away built in 20c (Settings, Inbox). Create enquiry and Book appointment buttons in the contact sidebar need checking now that the modules exist |
| Flows | Question re-ask and typed answers built in 20b. A replayed step never sends, books or charges twice: messages, Book appointment and Payment link carry the step key (`flow_step_key`, unique), so a crash between the side effect and "step recorded" gets the first result back (docs/23). Outbound webhooks node is wired, but untested live. CRM nodes (Create/update enquiry, Add task, Portal record, Book appointment) are wired since 20b (G0) |
| Campaigns | Recurring campaigns and carousel sending built in 20d; A/B (version B on one-off campaigns) built in 20g (docs/29) |
| Templates | Named variables, one-time code (authentication) and catalogue templates built (docs/32), payloads unverified against a live WABA; no flow-button templates |
| Portal | Bulk edit (one field on up to 500 selected records) and portal tags (drawer, bulk, list filter, Settings, Tags) built (`docs/33_PORTAL_BULK_EDIT_TAGS_NOTES.md`). No per-object custom fields: portal columns are defined in code (`lib/portal/objects`), deliberately not built. Tags are not saved in views or exported |
| Reports | Scheduled email digests, AI tags. (WhatsApp cost is built; its Meta response parser is unverified live, OQ-62) |
| Public API | Rate limit is per key and fixed-window; reads are audited but sampled (one row per key and resource per 15 minutes); marketing opt-in through the API needs `consent` evidence; URLs limited to port 443. Open: marketing sends still check `stop_marketing` only |
| AI | Limits are atomic (per user per minute, plus a workspace daily cap). Rate limits count calls, not tokens |
| Finance | Several thresholds are placeholders until Sharaf agrees them; Unite IP allow-listing may need a fixed-IP relay (Vercel has no fixed outbound IPs) |
| Security | **Built in Phase 15, unproven live:** MFA by role, session list, login history, record access log (see 4.11). Backup and restore drill written (`docs/37_BACKUP_RESTORE_DRILL.md`; first rehearsal still to run). Soft delete with a restore window built (`docs/35_SOFT_DELETE_NOTES.md`): deleted contacts, enquiries, tasks and website entry points go to Settings, Recently deleted for 30 days (1 to 90 per org), then a nightly purge; erasure is unchanged. **Finance access window built (off by default, unproven live):** days and hours per role for finance and accounting, enforced in Pulse and in the database (RLS, the accounting ledger included), plus an optional IP allow-list that applies to Pulse's own pages, actions and API routes only (not to direct database access); Admin never restricted (`docs/36_FINANCE_ACCESS_WINDOW_NOTES.md`). Still open: the Supabase Auth dashboard settings (password policy, leaked-password protection, TOTP switched on) |

### 2.4 Housekeeping

- Done 14 Oct 2026: `README.md`, `docs/06` and `docs/07` carry the "Phases 4 to 10 are built" update, `app/(app)/dashboard/page.tsx` is Prettier-clean, and `docs/00_HOW_TO_USE.md` points to the pitch pack in `docs/pitch/`. The six helper functions the Supabase security advisor flagged (`clinical_setting*`, `is_reminder_excluded`, `is_working_day`, `workdays_between`) now pin `search_path` (migration `20261118000100`, paste file 58).
- Done 14 Oct 2026: the advisor's 14 `security_definer_view` errors on the finance views are cleared and every member sees the same rows as before (`docs/38`, migration `20261119000100`, paste file 59). Six views no screen read are closed to signed-in users. The other eight are `security_invoker`, and the owner-rights part sits in `app.*` SECURITY DEFINER functions.
- Several docs share a number prefix (`05_*`, `06_*`, `08_*`). Harmless, but rename once the numbering settles.

---

## 3. What I need from you

Everything below is outside what code can fix. Tick them off in this order: accounts first (they unblock the most), then answers, then data.

### 3.1 Accounts, keys and secrets

Never paste any of these into chat, GitHub, a doc or a screenshot. Put them in Vercel environment variables (Production and Preview) and in `.env.local` for local work. Variable names come from `.env.example`.

| # | What | How to get it | Variable(s) | Unblocks |
|---|---|---|---|---|
| 1 | **Supabase project** (Pro plan, region decided with legal, see OQ-49) with extensions `pgmq`, `pg_cron`, `pg_net`, `vector`; point-in-time recovery on | supabase.com, new project, then `supabase link` and `supabase db push` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only) | Everything |
| 2 | **Vercel Pro project** linked to the GitHub repo, production domain (for example `pulse.<your domain>`) | vercel.com, import repo | `APP_URL` | Deploys, cron callbacks |
| 3 | **Two random secrets** | Run `bash scripts/generate-secrets.sh` on your own machine (it uses `openssl rand`) | `ENCRYPTION_KEY`, `JOB_SECRET` | Encrypting channel and integration tokens; pg_cron calling `/api/jobs/*`. **Back up `ENCRYPTION_KEY` somewhere safe: losing it makes stored tokens unreadable** |
| 4 | **Meta (WhatsApp Cloud API)** under Al Das's own Business Portfolio: verified business, a Business-type app, a System User with a permanent token, the WABA and the three phone numbers | business.facebook.com, developers.facebook.com | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (you choose it), `META_SYSTEM_USER_TOKEN`, `META_GRAPH_VERSION`; plus WABA ID and phone number IDs entered in Settings, Channels | Inbox, templates, campaigns, reminders |
| 5 | **Unite EMR credentials for the platform** (fresh app id/key, not the ones in Make) | Ask Unite. The email draft is `docs/finance/unite-request-email.md` | `UNITE_BASE_URL`, `UNITE_APP_ID`, `UNITE_APP_KEY` (entered encrypted in Settings, Unite EMR) | Appointment, doctor and patient sync |
| 6 | **Anthropic API key** | console.anthropic.com | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | AI assist (after OQ-57) |
| 7 | **Embeddings key** (Voyage assumed) | voyageai.com | `EMBEDDINGS_API_KEY`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_MODEL` | Knowledge-base search |
| 8 | **Resend** with the clinic's sending domain verified (SPF and DKIM) | resend.com | `RESEND_API_KEY`, `RESEND_FROM` | Invites, alerts, digests |
| 9 | **Sentry** project | sentry.io | `SENTRY_DSN` (and an auth token in Vercel for source maps) | Error monitoring |
| 10 | **Airtable personal access token**, read-only (`data.records:read`, `schema.bases:read`) on the 5 bases | airtable.com/create/tokens | `AIRTABLE_PAT` | Migration only. **Revoke after cut-over** |
| 11 | **Make API token**, read-only | Make profile, API | `MAKE_API_TOKEN`, `MAKE_ZONE=us2`, `MAKE_TEAM_ID=1494412` | Migration and parallel run only. **Revoke after cut-over** |
| 12 | **Sanoflow exports (CSV): contacts, enquiries + activity, appointments, tags, labels, categories, quick replies, segments; plus `sanoflow-config.json` / `sanoflow-names.json` filled by hand** | Sanoflow, each module's Export; Settings → Enquiries | files, not secrets | `pnpm import:sanoflow:all` (docs/22) |
| 13 | **GitHub**: repo secrets only if CI later needs them; Vercel-to-GitHub integration enabled | github.com settings | none today | Preview deployments |

**Added by the roadmap (not needed for the first go-live):** VAPID key pair for browser push (generated by a script, Phase 13); an SMS provider account for fallback messages; a payment gateway merchant account for pay-by-link; a Google Cloud OAuth client for calendar sync and review requests; a Meta Marketing API token for ad reports.

**Rotate at cut-over:** the Unite keys that sit in plain text inside the Make blueprints, and the old Sanoflow API key.

### 3.2 Decisions and sign-offs (answers only you or the clinic can give)

Full register: `docs/audit/open-questions.md`. These are the ones that block something real.

| Decision | Who | Blocks |
|---|---|---|
| ~~**Where may patient data be hosted?**~~ Answered 15 Oct 2026: US hosting is acceptable (OQ-49) | Owner | Done |
| **Does Al Das own the WhatsApp Business Account?** (OQ-38) | Saeed | Moving numbers off Sanoflow |
| **May patient messages be sent to Anthropic and Voyage?** DPA, zero retention (OQ-57) | Management and legal | AI assist |
| **Clinical thresholds**: recall interval 30/85/90 days (OQ-01), day-3 offset (OQ-02), probiotic days (OQ-03), feedback red-flag score (OQ-04), day-3 HALT score (OQ-05), side-effect keywords (OQ-06), all vitals thresholds (OQ-36) | Abdul and Snezana | Any patient-facing clinical message |
| **Working week and holidays** (OQ-07), **doctor to department lists** (OQ-08) | Abdul | Follow-up due dates, gynaecology rules |
| **Who works the follow-up queue, at what volume?** (OQ-14) | Abdul | Clinical go-live |
| **Meaning of Unite appointment status codes** (AAC, ACF, APH, CNR, CVI, YTC, NSW) (OQ-23) | Sharaf and Unite | No-show reports, reminders |
| **Reminder lead time**: keep the current ~24 h, or 48 h plus 24 h? (OQ-19) | Operations | Reminder schedule |
| **Birthday rules**: yearly or once ever; age bands; 29 Feb (OQ-17, 18) | Saeed and marketing | Birthday programme |
| **Marketing consent**: do marketing sends need a recorded opt-in, or only the absence of "stop marketing"? | Management and legal | Campaign go-live |
| **Finance thresholds** (E01 30, E04 14, E05 60 days), write-off "approved" value, `InvType` values, ordering vs performing doctor | Sharaf and finance | Finance tuning |
| **Names of the Billing and Finance users**, and the Medical Director and CEO view | Saeed | Finance roles |
| **Token coexistence with Make** (does Pulse refreshing the Unite token break Make's scenarios?) | You and Unite | Finance capture |

### 3.3 Data and content to supply

| Item | From |
|---|---|
| One unfiltered **Diligence export** (header row first, using `docs/finance/diligence-header-request.md`) | Sharaf |
| The three Unite **clinic long and short names** | You |
| **Working week, holiday calendar, doctor list with departments** | Abdul |
| **30 real patient questions with approved answers** to seed the AI knowledge base (and tune retrieval) | Operations |
| **Brand pack**: logo (SVG), colours, fonts, plus Arabic copy review for templates | Marketing |
| **Staff list** with names, roles and mobile numbers for invites | Saeed |
| **Two or three front-desk champions** for user testing and training videos | Operations |
| **Client name, contacts and any pricing/commercial terms** for the proposal (placeholders are marked in `docs/pitch/`) | You |

### 3.4 Legal and compliance paperwork

- Data processing agreements: Supabase, Vercel, Anthropic, Voyage, Resend, Sentry, Meta.
- Written position on health-data hosting, retention periods, patient consent wording for WhatsApp, and breach-notification contacts.
- Sign-off that **no real patient data** is used for demos: use the synthetic seed only.

---

## 4. Product review: what a senior reviewer would change

I went through the product as a clinic owner, a receptionist and a security reviewer. The first column says how it looks today, the rest is the improvement. Items marked **(done)** shipped in this session.

### 4.1 Design, UI and UX

| Today | Improvement |
|---|---|
| Neutral grey shadcn look with a blue primary; works, but nothing says "Al Das" | **Brand layer**: one set of tokens (logo, primary, accent, radius, type) so a client demo looks bespoke. Light and dark already exist; add the user-facing theme toggle |
| 14 flat menu items | **Grouped menu (done)**, plus per-role landing pages, favourites and recent items |
| Pages blank while loading | **Skeletons and error states (done)**; add empty states with a next action on every list |
| Settings was one long list | **Sectioned Settings (done)**; add a Settings home with search and an admin setup checklist |
| Finding things means knowing the menu | **Ctrl/Cmd+K (done)** for pages; extend to patients, appointments and templates ("find Ahmed", "book") |
| No "create" shortcut | A global **+ New** button: patient, appointment, enquiry, task, message |
| English only, left to right | **Arabic and RTL for staff screens** (templates and AI drafts already handle RTL). Essential for the UAE |
| Help lives in docs | **In-app help**: a "?" on every page that opens the matching training video and a one-page guide (section 8) |
| Dense tables everywhere | Comfortable/compact density toggle; card view on phones |
| No consistent confirmation pattern | Undo toasts instead of "are you sure?" for reversible actions |

### 4.2 Speed and optimisation

| Finding | Action |
|---|---|
| The signed-in layout runs two extra queries on every navigation (overdue-task count, 20 notifications) | Move badge counts to a client fetch plus Realtime, or cache per user for 30 s with a tag invalidated by task changes |
| The dashboard fires 11 separate count queries | One SQL function returning all tiles in a single round trip; cache for 30 s |
| Middleware calls `supabase.auth.getUser()` (a network call) on every request | Verify the JWT locally (`getClaims`) for page navigations; keep `getUser()` for sensitive actions |
| Heavy client libraries (FullCalendar, React Flow, Recharts, Tiptap) | `next/dynamic` so they load only on the pages that use them; run the bundle analyser and set a budget |
| Region | Put Vercel functions in the same region as Supabase |
| Database | Run `get_advisors` (performance) after the first real data; review indexes on `messages`, `conversations`, `contacts` (38.7k+ rows) and `audit_log` |
| Connections | Use the Supavisor transaction pooler URL for serverless functions |
| Measurement | Vercel Speed Insights and Sentry performance; targets: inbox opens under 1 s, p95 server action under 500 ms, LCP under 2.5 s on 4G |

**Phase 13 status.** Done: layout queries removed (browser fetch plus Realtime), dashboard tiles in one SQL function, local token verification for page navigations, `next/dynamic` for FullCalendar, React Flow and Recharts (Tiptap is not used anywhere), bundle analyser, budgets in CI (`pnpm bundle:check`), four indexes, Speed Insights installed. Still open: same-region Vercel and Supabase, the Supavisor pooler URL, real Speed Insights and Sentry numbers, and a look at the Supabase performance advisor on real data (it was not available in the build sandbox).

First-load JS, before and after Phase 13 (production build, same machine): shared 102 to 103 kB; dashboard 232 to 119 kB; management dashboard 306 to 193 kB; appointments 309 to 235 kB; flow builder 278 to 113 kB; inbox 286 to 291 kB (up: gestures and the pull-to-refresh and swipe code). Full table in `docs/13_PHASE_13_NOTES.md`.

Already good: virtualised grids, keyset-style pagination in the inbox, materialised metrics refreshed every 15 minutes, queue-based sends, debounced Realtime on boards.

### 4.3 Mobile

Receptionists and doctors will use phones. Today: a drawer menu and responsive pages, but desktop-first tables and no installable app.

- **(done)** Bottom tab bar, safe-area padding, installable manifest and icon.
- **(built in Phase 13, not yet tried on a phone)** Service worker (offline page, update prompt, push), PNG and maskable icons, install button, pull-to-refresh, swipe actions in the inbox (take, close), composer that follows the on-screen keyboard, camera and gallery upload, 44 px tap targets on touch screens, agenda list on phones, card layouts for every grid. Voice-note recording already existed.
- Passkey or PIN unlock for the installed app on shared devices.
- Test matrix: iOS Safari (installed PWA, for push) and Android Chrome; Lighthouse PWA audit in CI.
- Option later: a Capacitor wrapper if iOS push proves unreliable.

### 4.4 Notifications

**Built in Phase 13** (details and limits in `docs/13_PHASE_13_NOTES.md`): per-user preferences with quiet hours, Web Push, sound and tab-title badge, escalation ladder, daily and weekly digests, notification centre with filters and snooze. Not built: Slack/Teams webhook channel, staff WhatsApp alerts. The table below is the original review.

Today: in-app bell with Realtime, task-due and enquiry-SLA reminders, e-mail through Resend, finance alerts.

| Add | Why |
|---|---|
| **Per-user preferences** (event by channel matrix, quiet hours) | Stops alert fatigue |
| **Web push** (service worker, VAPID) for new messages, mentions, assigned conversations, SLA breach, failed reminders | Staff are not watching the tab |
| **Sound and tab-title badge** for inbound WhatsApp | Front desk basics |
| **Escalation ladder**: unassigned for 5 minutes tells the team lead; 15 minutes tells the on-call | Nobody misses a patient |
| **Daily and weekly digests** (management dashboard by e-mail; flagged as unbuilt in Phase 10) | Management value without logging in |
| **Slack/Teams webhook** channel | Clinics that live in chat |
| **Notification centre** page with filters and snooze | The bell only shows 20 |
| **Staff WhatsApp alerts** for critical events only (ids, never patient content) | Last-resort reach |

### 4.5 The receptionist: a "Front desk" mode

This is the screen that sells the product. One page, built for someone answering a phone and WhatsApp at once.

1. **Today board**: arrivals expected, confirmed vs unconfirmed (from reminder replies), no-shows, walk-ins, next free slots.
2. **Check-in** with statuses Arrived, With doctor, Done, Checked out (a Pulse-side status; Unite stays the system of record and is read-only).
3. **Screen pop**: when a WhatsApp message arrives, a patient card shows the next appointment, last visit, open enquiry and any balance flag.
4. **One-tap actions**: book, reschedule, cancel, call (tel: link, logged as a task), send location, send directions, send "your doctor is running late".
5. **Waitlist and gap filling**: when an appointment cancels, offer the slot by WhatsApp to the waitlist in order. This directly earns money.
6. **Quick replies** with `/` shortcuts, bilingual, with variables.
7. **Walk-in registration** in under a minute: phone number, name, language, consent tick; QR on the desk that opens a WhatsApp chat with a pre-filled message to register themselves.
8. **Insurance card and ID capture** from the phone camera into the patient's documents (see 4.7).
9. **Household linking**: one phone number often serves a family. Allow dependants under a guardian contact so reminders reach the right person about the right patient.
10. **End-of-day sheet**: unconfirmed tomorrow, unanswered conversations, open call tasks, failed messages. Printable.
11. **Shift handover notes** pinned at the top of the board.
12. **Double-booking guard** (the advisory lock from 2.3) and a soft warning for overbooked slots.

### 4.6 AI and flows

Today: suggested replies grounded in the knowledge base, conversation summary, rewrite, translate, thumbs feedback, guardrails (no diagnosis, no dosing, escalate to staff), draft-only; a visual flow builder with 21 node types, simulation by Test mode and run logs.

Proposed, in order of value:

1. **Flow Copilot. Built in Phase 17** (unproven with a real model). Type "If someone asks about prices, give the price list and offer a booking; outside office hours say we are closed" and get a draft flow in the builder. It generates the same graph JSON the builder uses, validated by the same graph checker, shown as a draft with the "Checks" panel; it is never auto-published. A **dry-run** button replays a sample conversation through the flow with no sends.
2. **Campaign Copilot. Built in Phase 17.** Describe the audience in words ("patients not seen in 90 days, Arabic speakers, no marketing opt-out") and it produces the filter definition the audience builder already uses, with the matching count before anything is sent. It also drafts template copy in English and Arabic and lints it against Meta's category rules and our opt-out line.
3. **Intent detection. Built in Phase 17** (labelling OFF by default; emergency wording check always on). On inbound messages (booking, price, complaint, report request, emergency) to tag and route. Emergency wording escalates to a human immediately with a notification. Needs the sign-off in OQ-61.
4. **Voice notes**: transcribe to text for the agent (needs the consent and provider decision).
5. **Smart summaries** at hand-off and at close, written to the timeline.
6. **Reply quality loop. Built in Phase 17.** Weekly report of AI suggestions accepted, edited or rejected, and the questions with no good answer (to grow the knowledge base).
7. **Rules that stay**: clinic-specific only (Meta bans general chatbots), drafts for staff, no diagnosis or dosing, human takeover always one click, every AI call logged without patient content.

### 4.7 Media, files and data

**Built in Phase 16 (waiting for review, merge and a real-device check):** Media Library, Patient documents tab with the view/download log, camera capture, rotate and trim, thumbnails and viewer in the conversation, malware-scan hook (no provider yet), retention policy per category, storage usage dashboard. Still open: a real scanner (OQ-70), PDF preview inside the app (files open in a new tab), tested backup and restore, nested folders.

Original plan, kept for reference. Today (before Phase 16): WhatsApp media goes to a private `wa-media` bucket with signed URLs; portal records can hold files.

Add a proper **Media Library** and **Patient documents**:

- **Media Library**: organisation-wide images, PDFs and videos with folders and tags, used for template headers, campaigns and quick replies. Validates against WhatsApp limits (image 5 MB, video 16 MB, document 100 MB), compresses images on upload, tracks where each file is used.
- **Patient documents tab** on every contact: referral letters, lab reports, insurance cards, consent forms, with category, expiry date (insurance cards expire), who uploaded, and **a log of every view and download**. Access is a permission, not a default.
- Camera capture on phones; image rotation and crop; PDF preview; thumbnails and lightbox in the conversation.
- Malware scan on upload, retention policy per category, storage usage dashboard, backups with a tested restore.
- Residency follows OQ-49: files are health data.
- Out of scope: imaging (DICOM) and storing clinical notes beyond what Unite holds.

### 4.8 Integrations worth planning

| Integration | Value | Notes |
|---|---|---|
| **Google/Outlook calendar** (doctors) | Doctors see their day on their phone | Two-way is harder; start with read-only feed (ICS) |
| **Google Business reviews** | Review request after a happy visit | Route unhappy feedback to a manager task instead |
| **Meta Lead Ads and click-to-WhatsApp attribution**, Conversions API | Know which ads bring patients | `referral` data arrives on the first message |
| **Instagram and Messenger DMs** | One inbox for social | Separate Meta permissions |
| **SMS fallback** (a UAE-registered sender) | Reach people when WhatsApp fails | Sender ID registration takes time |
| **Payments** (Stripe, Telr, PayTabs, Network International) | Pay-by-link in the chat; deposits | Merchant account needed |
| **Accounting** (Zoho Books, QuickBooks, Xero) | Invoice and receipt export | One-way |
| **Telephony** (WhatsApp Calling API, Zoom Phone) | Call log on the patient timeline | Check Meta's UAE availability |
| **Telehealth video** (Daily, Zoom) | Video appointment type with a join link | Consent and recording policy |
| **e-Signature** (DocuSign) | Consent forms signed from a link | Store signed PDF in patient documents |
| **Health information exchanges and e-claims** (DHA eClaimLink, DoH Shafafiya, Malaffi, NABIDH) | Direct claim and records exchange | Regulated; assess with a licensed partner before any build |
| **BI** (Power BI, Looker, BigQuery) | Management's own dashboards | Read replica or scheduled export |
| **Zapier/Make** | Anything else | Already possible through the public API and webhooks |
| **Website** forms, chat widget and booking widget | Leads straight into enquiries | Incoming-webhook entry points exist |

### 4.9 Clinic-level improvements

- **No-show reduction**: reminder-reply tracking (built), no-show risk flag, waitlist fill, deposit for repeat no-show patients.
- **Patient self-service in WhatsApp**: book, reschedule, cancel, ask for a report, pay, share location, in English and Arabic.
- **Feedback and reputation**: a rating after each visit; happy leads to a Google review request, unhappy creates a manager task within the hour; NPS trend by doctor and branch.
- **Preventive and chronic care**: recall programmes are built (birthday, chronic 90-day); add vaccination schedules, annual check-up and medication-refill reminders after clinical sign-off.
- **Referral and source tracking**: where each new patient came from (ad, website, walk-in, doctor referral, friend).
- **Utilisation**: slot utilisation by doctor and room, idle gaps, cancellations by reason.
- **Packages and vouchers**: sessions remaining, expiry reminders.
- **Complaints and incident register** with owner, due date and closure, for quality audits.
- **Consent management**: marketing consent, clinical-messaging consent, language preference, with evidence and date (the data model has these; add a clear UI).
- **VIP and special-needs flags** with care notes visible to the front desk only.

### 4.10 Insurance and billing

Built: Unite invoice capture (off), Diligence claim upload and matching, exception rules E01 to E10, aged receivables and monthly summary, data-health page, alerts.

| Improvement | What it does |
|---|---|
| **Pre-authorisation tracker** | Request, approved, expiry; linked to the appointment; task when about to expire |
| **Eligibility check step** | Card photo, payer, validity; blocks "ready to bill" if missing |
| **Denial management** | Reason-code taxonomy, owner, resubmission deadline countdown, AI-drafted appeal letter (draft only, human sends) |
| **Remittance reconciliation** | Match payment advice to claims, flag short payments against the payer's agreed price list |
| **Payer scorecards** | Denial rate, days-to-pay, top denial reasons by payer and by doctor |
| **Collections forecast** | Expected cash by week from ageing and payer history |
| **Self-pay recovery** | Outstanding-balance reminders by WhatsApp (opt-in, tone-reviewed), payment links, instalment tracking |
| **Month-end close pack** | One-click PDF/XLSX with sign-off by finance and the CEO; locks the month |
| **End-of-day cash-up** per branch | Reconcile payments by mode |
| **Revenue views** | By doctor, department, branch, service; estimate generator for patients |
| **Accounting export** | One-way to Zoho/QuickBooks |
| **Coding hints** | Draft suggestions for missing documentation (never auto-submitted) |

Rule that stays: Unite is the system of record, Pulse mirrors and flags. The deliver-once finance API is touched only by the guarded job.

### 4.11 Activity logs, history, user checks and access

| Have today | Gap and fix |
|---|---|
| `audit_log` (security and configuration events, append-only) | **(done) Activity log screen, now with Sign-ins, Record access, Alerts and API reads tabs and an audited CSV export (Phase 15).** Next: saved filters |
| Contact timeline with field-level changes | **(done, Phase 15)** History tab in the appointment, enquiry, task, template, flow and portal-record drawers (one `record_history` table, one component). Contacts keep their timeline; finance reference data still to do |
| Clinical settings history with signer | Same pattern for finance reference data and message templates |
| Roles with 42 permission keys, teams, invites, presence | **(done, Phase 15)** Login history, session list (sign out this device, others, everywhere), MFA switch per role (Supabase TOTP). Not done: revoking one specific other device (Supabase Auth has no API for it) |
| Read access to patient records is not logged | **(done, Phase 15)** Record access log: single opens and exports always, list views sampled, retention setting, viewer with filters |
| No periodic review | **(done, Phase 15)** Access review page with dormant detection, API-key owners and a signed quarterly attestation |
| Anyone with the role keeps access until removed | **(done, Phase 15)** One-step off-boarding. Not done: working-hours or IP restriction for finance |
| Alerts on job failures | **(done, Phase 15)** Anomaly alerts: bulk export, off-hours access, five failed sign-ins, role changes, bulk API reads |
| Delete and merge exist | **(done, Phase 15)** Patient data export and erasure with a two-person rule. **(done)** Soft delete with a restore window: Settings, Recently deleted (`docs/35_SOFT_DELETE_NOTES.md`) |
| Backups are the host's | Written backup and restore drill, PITR on, annual test |

---

## 5. Roadmap

Each phase starts in Plan Mode and uses the prompt of the same number in `docs/10_NEXT_PHASE_PROMPTS.md`. Effort assumes one senior builder with Claude Code.

| Phase | Outcome | Needs from you | Effort |
|---|---|---|---|
| **12a** | UX foundation: grouped menu, quick search, mobile tabs, skeletons, error pages, PWA manifest, Activity log, CI. **Done in this session** | nothing | done |
| **12b** | Make it real: bring up the Supabase and Vercel stack, seed demo org, click every page as three roles, fix what breaks, DB and e2e tests in CI, update stale docs. (`pnpm demo:reset`, item 6, was built in Phase 14.) | accounts 1, 2, 3 | 1 week |
| **13** | Mobile, notifications and speed: service worker, web push, preference matrix, escalation ladder, digests, layout/dashboard query cuts, dynamic imports, performance budget. **Built; waiting for review, merge and a real-device check** (`docs/13_PHASE_13_NOTES.md`) | VAPID keys (`pnpm push:keys`) | done in code |
| **14** | Front desk mode, waitlist, walk-in registration, household linking, quick replies, in-app help and training mode, `pnpm demo:reset`. **Built; waiting for review, merge, a real-device check, Meta approval of the offer templates and the training videos** (`docs/14_PHASE_14_NOTES.md`) | clinic input (offer wording), recorded videos | done in code |
| **15** | Security and audit: MFA, login history, sessions, record access log, access review, anomaly alerts, History tabs. **Built; waiting for review, merge and a real-stack check** (`docs/12_PHASE_15_NOTES.md`) | none | done in code |
| **16** | Media Library and patient documents. **Built; waiting for review, merge, a real-device check and the residency answer (OQ-68) before documents are switched on** (`docs/15_PHASE_16_NOTES.md`) | residency answer | done in code |
| **17** | AI: Flow Copilot, Campaign Copilot, intent routing, reply-quality loop. **Built; waiting for review, merge, a click-through, a trial with real wording and the answers to OQ-57, OQ-61 and OQ-78 to OQ-82 before any of it is switched on** (`docs/17_PHASE_17_NOTES.md`) | OQ-57, OQ-61 | done in code |
| **18** | Finance and insurance upgrades: pre-auth, denials, remittance, scorecards, month-end pack. **Built; waiting for review, merge, a click-through and the thresholds (OQ-72 to OQ-77)** (`docs/16_PHASE_18_NOTES.md`) | Diligence export, thresholds | done in code |
| **19** | Integrations: calendar feed, payments, SMS, reviews, ads attribution | the accounts in 4.8 | per integration |
| **Go-live** | Staging rehearsal, parallel run, number-by-number cut-over, retire Make, Airtable, Sanoflow | everything in section 3 | 3 weeks including the parallel week |

The pitch only needs 12b to be real. 13 to 15 turn it from "it works" into "I would trust it with my clinic".

---

## 6. Going live

1. **Accounts and secrets** (3.1), Supabase migrations pushed, Vercel deployed, cron schedules created.
2. **Staging rehearsal**: `pnpm cutover:preflight --stage pre-cutover` must report GO. Load tests on staging.
3. **Data**: Airtable and Sanoflow import with `--dry-run`, then real (`pnpm import:sanoflow:all`; appointments with `--with-appointments` only once Sanoflow's reminders are off), then `pnpm reconcile --live-airtable --sanoflow-counts latest`, sign-off file completed by operations, clinical and engineering.
4. **Parallel week**: Make and Pulse side by side in Test mode; `/recall/parallel-run` has to be clean before "Make off" unlocks.
5. **Cut over WhatsApp numbers one at a time**, lowest-traffic number first. Keep Sanoflow subscribed until the third number is stable.
6. **Retire** Make, then Airtable, then Sanoflow. Revoke the migration tokens. Rotate the Unite keys.
7. **Clinical messaging** switches on only after the clinical lead signs the validation period (OQ-16).

Definition of done is in `docs/02_CLAUDE_CODE_BUILD_PLAN.md` section 10 and `docs/06_PHASE_11_CUTOVER.md`.

---

## 7. Demo and MVP preview

For a client demo use a **demo org with synthetic patients only** (the seed already does this: `admin@pulse.local`). The script, the story order and the click path are in `docs/pitch/DEMO_SCRIPT.md`. The deck is `docs/pitch/Pulse_Pitch_Deck.pptx`.

Minimum bar before showing it live:
1. Phase 12b done: the stack is running, not a laptop prototype.
2. A test WhatsApp number connected, so the inbox moment (a real message arriving and a reply with ticks) is genuine.
3. Demo data reset script run the morning of the demo.
4. A recorded fallback video of the whole walkthrough in case Wi-Fi fails.

---

## 8. Recordings for training and for the pitch

Recorded walkthroughs of the product at work serve three audiences: receptionists learning the system, new hires later, and the client who wants to see it without a live demo.

**How to make them so they stay current**
- Script each walkthrough as a Playwright scenario against the demo org (synthetic data). The tool records video, so re-recording after a UI change is one command, not a re-shoot.
- Add on-screen captions and a cursor highlight in the script; add a voice-over (human or text-to-speech) in English and Arabic.
- Export MP4, host privately (Supabase Storage, Vimeo or unlisted YouTube), and surface them in the app: **Help, Training**, grouped by role, with a "?" on each page that opens the matching clip.
- Add a **Training mode**: a sandbox org with a banner so staff can practise without touching real patients.
- Pair each video with a one-page quick card (PDF) and a three-question check at the end.

**Receptionist curriculum (12 clips, 3 to 5 minutes each)**
1. Install Pulse on your phone and sign in
2. Your day at a glance (Front desk board)
3. Inbox basics: assign, reply, close, notes
4. The 24-hour rule and when to use a template
5. Booking, moving and cancelling an appointment
6. Handling reminder replies (Confirm, Reschedule, Cancel)
7. Call tasks and the daily call list
8. Registering a walk-in and linking family members
9. Finding and merging duplicate patients
10. Failed messages: what to do
11. End-of-day checklist and handover
12. Privacy rules: what you never put in a chat or a screenshot

Then similar short sets for managers (dashboards, campaigns), finance (uploads, exceptions) and admins (users, roles, activity log).

---

## 9. Immediate next actions

1. You: create the Supabase project and the Vercel project, and send me nothing secret; set the variables yourself (3.1 rows 1 to 3).
2. You: open Meta Business Manager and confirm WABA ownership (OQ-38). This is the longest lead time.
3. Me: run Phase 12b with those in place.
4. You: send the first questions to Abdul/Snezana (clinical thresholds), Sharaf (Diligence header row) and Unite (credentials, token coexistence).
5. Decide the client demo date; work back from it using section 7.
