# Phase 10 — AI, dashboards, reporting, public API: what was built and how to use it

Phases 4–9 (templates, enquiries, appointments, campaigns, flows, portal) were not merged when this phase was built, so everything that depends on their tables is registered as **awaiting** with a documented data contract (`docs/audit/reports.md` §5) instead of being faked. Everything else in the Phase 10 prompt is built.

## Scope delivered

- **Migrations** (`…001000` → `…001300`):
  - `ai_kb` — `vector` extension; `kb_groups`, `kb_sources`, `kb_chunks` (`embedding vector(1024)`, HNSW cosine index), `ai_usage` (tokens, latency, outcome; **never content**), `kb_feedback` (thumbs; no draft text), private `kb-files` bucket; service-role RPCs `kb_match` (org-scoped similarity search) and `kb_replace_chunks` (atomic swap); backfills `ai.use` / `kb.manage` / `reports.export` onto existing system roles.
  - `api_webhooks` — `api_keys` (SHA-256 hash only), `api_idempotency`, `webhook_subscriptions`, `webhook_secrets` (AES-GCM, service role only), `webhook_deliveries` (unique per subscription + event, so fan-out is idempotent).
  - `metrics` — materialized views `mv_conversation_facts`, `mv_daily_conversations`, `mv_hourly_conversations`, `mv_agent_performance`, `mv_message_usage_daily` (org-timezone days; revoked from API roles); live `security_invoker` views `v_team_queue_now`, `v_agent_workload_now`, `v_sla_breaches_now`; `refresh_metrics()`, `report_sources_available()`; cron `pulse:metrics_refresh` every 15 min.
  - `report_functions` — `report_*` SQL functions that aggregate in the database and return bounded results (PostgREST caps responses at 1000 rows, and the hourly view alone can exceed that over a year).
- **`lib/ai`** — clinic guardrail system prompt (clinic-only, no diagnosis or dosing, `[[STAFF]]` hand-off marker, tagged input treated as data); Summarize, Ask AI, KB-grounded Suggested Reply, Change Tone, Change Language (EN/AR), Fix Grammar; output checks that flag dose-like text and diagnostic phrasing; transcript builder (speakers are "Patient"/"Staff", phone numbers and emails masked, notes excluded from patient-facing prompts, capped); per-user rate limit; Anthropic client (model from `ANTHROPIC_MODEL`, effort set per feature, server-side refusal fallback on models that support it); Voyage and deterministic fake embedders; KB retrieval; chunking; HTML/PDF/text extraction.
- **`lib/net`** — SSRF guard for every server-side fetch of a user-controlled URL (KB pages, webhook endpoints): https only, no credentials, no internal names, every resolved address must be public, and the address actually **connected to** is re-validated (defeats DNS rebinding); redirects re-validated hop by hop.
- **Inbox** — **AI** popover in the composer (Suggest a reply, Ask, Summarize, tone, translate EN/AR, fix grammar, thumbs up/down); suggestions and rewrites land in the message box with **Undo**, flagged drafts show why; "Draft with AI" in the close dialog; Arabic text renders with `dir="auto"`. Nothing is ever auto-sent.
- **Settings → AI & knowledge base** — org AI switch (**off by default**, with a data-handling notice), rate limit, which KB groups Suggested Reply may use, this-month usage and feedback counts, groups, URL and file sources with status/re-crawl/delete.
- **`kb_ingest` handler** — one source per message; skips unchanged content by hash; embeds; swaps chunks in one transaction; marks `failed` with a short reason (never document text); retries transient failures.
- **Reports** (`/reports`, `/reports/[report]`) — Conversations, Response performance, Agent performance, WhatsApp usage (counts by type and status). Shared filters (period presets and custom range in the **org timezone**, WhatsApp number, team, staff member) live in the URL; KPIs, charts, a **table view** of every number, and **Export CSV** (`POST /api/reports/[report]/export`: 401 → 403 → validate → run → audit; durations in seconds, formulas neutralised).
- **Dashboards** (`/dashboard` tabs) — Overview (your live counts through your own RLS; 14-day trend for people with `reports.view`), Management (messaging KPIs and charts), Team lead (live queues per team, conversations past the SLA, staff workload and presence; refreshes every 30 s; admins set the SLA minutes inline).
- **Charts** (`components/charts`) — Recharts and HTML marks on a palette validated with the dataviz skill against the real card surfaces in light and dark (CSS tokens `--viz-*`), thin marks, 2 px surface gap, hairline grid, legend for 2+ series, hover tooltips.
- **Public API** (`/api/public/v1`) — `GET/POST /contacts`, `GET/PATCH /contacts/{id}`, `POST /send-template`; Settings → **API keys** (create with scopes + expiry, shown once, revoke, last used).
- **Outbound webhooks** — Settings → **Webhooks**: endpoints with an event filter, one-time signing secret, test ping, secret rotation, pause, delivery log with manual retry. HMAC-signed, retried with backoff, SSRF-guarded, ids-only payloads.
- **Tests** — the suite now runs 504 vitest tests with `TEST_DATABASE_URL` set, plus 8 Playwright smoke tests. New this phase: unit tests for every `lib/ai`, `lib/net`, `lib/reports`, `lib/public-api` and `lib/webhooks` module (including independent HMAC vectors and the delivery handler against a faked network); DB tests for cross-org RLS on every new table, metric definitions with hand-computed expectations (timezone day-bucketing, bot messages excluded from first response, returning contacts), every `report_*` function, `kb_match` org scoping, and the full chunk → embed → `kb_replace_chunks` → `kb_match` retrieval path on real pgvector.

