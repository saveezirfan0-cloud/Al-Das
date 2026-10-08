# Claude Code Build Plan — Al Das In-house Clinic Platform
### Patient messaging (Sanoflow replacement) + back-office portal (Airtable/Make replacement) on Supabase + Vercel

**How to use this file**
1. Create an empty repo. Put `CLAUDE.md` (file 03) at the root and this file plus `01_FEASIBILITY_AND_TEARDOWN.md` in `/docs`.
2. Work **one phase at a time**. Paste that phase's prompt into Claude Code. Review, test and commit before moving on.
3. Start Plan Mode for each phase (`shift+tab`) so Claude Code proposes the file plan before writing code.

> Working name: **"Pulse"**. Rename it freely. Use original UI copy, icons and template text, not Sanoflow's.

---

## 0. Scope

**One platform, two halves**

| Patient messaging (replaces Sanoflow) | Back office (replaces Airtable + Make) |
|---|---|
| WhatsApp Cloud API (3 numbers), shared inbox, team queues, round-robin assignment | Patient CRM (single record across WhatsApp, Unite, enquiries, appointments) |
| Templates, campaigns, analytics | Operational screens rebuilt from today's Airtable bases |
| Enquiry pipelines, tasks | Unite EMR sync (read-only in the MVP) |
| Appointments + WhatsApp reminders | Make.com scenarios rebuilt as native automations |
| Visual flow builder (bots) | Management dashboards + central reporting |
| AI assist (summaries, suggested replies) | Data import from Airtable + Sanoflow |

**Phase 2:** Messenger, Instagram, web chat, AI agents, Click-to-WhatsApp ad ROI + Meta CAPI, payment links, forms, Finance/Diligence feeds, Google Calendar.
**Phase 3:** WhatsApp Calling, two-way Unite writes.

---

## 1. Stack (Supabase + Vercel only)

| Concern | Choice |
|---|---|
| App | **Next.js 15 App Router + TypeScript (strict) + Tailwind + shadcn/ui**, deployed on **Vercel Pro** |
| Database | **Supabase Postgres**. Schema as SQL migrations through the Supabase CLI. Typed access via `supabase-js` + generated types |
| Tenancy/security | **Row Level Security** on every table, keyed on `org_id` (multi-location ready, single org in production) |
| Auth | Supabase Auth (email + password, magic link). Roles in our own tables |
| Realtime | Supabase Realtime (Postgres changes + broadcast) for inbox, presence, typing |
| Files | Supabase Storage (private buckets, signed URLs) for WhatsApp media, attachments, KB files |
| Background jobs | **Supabase Queues (pgmq)** + **Supabase Cron (pg_cron)** + **pg_net**. Cron pings secured Vercel route handlers (`/api/jobs/*`) every few seconds, and each handler drains a batch from a queue. No Redis, no extra servers |
| Scheduled/delayed work | A `scheduled_jobs` table (`run_at`, `kind`, `payload`, claimed with `FOR UPDATE SKIP LOCKED`) for reminders, flow waits and retries. pgmq `delay` for short delays |
| Search | Postgres full-text + `pg_trgm` for contacts and messages |
| AI | Anthropic Claude API (model from env). KB embeddings in **pgvector** |
| Charts | Recharts |
| Tables / Kanban / calendar / canvas | TanStack Table, dnd-kit, FullCalendar (Premium licence for the resource view, or a custom grid), @xyflow/react |
| Email | Resend (alerts, invites) |
| Monitoring | Sentry + a `job_runs` table with an in-app "System health" page |

**Why this works without a worker server:** each job handler is short (a batch of about 50–200 items). Vercel functions with Fluid compute allow long enough runs, and pg_cron can fire every 5–10 seconds. Throughput needed for the clinic (thousands of messages/day, campaigns of tens of thousands) fits comfortably.

---

## 2. Repo layout

