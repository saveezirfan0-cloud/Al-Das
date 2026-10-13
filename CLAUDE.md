# CLAUDE.md — Pulse (Al Das in-house clinic platform)

> Rename to `CLAUDE.md` at the repo root. Put `01_FEASIBILITY_AND_TEARDOWN.md` and `02_CLAUDE_CODE_BUILD_PLAN.md` in `/docs`. The Airtable/Make audit goes in `/docs/audit/`.

## What we're building
One platform for Al Das Medical that replaces **Sanoflow** (WhatsApp inbox, templates, campaigns, enquiries, appointments, bots, AI assist, reports) and the **Airtable + Make.com back office** (patient CRM, operational portal screens, Unite sync, native automations, management dashboards). The spec is `docs/01`; the plan and phase prompts are `docs/02`. **Work one phase at a time and start each in Plan Mode.**

## Stack — Supabase + Vercel only
- Next.js 15 App Router, TypeScript strict, Tailwind, shadcn/ui, deployed on Vercel.
- Supabase: Postgres (SQL migrations via the Supabase CLI), Auth, Realtime, Storage, **pgmq** (queues), **pg_cron + pg_net** (cron calls `/api/jobs/[queue]`), pgvector.
- `supabase-js` with generated types. No Prisma, no Redis, no separate worker server.
- TanStack Table, dnd-kit, @xyflow/react, FullCalendar, Recharts, Tiptap, Zod, Anthropic SDK, Resend, Sentry, Vitest, Playwright.

