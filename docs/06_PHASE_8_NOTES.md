# Phase 8 — Flows + Make replacement: what was built and how to use it

## Scope delivered

Phase 8 was first built on a branch cut before Phase 6, then **merged onto `main` after Phase 6 (appointments, Unite sync, clinical rules engine), Finance and Phase 11 hardening landed**. It builds on Phase 6's tables and does not recreate them. Phases 4, 5, 7, 9 and 10 landed on `main` while this was in review. The enquiry / task / portal / appointment flow nodes still go through the small port (`lib/flow-engine/crm-registry.ts`) and fail closed until adapters are registered; wiring them to the real Enquiries, Tasks and Portal services is the first follow-up. Nothing here calls Unite.

### Flow engine (`lib/flow-engine/`)

| File | What it does |
|---|---|
| `types.ts`, `graph.ts` | Graph schema (React Flow JSON), edge handles (`default`, `fallback`, `option:<id>`, `inside`/`outside`, `true`/`false`), validation. Structural errors and "this node still needs settings" errors both block **Publish**. |
| `run.ts` | `startRun` / `advance` / `resumeFromTimer` / `resumeFromReply` / `cancelRun`. **One `flow_steps` job per node.** A per-conversation lease lock (`claim_flow_lock`) serialises steps; max **200 steps** per run; the `flow_run_steps` row is written **before** side effects and holds the executor's outcome, so a redelivered job replays the outcome instead of sending twice. Waits use `scheduled_jobs` (`flow.resume`), never in-memory timers. |
| `executors/*` | 20 node types: Message, Question (≤3 buttons / ≤10 rows / free text, saves a variable, timeout → fallback), Quick reply, Template, Branch, Wait, Office hours, Run flow (depth ≤ 3), End flow, Assign to, Close conversation, Add comment, Update contact field, API action, Send notification, plus Create enquiry / Add task / Portal record / Book appointment (ports). |
| `triggers.ts`, `listeners.ts` | Domain events → `flow_steps` trigger jobs (the listener only enqueues). `message.received` resumes a waiting bot run; a template quick-reply tap starts a `template_button` flow. Conditions: **Source / Keyword / Ad** × equals / not equals / contains / not contains (AND/OR). |
| `interpolate.ts` | `{contact.first_name}`, `{vars.KEY}`, `{steps.<node>.response.x}`, `{appointment.starts_at|date:"DD MMM HH:mm"}`, `{x|default:Patient}`. Unknown paths render empty and are reported. |
| `supabase-deps.ts` | Production adapters. Sends go through `queueOutbound` (bulk `outbound` queue, rate limit + 24h guard apply there). Template sends do not need an open window; free-form Message/Question nodes check the window first and fail the step otherwise. |
| `takeover.ts` | Human takeover cancels the live run (and nested runs). Called from the inbox actions: agent reply (text, attachment, template), assign, close, "Take over from bot". |
| `catalog.ts`, `starter-flows.ts`, `schedule.ts` | Node catalogue + search, five starter flows, recurring-schedule ↔ cron builder. |
| `http-action.ts`, `ssrf.ts` | API Action: https only, no credentials in URL, private/loopback/link-local/metadata addresses blocked (literal check **and** DNS re-check), no redirects, 100 KB response cap. |
| `webhook-token.ts` + `app/api/webhooks/in/[flowId]` | Incoming-webhook trigger: bearer token (only its SHA-256 is stored), body ≤ 64 KB, phone normalised to E.164, contact matched or created (`source = 'api'`). |

Other triggers: **Recurring** (`flow_recurring` task, every minute, cron in Asia/Dubai, optional segment → one run per member up to 200/tick), **Shortcut** (inbox composer button), enquiry/appointment triggers (fire when Phase 5/6 emit `enquiry.*` / `appointment.*`; the event names are already in `DomainEventName`).

### Flows UI (`/flows`)

