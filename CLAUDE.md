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
Captures Unite invoices, matches them to Diligence claim files, and routes exceptions. Phases F0–F6; F0–F2, F2.1 and F4 built (Unite capture is built but OFF). Open items: `docs/finance/open-items.md`.
- Tables are `public.fin_*`, `ins_*`, `ops_*` (never separate schemas); raw tables (`fin_raw_*`, capture settings and lease) have RLS and **no policies**: service role only, and the payload column is never selected for the UI.
- **The Unite Finance API is deliver-once.** Only the F2 `finance_capture` handler may call it, only when `fin_capture_settings.enabled` is true (default false), only after taking `fin_capture_try_lease`, and only after the previous raw payload is stored. No scripts, tests or "quick checks" against it.
- Store the raw batch first, then process with `fin_process_batch` (idempotent, replayable). Never delete invoice lines (`is_current = false`).
- Finance tables carry the Unite PIN only; no names, DOB, Emirates ID or member IDs. Test fixtures are synthetic (`tests/unit/finance/fixtures`).
- Permissions are `finance.*` (see `lib/auth/permissions.ts`); finance reads for staff go through RLS or the `v_fin_*` / `v_ins_*` views, server jobs use the service role after `can()`.
- Unite JSON field names live ONLY in `lib/finance/unite-mapping.ts`; the mapper fails a batch closed rather than guess. Recover with `pnpm finance:replay <batchId|--failed>` (never calls Unite). Tests must never reach Unite (`tests/setup.ts` blocks the host).
- Diligence files: the uploaded `.xlsx` holds names and Emirates IDs. It is parsed server-side, only sanitised rows are staged (`ins_staged_activities`), and the original is deleted at once. Column names live ONLY in `lib/finance/diligence-mapping.ts`; unknown columns are never read. No real export in the repo, tests build synthetic workbooks.
- Claim matching is pure (`lib/finance/match-claims.ts`) and writes through `ins_apply_matches`; commits go through the atomic `ins_commit_import`.
- `pnpm finance:seed --org=<slug>` adds the Finance/Billing/Insurance/CEO/Medical Director roles and reference rows to an existing org.

## Conventions
- Business logic in `lib/*` as plain TS with unit tests. Route handlers and server actions stay thin and validate with Zod.
- Phones are always E.164 (`libphonenumber-js`). Times are stored in UTC and displayed in location/org timezone (`date-fns-tz`).
- Domain events go through `emit(orgId, 'enquiry.stage_changed', payload)`, which triggers flows and outbound webhooks.
- UI patterns: right-side drawers for records, DataGrid for lists with saved views, a phone preview for templates/campaigns.
- Every schema change is a new migration. Never edit applied migrations. Regenerate types after migrating.
- Back-office objects: core entities merge into core tables; everything else becomes a real table registered in `portal_objects`.

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
```

## Definition of done per task
Typecheck, lint and tests pass. The happy path works locally (webhook simulator for WhatsApp). RLS is covered for new tables. No PHI in logs or fixtures. Docs are updated if behaviour changed.