```
pulse/
  app/                         # Next.js App Router
    (auth)/login, invite/[token]
    (app)/
      dashboard/ inbox/ contacts/ enquiries/ tasks/ appointments/
      campaigns/ templates/ flows/ reports/ portal/ settings/
    api/
      webhooks/meta/route.ts           # Meta webhook ingress
      webhooks/in/[flowId]/route.ts    # incoming-webhook flow trigger
      jobs/[queue]/route.ts            # cron-driven queue drains (secret header)
      public/v1/...                    # public API (API keys)
  lib/
    supabase/ (server, client, admin, types.ts)
    auth/ (session, can())
    whatsapp/ (client.ts, webhook-types.ts, parse.ts, errors.ts, templates.ts)
    jobs/ (enqueue.ts, handlers/*.ts, scheduler.ts)
    flow-engine/ (types.ts, run.ts, executors/*.ts, interpolate.ts)
    filters/ (ast.ts, to-sql.ts, evaluate.ts, field-registry.ts)
    unite/ (client.ts, sync.ts, mappers.ts)
    ai/ (prompts/, summarize.ts, suggest.ts, rewrite.ts, kb.ts)
    events/ (emit.ts)               # domain events → flows + outbound webhooks
  components/ (data-grid, drawer, filter-builder, phone-preview, kanban, calendar, charts)
  supabase/
    migrations/*.sql
    seed.sql                        # fake data only
  scripts/
    wa-simulate.ts                  # post sample Meta payloads locally
    import-airtable.ts              # Airtable → Postgres importer
    import-sanoflow.ts              # CSV exports → Postgres
  docs/
  tests/ (unit: vitest, e2e: playwright)
```

Single Next.js app, no monorepo: simpler on Vercel. Business logic lives in `lib/` as plain TS modules with unit tests.

---

## 3. Data model (SQL migrations, abridged)

Every tenant table has `org_id uuid not null`, `created_at`, `updated_at`, and an RLS policy `org_id in (select org_id from memberships where user_id = auth.uid())`. Sensitive writes go through server actions using the service role, after `can()` checks.

