-- Phase 19a (1/4): integrations foundation, shared by every integration (19a and 19b).
--
--   integration_accounts      (exists since Finance F2) gains the on/off flag and health columns. Credentials stay in config_enc
--                             (AES-256-GCM, lib/crypto.ts) and the table keeps NO policies: only server code (service role, after
--                             can('integrations.manage')) reads or writes it, and the browser never receives the ciphertext.
--   integration_calls         one row per call to an external provider: provider, operation, outcome, status code, latency.
--                             Never a URL, header, request or response body, phone number, name or amount.
--   integration_webhook_events idempotency keys for inbound provider webhooks (service role only).
--   integration_usage_daily   daily counters per provider and metric (messages sent, segments, calendar fetches, ...).
--   integration_call_stats()  the 24-hour summary the System health page shows.
--   permissions               integrations.manage (Admin has '*'); integrations.calendar and finance.payment_links are granted to
--                             the existing roles below.
--
-- Every integration is OFF until an administrator switches it on (integration_accounts.enabled = false by default).

-- ---------------------------------------------------------------------------
-- integration_accounts: flag + health
-- ---------------------------------------------------------------------------
alter table public.integration_accounts
  add column if not exists enabled boolean not null default false,
  add column if not exists enabled_at timestamptz,
  add column if not exists enabled_by uuid references public.profiles (id) on delete set null,
  add column if not exists credentials_set_at timestamptz,
  add column if not exists last_ok_at timestamptz,
  add column if not exists last_error_at timestamptz;

comment on column public.integration_accounts.enabled is
  'Feature flag. OFF by default. Nothing is sent to, or fetched from, the provider while false. Unite keeps its own flags in config.';
comment on column public.integration_accounts.last_error is
  'Redacted (lib/redact.ts) one-line reason of the last failure; never a body, token or phone number.';

-- ---------------------------------------------------------------------------
-- integration_calls
-- ---------------------------------------------------------------------------
create table public.integration_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  operation text not null check (char_length(operation) between 1 and 60),
  outcome text not null check (outcome in (
    'ok', 'client_error', 'auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout', 'breaker_open', 'blocked'
  )),
  http_status integer,
  duration_ms integer,
  attempt smallint not null default 1,
  at timestamptz not null default now()
);
create index integration_calls_org_provider_at_idx on public.integration_calls (org_id, provider, at desc);

alter table public.integration_calls enable row level security;
create policy integration_calls_select on public.integration_calls for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));

-- ---------------------------------------------------------------------------
-- integration_webhook_events: idempotency for inbound webhooks (service role only, no policies)
-- ---------------------------------------------------------------------------
create table public.integration_webhook_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  event_key text not null check (char_length(event_key) between 1 and 200),
  outcome text check (outcome is null or char_length(outcome) <= 60),
  received_at timestamptz not null default now(),
  unique (org_id, provider, event_key)
);
create index integration_webhook_events_received_idx on public.integration_webhook_events (received_at);
alter table public.integration_webhook_events enable row level security;
-- no API policies: service role only (the webhook route claims a key before it acts)

-- ---------------------------------------------------------------------------
-- integration_usage_daily
-- ---------------------------------------------------------------------------
create table public.integration_usage_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  day date not null,
  metric text not null check (char_length(metric) between 1 and 60),
  value bigint not null default 0,
  primary key (org_id, provider, day, metric)
);
alter table public.integration_usage_daily enable row level security;
create policy integration_usage_daily_select on public.integration_usage_daily for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));

create or replace function public.integration_usage_bump(p_org uuid, p_provider text, p_metric text, p_n bigint default 1)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.integration_usage_daily as u (org_id, provider, day, metric, value)
  values (p_org, p_provider, (now() at time zone 'utc')::date, p_metric, p_n)
  on conflict (org_id, provider, day, metric) do update set value = u.value + excluded.value;
$$;
revoke all on function public.integration_usage_bump(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.integration_usage_bump(uuid, text, text, bigint) to service_role;

-- Calls per provider and outcome since a moment (System health). Service role only.
create or replace function public.integration_call_stats(p_org uuid, p_since timestamptz)
returns table (provider text, outcome text, calls bigint, avg_ms integer, last_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select c.provider, c.outcome, count(*)::bigint, coalesce(round(avg(c.duration_ms)), 0)::integer, max(c.at)
  from public.integration_calls c
  where c.org_id = p_org and c.at >= p_since
  group by c.provider, c.outcome
$$;
revoke all on function public.integration_call_stats(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.integration_call_stats(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions for the existing system roles (idempotent; new orgs get them from lib/auth/permissions.ts).
-- integrations.manage: Admin only (Admin holds '*').
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Manager', 'integrations.calendar'),
      ('Finance', 'finance.payment_links'),
      ('Billing', 'finance.payment_links')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- Housekeeping: call log 30 days, webhook idempotency keys 14 days, usage counters 400 days.
select cron.schedule('pulse:housekeeping_integrations', '45 3 * * *', $$
  delete from public.integration_calls where at < now() - interval '30 days';
  delete from public.integration_webhook_events where received_at < now() - interval '14 days';
  delete from public.integration_usage_daily where day < (now() - interval '400 days')::date;
$$);