## Local happy path

```bash
pnpm db:reset                                  # applies …001000–001300 (needs pgvector; Supabase has it)
# .env.local: ANTHROPIC_API_KEY=…, EMBEDDINGS_PROVIDER=fake   (fake = no provider key needed, development only)
#             ENCRYPTION_KEY=$(openssl rand -base64 32)       (webhook signing secrets)
pnpm dev
pnpm wa:simulate message-text && pnpm jobs:run meta_events    # something to report on
pnpm jobs:run metrics_refresh                                  # fills the dashboards (cron does this every 15 min)
```

1. **Reports** — `/dashboard/management`, `/reports/conversations`: change period / number, open the table view, Export CSV.
2. **AI** — Settings → AI & knowledge base → turn on; add a page or upload a file; `pnpm jobs:run kb_ingest`; in the inbox open a conversation → **AI** → Suggest a reply.
3. **API** — Settings → API keys → New key, then:
   ```bash
   curl localhost:3000/api/public/v1/contacts?limit=5 -H "Authorization: Bearer $KEY"
   curl -X POST localhost:3000/api/public/v1/send-template -H "Authorization: Bearer $KEY" \
     -H "Idempotency-Key: demo-1" -H "Content-Type: application/json" \
     -d '{"to":"+971500000001","template":"<approved template name>","language":"en","variables":{"body.1":"Amal"}}'
   pnpm jobs:run outbound        # API sends use the standard lane
   ```
4. **Webhooks** — Settings → Webhooks → New endpoint (a public https URL, e.g. a webhook inspector) → Send test → `pnpm jobs:run webhooks_out`.

## Going live

1. **Decide data handling first (OQ-49, OQ-57).** AI sends recent conversation text (numbers and emails masked) to Anthropic, and KB text to Voyage. Get the residency/consent answer before anyone turns the org switch on. It is off until an admin does.
2. Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `EMBEDDINGS_API_KEY` (`EMBEDDINGS_PROVIDER=voyage`, `EMBEDDINGS_MODEL=voyage-3`, which must output 1024 dimensions to match the column), `ENCRYPTION_KEY`. `EMBEDDINGS_PROVIDER=fake` is refused in production.
3. Supabase: apply the migrations; confirm the `kb-files` bucket exists; vault secrets `app_url` / `job_secret` (Phase 1) so `pulse:metrics_refresh` and `pulse:kb_ingest` / `pulse:webhooks_out` fire.
4. Grant roles: Manager already gets `ai.use`, `kb.manage`, `reports.export`; Agent/Receptionist get `ai.use`. The migration backfills existing orgs' system roles; custom roles are edited in Settings → Roles.
5. Tune the retrieval cutoff (`Embedder.minSimilarity`, 0.3 for Voyage) on real clinic content; it is a starting value, not a measured one.

