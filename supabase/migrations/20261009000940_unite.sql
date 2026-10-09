-- Phase 6 (6b): Unite EMR sync plumbing. Unite is READ-ONLY here (CLAUDE.md rule 7).
--
-- The Finance module (…0600_finance_capture.sql) already owns integration_accounts (encrypted
-- credentials + token cache in config_enc) and unite_api_calls (call log). The appointment/patient sync
-- shares both: one set of credentials, one token cache. This migration only adds what the sync needs.
--
--   integration_accounts.config / consecutive_failures / breaker_open_until : non-secret sync settings
--                          (endpoint paths, feature flags) and the circuit breaker
--   sync_cursors         : where each incremental sync (source/entity/scope) got to.
--   sync_reviews.incoming: what Unite sent for a patient we could not match unambiguously.
--
-- The Unite Finance API is sync-once (each call permanently dequeues records). Nothing in the sync
-- calls it; only the guarded, feature-flagged finance_capture job does.

alter table public.integration_accounts
  add column config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  add column consecutive_failures integer not null default 0,
  add column breaker_open_until timestamptz;

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null,                                -- 'unite'
  entity text not null,                                -- 'appointments' | 'patients' | 'doctors'
  scope text not null default '',                      -- e.g. the clinic id for per-branch syncs
  cursor jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, entity, scope)
);
create trigger sync_cursors_set_updated_at before update on public.sync_cursors
  for each row execute function app.set_updated_at();
alter table public.sync_cursors enable row level security;
create policy sync_cursors_select on public.sync_cursors for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

alter table public.sync_reviews add column incoming jsonb not null default '{}'::jsonb;

-- Schedules. pg_cron runs in UTC: Dubai (UTC+4) 07:00–22:00 → 03:00–17:59 UTC.
select cron.schedule('pulse:unite_enqueue', '*/15 3-17 * * *', $$select app.ping_jobs('unite_enqueue')$$);
select cron.schedule('pulse:unite_nightly', '30 18 * * *', $$select app.ping_jobs('unite_nightly')$$);
select cron.schedule('pulse:unite_housekeeping', '40 3 * * *', $$
  delete from public.unite_api_calls where at < now() - interval '30 days';
$$);
