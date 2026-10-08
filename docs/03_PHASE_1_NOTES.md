# Phase 1 — Foundation: what was built and how to use it

## Scope delivered
- **Scaffold:** Next.js 15 App Router, TypeScript strict, Tailwind v4, shadcn-style components (`components/ui`, hand-written on Radix because the shadcn registry was unreachable from the build environment; `components.json` is in place so `pnpm dlx shadcn add <x>` works later), Supabase SSR auth, generated DB types.
- **Migrations** (`supabase/migrations`):
  1. `extensions_and_helpers` — pgcrypto, uuid-ossp, pg_trgm, the `app` schema, `set_updated_at`.
  2. `tenancy` — `orgs, profiles, roles, memberships, teams, team_members, invites, audit_log, notifications`; RLS on all; `app.is_org_member / has_perm / shares_org_with` helpers; integrity triggers (role ↔ org, team ↔ org, protected system roles); RPCs `create_org`, `set_presence`, `mark_all_notifications_read`.
  3. `jobs` — `scheduled_jobs, job_runs, dead_letters` (RLS enabled, no API policies → service role only); `claim_scheduled_jobs` (FOR UPDATE SKIP LOCKED, stale-lock reclaim), `complete_scheduled_job`, `fail_scheduled_job` (retry or dead-letter).
  4. `queues` — pgmq queues (`meta_events, outbound, outbound_priority, campaign_fanout, flow_steps, media_fetch, webhooks_out, unite_sync, kb_ingest, notifications`) and service-role RPCs `job_enqueue / job_read / job_archive / job_dead_letter / job_retry_dead_letter / job_queue_metrics`.
  5. `cron` — pg_cron + pg_net: `app.ping_jobs(queue)` POSTs to `/api/jobs/<queue>` with `X-Job-Secret`; schedules every 10 s (hot queues) / 30 s (slow lanes), nightly housekeeping, `job_cron_status()` for the health page.
  6. `realtime` — notifications + memberships in the realtime publication.
- **Auth:** email+password and magic-link login, PKCE callback, sign-out, middleware session refresh + redirects. Invite → accept (creates the account or joins an existing one). First-run `/onboarding` creates the workspace when `ALLOW_WORKSPACE_CREATION=true`.
- **Permissions:** catalogue + seed roles in `lib/auth/permissions.ts`; `can()/assertCan()` in `lib/auth/can.ts`; `requireMember()/requirePerm()` in `lib/auth/session.ts`. Wildcards: `*`, `portal.*`, `portal.*.read`.
- **Shell:** collapsible left nav (state in a cookie), mobile sheet nav, top bar with notifications (realtime inserts + toast) and presence menu (Online / Away / Appear offline), org switcher when a user belongs to several orgs.
- **Settings:** Account (profile, password), Users (invite with role + teams, resend, revoke, change role, suspend/restore, remove; last-admin guard), Roles (permission matrix, system roles locked), Teams (members, round-robin flag), System health (queue depths, cron pings, recent runs, dead letters with retry/discard, manual drain).
- **Jobs framework** (`lib/jobs`): handler registry, batch runner (archive on success, retry via visibility timeout, dead-letter after `maxReads` or on `PermanentJobError`, `job_runs` logging), scheduler (claim → route kind → enqueue), `enqueue()/scheduleJob()`, `/api/jobs/[queue]` secured by a constant-time secret check. First real handler: `notifications` (email via Resend, in-app notifications).
- **Tests:** 43 unit tests (permissions, can, scheduler claim/route/back-off, runner, health, invites, secret), 14 DB tests (cross-org isolation on every tenant table, agent vs admin writes, membership self-escalation blocked, SKIP LOCKED claim with two workers, fail/retry/dead-letter lifecycle, pgmq wrappers, cron schedules), 2 Playwright smoke tests.

## Deploy checklist (Supabase + Vercel)
1. Supabase project with **pgmq, pg_cron, pg_net** enabled (Database → Extensions). `supabase link` then `supabase db push`.
2. Vercel env: everything in `.env.example` that has a value. `JOB_SECRET` ≥ 16 random chars. `APP_URL` = the production URL.
3. In the Supabase SQL editor, give pg_cron the URL and secret (Vault):
   ```sql
   select vault.create_secret('https://<your-app>.vercel.app', 'app_url');
   select vault.create_secret('<JOB_SECRET>', 'job_secret');
   ```
   Until both exist `app.ping_jobs` is a no-op.
4. Supabase Auth → URL configuration: site URL = `APP_URL`, redirect URL `${APP_URL}/auth/callback`.
5. First user: sign up by email (Auth → Users → Add user, or an invite from a seeded org), set `ALLOW_WORKSPACE_CREATION=true` for the first deploy, sign in, create the workspace at `/onboarding`, then set it back to `false`.
6. Open **Settings → System health**: every `pulse:*` cron row should show `succeeded` within a minute.

## Demo checklist
- [ ] `/login` → wrong password shows an error; correct password lands on `/dashboard`.
- [ ] Sidebar collapses and the state survives a reload. Mobile menu opens as a sheet.
- [ ] Presence menu: set Away → the dot changes; Users page shows the same state for colleagues.
- [ ] Settings → Users → Invite: with no Resend key the dialog shows the link; open it in a private window, create the account, land on the dashboard as that role (an Agent sees fewer nav items, no admin Settings tabs).
- [ ] Settings → Roles: edit Agent's permissions → the invited user's nav updates on refresh. Admin can't lose `*`; system roles can't be renamed/deleted.
- [ ] Settings → Teams: create a round-robin team with members.
- [ ] Notifications: insert a row for your user (or `pnpm jobs:run notifications` after enqueuing an `in_app` job) → bell badge + toast appear live.
- [ ] System health: Run scheduler / Drain show toasts and job_runs rows; dead letters can be retried.
- [ ] `curl -X POST $APP_URL/api/jobs/outbound` → 401; with the header → JSON result.

## Open questions / follow-ups
- Supabase hosted pgmq is 1.4.x; the wrappers only use the `send/read/archive/metrics_all` signatures that exist in both 1.4 and 1.5.
- `pg_cron` sub-minute schedules need Postgres 15+ on Supabase (default for new projects).
- Email templates (invite) are plain text; branded HTML comes with Phase 10's digests.
- Presence is set on page load and by the user; an inactivity timeout can be added with the inbox in Phase 3.