```sql
-- Tenancy & users
orgs(id, name, timezone default 'Asia/Dubai', settings jsonb)
profiles(id = auth.users.id, first_name, last_name, designation, timezone, language)
memberships(org_id, user_id, role_id, status, presence)            -- presence: online/away/offline
roles(id, org_id, name, description, permissions jsonb, is_system)
teams(id, org_id, name, round_robin bool)
team_members(team_id, user_id, rr_weight, last_assigned_at)
invites(id, org_id, email, role_id, team_ids uuid[], token, expires_at)
audit_log(id, org_id, user_id, action, entity, entity_id, diff jsonb, at)
notifications(id, org_id, user_id, type, payload jsonb, read_at)

-- Channels
channels(id, org_id, type, name, status,
         waba_id, phone_number_id unique, display_phone, business_id,
         access_token_enc, quality_rating, messaging_limit_tier, is_coexistence, catalog_id, meta jsonb)

-- Patients / contacts (CRM core)
contacts(id, org_id, first_name, last_name, phone_e164, wa_bsuid, email, gender, nationality, language, dob,
         label_id, owner_id, assignee_id, source, external_id,      -- external_id = Unite patient id
         promotions_opt_in, stop_marketing, custom jsonb, last_interaction_at, deleted_at)
  -- unique (org_id, phone_e164) where phone_e164 is not null; unique (org_id, wa_bsuid) where wa_bsuid is not null
contact_phones(id, contact_id, phone_e164, label)
tags(id, org_id, name, color, scope)                  -- contact | enquiry | conversation
contact_tags(contact_id, tag_id)
custom_fields(id, org_id, entity, key, label, type, options jsonb, required, sort)
segments(id, org_id, name, kind, filter jsonb, drip_flow_id)       -- static | dynamic
segment_members(segment_id, contact_id)
timeline_events(id, org_id, contact_id, enquiry_id, type, actor_type, actor_id, payload jsonb, at)

-- Inbox
conversations(id, org_id, channel_id, contact_id, status, assignee_user_id, assignee_team_id, bot_active,
              last_inbound_at, last_message_at, unread_count, category_id, summary, ai_tags text[],
              ad_referral jsonb, closed_at, closed_by)
messages(id, org_id, conversation_id, direction, kind, body, payload jsonb, media_path,
         wa_message_id unique, status, error_code, error_message,
         sent_by_user_id, flow_run_id, campaign_recipient_id, at)
conversation_labels(conversation_id, tag_id, added_at)
quick_replies(id, org_id, shortcut, text)
conv_categories(id, org_id, name)
inbox_views(id, org_id, owner_id, name, filter jsonb, shared_team_ids uuid[])
mentions(id, message_id, user_id, read_at)

-- Enquiries & tasks
pipelines(id, org_id, name, sort, card_fields text[])
stages(id, pipeline_id, name, color, sort)
enquiries(id, org_id, number, pipeline_id, stage_id, status, lost_reason, contact_id, title, channel_id, source,
          assignee_id, est_value, location_id, department_id, specialist_id, service_id, appt_date,
          custom jsonb, stage_entered_at, closed_at, created_by)
enquiry_views(id, org_id, owner_id, name, filter jsonb, columns jsonb, shared_team_ids uuid[])
tasks(id, org_id, type, subject, notes, due_at, assignee_id, contact_id, enquiry_id, done, created_by)

-- Appointments
locations(id, org_id, name, timezone, photo_path, address)
departments(id, org_id, name)
services(id, org_id, department_id, name, duration_min, price)
specialists(id, org_id, name, title, photo_path, department_id, user_id, external_id)   -- external_id = Unite doctor id
specialist_locations(specialist_id, location_id)
specialist_services(specialist_id, service_id)
working_hours(id, specialist_id, location_id, weekday, start_min, end_min)
time_blocks(id, specialist_id, starts_at, ends_at, reason)
appointments(id, org_id, number, contact_id, location_id, specialist_id, service_id, starts_at, ends_at,
             status, channel_id, notes, notify_early, source, external_id, created_by)      -- source: portal | unite | bot
appointment_reminders(id, appointment_id, idx, due_at, sent_at)

-- Templates & campaigns
wa_templates(id, org_id, channel_id, meta_template_id, name, language, category, status, type,
             components jsonb, variable_map jsonb, retry_on_fail, rejected_reason, quality)
campaigns(id, org_id, name, channel_id, template_id, audience_type, segment_id, scheduled_at, status,
          retry_rounds, stats jsonb, created_by, completed_at)
campaign_recipients(id, campaign_id, contact_id, phone_e164, vars jsonb, status, attempts, error_code,
                    wa_message_id, replied_at)

-- Flows & automations
flows(id, org_id, name, status, trigger_type, trigger_config jsonb, channel_id, pipeline_id,
      graph jsonb, published_graph jsonb, version)
flow_runs(id, org_id, flow_id, flow_version, contact_id, conversation_id, enquiry_id, status,
          current_node_id, context jsonb, waiting_for jsonb, started_at, ended_at, error)
flow_run_steps(id, run_id, node_id, status, input jsonb, output jsonb, error, at)
flow_variables(id, org_id, key, value, enabled)

-- Back office (Airtable replacement) — concrete tables come from the Airtable audit in Phase 0
portal_objects(id, org_id, key, label, icon, source_airtable_table)       -- registry of back-office entities
-- + one real table per entity, e.g. insurance_claims, lab_results_followups, pharmacy_requests, staff_rota …
saved_views(id, org_id, object_key, owner_id, name, filter jsonb, columns jsonb, sort jsonb, shared_team_ids)

-- Integrations & sync
integration_accounts(id, org_id, kind, config_enc, status)                -- unite, google_calendar, …
sync_cursors(id, org_id, source, entity, cursor, last_run_at, last_ok_at, error)
external_refs(id, org_id, source, entity, external_id, local_table, local_id)   -- dedupe map

-- Jobs & ops
scheduled_jobs(id, kind, payload jsonb, run_at, attempts, max_attempts, locked_at, last_error, done_at)
job_runs(id, queue, started_at, finished_at, processed, failed, error)
webhook_events_in(id, source, payload jsonb, received_at, processed_at, error)
api_keys(id, org_id, name, hash, last_used_at)
webhook_subscriptions(id, org_id, url, events text[], secret, active)
webhook_deliveries(id, subscription_id, event, status, attempts, response_code, at)

-- AI / KB
kb_sources(id, org_id, group_id, kind, name, status)
kb_chunks(id, source_id, content, embedding vector(1024))
kb_feedback(id, org_id, message_id, positive, note)

-- Reporting
-- SQL views + materialized views refreshed by pg_cron (e.g. mv_daily_conversations, mv_enquiry_stage_times,
-- mv_agent_performance, mv_appointments_by_status, mv_campaign_funnel, mv_unite_appointments_daily)
```

**Permissions catalogue (in code):** `inbox.view_all`, `inbox.send`, `contacts.export`, `campaigns.create`, `templates.manage`, `flows.manage`, `appointments.manage`, `portal.<object>.read|write`, `reports.view`, `settings.manage`. Seed roles: Admin, Manager, Agent, Receptionist, Marketing.

---

## 4. Background jobs design (no Redis)

**Queues (pgmq):** `meta_events`, `outbound`, `campaign_fanout`, `flow_steps`, `media_fetch`, `webhooks_out`, `unite_sync`, `kb_ingest`.