## Non-negotiable rules
1. **RLS on every table**, keyed on `org_id` via memberships. Use the service role only in server code after `can()` checks. Keep a test suite proving cross-org access fails.
2. **Permissions:** every mutation and sensitive read checks `can(member, 'perm.key')`.
3. **Meta webhooks:** verify `X-Hub-Signature-256` → store raw → `pgmq.send` → 200 fast. Processing happens in job handlers and is idempotent (unique `wa_message_id`; status only moves forward).
4. **Outbound WhatsApp only through queues**, with the per-number rate limit and the 24h window guard (free-form inside 24h, otherwise template).
5. **Contacts are matched by BSUID (`user_id`) and/or E.164 phone.** The phone can be missing for WhatsApp username users. Subscribe to `user_id_update`.
6. **Job handlers** are short, batched and idempotent, and log to `job_runs`. Long waits use `scheduled_jobs` (`SKIP LOCKED`), never in-memory timers.
7. **Unite EMR is live production: read-only in the MVP.** Use conservative rate limits and back-off, log every call, never bulk-hammer, never write. Tokens expire in about 240 s, so refresh on demand. **The Unite Finance API is sync-once (each call permanently dequeues records). Never call it outside the guarded, feature-flagged job that writes raw payloads first.**
8. **Imports (Airtable, Sanoflow, Unite)** are idempotent via `external_refs`, with dry-run + reconciliation reports.
9. **Secrets:** Meta System User token and integration creds are encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`). Never log tokens, full phone numbers or message bodies.
10. **PHI:** contact and message data is health data. **No real patient data in seeds, tests, fixtures, screenshots or prompts to AI outside the feature itself.**
11. **Marketing compliance:** honour `stop_marketing` / opt-in. Error 131050 sets `stop_marketing = true`.
12. **AI:** clinic-specific only (Meta bans general-purpose AI chatbots). Drafts only in the MVP; no diagnosis or dosing; escalate to staff. Model ID from `ANTHROPIC_MODEL`.
13. **Flow engine:** one job per step, an advisory lock per conversation, max 200 steps, and every executor unit-tested.
14. **Branding:** original names, copy, icons and template texts. Don't copy third-party product assets.

15. **Clinical rules** (docs/audit/airtable-schema.md §3) live in `lib/clinical/` as pure functions. Each one has unit tests, fails closed on unknown or blank data, and reads thresholds from `clinical_settings`, never hardcoded.
16. **Audit files** in `docs/audit/` are the source of truth for migration. Never commit unredacted blueprints, tokens or record exports.
17. **Security guards are tests.** A new table needs RLS and a policy scoped to `org_id` (or an entry in the service-only list in `tests/db/security-guard.test.ts`); a new server action or route needs `requirePerm`/`can` and, if it mutates, `recordAudit` (or a reasoned entry in `lib/security/policy.ts`); rate-limit anything unauthenticated with `lib/rate-limit.ts`; pass free-form error text through `lib/redact.ts` before logging or persisting it.

## Finance & Insurance module (docs/05_FINANCE_MODULE_PLAN.md)
Captures Unite invoices, matches them to Diligence claim files, and routes exceptions. Phases F0–F6 plus the F7 UI polish pass; all built (Unite capture is built but OFF; only the closed-month review with Saeed remains, a human step). Open items: `docs/finance/open-items.md`.
- Tables are `public.fin_*`, `ins_*`, `ops_*` (never separate schemas); raw tables (`fin_raw_*`, capture settings and lease) have RLS and **no policies**: service role only, and the payload column is never selected for the UI.
- **The Unite Finance API is deliver-once.** Only the F2 `finance_capture` handler may call it, only when `fin_capture_settings.enabled` is true (default false), only after taking `fin_capture_try_lease`, and only after the previous raw payload is stored. No scripts, tests or "quick checks" against it.
- Store the raw batch first, then process with `fin_process_batch` (idempotent, replayable). Never delete invoice lines (`is_current = false`).
- Finance tables carry the Unite PIN only; no names, DOB, Emirates ID or member IDs. Test fixtures are synthetic (`tests/unit/finance/fixtures`).
- Permissions are `finance.*` (see `lib/auth/permissions.ts`); finance reads for staff go through RLS or the `v_fin_*` / `v_ins_*` views, server jobs use the service role after `can()`.
- Unite JSON field names live ONLY in `lib/finance/unite-mapping.ts`; the mapper fails a batch closed rather than guess. Recover with `pnpm finance:replay <batchId|--failed>` (never calls Unite). Tests must never reach Unite (`tests/setup.ts` blocks the host).
- Diligence files: the uploaded `.xlsx` holds names and Emirates IDs. It is parsed server-side, only sanitised rows are staged (`ins_staged_activities`), and the original is deleted at once. Column names live ONLY in `lib/finance/diligence-mapping.ts`; unknown columns are never read. No real export in the repo, tests build synthetic workbooks.
- Claim matching is pure (`lib/finance/match-claims.ts`) and writes through `ins_apply_matches`; commits go through the atomic `ins_commit_import`.
- Exception rules live in SQL (`fin_run_exception_rules`) and read thresholds from `fin_ref_exception_rules`; they are idempotent and guarded against start-up false alarms. Exceptions are only changed through the member's own client (RLS decides) and audited.
- `pnpm finance:seed --org=<slug>` adds the Finance/Billing/Insurance/CEO/Medical Director roles and reference rows to an existing org.
- **Phase 18 upgrades (docs/16_PHASE_18_NOTES.md):** each feature has its own `finance.*` key (`preauth`, `eligibility`, `denials`, `remittance`, `scorecards`, `forecast`, `recovery.manage` / `recovery.approve`, `close.*` with separate `signoff.finance` and `signoff.ceo`, `cashup`, `revenue`, `export.run`); check the one for what the code does, never a neighbour's. Every threshold is read from `fin_ref_finance_settings` (never hardcoded); analytics and state machines are SECURITY DEFINER SQL functions with `search_path = ''`, service role only, returning jsonb; pure rules in `lib/finance/*` are parity-tested against SQL with the shared `phase18-*.synthetic.json` fixtures.
- **Month lock:** the CEO sign-off locks a month in the database (trigger, all roles). Sign-offs are bound to the snapshot sha256 and need two different people. Packs (XLSX, PDF) are rendered from the stored snapshot only. The Unite and Diligence mirrors are deliberately NOT blocked; show drift, never refuse delivered data. Cash-ups in a locked month cannot change.
- **Remittance files** are parsed server-side, sanitised, and the original is deleted at once; column names live ONLY in `lib/finance/remittance-mapping.ts`; matching is pure (`match-remittance.ts`) and an ambiguous match is never guessed. Payment-advice tables (`fin_raw_remittance_files`) are service-only.
- **Appeal letters** are drafts: the app adds the DRAFT banner, the prompt carries ids, codes, amounts and dates only (no names), there is a template fallback, and no code path sends one. **Self-pay reminders** go only through `queueOutbound` with an approved template, `resolveRecipient()`, `promotions_opt_in` and not `stop_marketing`; they stay OFF until the tone is approved (bound to the template wording hash) and an administrator enables them. The accounting export is one-way and audited with `recordExport`.
- A new `gate()` helper in a finance `actions.ts` must be a `function` declaration, not an arrow function, or `pnpm audit:security` cannot see that the action is guarded.

## Mobile, notifications and speed (Phase 13, docs/13_PHASE_13_NOTES.md)
- **Telling people:** use `notify()` (`lib/notify/dispatch-db.ts`) for anything a person can configure. It applies `notification_preferences` (channel per event, master switches, quiet hours) and fans out to in-app, e-mail and Web Push. **Push and e-mail carry ids and a fixed generic sentence only, never a name, number or message text** (`lib/notify/push-payload.ts` takes ids, so it cannot leak). A new event goes in the catalogue `lib/notify/events.ts` first. Plain `createNotification` stays for alerts people cannot turn off (security, finance, integrations).
- **Push:** the sender sits behind the `PushSender` interface (`lib/push/types.ts`); tests use a fake and nothing may call a real push service. Subscriptions are AES-256-GCM at rest and removed on 404/410; endpoints are checked against known push hosts (SSRF). VAPID keys come from `pnpm push:keys`.
- **Service worker (`public/sw.js`):** caches build assets and an offline page only. It must never cache pages, API responses or server actions (patient data). Bump `VERSION` in the file when it changes; new versions wait for the user to accept the update prompt.
- **Escalation:** unowned conversations walk team lead then on-call through `scheduled_jobs` (`inbox.escalate`); `conversations.escalation_level` is claimed atomically so a retry never notifies twice. Settings are under Settings, Notifications (`settings.manage`).
- **Digests:** `loadManagementSummary()` (`lib/reports/management.ts`) feeds both the Management dashboard page and the digest e-mail; change KPIs there, never in one place only.
- **Request authentication:** page navigations (GET/HEAD, not `/api`) verify the JWT locally (`getClaims`); server actions, other methods and API routes still call `getUser`. The middleware decides and passes `x-pulse-auth` to `lib/auth/session.ts`. `mfaGate` is unchanged and runs on both paths.
- **Layout stays query-free:** the overdue-task badge, notification list and inbox unread count are fetched in the browser and kept fresh by Realtime (`components/shell/shell-data.tsx`). Do not add per-request queries to `app/(app)/layout.tsx`.
- **Bundles:** heavy libraries (FullCalendar, React Flow, Recharts) load through `next/dynamic`. `scripts/bundle-budget.json` holds first-load budgets; a pull request that exceeds one fails CI. Raise the number in the same commit when a bigger bundle is intended and say why.
- **Phones:** use `useIsPhone()` (`lib/hooks/use-media-query.ts`) for phone-only layouts; touch screens get 44 px tap targets from `app/globals.css` (do not shrink controls below that with `@media (pointer: coarse)` overrides). Gesture rules live in `lib/hooks/gestures.ts` with unit tests.

## Front desk, help and training (Phase 14, docs/14_PHASE_14_NOTES.md)
- **Front desk (`/front-desk`)** needs `frontdesk.use` (Receptionist and Manager presets; the Receptionist role lands here via `lib/front-desk/landing.ts`). Each action also needs the permission of what it does (`appointments.manage`, `contacts.manage`, `tasks.manage`, `inbox.send`). Check-in (Arrived / With doctor / Done / Checked out) lives on `appointments` in Pulse only; nothing here ever writes to Unite, and the Unite sync never touches those columns.
- **Waiting list:** a cancelled or moved appointment calls `scheduleSlotFreed()` (`lib/front-desk/freed.ts`), a durable `scheduled_jobs` row (`waitlist.freed`); offers and their expiry (`waitlist.expire`) ride the `appointments` queue. Offers go out only through `queueOutbound` (free text inside the 24 h window, the mapped template outside it, otherwise the offer is marked failed, never sent), and stay OFF until `front_desk.offers_enabled`. **First YES wins inside `public.accept_slot_offer()`**, which takes the same per-specialist advisory lock as `book_appointment` / `move_appointment`; never book a slot for a waiting-list patient any other way.
- **Households:** a dependant has no phone (`contacts.phone_e164` is unique per org); `household_links` ties them to a guardian. Any message about an appointment must pick its recipient with `resolveRecipient()` (`lib/household/addressing.ts`) so it reaches the guardian and names the patient; a guardian's Confirm tap counts for the dependant. `matchContact` treats a shared number as a family (`lib/household/shared-phone.ts`) and `merge_contacts` / `contact_duplicate_candidates` know about links.
- **Training mode (`orgs.is_training`):** the outbound handler marks messages sent on screen with a `training:` id and `clientForChannel` refuses to build a Meta client for a training org. New code that talks to Meta must go through one of those two; never construct `WhatsAppClient` for a stored channel any other way. Turn it on under Settings, Training mode (typed confirmation, audited).
- **Demo data:** `DEMO_RESET_OK=1 pnpm demo:reset --owner-email=<you>` empties and re-seeds a demo workspace (guard in `lib/demo/guard.ts`: local database or a demo project; `public.demo_wipe_org` also needs `is_training` AND the script's own flag). All demo content is synthetic: names like `Layla Demo-07`, numbers only in the reserved range `+44 7700 900000` to `900999`. Never point it at a real project, never put real people in `lib/demo/`.
- **Quick replies** are bilingual (`text`, `text_ar`) with `{{first_name}}`-style variables (`lib/inbox/quick-reply.ts`); add a variable there and in the composer context in `app/(app)/inbox/page.tsx`.
- **Help:** a new page gets a guide in `lib/help/guides.ts` and, when a video is planned, a clip in `lib/help/clips.ts` (recorded links are pasted under Settings, Training mode; no deploy needed). New keyboard shortcuts go in `lib/help/shortcuts.ts`, and bare-key handlers must skip typing targets (`isTypingTarget`). New release notes go at the top of `lib/help/whats-new.ts`.
- **Printing:** printable pages hide the shell with Tailwind's `print:hidden` (see `app/(app)/layout.tsx`); do the same for any new printable screen.

## Media Library and patient documents (Phase 16, docs/15_PHASE_16_NOTES.md)
- **Two private buckets, no storage policies:** `media-library` (org-wide images, PDFs, videos, used by templates, campaigns, quick replies, conversations) and `patient-documents` (health data on one patient). Browsers never read storage directly: the server checks `can()` and hands out a short signed link (documents: 60 s). Paths are built and parsed only by `lib/media/paths.ts` (UUID segments, fixed shape, no person-typed names); compare org and document id, not the patient segment (a record merge moves the row, not the file).
- **Permissions:** `media.view` / `media.manage` for the library, `documents.view` / `documents.manage` for patient documents. **`documents.*` is never implied by `contacts.*`**, inbox rights or `*`-less roles; no preset except Manager, Receptionist and Care coordinator holds it. Tables have SELECT policies only; every write is a server action using the service role after `can()`.
- **Uploads are prepare, browser, finalise.** `prepare*` validates (`lib/media/limits.ts`: WhatsApp 5 MB image, 16 MB video, 100 MB document; patient documents 25 MB) and creates a `pending` row; the browser uploads to a signed URL; `finalize*` probes the stored object (real size, first bytes sniffed by `lib/media/sniff.ts`), runs the scan hook and only then marks it `ready`. The browser is never trusted. Pending rows older than a day are removed by `documents_maintenance`.
- **Malware scan is a hook** (`lib/media/scan.ts`, `MALWARE_SCAN_PROVIDER`). With no provider every file is stored `unscanned` and the UI flags it (`ScanBadge`); never display or log "unscanned" as clean. `infected` is never served or sent.
- **Library files in templates and campaigns** are referenced as `media:<asset id>` in `variable_map` (`header.media`). Nothing resolves it until the outbound job calls `resolveHeaderMedia()`, which swaps in a one-hour signed link. A new feature that can reference a library file must be counted by `public.media_asset_usage()`, which also drives the delete block (a trigger repeats the check).
- **Patient documents:** off until an administrator types the confirmation under Settings, Patient documents (data-residency question). Opening one goes through `getDocumentUrl`, which calls `recordAccess` (`entity: "document"`, view or download, ids only). Titles are health data: never log them, never put them in push, e-mail or task subjects. Delete removes the file first, then the row. Erasure removes the files before `erase_contact`, which deletes the rows. Retention never deletes without a per-category policy and, for the nightly task, `auto_delete`.
- **Insurance card reminders** run in `documents_maintenance` (daily): atomic claim of `expiry_notified_at`, one `notify()` per organisation (`document.expiring`, generic text) and a task per card. A new category that should remind goes in `REMINDER_CATEGORIES` (`lib/documents/categories.ts`).
- **Images are compressed in the browser** (`lib/media/client-image.ts`, decisions in `image-ops.ts` and `encode.ts`). Thumbnails and the viewer (`components/media/lightbox.tsx`) use short signed links; use `MediaPicker` for any "choose from the library" button.

## AI copilots (Phase 17, docs/17_PHASE_17_NOTES.md)
- **Everything the copilots write is a draft.** The Flow Copilot (`lib/ai/flow-copilot/`) creates a NEW flow with `ai_review_required = true`; a database trigger (`flows_ai_review_guard`) keeps it from becoming active until a person runs `markAiFlowReviewed`. No AI path may set a flow's status, version or published graph, or send, schedule or submit anything. A copy of an unreviewed draft is still unreviewed.
- **The model's reply is untrusted data.** Parse it with `lib/ai/copilot/json.ts` (size cap first), validate it with a closed list (`validate.ts`, `audience.ts`, `copy.ts`, `intent.ts`), repair at most ONCE, then reject with the reason. A new node type must be added to `AI_NODE_TYPES` or `STRIPPED_NODE_TYPES` in `lib/ai/flow-copilot/policy.ts` (a test fails until it is). `api_action` is never generated. A new filterable field is invisible to the Campaign Copilot until it is added to `AI_AUDIENCE_FIELDS`.
- **Gates for every copilot action:** `requirePerm` for the base ability, `can(member, 'flows.ai' | 'campaigns.ai' | 'ai.insights.view')`, then `openCopilot()` (`lib/ai/copilot/server.ts`: master switch, per-person limit, daily cap, key) and `recordCalls()` (one `ai_usage` row per call, tokens only). Prompts carry no patient data beyond the minimum, masked (`maskContactDetails`), inside a data tag (`wrapData`).
- **Dry run** (`lib/flow-engine/simulate.ts`) drives the real engine over in-memory ports. It must never import the database, the queue, the HTTP action or the WhatsApp client (a test checks the source).
- **Emergency wording** (`lib/ai/intent/emergency.ts`) is pure and deterministic and runs with AI off; `screenInboundMessage()` never throws and never calls the model; the escalation (`handleEmergency`) is idempotent per message and source and notifies through `notify()` with the fixed generic sentence. An emergency never starts a flow. Intent output is a closed enum; anything else is discarded.
- **AI tags start flows only with the clinical lead's signed setting** (`orgs.settings.ai_copilot.tag_flows`, `tagMayStartFlows`), checked where the tag is applied and again in the `flow_steps` handler.
- **Tests never reach a provider:** use a fake `Llm`; `tests/setup.ts` makes `fetch` to Anthropic, Voyage or Meta throw. Tables `ai_message_intents`, `ai_suggestion_outcomes`, `ai_quality_reports` hold labels, verdicts and counts, never text; they are in `PHASE17_TABLES` / `seedPhase17Rows()`.

## Integrations (Phase 19, docs/18_PHASE_19A_NOTES.md)
- **One registry, one table.** `lib/integrations/catalog.ts` lists every integration (kind, who may see it, fields, confirmation words). Credentials and the on/off flag live in `integration_accounts` (service-only, no policies): secret fields in `config_enc` (AES-256-GCM), everything else in `config`, `enabled` is **false by default**. Pages read it through `loadView()`/`toView()`, which never return a secret or the ciphertext. Switching on anything that messages patients or takes money needs `integrations.manage` (Admin only) **and** the typed `confirmWord`; the action re-checks `readinessProblems()`. Every code path starts with `isEnabled()`/`loadAccount()`; SMS and payments also refuse a training workspace (`isTrainingOrg`).
- **Every provider call goes through `createIntegrationClient()`** (`lib/integrations/client.ts`): https only, host allow-list, timeout, response cap, no redirects, back-off with jitter, circuit breaker (state kept in `integration_accounts.consecutive_failures / breaker_open_until`). Only idempotent requests are retried; a POST without an idempotency key is retried after a 429 only, and after a timeout or 5xx it is `ambiguous` and must never be sent again by code. Each attempt is one `integration_calls` row (provider, operation, outcome, status, latency): never a URL, header, body, number, link or amount. No bare `fetch` to a provider anywhere in `lib/integrations` (a test greps for it).
- **Inbound webhooks** use `receiveIntegrationWebhook()` (`lib/integrations/webhook-route.ts`): 404 for an unknown or switched-off account, 413 over the cap, signature check in constant time (`lib/integrations/webhook.ts`; Stripe also has a 5 minute replay window), per-IP limit on failures and per-account limit, then each event claims its key in `integration_webhook_events` before it acts; a failing handler releases the claim and answers 500 so the provider retries. A new route goes in `UNGUARDED_OK` with its reason.
- **Calendar feeds** (`lib/integrations/calendar/`): 256-bit token, only the SHA-256 stored, URL shown once, rotate/revoke, `integrations.calendar`. An event carries id hash, start, end, "Appointment" and the location name: nothing else (`renderEvent` takes a fixed shape; a test passes hostile extras).
- **SMS fallback** (`lib/integrations/sms/`): only for an appointment reminder WhatsApp could not deliver; `queueSmsFallback()` is called from `reportReminderFailure()`; sent from the `sms_outbound` queue (`processSmsJob`) with a per-sender rate limit, a daily cap, fresh consent/appointment checks (`smsDecision`) and fixed generic wording (`renderReminderSms`; a guardian's message names the child by first name only). `sms_messages` stores no number and no text. Marketing SMS does not exist; `smsDecision` already refuses it without `promotions_opt_in`.
- **Payment links** (`lib/integrations/payments/`): `PaymentProvider` (Stripe Checkout, PayTabs-style) with money in integer minor units; `fin_payment_requests` records the gateway's word and nothing else. **Never write `fin_invoices` or anything in Unite from here**; a webhook whose amount or currency differs is never applied (`decidePaymentEvent`); one live request per invoice; the message is an APPROVED **Utility** template through `queueOutbound`; staff need `finance.payment_links` and tick a check each time.
- **Tests never reach a provider:** `tests/setup.ts` makes `fetch` to Stripe, PayTabs and Twilio throw; adapters take an injected `fetchFn`; use `createFakeSmsProvider` / `createFakePaymentProvider`. Adapter shapes come from documentation and are unverified against live accounts.
- A new integration: add it to the catalogue, a permission, a typed adapter on the shared client, its webhook spec, a health entry (`CALL_PROVIDERS`), migration tables with RLS (and `PHASE19_TABLES` + `seedPhase19Rows`), and read "How to add the next integration" in the notes.

## Conventions
- Business logic in `lib/*` as plain TS with unit tests. Route handlers and server actions stay thin and validate with Zod.
- Phones are always E.164 (`libphonenumber-js`). Times are stored in UTC and displayed in location/org timezone (`date-fns-tz`).
- Domain events go through `emit(orgId, 'enquiry.stage_changed', payload)`, which triggers flows and outbound webhooks.
- UI patterns: right-side drawers for records, DataGrid for lists with saved views, a phone preview for templates/campaigns.
- Every schema change is a new migration. Never edit applied migrations. Regenerate types after migrating.
- Navigation: sidebar entries live in `components/shell/nav.ts` (with `group` and search `keywords`); Settings pages live in `components/shell/settings-pages.ts`, which feeds both the Settings menu and Ctrl+K quick search. A new page is added there, gated by its permission. Status, gaps and roadmap: `docs/09_STATUS_AND_ROADMAP.md`.
- Back-office objects: core entities merge into core tables; everything else becomes a real table registered in `portal_objects`.

## Security & access (Phase 15, docs/12_PHASE_15_NOTES.md)
- **Permissions:** `security.manage` (MFA by role, access review, retention and alert settings) and `privacy.manage` (patient export and erasure, always two people). Admin (`*`) only by default.
- **MFA:** `roles.require_mfa` is enforced in `lib/supabase/middleware.ts` through the pure `mfaGate()`. Anyone who has enrolled an authenticator is challenged once per session whatever their role says. The MFA pages must stay exempt (`isMfaExemptPath`).
- **Who opened what:** call `recordAccess(admin, member, {...})` when a server action or page shows ONE patient record, conversation, claim or file (always logged, repeats within 5 minutes merge) and for list screens (sampled); call `recordExport(...)` next to the `recordAudit` of every export. Ids only, never names, numbers or message text.
- **Who changed it:** server actions that write `appointments`, `enquiries`, `tasks`, `wa_templates`, `flows` or a portal table use `createAdminClient(member.userId)` so `record_history` names the person. Attach the trigger to a new table with `select app.enable_record_history('<table>')`, add it to `HISTORY_TABLES` in `lib/security/history.ts` and to `can_view_record_history()`.
- **Alerts:** raise them with `raiseAlert()` (idempotent on `dedupe_key`; counts only in the summary). Rules are pure functions in `lib/security/anomaly.ts`.
- **Seeds for the sweeps:** a new Phase-15-style table goes in `PHASE15_TABLES` and `seedSecurityRows()` (`tests/db/helpers.ts`) so the cross-org tests are not vacuous for it.

## Commands
```
pnpm dev                     # next dev
supabase start               # local stack
pnpm db:migrate              # supabase migration up + gen types
pnpm db:seed                 # fake data only
pnpm test / pnpm e2e
pnpm test:db                 # RLS + jobs tests on plain Postgres (supabase/test/README.md)
pnpm jobs:run <queue>        # drain a queue through /api/jobs like pg_cron does
pnpm wa:simulate <fixture>   # post a sample Meta webhook locally
pnpm import:airtable --dry-run
pnpm import:sanoflow --dry-run
pnpm parallel:ingest --org <slug> --scenario birthday --date YYYY-MM-DD --file ids.txt   # one day of Make output for the parallel-run report (ids are hashed)
pnpm tsx scripts/export-airtable-schema.ts --counts
pnpm tsx scripts/export-make.ts --all
pnpm audit:security          # static security pass → docs/audit/security-pass.generated.md
pnpm load:webhook --yes-staging --rate 1000 --minutes 1   # webhook burst (staging/local only)
pnpm load:mock-graph & pnpm load:outbound --yes-staging --count 20000 --rate 20   # 20k send against a local Graph stub
pnpm reconcile --org <slug> --live-airtable --freeze-at <iso>   # migration sign-off report
pnpm cutover:preflight --org <slug> --stage pre-cutover   # read-only go/no-go before moving a number
DEMO_RESET_OK=1 pnpm demo:reset --owner-email=<you>   # wipe + re-seed the DEMO workspace with synthetic data (local or demo project only; --check, --users, --slug)
pnpm push:keys               # generate VAPID keys for Web Push (prints env lines, writes nothing)
pnpm bundle:check build.log  # first-load JS budgets (scripts/bundle-budget.json); CI runs it after `pnpm build 2>&1 | tee build.log`
pnpm analyze                 # next build with the bundle analyser (report under .next/analyze)
```

## Env
```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
JOB_SECRET, ENCRYPTION_KEY, APP_URL
META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_SYSTEM_USER_TOKEN, META_GRAPH_VERSION
UNITE_BASE_URL, UNITE_APP_ID, UNITE_APP_KEY
AIRTABLE_PAT, MAKE_API_TOKEN, MAKE_ZONE=us2, MAKE_TEAM_ID=1494412   # migration/audit only; remove after cut-over
ANTHROPIC_API_KEY, ANTHROPIC_MODEL, EMBEDDINGS_API_KEY
RESEND_API_KEY, SENTRY_DSN
META_GRAPH_BASE_URL   # load tests only; honoured only for http://localhost|127.0.0.1, never set in production
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   # Web Push, from `pnpm push:keys`; without them push is simply off
PULSE_VERIFY_JWT_LOCALLY=0   # optional: make page navigations call Supabase Auth again (default verifies the token locally)
DEMO_RESET_OK=1   # only for `pnpm demo:reset`; never set in production. SUPABASE_PROJECT_NAME / DEMO_PROJECT_NAME (must contain "demo") lets it run against a hosted demo project
```

## Definition of done per task
Typecheck, lint and tests pass. The happy path works locally (webhook simulator for WhatsApp). RLS is covered for new tables. No PHI in logs or fixtures. Docs are updated if behaviour changed.