## Public API reference

Base URL `${APP_URL}/api/public/v1`. `Authorization: Bearer pk_<8>_<43>`. Keys are random, stored only as SHA-256, shown once; `last_used_at` updates at most every 5 minutes. All responses are JSON with `Cache-Control: no-store`. Errors: `{"error":{"code","message","details?"}}`.

| Status / code | Meaning |
|---|---|
| 401 `missing_api_key`, `invalid_api_key`, `api_key_revoked`, `api_key_expired` | unknown, malformed and wrong-secret keys are indistinguishable; revoked/expired only after the hash matched |
| 403 `insufficient_scope` | key lacks the scope |
| 400 `invalid_json`, `invalid_cursor`, `idempotency_key_required` | |
| 422 `validation_failed` (+ `details[{field,message}]`), `invalid_phone`, … | |
| 429 `rate_limited` | reserved: the limiter hook exists (`setRateLimiter`), Phase 11 installs the real one |

Scopes: `contacts:read`, `contacts:write`, `messages:send_template`.

- `GET /contacts?limit=50&cursor=&phone=&email=&external_id=&updated_since=` → `{ data: [contact], next_cursor }`, newest first, `limit` ≤ 200. Contact fields: `id, first_name, last_name, phone, email, gender, nationality, country, language, dob, external_id, promotions_opt_in, stop_marketing, source, created_at, updated_at` (no BSUID, owner, custom fields or org id).
- `POST /contacts` — requires `phone`; matched by E.164 (national formats are normalised, default region AE). Existing phone → **200** and only the fields sent are updated; new → **201**. Unknown fields are rejected. `stop_marketing` may only be set to `true`: the API can record an opt-out but never lift one. `external_id` clashes → 409.
- `GET|PATCH /contacts/{id}` — partial update; changing `phone` to one another contact owns → 409.
- `POST /send-template` — requires an `Idempotency-Key` header. Body: `{ to, template, language, variables?: {"body.1": "…"}, channel_id?, contact?: {first_name, last_name} }`. Same rules as the inbox: approved templates only; marketing templates refuse a contact with `stop_marketing` (`recipient_opted_out`); every variable must have a value (`missing_variables`); templates with a media/location header are not supported yet (`unsupported_template`). With several active numbers `channel_id` is required (`channel_required`). The message is **queued** (`202 { message_id, conversation_id, contact_id, status: "queued" }`); delivery goes through the outbound queue with the per-number rate limit.
  - Same key + same body → the first response is replayed (`Idempotent-Replayed: true`). Same key + different body → 422 `idempotency_key_reused`. A failed request releases the key. **If a request crashes after queuing, its key stays "in progress" (409 `request_in_progress`) until it is pruned after 48 h:** the outcome is unknown, so check the conversation before retrying with a new key. This favours never sending twice.

## Outbound webhook reference

Request: `POST` JSON `{ id, type, created_at, org_id, data }` with headers `X-Pulse-Event`, `X-Pulse-Delivery` and `X-Pulse-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` (the timestamp is signed; reject signatures older than 5 minutes). Any 2xx is success; redirects are not followed; the response body is read up to 4 KB and ignored. Failures retry after 1 min, 5 min, 30 min, 2 h, 6 h, then the delivery is **dead** (HTTP 410 and non-public addresses are dead at once); Settings → Webhooks can retry a dead delivery.

