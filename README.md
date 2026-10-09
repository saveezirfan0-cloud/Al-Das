# Pulse — Al Das in-house clinic platform

One platform replacing Sanoflow (WhatsApp inbox, templates, campaigns, enquiries, appointments, bots) and the Airtable + Make.com back office. Next.js 15 + Supabase + Vercel. See `CLAUDE.md` for the rules, `docs/02_CLAUDE_CODE_BUILD_PLAN.md` for the plan.

**Status:** Phases 1–3 are built: auth, tenancy with RLS, roles/permissions, teams, invites, app shell and the jobs framework (Phase 1); the patient CRM — contacts grid, views, segments, filter builder, import/export, merge, custom fields, tags (Phase 2); the WhatsApp Cloud API client, webhook ingress, queue handlers, Settings → Channels / Inbox and the shared inbox (Phase 3). Phase 6 adds appointments (slot engine, reminders, button replies), the read-only Unite EMR sync with Sync Review, and the clinical rules engine with the Follow-Up Queue and Clinical settings (patient-facing clinical messaging stays off until signed off). Other module pages are placeholders until their phase. Details: `docs/03_PHASE_1_NOTES.md`, `docs/04_PHASE_2_NOTES.md`, `docs/05_PHASE_3_NOTES.md`, `docs/06_PHASE_6_NOTES.md`.

## Run it locally

```bash
pnpm install
cp .env.example .env.local        # fill in the Supabase keys
supabase start                    # local Supabase stack (Docker)
pnpm db:reset                     # applies migrations + seed, regenerates lib/supabase/types.ts
pnpm dev                          # http://localhost:3000
```

Seeded dev login: `admin@pulse.local` / `pulse-dev-password` (fake data only).

Queue handlers are driven by pg_cron on Supabase. Locally, trigger them by hand:

```bash
pnpm jobs:run scheduler           # moves due scheduled_jobs into pgmq
pnpm jobs:run notifications       # drains one queue
pnpm wa:simulate message-text     # post a signed sample Meta webhook (see scripts/wa-fixtures)
pnpm jobs:run meta_events         # process it into the inbox
```

or from **Settings → System health** (Drain / Run scheduler buttons).

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test      # unit tests (no database needed)
pnpm test:db                                   # RLS + scheduler/queue + filter tests on a plain Postgres (see supabase/test/README.md)
pnpm e2e                                       # Playwright smoke tests
pnpm import:sanoflow --file=contacts.csv --dry-run   # Sanoflow contact export → contacts (docs/04 for options)
pnpm import:airtable --dry-run                       # Airtable patient tables → contacts
```

## Layout

```
app/            Next.js App Router: (auth) login + invite, (app) shell + modules, api/jobs/[queue]
components/     shadcn-style UI primitives (components/ui) and the app shell (components/shell)
lib/            auth (can, session, permissions), jobs (registry, runner, scheduler), filters (AST → SQL / evaluator),
                contacts (import, export, merge, query), supabase clients, audit, email
supabase/       migrations, seed.sql (fake data), test/ (plain-Postgres stand-ins for tests)
tests/          unit (vitest), db (vitest + pg), e2e (playwright)
scripts/        audit exporters, importers (import-sanoflow, import-airtable + import/mappers), test-db.sh, run-job.ts
docs/           spec, build plan, audit, phase notes
```
