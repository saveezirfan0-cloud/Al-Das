-- Phase 6 (6b): Unite EMR integration plumbing. Unite is READ-ONLY in the MVP (CLAUDE.md rule 7).
--
--   integration_accounts : one row per org per external system. Non-secret config (endpoint paths,
--                          feature flags) in `config`; credentials in `config_enc` (AES-256-GCM,
--                          lib/crypto.ts); the short-lived Unite token (~240 s) in `token_enc`.
--   sync_cursors         : where each incremental sync (source/entity/scope) got to.
--   unite_api_calls      : one row per outbound Unite call — endpoint, outcome, timing. No bodies,
--                          no patient data.
--   sync_reviews.incoming: what Unite sent for a patient we could not match unambiguously.
--
-- The Unite Finance API is sync-once (each call permanently dequeues records), so nothing here
-- calls it and there is deliberately no raw-payload table yet: it is added together with the
-- guarded, feature-flagged job that would write it.

create table public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('unite')),
  status text not null default 'active' check (status in ('active', 'paused')),
  config jsonb not null default '{}'::jsonb,           -- non-secret: base_url, paths, flags
  config_enc text,                                     -- encrypted credentials (optional; env fallback)
  token_enc text,                                      -- encrypted {access_token, refresh_token, expires_at}
  token_expires_at timestamptz,
  refresh_lock_until timestamptz,                      -- single-flight token refresh
  consecutive_failures integer not null default 0,
  breaker_open_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind),
  check (jsonb_typeof(config) = 'object')
);
create trigger integration_accounts_set_updated_at before update on public.integration_accounts
  for each row execute function app.set_updated_at();
alter table public.integration_accounts enable row level security;  -- service role only

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

create table public.unite_api_calls (
  id bigserial primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  endpoint text not null,
  outcome text not null check (outcome in ('ok', 'error', 'auth_error', 'rate_limited', 'breaker_open')),
  http_status integer,
  duration_ms integer,
  batch_id text,
  at timestamptz not null default now()
);
create index unite_api_calls_org_at_idx on public.unite_api_calls (org_id, at desc);
alter table public.unite_api_calls enable row level security;
create policy unite_api_calls_select on public.unite_api_calls for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

alter table public.sync_reviews add column incoming jsonb not null default '{}'::jsonb;

-- Single-flight token refresh: true for exactly one caller until the lock expires.
create or replace function public.unite_claim_token_refresh(p_org uuid, p_ttl_seconds integer default 20)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.integration_accounts
    set refresh_lock_until = now() + make_interval(secs => p_ttl_seconds)
    where org_id = p_org and kind = 'unite'
      and (refresh_lock_until is null or refresh_lock_until < now())
    returning 1
  )
  select exists (select 1 from claimed);
$$;
revoke all on function public.unite_claim_token_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function public.unite_claim_token_refresh(uuid, integer) to service_role;

-- Schedules. pg_cron runs in UTC: Dubai (UTC+4) 07:00–22:00 → 03:00–17:59 UTC.
select cron.schedule('pulse:unite_enqueue', '*/15 3-17 * * *', $$select app.ping_jobs('unite_enqueue')$$);
select cron.schedule('pulse:unite_nightly', '30 18 * * *', $$select app.ping_jobs('unite_nightly')$$);
select cron.schedule('pulse:unite_housekeeping', '40 3 * * *', $$
  delete from public.unite_api_calls where at < now() - interval '30 days';
$$);
