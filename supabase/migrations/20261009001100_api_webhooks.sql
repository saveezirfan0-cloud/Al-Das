-- Phase 10 / 2: public API keys + outbound webhooks.
--
--   api_keys              hashed keys (the full key is shown once); service role only
--   api_idempotency       Idempotency-Key replay store for POST /api/public/v1/send-template
--   webhook_subscriptions org-scoped endpoints + event filter (readable with settings.manage)
--   webhook_secrets       encrypted signing secret per subscription; service role only
--   webhook_deliveries    delivery log, one row per (subscription, event) so fan-out is idempotent

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  key_prefix text not null,                          -- first characters of the key, safe to display
  key_hash text not null unique,                     -- sha256 hex of the full key; the key itself is never stored
  scopes text[] not null default '{}',               -- contacts:read, contacts:write, messages:send_template
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index api_keys_org_idx on public.api_keys (org_id, created_at desc);
alter table public.api_keys enable row level security;
-- no API policies: service role only

create table public.api_idempotency (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,                        -- same key + different body is a 422, not a replay
  response_status integer,                           -- null while the first request is still in flight
  response jsonb,
  created_at timestamptz not null default now(),
  unique (api_key_id, idempotency_key)
);
create index api_idempotency_created_idx on public.api_idempotency (created_at);
alter table public.api_idempotency enable row level security;
-- no API policies: service role only

create table public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  url text not null check (url like 'https://%'),
  description text,
  events text[] not null check (cardinality(events) > 0),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_subscriptions_org_idx on public.webhook_subscriptions (org_id) where active;
create trigger webhook_subscriptions_set_updated_at before update on public.webhook_subscriptions
  for each row execute function app.set_updated_at();

create table public.webhook_secrets (
  subscription_id uuid primary key references public.webhook_subscriptions (id) on delete cascade,
  secret_enc text not null,                          -- lib/crypto.ts encryptSecret()
  updated_at timestamptz not null default now()
);
alter table public.webhook_secrets enable row level security;
-- no API policies: service role only

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  subscription_id uuid not null references public.webhook_subscriptions (id) on delete cascade,
  event_id uuid not null,                            -- stable id of the domain event; also sent as X-Pulse-Delivery's event id
  event text not null,
  payload jsonb not null,                            -- envelope {id,type,created_at,org_id,data}; ids only, no PHI
  status text not null default 'pending' check (status in ('pending', 'success', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  response_code integer,
  error text,                                        -- short reason (timeout, status text); the response body is never stored
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, event_id)
);
create index webhook_deliveries_org_idx on public.webhook_deliveries (org_id, created_at desc);
create index webhook_deliveries_sub_idx on public.webhook_deliveries (subscription_id, created_at desc);
create trigger webhook_deliveries_set_updated_at before update on public.webhook_deliveries
  for each row execute function app.set_updated_at();
create trigger webhook_deliveries_sub_org_check before insert or update on public.webhook_deliveries
  for each row execute function app.check_parent_org('webhook_subscriptions', 'subscription_id');

alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy webhook_subscriptions_select on public.webhook_subscriptions for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'settings.manage'));
create policy webhook_deliveries_select on public.webhook_deliveries for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'settings.manage'));
-- Writes are server-side only (settings.manage check, then the service role).