List (trigger, number, ✅ completed / ⚠️ failed / ⏳ running+waiting, status; pause/resume, duplicate, delete, logs, "start from" starter flows), **Variables** manager (`{vars.NAME}`, enable/disable), **builder** on `@xyflow/react` (searchable palette with drag-and-drop, zoom/minimap, undo/redo with Ctrl+Z / Ctrl+Shift+Z, per-node properties, trigger settings incl. conditions and cron builder, live checks list, Save draft, Publish → immutable `flow_versions` snapshot), **Logs** and a per-run step trace. Runs pin their `flow_version`, so editing a published flow never changes a conversation already in progress.

> Trigger settings (trigger type, conditions, number) apply as soon as they are saved; changes to the *steps* apply only after Publish. The builder says so.

### Inbox

* **Shortcut** button in the composer lists active `shortcut` flows and runs one on the conversation (`runShortcut`, `inbox.send`).
* **Human takeover** now actually stops the bot: see `takeover.ts` above. "Hand to bot" still just sets `bot_active`.

### Recall programmes (`lib/recall/`, `/recall`)

`runProgramme` is the engine: gate → send mode → eligibility view → per row (template map, opt-outs) → **`recall_sends` row inserted first** (unique contact + programme + cycle ⇒ idempotent) → template queued.

* **Test/Live.** Default is **Test**: effective mode = programme override ?? `clinical_settings.recall_send_mode` (signed off) ?? `test`. In Test mode nothing reaches a patient: messages go to internal **test contacts** (`is_test_record`) built from `test_recipient_numbers`, and only a **sample** (default 5 per run, `config.test_sample_size`) is actually delivered; the rest are recorded with status `eligible` ("counted, not delivered") so the parallel-run comparison still sees them. No test numbers signed off ⇒ the run is blocked.
* **Live** needs an explicit `live`, and clinical programmes (chronic, screening, post-visit, no-show) additionally need `clinical_messaging_enabled = true`. Going Live in the UI needs `clinical.settings.manage`.
* **Fail closed.** No template mapped, template not linked, or not `APPROVED` ⇒ `skipped_no_template` (no default template, by design: OQ-24). `stop_marketing`, missing marketing opt-in, missing clinical consent (Live) ⇒ `skipped_opted_out`. Unsigned thresholds ⇒ the SQL views return nobody (`chronic_recall_min_days` is OQ-01 and is **not signed off**, so the chronic programme currently selects nobody).
* **Programmes** (seeded as drafts by `seed_phase8_defaults`): `chronic_90d` (12:15, max 100, oldest visit first), `birthday` (09:00, six gender/age bands, 29 Feb → 1 Mar, yearly cycle; Make ran at 12:00 — OQ-55), and the screening/dormant programmes as inactive rows with no view yet.
* **Attribution** (`lib/recall/replies.ts`, `attribution.ts`, `listeners.ts`): an inbound message credits **only the newest open send** within `recall_reply_attribution_days` (default 14; Make marked every row for the phone). Quick-reply buttons map to outcomes (`Book now → wants_booking`, `Claim offer → offer_redeemed`, `Not interested → declined`; per-programme overrides in `config.button_outcomes`). `appointment.created` credits a booking within `recall_booking_attribution_days` (default 30) and sets `follow_up_status = booked`.
* **Delivery status** is mirrored onto `recall_sends` by the `recall_run` task (forward-only).
* **UI.** Programme list + right-hand drawer (status, Test/Live override, schedule, max per run, test sample, preview of who would be picked up as *counts only*, template per group, recent weeks), a "where messages go" panel (test numbers + workspace default, signed off), the **call list** (`v_recall_call_list`, outcome picker, booked ⇒ booking date), and the parallel-run report.

### Make scenarios → native (see also `docs/audit/make-replacement-design.md`)