**Drain pattern:**
```
pg_cron (every 5–10s) ──pg_net POST──▶ /api/jobs/<queue>   (header X-Job-Secret)
   handler: read up to N msgs with visibility timeout → process → pgmq.archive on success
            on failure: let the visibility timeout expire (auto-retry); after max reads → dead-letter table
```

- **Outbound rate limit per number:** a `send_slots` counter per `phone_number_id` per second (an atomic `UPDATE … RETURNING`). The handler skips messages whose number is saturated, so they're picked up on the next tick. Live chat sends go through a separate `outbound_priority` queue drained first.
- **Delayed work:** `scheduled_jobs` polled every 10s by `/api/jobs/scheduler`. Due rows are claimed with `SKIP LOCKED` and pushed to the right pgmq queue.
- **Idempotency everywhere:** unique `wa_message_id`, campaign recipient status machine, `flow_run_steps` written before executing side effects, `external_refs` for Unite/Airtable imports.
- **Health page:** `job_runs` + queue depths + dead letters, with alerts by email when a queue backs up or a handler fails repeatedly.

---

## 5. WhatsApp integration (Al Das's own Meta app, no Tech Provider needed)

1. **Connection:** Al Das's Meta Business portfolio owns the Meta app and the WABA. Use a **System User token** (permanent) with `whatsapp_business_management` + `whatsapp_business_messaging`. Settings → Channels shows each number with its phone_number_id, quality, tier and profile. Embedded Signup is optional (only needed if more businesses are onboarded later).
2. **Webhook ingress** (`/api/webhooks/meta`): verify `X-Hub-Signature-256` → insert `webhook_events_in` → `pgmq.send('meta_events')` → return 200. GET handles the verify challenge.
3. **Inbound:** upsert the contact by **BSUID (`user_id`) and/or phone** (phone may be absent for username users), find or open a conversation (fires the "Conversation Opened" trigger, captures the CTWA `referral`), store the message, queue a media fetch, update the 24h window, resume a waiting flow run or route (team → round-robin), broadcast realtime.
4. **Statuses:** forward-only status updates. Failures are mapped through `lib/whatsapp/errors.ts` (131026, 131047, 131049, 131050 → set `stop_marketing`, 131056, 130429, 132xxx…).
5. **Outbound:** always via a queue. The 24h guard requires a template outside the window.
6. **Templates:** a builder producing Meta `components` (header text/media via resumable upload, body vars with examples, footer, buttons, carousel). Submit, status/category/quality webhooks, a nightly sync, and a variable mapper.
7. **Campaigns:** snapshot recipients (segment SQL or CSV), drop opted-out recipients, fan out in batches, aggregate stats from status webhooks, retry rounds, auto-pause on a quality drop / failure spike.
8. **Subscribed webhook fields:** `messages`, `message_template_status_update`, `template_category_update`, `message_template_quality_update`, `phone_number_quality_update`, `account_update`, `user_id_update`, `business_username_updates`. Later: `smb_message_echoes`, `history`, `smb_app_state_sync` (coexistence), `calls`.
9. **Number migration from Sanoflow:** confirm WABA ownership → remove Sanoflow's partner app access → subscribe our app (`POST /{waba_id}/subscribed_apps`) → point the webhook at our ingress. Templates and quality stay with the WABA. Do one number at a time, out of hours.
10. **Policy:** AI features must stay clinic-specific (Meta's general-purpose AI chatbot ban). No diagnosis or dosing. Hand off to staff.

---

## 6. Back-office portal (Airtable + Make replacement)

**Phase 0 audit produces three inventories in `/docs/audit/`:**
- `airtable-schema.json`: every base, table, field (type, options, links), views and interfaces in use. Export it with the Airtable API/MCP.
- `make-scenarios.md`: each Make scenario with trigger, steps, systems touched, frequency, and the new home (native job, flow, or dropped).
- `reports.md`: every report/dashboard management uses today (incl. the centralised reporting Data Requirements Matrix).

**Rules for rebuilding Airtable tables:**
- Entities that already exist in the core (patients, appointments, enquiries, tasks) **merge into the core tables**, with extra fields as typed columns or `custom` jsonb.
- Remaining operational entities become **real tables** registered in `portal_objects`, with generic portal screens: list (DataGrid with saved views, filters, column chooser, export), record drawer (fields, linked records, timeline, comments, attachments), and create/edit forms with validation. Permissions per object.
- Linked-record fields become foreign keys. Lookups/rollups become SQL views. Formulas become generated columns or view expressions.
- Write a **one-shot importer** (`scripts/import-airtable.ts`) that maps Airtable record IDs to new IDs via `external_refs`, so it can be re-run safely before cut-over.

**Rebuilding Make scenarios:**
- Event-driven ones (e.g. "new WhatsApp booking → create Airtable record → call Unite") become **flows** or **domain-event handlers** (`lib/events`).
- Scheduled ones (e.g. nightly Unite pulls, report refreshes) become **pg_cron jobs** calling `/api/jobs/*`.
- Every rebuilt automation logs to `job_runs` and alerts on failure. Make it a checklist: one row per scenario with ✅ when the native version has run in parallel and matched.

**Unite facts from the Make audit:**
- **Base URL:** `https://ucexternalapiprod.uniteuae.care/gateway/`.
- **Auth:** `authorize?app_id&app_key` returns an access + refresh token. Tokens live about **240 s**; refresh via `refreshtoken`.
- **Appointments:** `getallappointments?clinic_id=<DHA licence>&from_date=&to_date=`, called once per branch:
  - Golden Mile `DHA-F-6456618`
  - Meadows `DHA-F-2116734`
  - Palm Jumeirah `DHA-F-0000419`

  Store the branches in `locations.external_id`.
- **The Finance API is sync-once** (each call permanently dequeues records). Only call it inside a transaction that first writes raw payloads to `unite_raw_payloads`. It sits behind a feature flag and is off by default.

**Unite EMR (live production API, limited vendor support):**
- **Read-only in the MVP.** Incremental pulls of patients, doctors and appointments using `sync_cursors`. Upsert via `external_refs`. Match patients to contacts by Unite ID → phone → name+DOB (with a manual review queue for ambiguous matches).
- Conservative rate limits, retries with back-off, never bulk-hammer production. Log every call's status.
- Appointment changes in Unite flow into `appointments` (`source = 'unite'`), which drives WhatsApp reminders.

**Dashboards & reporting:**
- A metrics layer as SQL views/materialized views (refreshed by cron). Dashboards built with Recharts.
- **Management dashboard:** enquiries in/closed/converted, conversion to appointments, appointments by status/location/specialist, no-shows, response times, campaign results, WhatsApp usage/cost.
- **Team lead dashboard:** live queues, unassigned, SLA breaches, agent workload/presence.
- All reports filterable by period/location/channel/team, with CSV export. Later: scheduled email digests.

---

## 7. Flow engine (`lib/flow-engine`)

- Graph = React Flow JSON. Edges carry handles (`default`, `fallback`, `option:<id>`, `inside`/`outside`, `true`/`false`).
- Saving stores a draft. Activating copies it to `published_graph` and bumps `version`. Runs pin `flow_version`.
- One `flow_steps` job per node:
  1. Take an advisory lock on the conversation, load the run, execute the node, write `flow_run_steps`.
  2. Then either enqueue the next step, wait (`scheduled_jobs` timeout for replies/delays), or end.
  3. Max 200 steps per run.
- **Triggers:** Conversation Opened/Closed/Waiting, Template button reply, Shortcut, Enquiry Added / Stage Updated / Status Updated, Incoming Webhook, Recurring (cron), **Unite appointment created/updated** (new, for the back office).
  - Conditions use `lib/filters` (AND/OR; Source / Keyword / Ad; equals / contains…).
- **MVP nodes:**
  - Messaging: Message, Question (≤3 buttons / ≤10 list rows, save to variable, fallback), Quick Reply, Template
  - Logic: Branch, Wait, Office Hours, Run Flow, End Flow
  - Conversation: Assign To, Close Conversation, Add Comment
  - CRM: Update Contact Field, Create/Update Enquiry, Add Task, **Create/Update Portal Record**, **Book/Update Appointment**
  - Integrations: API Action, Send Notification
- One active bot run per conversation. Human takeover cancels it.
- Interpolation: `{contact.first_name}`, `{appointment.starts_at|date:"DD MMM HH:mm"}`, `{vars.KEY}`, `{steps.<node>.response.x}`.

---

## 8. Phases with Claude Code prompts

Each phase ends with: `pnpm typecheck && pnpm lint && pnpm test`, a seed with **fake data only**, a demo checklist, and a commit.

### Phase 0 — Setup, data access & audit (week 1)

**0a. Accounts (you)**
- Al Das Meta portfolio access, a Meta app, a System User token, and Meta's test number.
- Create a Supabase project (pick a region) with the pgmq, pg_cron, pg_net and pgvector extensions enabled.
- Create a Vercel Pro project, plus Sentry and Resend accounts.

**0b. Data access (you, about 15 minutes)**

| System | What to create | Scopes | Goes in |
|---|---|---|---|
| Airtable | Personal access token, limited to the 5 Al Das bases | `schema.bases:read` now; add `data.records:read` for the import | `.env.local` → `AIRTABLE_PAT` |
| Make | API token (Profile → API access) | `scenarios:read`, `datastores:read`, `hooks:read`, `teams:read`, `organizations:read` | `.env.local` → `MAKE_API_TOKEN` |
| Unite | Copy the current app_id/app_key **from the Make "Token" scenario**, then ask Unite for fresh keys at cut-over | — | `.env.local` → `UNITE_APP_ID`, `UNITE_APP_KEY` |
| Claude Code MCP (optional) | `cp scripts/mcp.json.example .mcp.json`, then authorise Make/Airtable/Supabase via OAuth on first use | read-only where possible | repo root (gitignored) |

**0c. Audit (already done, refresh before building)**
- `docs/audit/airtable-schema.md` and `docs/audit/make-scenarios.md` were produced from the live accounts on 8 Oct 2026, together with redacted blueprints in `docs/audit/make-raw/`.
- Refresh them with:
  ```
  pnpm tsx scripts/export-airtable-schema.ts --counts   # exact schema JSON + record counts (no PHI)
  pnpm tsx scripts/export-make.ts --all                 # every scenario, secrets & samples redacted
  ```

> **Prompt 0:** "Read CLAUDE.md, /docs and /docs/audit (airtable-schema.md, make-scenarios.md, airtable-raw/*.json, make-raw/*). Produce:
> 1. /docs/audit/data-model-mapping.md: every Airtable table and field → its new table/column (or 'computed' or 'drop'), with the rule notes preserved.
> 2. Draft SQL migrations for the core clinical tables (visits, prescriptions, reference tables, clinical_settings, clinical_followups, recall_programmes, recall_sends) following docs/02 §3 and §6.
> 3. /docs/audit/clinical-rules.md: each rule from the Acute base field descriptions as a numbered spec with test cases taken from the Test Plan table design.
> 4. A replacement design for each active Make scenario.
>
> Don't write app code yet. Flag every open clinical question (e.g. 85 vs 90 days, day-3 offset, probiotic duration, feedback threshold)."

### Phase 1 — Foundation (weeks 1–2)
> **Prompt 1:** "Scaffold the Next.js 15 app per docs/02 §1–2 with Tailwind and shadcn/ui, Supabase SSR auth, and generated DB types. Create migrations for tenancy, users, roles, teams, invites, audit_log and notifications, with RLS policies and a test that proves a user can't read another org's rows. Implement login, invite + accept, the role/permission helper `can()`, the app shell (collapsible left nav: Dashboard, Inbox, Contacts, Enquiries, Tasks, Appointments, Campaigns, Templates, Flows, Portal, Reports, Settings; top bar with notifications and presence) and Settings → Account, Users, Roles, Teams. Implement the jobs framework from docs/02 §4: pgmq queues, scheduled_jobs, a pg_cron + pg_net migration that calls /api/jobs/[queue] with a secret, a handler registry, job_runs logging, a dead-letter table and a System Health page. Add unit tests for the scheduler claim logic."

### Phase 2 — Patient CRM + filters + data import (weeks 2–3)
> **Prompt 2:** "Build lib/filters (JSON condition AST with AND/OR groups and an exclusion group, an SQL compiler using parameterised queries, an in-memory evaluator, a field registry incl. custom fields and related-entity fields), all with unit tests. Build Contacts:
> - A DataGrid (virtualised, column chooser with saved widths, sort, pagination), views (All, last interacted <7d/<30d/>30d, Mentions) and static + dynamic segments.
> - A filter side panel, bulk actions, CSV import with E.164 validation and dedupe, CSV export, and merge duplicates.
> - A contact drawer with fields, alternate phones, opt-in, tags, custom fields, and tabs Timeline / Inbox / Enquiries / Appointments / Campaigns.
> - Settings → Custom Fields.
> - scripts/import-sanoflow.ts for contact CSV exports, and a first pass of scripts/import-airtable.ts for patient-related tables using external_refs (idempotent re-runs)."

### Phase 3 — WhatsApp + Inbox (weeks 3–6) ★ critical path
> **Prompt 3:** "Implement lib/whatsapp per docs/02 §5:
> - A typed Cloud API client (text, media, interactive, template, reaction, mark-read, media upload/download, business profile, phone fields, subscribed_apps, templates CRUD) and typed webhook parsers incl. BSUID user_id handling.
> - Settings → Channels to add a number by phone_number_id + WABA ID using the System User token (stored encrypted), showing quality, tier and profile, with a profile editor and catalogue ID.
> - The webhook route with signature verification → webhook_events_in → pgmq. Queue handlers for meta_events (inbound + statuses + template/quality/user-id updates), media_fetch (to Supabase Storage), and outbound / outbound_priority with the per-number rate limit, the 24h window guard and the error map.
>
> Then build the Inbox:
> - Folders (Open, My inbox, Assigned to me, Assigned to bot, Unassigned, Waiting, Unread, Mentions, Closed), team queues, saved shared views, search/filter/sort.
> - A conversation list with channel badge, unread count and labels. A thread with status ticks and media. The composer: Chat/Comment with @mentions, number selector, '/' quick replies, emoji, attachments, voice notes, template picker with variable preview.
> - Close with category/summary, assign user/team, round-robin auto-assign, a right sidebar (contact, shared media, merge suggestions, create enquiry, book appointment), and a Failed Messages log.
> - Realtime via Supabase. Settings → Inbox (categories, require category/summary, auto-remove labels, auto-close, unread email alert, show agent name, quick replies, labels).
> - scripts/wa-simulate.ts with fixtures for every webhook type."

### Phase 4 — Templates (week 6)
> **Prompt 4:** "Build Templates per docs/02 §5.6:
> - A list filtered by number and status (all Meta statuses), search, and actions (edit, map variables, duplicate, delete, archive/unarchive).
> - A builder drawer: name, category, language (EN/AR), number, type (Standard, Media & Interactive, Carousel), body with formatting and '@' variables, header media via the resumable upload API, footer, buttons (quick reply, URL, phone, copy code), and a live phone preview.
> - Submit to Meta, a nightly + manual sync, and an original starter gallery of about 20 clinic templates in EN and AR."

### Phase 5 — Enquiries + Tasks (week 7)
> **Prompt 5:** "Build Enquiries:
> - A pipelines rail, a Kanban (dnd-kit, counts, add per column, configurable card fields) and a table view (column chooser, export).
> - An Open/Closed switch, saved shareable views, filters, bulk edit/delete/disqualify.
> - An enquiry drawer: stage and status (Open/Won/Lost/Disqualified + reason), details incl. location/department/specialist/service/appt date, assignee, est. value, custom fields, move pipeline, linked contact, and tabs Timeline / Inbox.
> - Domain events via lib/events. Settings → Enquiries: SLA, notification rules, pipeline/stage editor, assignment rules, custom fields.
>
> Then build Tasks: list, filters, drawer, due notifications."

### Phase 6 — Appointments + Unite sync (weeks 7–9)
> **Prompt 6:** "Build Settings → Appointments: locations, departments, services, specialists (with Unite external_id), working hours, booking rules (3 reminders relative to start, lead time, reschedule/cancel cut-offs, auto-confirm) and notification template mapping. Build a slot engine with unit tests (timezone-aware). Build the Appointments page: a resource day view, a specialist day/week/month view, and a table with filters/export. Add a New Appointment drawer (single / block time) and status changes with optional WhatsApp notification. Schedule reminders in scheduled_jobs; template button replies (Confirm/Reschedule/Cancel) update status.
>
> Then implement lib/unite per docs/02 §6:
> - A read-only client with conservative rate limiting and retries.
> - Incremental sync jobs for doctors, patients and appointments using sync_cursors + external_refs.
> - Patient matching with a manual review queue (Portal → Sync Review), and Unite appointment events feeding flows and reminders.
> - Never write to Unite. Never call the Finance API.
>
> Then build `lib/clinical/` from docs/audit/clinical-rules.md:
> - Department Effective, vitals parsing, negation scrubbing, PAED/GP/GYN triggers, follow-up due dates, dedupe keys, antibiotic/probiotic sequences and the feedback red flag. Pure functions with the Test Plan cases as unit tests; thresholds come from clinical_settings.
> - Portal screens for the Follow-Up Queue and Clinical Settings (with sign-off fields).
> - **No patient-facing clinical messages until a 'clinical_messaging_enabled' setting is signed off.**"

### Phase 7 — Campaigns (weeks 9–10)
> **Prompt 7:** "Build Campaigns per docs/02 §5.7:
> - A list. A new-campaign page: name, number, audience = segment or CSV, template + variable mapping preview, now or scheduled, retry rounds, test send.
> - campaign_fanout and stats handlers, retry rounds, auto-pause guardrails, opt-out enforcement.
> - A detail drawer with Details and Recipients (Sent / Delivered / Read / Replied / Failed funnel + per-recipient table + CSV report)."

### Phase 8 — Flows + Make replacement (weeks 10–12)
> **Prompt 8:** "Implement lib/flow-engine per docs/02 §7 with full unit tests. Then build the Flows UI:
> - A list (trigger, number/pipeline, ✅/⚠️/⏳ run counters, status) and a Variables manager.
> - A builder on @xyflow/react: searchable palette, canvas with zoom/undo/redo, per-node properties panel, trigger conditions, publish, and a Logs page with step traces.
> - The inbox 'Shortcut' action and human takeover.
>
> Build a 'Recall programmes' engine (eligibility SQL view + template map + cadence + Test/Live mode) and configure Chronic 90-day, Birthday (gender/age bands) and the 48h appointment reminder on it.
>
> Then go through /docs/audit/make-scenarios.md and implement each scenario as its proposed native replacement (flow template, event handler or cron job). Add a 'Parallel run' report comparing native outputs with Make outputs for one week before retiring each scenario."

### Phase 9 — Back-office portal (weeks 12–13)
> **Prompt 9:** "Using /docs/audit/airtable-schema.md and the migration from Prompt 0, build the generic portal framework:
> - A portal_objects registry, and per object: a list page (DataGrid with saved views, filters, column chooser, export), a record drawer (typed fields, linked records, timeline, comments, attachments) and create/edit forms with Zod validation and permissions.
> - Register each Airtable-derived object.
> - Finish scripts/import-airtable.ts for all tables (idempotent via external_refs), with a dry-run mode and a reconciliation report (counts per table, unmatched links)."

### Phase 10 — AI, dashboards, reporting, public API (weeks 13–14)
> **Prompt 10:**
> - "Implement lib/ai with the Anthropic SDK (model from env) and the clinic guardrail system prompt.
>   - Inbox: Summarize, Ask AI, Suggested Reply (KB-grounded), Change Tone / Language (EN/AR), Fix Grammar, thumbs up/down feedback.
>   - Knowledge base: URL/file sources and groups, kb_ingest to pgvector.
> - Build the metrics layer (SQL views + materialized views refreshed by pg_cron) and:
>   - the Dashboard home
>   - a Management dashboard
>   - a Team-lead dashboard
>   - Reports: conversations, agent performance, enquiry funnel / stage time, campaign performance, appointments by status / location / specialist / no-shows, WhatsApp usage and cost, Unite appointments
>   - Shared filters, CSV export.
> - Add Settings → API keys (hashed) with /api/public/v1 (contacts, enquiries, appointments, send-template) and outbound webhooks (HMAC-signed, retries, delivery log)."

### Phase 11 — Hardening, migration & cut-over (weeks 14–15)
- Security pass:
  - RLS on every table, plus the cross-org test suite.
  - Service-role usage audited.
  - Tokens encrypted.
  - Webhook signatures checked.
  - Rate limits on the public API.
  - Audit-log coverage.
- Load test: a 20k-recipient campaign and a webhook burst (1k events/min).
- Final Airtable + Sanoflow import, reconciliation sign-off.
- Cut over WhatsApp numbers one at a time (§5.9). Run Make in parallel for one week, then retire Make, Airtable and Sanoflow.

---

## 9. Running cost (for reference)
| Item | ≈ / month |
|---|---|
| Supabase Pro + compute/backup add-ons | $25 – 150 |
| Vercel Pro | $20 – 60 |
| Anthropic API | $30 – 150 |
| Resend, Sentry, misc. | $0 – 40 |
| FullCalendar Premium (if used; annual licence) | ≈ $40 equivalent |
| Meta WhatsApp fees | unchanged, paid by Al Das to Meta |

---

## 10. Definition of done (go-live)
1. All 3 numbers live on the new inbox. Inbound to screen in under 2 seconds. Statuses tick to read.
2. Templates created and approved via the platform. The 24h rule is enforced.
3. A 10k campaign sends with no duplicates. The funnel matches webhook counts. Retries work.
4. Booking bot + reminders + button replies work end to end. Unite appointments appear and trigger reminders.
5. Every Make scenario has a native replacement verified in a parallel run. Make is switched off.
6. All Airtable data is imported and reconciled. Teams work only in the portal. Airtable is switched off.
7. The management dashboard reproduces the numbers management currently gets.
8. Cross-org/RLS tests pass. No patient data in seeds or logs.