`data` is built from an allowlist of opaque ids (`conversation_id`, `message_id`, `contact_id`, `channel_id`, `template_id`, …) and non-identifying enums (`status`, `kind`, `direction`, `code`, …). Message text, names, phones and `wa_id`/`external_id` never leave the platform; receivers fetch details through the API with the ids. Events: `conversation.opened|closed|waiting|assigned`, `message.received|sent|failed`, `contact.created`, `contact.stop_marketing`, `channel.quality_changed`, `template.status_changed`; enquiry/appointment/campaign events join the catalogue (`lib/webhooks/events.ts`) with their phases.

## Decisions and assumptions

- **Awaiting, not faked.** Enquiry funnel/stage time, appointments (status/location/specialist/no-shows), Unite appointments, campaign performance, WhatsApp **cost**, and the `/enquiries` and `/appointments` API routes are not built; they appear as "Awaiting Phase N" and become live when their views and a `run` function are added (`lib/reports/registry.ts`).
- **Metric definitions are working definitions** (OQ-44, the data requirements matrix, is missing): first response = first outbound message sent by a staff member (bots/flows excluded) at or after the first patient message; resolution = `closed_at − opened_at`; returning contact = had an earlier conversation; SLA breach = the patient wrote last and nobody replied within `orgs.settings.reports.sla_minutes` (default 15). Days are bucketed in the org timezone. Documented in `docs/audit/reports.md` §5.
- **Embeddings:** Voyage `voyage-3` (1024-d, matching the planned `vector(1024)`), behind `lib/ai/embeddings.ts`. The similarity cutoff belongs to the embedder because scales differ by model (the fake embedder's is lower).
- **Webhook fan-out is called from `emit()`**, not registered as an `on("*")` listener, because listeners only exist in the process that registered them and serverless processes differ. Skipped when no database is configured (tests, build).
- **Refusal fallback** (`fallbacks: "default"`) is enabled on models that support it, so a classifier decline on a routine clinic message is retried on the fallback model inside the same call. A refusal that still stands is shown to staff as "couldn't help", never as an empty draft.
- **Materialized views are not covered by RLS**, so they are revoked from `anon`/`authenticated` and read only through service-role functions after `can('reports.view')`, always filtered by `org_id`. The live views are `security_invoker`.

## Deviations from the plan

- Summarize lives in the composer's AI popover and the close dialog (explicit "Save as conversation summary"), not in the thread header.
- `kb_ingest` caps a document at 400 sections so a source embeds within one invocation, instead of the "continuation message" design. Larger sources fail with a clear reason ("split it into smaller sources").
- Heavy report aggregation moved into SQL functions (`…001300`), an addition to the plan, because of PostgREST's 1000-row cap.
- API-key and webhook management sit under `settings.manage` rather than new permission keys.
- Idempotency keys and finished webhook deliveries (30 days) are pruned by the `metrics_refresh` task rather than a separate cron.

## Demo checklist

- [ ] `/dashboard/management` shows numbers after `pnpm jobs:run metrics_refresh`; period and number filters change them; the table view matches; Export CSV opens in a spreadsheet.
- [ ] `/dashboard/team`: a conversation left unanswered past the SLA appears under "Waiting too long"; the SLA setting changes the count.
- [ ] Reports index lists the five awaiting reports with their phase.
- [ ] AI: with the switch off the AI button is absent; on, Suggest a reply drafts from a KB page, Undo restores the text, thumbs up/down is saved; an Arabic draft renders right-to-left; a message about symptoms comes back flagged.
- [ ] API: wrong key → 401, key without scope → 403, `send-template` without `Idempotency-Key` → 400, same key twice → one message, marketing template to an opted-out contact → 422.
- [ ] Webhooks: Send test → delivery log shows success; point it at a failing URL → retries are scheduled; verify the signature with the snippet on the page.

## Open questions / follow-ups

OQ-56 to OQ-61 in `docs/audit/open-questions.md`. Also: Phase 11 installs the API rate limiter (`setRateLimiter`) and widens audit coverage; `ai_tags` auto-tagging (e.g. `retention_risk`) is not built; scheduled email digests of the dashboards are not built.