| Make scenario | Native replacement | Status |
|---|---|---|
| 5 Chronic recall (5882746) | `chronic_90d` programme | Built, **Test only**; selects nobody until OQ-01 is signed off and templates are linked |
| 6 Chronic update (5916036) | `lib/recall/attribution.ts` + starter flow "Recall: patient taps Book now" | Built |
| 4 Birthday (4049277) | `birthday` programme + `birthday_sent_<year>` tag in Live | Built; Make's "one message ever" becomes once per year (OQ-17/18 to confirm) |
| Birthday Offer Update webhook (inactive) | Button outcome `offer_redeemed` + starter flow "Birthday offer" | Built |
| 2 + 3 Appointment reminders (3613818, 3913219) | **Phase 6** (`lib/appointments/reminders.ts`, `appointment_reminders` + `scheduled_jobs`) | Not part of recall. Phase 8 only compares it in the parallel run (reminders *scheduled* for each day vs Make's) |
| Post-appointment follow-up, NoShow recovery (drafts) | Starter flows | Built as starters (need a template chosen) |
| Screening / dormant scenarios (inactive) | Rows in `recall_programmes` | Seeded, inactive, no eligibility view yet |
| 1 Token (3576415) | `lib/unite/auth.ts` | **Deferred to Phase 6** (Unite stays untouched) |
| 7 MRD sync (5990863) | Phase 6 clinical engine | **Deferred to Phase 6** |
| Airtable native automations (2) | Document, then switch off | Open (OQ-41) |
| Finance API (6555877) | — | Not touched (sync-once; stays feature-flagged/off) |

### Parallel Run (`/recall/parallel-run`)

* Native side: per scenario and clinic-local day, the **salted SHA-256** of the Unite PIN (appointment id for reminders) of everything the native engine did (queued, counted-in-Test, sent…; for reminders, what Phase 6 scheduled for that day via `appointment_reminders.due_at`, so patients are never messaged twice for the comparison; replies for Chronic update).
* Make side: `pnpm parallel:ingest --org <slug> --scenario birthday --date YYYY-MM-DD --file ids.txt` (one PIN per line; hashed immediately, the file never leaves your machine — don't commit it). Needs Airtable/Make log IDs exported separately; the tool does not call Make or Airtable.
* The `parallel_run` task (00:30 Asia/Dubai) stores `parallel_run_diffs` (counts, only-in-Make, only-in-native hashes). Every day with a difference needs a written reason and **Mark explained**.
* Checklist per scenario: ☐ native built ☐ 7-day parallel ☐ differences explained ☐ **Make off** (the last one is only enabled when the first three hold; Token / MRD sync / Airtable automations are not comparable yet and are marked as blocked).

## Data model (migrations `20261010000600`–`…000900`, numbered after Phase 9)

`flows`, `flow_versions`, `flow_runs` (one live top-level run per conversation: partial unique index), `flow_run_steps`, `flow_variables`, `flow_locks`, `v_flow_run_counts`; real FKs for `conversations.flow_run_id`, `messages.flow_run_id`, `segments.drip_flow_id`. **On top of Phase 6:** `20261010000700_recall_reference.sql` adds only what Phases 6 and 9 do not have and the recall views read: `contact_chronic_conditions` and `clinic_calendar` (+ `workdays_between`). `ref_condition_groups`, `ref_diagnoses` and `seed_condition_groups` come from Phase 9. `20261010000800_recall.sql` is draft `0104` (programmes, template map, sends, views). `…000900_recall_phase8.sql` adds `recall_programmes.last_run_at`, `flows.last_triggered_at`, `recall_clinical_messaging_enabled()` (a service-role wrapper over Phase 6's `app.clinical_messaging_enabled`), `seed_phase8_defaults(org)`, the parallel-run tables (hashes only) and the cron entries. Phase 6's `clinical_settings`, `visits`, `appointments`, `appointment_reminders`, `reminder_exclusions` and the `contacts.is_test_record` / `clinical_messaging_consent` columns are used as they are.

New permission key: `portal.recall_sends.write` (call-list edits). `clinical.settings.manage` (Phase 6) also gates switching a programme Live. Admin has `*`; Manager has `portal.*`. Recall pages use existing keys (`campaigns.view` / `campaigns.create` / `templates.manage` / `reports.view` / `settings.manage`).

## Operating notes

* **Cron** (migration `…001600`): `pulse:recall_run` and `pulse:flow_recurring` every minute, `pulse:parallel_run` daily. Both per-minute tasks claim their row atomically (`lib/jobs/claim.ts`), so overlapping pings never double-fire.
* **First visit** to `/recall` (or the parallel-run page) seeds the workspace (`seed_phase8_defaults`): condition groups, the clinical settings rows (all *awaiting* sign-off; Phase 6's page seeds the same rows), programmes and the parallel-run scenarios.
* **Going Live checklist** (per programme): link approved templates for each group → sign off `test_recipient_numbers`, `recall_send_mode` and the thresholds in **Clinical settings** (`/portal/clinical-settings`; the Recall page only shows the current values and links there) → sign off `clinical_messaging_enabled` for clinical programmes → run a week in Test and review the parallel-run report → set the programme to Live (needs `clinical.settings.manage` and typing `I CONFIRM`, like Phase 6's guarded settings).
* **Event listeners** run in-process. `lib/flow-engine/listeners.ts` and `lib/recall/listeners.ts` register on import; the jobs route and the inbox server actions import them. Any other code path that emits events must import the listener module too.
* **Test numbers** are stored by the clinical sign-off as a JSON array of E.164 strings; the engine also accepts comma/newline lists.

## Testing

* **Unit** (`tests/unit/flow-*.test.ts`, `recall-engine`, `parallel-run`, `cron`): every executor, the run loop (locking, 200-step cap, idempotent replay, wait/resume, stale tokens, takeover, nested flows), triggers + conditions, graph validation, SSRF guard, starter flows, recall gates (Test/Live, fail-closed templates, opt-outs, idempotency, sample cap), attribution, diff + retirement readiness.
* **DB** (`tests/db/flows-recall-rls.test.ts`): cross-org isolation on every new table and view, engine-owned tables have no user write policy, one-live-run index, lock lease, seed functions are service-role only, eligibility views (birthday bands, reminder window/exclusions, chronic fail-closed).
* **Integration** (`tests/db/flows-integration.test.ts`, needs PostgREST — see `supabase/test/README.md`): the real adapters end to end — start → question → inbound button reply → resume → complete, takeover, timers via `scheduled_jobs`, keyword triggers, recurring claim, the webhook route, recall Test/Live, idempotency, attribution, status sync, parallel-run diff. This caught a real bug: PostgREST rejects `or=` on UPDATE, so cron claims use two conditional updates.
* **E2E**: signed-out redirects for the new pages; webhook 404 for a malformed id. The builder was also exercised in Chromium (add node, undo/redo, palette search).

## Not done / known gaps

* **Live path against real Meta** is untested (no credentials). Test mode and everything up to `queueOutbound` is covered.
* **Unite** (Token, MRD sync, appointment/visit sync) — Phase 6, now merged on `main`; the parallel run for Token/MRD sync still waits on their Make-side exports. Phase 6 has since landed; chronic recall still needs `visits` and `contact_chronic_conditions` to be filled by the Unite sync and the threshold signed off.
* **Create enquiry / Add task / Portal record / Book appointment** nodes fail closed ("not available yet") until Phases 5–7 call `registerCrmAdapter` (`lib/flow-engine/crm-registry.ts`).
* **Pipeline** on the flows list is "—" until Phase 5 (`flows.pipeline_id` exists without an FK).
* **Outbound webhooks** (`webhook_subscriptions`) were not part of this phase's prompt and are not built.
* The **Question** node re-asks nothing: an unmatched answer takes the fallback output (or keeps waiting when there is none).
* A crash between "message queued" and "step recorded" can still send once more on replay for nodes that never completed their step row; completed steps never repeat.
* OQ-01 (chronic threshold), OQ-17/18 (birthday bands, 29 Feb), OQ-19 (24 h vs 48 h lead time), OQ-21 (exclusion reasons), OQ-22 (attribution), OQ-23 (status codes), OQ-55 (cron times) are still open and are called out where they bite.

## Demo checklist

- [ ] `/flows` → New flow → start from "Inbound routing by office hours" → pick teams and Publish; the Checks panel lists what is missing until you do.
- [ ] In the inbox, **Shortcut** lists active shortcut flows; running one sets the conversation to "Assigned to bot"; replying as an agent cancels it.
- [ ] `/recall` → sign off two test numbers → activate **Birthday** → wait for 09:00 (or `pnpm jobs:run recall_run`) → only your test numbers receive a sample; `/recall` shows the counts.
- [ ] `/recall/parallel-run` after importing a day of Make output: counts per day, differences needing a reason, **Make off** disabled until the week is clean.
