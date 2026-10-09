-- Phase 3 / 1: WhatsApp channels, per-number send slots, webhook ingress log, templates.

-- ---------------------------------------------------------------------------
-- channels: one row per WhatsApp number (phone_number_id) connected to the org.
-- The System User token lives in channel_secrets (service role only), encrypted
-- with AES-256-GCM by lib/crypto.ts.
-- ---------------------------------------------------------------------------

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  type text not null default 'whatsapp' check (type in ('whatsapp')),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  waba_id text not null,
  phone_number_id text not null unique,
  display_phone text,                                -- as reported by Meta (+971 4 ...), not a contact's phone
  verified_name text,
  business_id text,
  quality_rating text,                               -- GREEN | YELLOW | RED | UNKNOWN
  messaging_limit_tier text,                         -- TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED
  name_status text,
  is_coexistence boolean not null default false,
  catalog_id text,
  send_rate_per_sec integer not null default 20 check (send_rate_per_sec between 1 and 1000),
  business_profile jsonb not null default '{}'::jsonb,   -- about, address, description, email, websites, vertical, profile_picture_url
  meta jsonb not null default '{}'::jsonb,               -- raw phone fields, account_update payloads, last sync
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index channels_org_idx on public.channels (org_id, status);
create trigger channels_set_updated_at before update on public.channels for each row execute function app.set_updated_at();

alter table public.channels enable row level security;
create policy channels_select on public.channels for select to authenticated
  using (app.is_org_member(org_id));
-- Writes are server-side only (settings.manage checks, then the service role).

create table public.channel_secrets (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  access_token_enc text not null,                    -- lib/crypto.ts encrypt(); null row = use META_SYSTEM_USER_TOKEN
  updated_at timestamptz not null default now()
);
alter table public.channel_secrets enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- Per-number rate limit: one row per (channel, second). claim_send_slot() is an
-- atomic insert-or-increment that fails once the second is full, so parallel
-- drains never exceed the per-number limit. Rows are swept by housekeeping.
-- ---------------------------------------------------------------------------

create table public.channel_send_slots (
  channel_id uuid not null references public.channels (id) on delete cascade,
  slot timestamptz not null,                         -- truncated to the second
  used integer not null default 0,
  primary key (channel_id, slot)
);

create or replace function public.claim_send_slot(p_channel_id uuid, p_limit integer, p_at timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot timestamptz := date_trunc('second', p_at);
  v_used integer;
begin
  insert into public.channel_send_slots (channel_id, slot, used)
  values (p_channel_id, v_slot, 1)
  on conflict (channel_id, slot) do update
    set used = public.channel_send_slots.used + 1
    where public.channel_send_slots.used < greatest(p_limit, 1)
  returning used into v_used;
  return v_used is not null;
end;
$$;
revoke all on function public.claim_send_slot(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_send_slot(uuid, integer, timestamptz) to service_role;

alter table public.channel_send_slots enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- webhook_events_in: every verified Meta POST is stored raw before anything
-- else happens, then referenced by id from the meta_events queue.
-- ---------------------------------------------------------------------------

create table public.webhook_events_in (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'meta',
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  attempts integer not null default 0
);
create index webhook_events_in_pending_idx on public.webhook_events_in (received_at) where processed_at is null;
create index webhook_events_in_received_idx on public.webhook_events_in (received_at desc);

alter table public.webhook_events_in enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- wa_templates: Meta message templates per WABA (mirrors Meta; Phase 4 builds
-- the editor). Status/category/quality webhooks update rows here.
-- ---------------------------------------------------------------------------

create table public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete set null,
  waba_id text not null,
  meta_template_id text,
  name text not null,
  language text not null,
  category text not null default 'UTILITY',          -- MARKETING | UTILITY | AUTHENTICATION
  status text not null default 'PENDING',            -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL | ...
  type text not null default 'standard' check (type in ('standard', 'media_interactive', 'carousel')),
  components jsonb not null default '[]'::jsonb,     -- Meta components array
  variable_map jsonb not null default '{}'::jsonb,   -- {"body.1": "contact.first_name", ...}
  parameter_format text not null default 'positional' check (parameter_format in ('positional', 'named')),
  retry_on_fail boolean not null default false,
  rejected_reason text,
  quality text,                                      -- GREEN | YELLOW | RED | UNKNOWN
  archived_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, name, language)
);
create index wa_templates_org_idx on public.wa_templates (org_id, status);
create index wa_templates_meta_id_idx on public.wa_templates (meta_template_id) where meta_template_id is not null;
create trigger wa_templates_set_updated_at before update on public.wa_templates for each row execute function app.set_updated_at();

alter table public.wa_templates enable row level security;
create policy wa_templates_select on public.wa_templates for select to authenticated
  using (app.is_org_member(org_id));
create policy wa_templates_insert on public.wa_templates for insert to authenticated
  with check (app.has_perm(org_id, 'templates.manage'));
create policy wa_templates_update on public.wa_templates for update to authenticated
  using (app.has_perm(org_id, 'templates.manage'))
  with check (app.has_perm(org_id, 'templates.manage'));
create policy wa_templates_delete on public.wa_templates for delete to authenticated
  using (app.has_perm(org_id, 'templates.manage'));

-- Housekeeping additions (pg_cron stub in tests is a no-op).
select cron.schedule('pulse:housekeeping_phase3', '25 3 * * *', $$
  delete from public.channel_send_slots where slot < now() - interval '1 hour';
  delete from public.webhook_events_in where processed_at is not null and received_at < now() - interval '30 days';
$$);
