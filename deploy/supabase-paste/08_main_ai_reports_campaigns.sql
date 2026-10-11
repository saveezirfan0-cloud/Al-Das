-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.

-- ======================================================================
-- 20261009001000_ai_kb.sql
-- ======================================================================
-- Phase 10 / 1: AI assist + knowledge base (pgvector).
--
--   kb_groups / kb_sources / kb_chunks   knowledge base (URL + file sources, scoped by group)
--   ai_usage                              one row per AI call: tokens + latency only, NEVER content
--   kb_feedback                           thumbs up/down from the inbox AI panel (no draft text stored)
--
-- Embeddings are 1024-d (Voyage voyage-3 by default). All writes happen server-side after
-- can() checks, through the service role; members with kb.manage / reports.view can read.

create extension if not exists vector with schema public;

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------

create table public.kb_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create trigger kb_groups_set_updated_at before update on public.kb_groups for each row execute function app.set_updated_at();

create table public.kb_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  group_id uuid references public.kb_groups (id) on delete set null,
  kind text not null check (kind in ('url', 'file')),
  name text not null check (length(btrim(name)) between 1 and 200),
  url text,                                          -- kind = url (https only, enforced in lib/ai/ingest/fetch-url.ts)
  storage_path text,                                 -- kind = file: <org_id>/<source_id>/<filename> in the kb-files bucket
  mime_type text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,                                        -- short reason, never document text
  content_hash text,                                 -- sha256 of the extracted text: unchanged content is not re-embedded
  chunk_count integer not null default 0 check (chunk_count >= 0),
  last_ingested_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'url' and url is not null) or (kind = 'file' and storage_path is not null))
);
create index kb_sources_org_idx on public.kb_sources (org_id, status);
create index kb_sources_group_idx on public.kb_sources (group_id);
create trigger kb_sources_set_updated_at before update on public.kb_sources for each row execute function app.set_updated_at();
create trigger kb_sources_group_org_check before insert or update on public.kb_sources
  for each row execute function app.check_parent_org('kb_groups', 'group_id');

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_id uuid not null references public.kb_sources (id) on delete cascade,
  ord integer not null check (ord >= 0),
  content text not null,
  embedding vector(1024) not null,
  created_at timestamptz not null default now(),
  unique (source_id, ord)
);
create index kb_chunks_org_idx on public.kb_chunks (org_id);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);
create trigger kb_chunks_source_org_check before insert or update on public.kb_chunks
  for each row execute function app.check_parent_org('kb_sources', 'source_id');

alter table public.kb_groups enable row level security;
alter table public.kb_sources enable row level security;
alter table public.kb_chunks enable row level security;

create policy kb_groups_select on public.kb_groups for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
create policy kb_sources_select on public.kb_sources for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
create policy kb_chunks_select on public.kb_chunks for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
-- Writes: server actions / the kb_ingest handler, service role only.

-- Similarity search, scoped to one org (and optionally to source groups). Only ready sources match.
-- similarity = 1 - cosine distance. Service role only; callers pass the org from a verified member.
create or replace function public.kb_match(
  p_org_id uuid,
  p_embedding vector(1024),
  p_group_ids uuid[] default null,
  p_limit integer default 5
)
returns table (chunk_id uuid, source_id uuid, source_name text, content text, similarity double precision)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select ch.id, ch.source_id, s.name, ch.content, (1 - (ch.embedding <=> p_embedding))::double precision
  from public.kb_chunks ch
  join public.kb_sources s on s.id = ch.source_id
  where ch.org_id = p_org_id
    and s.org_id = p_org_id
    and s.status = 'ready'
    and (p_group_ids is null or s.group_id = any (p_group_ids))
  order by ch.embedding <=> p_embedding
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;
revoke all on function public.kb_match(uuid, vector, uuid[], integer) from public, anon, authenticated;
grant execute on function public.kb_match(uuid, vector, uuid[], integer) to service_role;

-- Atomically swap a source's chunks (delete + insert in one transaction) and mark it ready.
-- p_chunks: [{"ord":0,"content":"...","embedding":[...1024 floats...]}, ...]
create or replace function public.kb_replace_chunks(
  p_org_id uuid,
  p_source_id uuid,
  p_chunks jsonb,
  p_content_hash text
)
returns integer
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.kb_sources where id = p_source_id and org_id = p_org_id) then
    raise exception 'kb source % not found in org %', p_source_id, p_org_id using errcode = 'no_data_found';
  end if;

  delete from public.kb_chunks where source_id = p_source_id;

  insert into public.kb_chunks (org_id, source_id, ord, content, embedding)
  select p_org_id, p_source_id, (e ->> 'ord')::integer, e ->> 'content', (e ->> 'embedding')::vector(1024)
  from jsonb_array_elements(p_chunks) as e;
  get diagnostics v_count = row_count;

  update public.kb_sources
     set status = 'ready', error = null, content_hash = p_content_hash,
         chunk_count = v_count, last_ingested_at = now()
   where id = p_source_id;
  return v_count;
end;
$$;
revoke all on function public.kb_replace_chunks(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.kb_replace_chunks(uuid, uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- AI usage + feedback. No prompt, draft or conversation text is ever stored here.
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  feature text not null check (feature in ('summarize', 'ask', 'suggest_reply', 'rewrite')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  status text not null default 'ok' check (status in ('ok', 'error', 'refused', 'needs_review')),
  created_at timestamptz not null default now()
);
create index ai_usage_org_idx on public.ai_usage (org_id, created_at desc);
create index ai_usage_user_idx on public.ai_usage (user_id, created_at desc);
create trigger ai_usage_conversation_org_check before insert or update on public.ai_usage
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

create table public.kb_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  ai_usage_id uuid references public.ai_usage (id) on delete set null,
  feature text not null check (feature in ('summarize', 'ask', 'suggest_reply', 'rewrite')),
  positive boolean not null,
  note text check (note is null or length(note) <= 500),
  chunk_ids uuid[] not null default '{}',            -- KB chunks that grounded a suggested reply
  created_at timestamptz not null default now()
);
create index kb_feedback_org_idx on public.kb_feedback (org_id, created_at desc);
create trigger kb_feedback_conversation_org_check before insert or update on public.kb_feedback
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

alter table public.ai_usage enable row level security;
alter table public.kb_feedback enable row level security;

create policy ai_usage_select on public.ai_usage for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'reports.view'));
create policy kb_feedback_select on public.kb_feedback for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'kb.manage') or app.has_perm(org_id, 'reports.view')));
-- Inserts are server-side only (the AI server actions run can() first).

-- ---------------------------------------------------------------------------
-- Storage: private bucket for uploaded KB files (service role only).
-- Paths: <org_id>/<source_id>/<filename>. Guarded so the migration also applies on a plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('kb-files', 'kb-files', false, 20971520)
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- New permissions for existing orgs. New orgs get them from lib/auth/permissions.ts SYSTEM_ROLES.
-- Idempotent: only appends a key a system role does not already hold.
-- ---------------------------------------------------------------------------

update public.roles r
   set permissions = r.permissions || to_jsonb(p.perm)
  from (values
    ('Manager', 'reports.export'), ('Manager', 'ai.use'), ('Manager', 'kb.manage'),
    ('Agent', 'ai.use'), ('Receptionist', 'ai.use')
  ) as p (role_name, perm)
 where r.is_system
   and r.name = p.role_name
   and not (r.permissions ? p.perm);

-- ======================================================================
-- 20261009001100_api_webhooks.sql
-- ======================================================================
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

-- ======================================================================
-- 20261009001200_metrics.sql
-- ======================================================================
-- Phase 10 / 3: metrics layer for dashboards and reports.
--
-- Built only from tables that exist today (conversations, messages, memberships). Reports for
-- enquiries, appointments, campaigns and Unite are added with their phases; the report registry
-- (lib/reports/registry.ts) checks public.report_sources_available() to decide what is "live".
--
-- Metric definitions (documented in docs/audit/reports.md; OQ-44, the data requirements matrix, is
-- still missing, so these are working definitions):
--   first response     first outbound message sent by a *staff member* (sent_by_user_id is set; bots and
--                      flows excluded) at or after the first inbound message of the conversation
--   resolution time    closed_at - opened_at
--   returning contact  the contact had an earlier conversation than this one
--   days               bucketed in the org's timezone (orgs.timezone)
--
-- Materialized views are NOT covered by RLS. They are revoked from anon/authenticated and read only
-- by lib/reports through the service role, after can('reports.view') and always filtered by org_id.

-- ---------------------------------------------------------------------------
-- Materialized views (refreshed concurrently by pg_cron every 15 minutes)
-- ---------------------------------------------------------------------------

create materialized view public.mv_conversation_facts as
with m as (
  select conversation_id,
         min(at) filter (where direction = 'in') as first_inbound_at,
         count(*) filter (where direction = 'in') as inbound_count,
         count(*) filter (where direction = 'out') as outbound_count
  from public.messages
  group by conversation_id
)
select c.id as conversation_id,
       c.org_id,
       c.channel_id,
       c.contact_id,
       c.assignee_user_id,
       c.assignee_team_id,
       c.status,
       c.opened_at,
       c.closed_at,
       c.closed_by,
       (c.opened_at at time zone o.timezone)::date as opened_day,
       m.first_inbound_at,
       fr.first_response_at,
       fr.first_response_by,
       case when fr.first_response_at is not null and m.first_inbound_at is not null
            then extract(epoch from fr.first_response_at - m.first_inbound_at)::integer end as first_response_seconds,
       case when c.closed_at is not null
            then extract(epoch from c.closed_at - c.opened_at)::integer end as resolution_seconds,
       coalesce(m.inbound_count, 0)::integer as inbound_count,
       coalesce(m.outbound_count, 0)::integer as outbound_count,
       exists (
         select 1 from public.conversations p
         where p.contact_id = c.contact_id and p.opened_at < c.opened_at
       ) as is_returning
from public.conversations c
join public.orgs o on o.id = c.org_id
left join m on m.conversation_id = c.id
left join lateral (
  select x.at as first_response_at, x.sent_by_user_id as first_response_by
  from public.messages x
  where x.conversation_id = c.id
    and x.direction = 'out'
    and x.sent_by_user_id is not null
    and x.at >= coalesce(m.first_inbound_at, c.opened_at)
  order by x.at
  limit 1
) fr on true;
create unique index mv_conversation_facts_pk on public.mv_conversation_facts (conversation_id);
create index mv_conversation_facts_org_day_idx on public.mv_conversation_facts (org_id, opened_day);

create materialized view public.mv_daily_conversations as
with opened as (
  select org_id, opened_day as day, channel_id,
         count(*) as opened,
         count(distinct contact_id) as unique_contacts,
         count(distinct contact_id) filter (where is_returning) as returning_contacts
  from public.mv_conversation_facts
  group by org_id, opened_day, channel_id
),
closed as (
  select f.org_id, (f.closed_at at time zone o.timezone)::date as day, f.channel_id, count(*) as closed
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.closed_at is not null
  group by f.org_id, (f.closed_at at time zone o.timezone)::date, f.channel_id
),
msgs as (
  select m.org_id, (m.at at time zone o.timezone)::date as day, c.channel_id,
         count(*) filter (where m.direction = 'in') as inbound_messages,
         count(*) filter (where m.direction = 'out') as outbound_messages
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
  join public.orgs o on o.id = m.org_id
  group by m.org_id, (m.at at time zone o.timezone)::date, c.channel_id
)
select org_id, day, channel_id,
       coalesce(opened.opened, 0)::integer as opened,
       coalesce(closed.closed, 0)::integer as closed,
       coalesce(opened.unique_contacts, 0)::integer as unique_contacts,
       coalesce(opened.returning_contacts, 0)::integer as returning_contacts,
       coalesce(msgs.inbound_messages, 0)::integer as inbound_messages,
       coalesce(msgs.outbound_messages, 0)::integer as outbound_messages
from opened
full join closed using (org_id, day, channel_id)
full join msgs using (org_id, day, channel_id);
create unique index mv_daily_conversations_pk on public.mv_daily_conversations (org_id, day, channel_id);

-- Hour x weekday heatmap source: the report sums over the chosen period and groups by dow/hour.
create materialized view public.mv_hourly_conversations as
select m.org_id,
       (m.at at time zone o.timezone)::date as day,
       extract(hour from m.at at time zone o.timezone)::integer as hour,
       c.channel_id,
       count(*) filter (where m.direction = 'in')::integer as inbound_messages,
       count(*) filter (where m.direction = 'out')::integer as outbound_messages
from public.messages m
join public.conversations c on c.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction in ('in', 'out')
group by m.org_id, (m.at at time zone o.timezone)::date, extract(hour from m.at at time zone o.timezone)::integer, c.channel_id;
create unique index mv_hourly_conversations_pk on public.mv_hourly_conversations (org_id, day, hour, channel_id);

-- Per staff member per day. Sums + counts (not medians) so any period can be re-aggregated exactly.
create materialized view public.mv_agent_performance as
with sent as (
  select m.org_id, (m.at at time zone o.timezone)::date as day, m.sent_by_user_id as user_id,
         count(*) as messages_sent,
         count(distinct m.conversation_id) as conversations_handled
  from public.messages m
  join public.orgs o on o.id = m.org_id
  where m.direction = 'out' and m.sent_by_user_id is not null
  group by m.org_id, (m.at at time zone o.timezone)::date, m.sent_by_user_id
),
fr as (
  select f.org_id, (f.first_response_at at time zone o.timezone)::date as day, f.first_response_by as user_id,
         count(f.first_response_seconds) as first_response_count,
         coalesce(sum(f.first_response_seconds), 0) as first_response_seconds_sum
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.first_response_by is not null
  group by f.org_id, (f.first_response_at at time zone o.timezone)::date, f.first_response_by
),
cl as (
  select f.org_id, (f.closed_at at time zone o.timezone)::date as day, f.closed_by as user_id,
         count(*) as conversations_closed,
         coalesce(sum(f.resolution_seconds), 0) as resolution_seconds_sum
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.closed_at is not null and f.closed_by is not null
  group by f.org_id, (f.closed_at at time zone o.timezone)::date, f.closed_by
)
select org_id, day, user_id,
       coalesce(sent.messages_sent, 0)::integer as messages_sent,
       coalesce(sent.conversations_handled, 0)::integer as conversations_handled,
       coalesce(fr.first_response_count, 0)::integer as first_response_count,
       coalesce(fr.first_response_seconds_sum, 0)::bigint as first_response_seconds_sum,
       coalesce(cl.conversations_closed, 0)::integer as conversations_closed,
       coalesce(cl.resolution_seconds_sum, 0)::bigint as resolution_seconds_sum
from sent
full join fr using (org_id, day, user_id)
full join cl using (org_id, day, user_id);
create unique index mv_agent_performance_pk on public.mv_agent_performance (org_id, day, user_id);

-- Outbound usage by day / number / template vs free-form / delivery status.
-- Cost is NOT here: it needs Meta pricing_analytics ingestion (a later task).
create materialized view public.mv_message_usage_daily as
select m.org_id,
       (m.at at time zone o.timezone)::date as day,
       c.channel_id,
       case when m.kind = 'template' then 'template' else 'free_form' end as category,
       m.status,
       count(*)::integer as messages
from public.messages m
join public.conversations c on c.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction = 'out'
group by m.org_id, (m.at at time zone o.timezone)::date, c.channel_id,
         case when m.kind = 'template' then 'template' else 'free_form' end, m.status;
create unique index mv_message_usage_daily_pk on public.mv_message_usage_daily (org_id, day, channel_id, category, status);

-- ---------------------------------------------------------------------------
-- Live views for the team-lead dashboard (security_invoker: the caller's RLS still applies)
-- ---------------------------------------------------------------------------

create view public.v_team_queue_now with (security_invoker = true) as
select org_id,
       assignee_team_id,
       count(*) filter (where status = 'open')::integer as open_count,
       count(*) filter (where status = 'waiting')::integer as waiting_count,
       count(*) filter (where assignee_user_id is null)::integer as unassigned_count,
       count(*) filter (where unread_count > 0)::integer as unread_count
from public.conversations
where status <> 'closed'
group by org_id, assignee_team_id;

create view public.v_agent_workload_now with (security_invoker = true) as
select m.org_id,
       m.user_id,
       m.presence,
       m.presence_at,
       count(c.id) filter (where c.status <> 'closed')::integer as open_conversations,
       count(c.id) filter (where c.status <> 'closed' and c.unread_count > 0)::integer as unread_conversations
from public.memberships m
left join public.conversations c on c.org_id = m.org_id and c.assignee_user_id = m.user_id
where m.status = 'active'
group by m.org_id, m.user_id, m.presence, m.presence_at;

-- Conversations where the patient wrote last and staff have not replied within the SLA.
-- Threshold: orgs.settings->'reports'->>'sla_minutes' (default 15).
create view public.v_sla_breaches_now with (security_invoker = true) as
select c.org_id,
       c.id as conversation_id,
       c.assignee_user_id,
       c.assignee_team_id,
       c.last_inbound_at,
       extract(epoch from now() - c.last_inbound_at)::integer / 60 as waiting_minutes
from public.conversations c
join public.orgs o on o.id = c.org_id
where c.status <> 'closed'
  and c.last_message_direction = 'in'
  and c.last_inbound_at is not null
  and c.last_inbound_at < now() - make_interval(mins => coalesce((o.settings -> 'reports' ->> 'sla_minutes')::integer, 15));

-- ---------------------------------------------------------------------------
-- Access: service role only for the materialized views; views are service role + RLS.
-- ---------------------------------------------------------------------------

revoke all on public.mv_conversation_facts, public.mv_daily_conversations, public.mv_hourly_conversations,
              public.mv_agent_performance, public.mv_message_usage_daily
  from public, anon, authenticated;
grant select on public.mv_conversation_facts, public.mv_daily_conversations, public.mv_hourly_conversations,
                public.mv_agent_performance, public.mv_message_usage_daily
  to service_role;

revoke all on public.v_team_queue_now, public.v_agent_workload_now, public.v_sla_breaches_now from public, anon;
grant select on public.v_team_queue_now, public.v_agent_workload_now, public.v_sla_breaches_now to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Refresh + discovery
-- ---------------------------------------------------------------------------

-- Refresh one view, or all in dependency order. Concurrent, so dashboards keep reading during a refresh.
create or replace function public.refresh_metrics(p_name text default null)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_all text[] := array[
    'mv_conversation_facts', 'mv_daily_conversations', 'mv_hourly_conversations',
    'mv_agent_performance', 'mv_message_usage_daily'
  ];
  v_name text;
  v_done text[] := '{}';
begin
  if p_name is not null and not (p_name = any (v_all)) then
    raise exception 'unknown metrics view %', p_name using errcode = 'invalid_parameter_value';
  end if;
  foreach v_name in array v_all loop
    if p_name is null or p_name = v_name then
      execute format('refresh materialized view concurrently public.%I', v_name);
      v_done := v_done || v_name;
    end if;
  end loop;
  return v_done;
end;
$$;
revoke all on function public.refresh_metrics(text) from public, anon, authenticated;
grant execute on function public.refresh_metrics(text) to service_role;

-- Which report data sources exist right now (views / materialized views named v_* or mv_*).
-- The report registry marks a report "awaiting Phase N" until its sources appear here.
create or replace function public.report_sources_available()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(c.relname::text order by c.relname), '{}')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and (c.relname like 'mv\_%' or c.relname like 'v\_%');
$$;
revoke all on function public.report_sources_available() from public, anon, authenticated;
grant execute on function public.report_sources_available() to service_role;

-- The refresh runs through the app's task route so it lands in job_runs.
select cron.schedule('pulse:metrics_refresh', '*/15 * * * *', $$select app.ping_jobs('metrics_refresh')$$);

-- ======================================================================
-- 20261009001300_report_functions.sql
-- ======================================================================
-- Phase 10 / 4: report query functions over the metrics views.
--
-- Each function aggregates in SQL and returns a bounded result (<= a few hundred rows), because
-- PostgREST caps every response at max-rows (1000 on Supabase) and the hourly view alone can exceed
-- that over a year. Service role only: lib/reports calls them after can('reports.view') with the
-- caller's org. Filters are optional arrays; null or empty means "no filter".
--
-- Filter applicability (documented in docs/audit/reports.md):
--   channels  conversation, message and usage numbers
--   teams     conversation-level numbers (assignee_team_id) and the agent report (team members)
--   users     the agent report
-- Message volume per day comes from mv_daily_conversations, which has no team dimension.

-- Conversation-level headline numbers for the period (by the day the conversation opened).
create or replace function public.report_conversations_summary(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  conversations integer, closed integer, still_open integer,
  unique_contacts integer, returning_contacts integer,
  inbound_messages integer, outbound_messages integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where status = 'closed')::integer,
         count(*) filter (where status <> 'closed')::integer,
         count(distinct contact_id)::integer,
         count(distinct contact_id) filter (where is_returning)::integer,
         coalesce(sum(inbound_count), 0)::integer,
         coalesce(sum(outbound_count), 0)::integer
  from public.mv_conversation_facts
  where org_id = p_org
    and opened_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams));
$$;

-- One row per day: conversations opened/closed (team-filterable) and message volume (channel-filterable only).
create or replace function public.report_conversations_by_day(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (day date, opened integer, closed integer, inbound_messages integer, outbound_messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  opened as (
    select opened_day as day, count(*)::integer as n
    from public.mv_conversation_facts
    where org_id = p_org and opened_day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams))
    group by opened_day
  ),
  closed as (
    select (f.closed_at at time zone o.timezone)::date as day, count(*)::integer as n
    from public.mv_conversation_facts f
    join public.orgs o on o.id = f.org_id
    where f.org_id = p_org and f.closed_at is not null
      and (f.closed_at at time zone o.timezone)::date between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or f.assignee_team_id = any (p_teams))
    group by 1
  ),
  msgs as (
    select day, sum(inbound_messages)::integer as i, sum(outbound_messages)::integer as o
    from public.mv_daily_conversations
    where org_id = p_org and day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    group by day
  )
  select days.day, coalesce(opened.n, 0), coalesce(closed.n, 0), coalesce(msgs.i, 0), coalesce(msgs.o, 0)
  from days
  left join opened on opened.day = days.day
  left join closed on closed.day = days.day
  left join msgs on msgs.day = days.day
  order by days.day;
$$;

create or replace function public.report_conversations_by_channel(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (channel_id uuid, channel_name text, conversations integer)
language sql stable
set search_path = public, pg_temp
as $$
  select f.channel_id, ch.name, count(*)::integer
  from public.mv_conversation_facts f
  join public.channels ch on ch.id = f.channel_id
  where f.org_id = p_org and f.opened_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or f.assignee_team_id = any (p_teams))
  group by f.channel_id, ch.name
  order by count(*) desc, ch.name
  limit 50;
$$;

-- Inbound messages by weekday (0 = Sunday) and hour, in the org's timezone. At most 168 rows.
create or replace function public.report_heatmap(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (dow integer, hour integer, inbound_messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  select extract(dow from day)::integer, hour, sum(inbound_messages)::integer
  from public.mv_hourly_conversations
  where org_id = p_org and day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
  group by 1, 2
  having sum(inbound_messages) > 0
  order by 1, 2;
$$;

-- First-response and resolution times for conversations opened in the period.
create or replace function public.report_response_summary(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  conversations integer, answered integer, unanswered integer,
  fr_avg_seconds numeric, fr_median_seconds numeric, fr_p90_seconds numeric,
  within_5m integer, within_15m integer, within_1h integer, within_4h integer, over_4h integer,
  resolved integer, res_avg_seconds numeric, res_median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.mv_conversation_facts
    where org_id = p_org and opened_day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams))
  )
  select count(*)::integer,
         count(first_response_seconds)::integer,
         count(*) filter (where first_inbound_at is not null and first_response_at is null)::integer,
         round(avg(first_response_seconds)),
         round((percentile_cont(0.5) within group (order by first_response_seconds))::numeric),
         round((percentile_cont(0.9) within group (order by first_response_seconds))::numeric),
         count(*) filter (where first_response_seconds < 300)::integer,
         count(*) filter (where first_response_seconds >= 300 and first_response_seconds < 900)::integer,
         count(*) filter (where first_response_seconds >= 900 and first_response_seconds < 3600)::integer,
         count(*) filter (where first_response_seconds >= 3600 and first_response_seconds < 14400)::integer,
         count(*) filter (where first_response_seconds >= 14400)::integer,
         count(resolution_seconds)::integer,
         round(avg(resolution_seconds)),
         round((percentile_cont(0.5) within group (order by resolution_seconds))::numeric)
  from f;
$$;

-- Per staff member over the period. Sums and counts are re-aggregated from daily rows, so averages are exact.
create or replace function public.report_agents(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  user_id uuid, name text, messages_sent integer, first_responses integer,
  avg_first_response_seconds numeric, conversations_closed integer, avg_resolution_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  select a.user_id,
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         sum(a.messages_sent)::integer,
         sum(a.first_response_count)::integer,
         case when sum(a.first_response_count) > 0
              then round(sum(a.first_response_seconds_sum)::numeric / sum(a.first_response_count)) end,
         sum(a.conversations_closed)::integer,
         case when sum(a.conversations_closed) > 0
              then round(sum(a.resolution_seconds_sum)::numeric / sum(a.conversations_closed)) end
  from public.mv_agent_performance a
  left join public.profiles p on p.id = a.user_id
  where a.org_id = p_org
    and a.day between p_from and p_to
    and (p_users is null or cardinality(p_users) = 0 or a.user_id = any (p_users))
    and (p_teams is null or cardinality(p_teams) = 0 or a.user_id in (
      select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)
    ))
  group by a.user_id, p.first_name, p.last_name
  order by sum(a.messages_sent) desc, 2
  limit 200;
$$;

-- Outbound messages per day: template vs free-form, and how many failed.
create or replace function public.report_usage_by_day(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (day date, template integer, free_form integer, failed integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  u as (
    select day,
           sum(messages) filter (where category = 'template')::integer as template,
           sum(messages) filter (where category = 'free_form')::integer as free_form,
           sum(messages) filter (where status = 'failed')::integer as failed
    from public.mv_message_usage_daily
    where org_id = p_org and day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    group by day
  )
  select days.day, coalesce(u.template, 0), coalesce(u.free_form, 0), coalesce(u.failed, 0)
  from days left join u on u.day = days.day
  order by days.day;
$$;

-- Outbound messages by delivery status and category for the period (<= 14 rows).
create or replace function public.report_usage_totals(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (category text, status text, messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  select category, status, sum(messages)::integer
  from public.mv_message_usage_daily
  where org_id = p_org and day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
  group by category, status
  order by category, status;
$$;

do $$
declare
  f text;
begin
  for f in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'report\_%' and p.proname <> 'report_sources_available'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ======================================================================
-- 20261009001400_appointment_reports.sql
-- ======================================================================
-- Phase 10 follow-up: appointment reports, now that Phase 6 tables exist.
--
-- One live view (security_invoker, revoked from API roles) gives the reports a stable contract;
-- the report_* functions aggregate in SQL and are service-role only, like the others in
-- 20261009001300_report_functions.sql. Appointments are bucketed by the day they take place
-- (starts_at in the org timezone), not the day they were created.
--
-- Definitions (docs/audit/reports.md §5):
--   no-show rate   no_show / (completed + no_show): of the appointments that reached an outcome,
--                  how many the patient missed. Awaiting/confirmed/cancelled are not in the base.
--   Unite status   appointments.status is whatever unite_appointment_status_map says; a Unite code
--                  whose mapping is still empty leaves status 'awaiting' (OQ-23), so the Unite report also lists
--                  the raw codes and how they currently map.

create view public.v_appointment_facts
with (security_invoker = true) as
select a.id,
       a.org_id,
       (a.starts_at at time zone o.timezone)::date as day,
       a.status,
       a.source,
       a.location_id,
       l.name as location_name,
       a.specialist_id,
       sp.name as specialist_name,
       a.external_status
from public.appointments a
join public.orgs o on o.id = a.org_id
left join public.locations l on l.id = a.location_id
left join public.specialists sp on sp.id = a.specialist_id;

revoke all on public.v_appointment_facts from public, anon, authenticated;
grant select on public.v_appointment_facts to service_role;

create or replace function public.report_appointments_summary(p_org uuid, p_from date, p_to date)
returns table (total integer, awaiting integer, confirmed integer, cancelled integer, completed integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where status = 'awaiting')::integer,
         count(*) filter (where status = 'confirmed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to;
$$;

create or replace function public.report_appointments_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, awaiting integer, confirmed integer, cancelled integer, completed integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  agg as (
    select day,
           count(*) filter (where status = 'awaiting')::integer as awaiting,
           count(*) filter (where status = 'confirmed')::integer as confirmed,
           count(*) filter (where status = 'cancelled')::integer as cancelled,
           count(*) filter (where status = 'completed')::integer as completed,
           count(*) filter (where status = 'no_show')::integer as no_show
    from public.v_appointment_facts
    where org_id = p_org and day between p_from and p_to
    group by day
  )
  select days.day, coalesce(agg.awaiting, 0), coalesce(agg.confirmed, 0), coalesce(agg.cancelled, 0),
         coalesce(agg.completed, 0), coalesce(agg.no_show, 0)
  from days left join agg on agg.day = days.day
  order by days.day;
$$;

create or replace function public.report_appointments_by_location(p_org uuid, p_from date, p_to date)
returns table (location_id uuid, location_name text, total integer, completed integer, cancelled integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select location_id, coalesce(location_name, 'No location'), count(*)::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to
  group by location_id, location_name
  order by count(*) desc, 2
  limit 100;
$$;

create or replace function public.report_appointments_by_specialist(p_org uuid, p_from date, p_to date)
returns table (specialist_id uuid, specialist_name text, total integer, completed integer, cancelled integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select specialist_id, coalesce(specialist_name, 'No specialist'), count(*)::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to
  group by specialist_id, specialist_name
  order by count(*) desc, 2
  limit 100;
$$;

-- Appointments that came from Unite, per day.
create or replace function public.report_unite_appointments_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, appointments integer, unmapped integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  agg as (
    select f.day, count(*)::integer as n,
           count(*) filter (where f.external_status is not null and m.status is null)::integer as unmapped
    from public.v_appointment_facts f
    left join public.unite_appointment_status_map m on m.org_id = f.org_id and m.code = upper(f.external_status)
    where f.org_id = p_org and f.source = 'unite' and f.day between p_from and p_to
    group by f.day
  )
  select days.day, coalesce(agg.n, 0), coalesce(agg.unmapped, 0)
  from days left join agg on agg.day = days.day
  order by days.day;
$$;

-- Raw Unite status codes in the period and what each currently maps to (null = meaning not confirmed yet, OQ-23).
create or replace function public.report_unite_status_codes(p_org uuid, p_from date, p_to date)
returns table (code text, mapped_status text, appointments integer)
language sql stable
set search_path = public, pg_temp
as $$
  select f.external_status, m.status, count(*)::integer
  from public.v_appointment_facts f
  left join public.unite_appointment_status_map m on m.org_id = f.org_id and m.code = upper(f.external_status)
  where f.org_id = p_org and f.source = 'unite' and f.day between p_from and p_to and f.external_status is not null
  group by f.external_status, m.status
  order by count(*) desc, 1
  limit 50;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'report_appointments_summary', 'report_appointments_by_day', 'report_appointments_by_location',
    'report_appointments_by_specialist', 'report_unite_appointments_by_day', 'report_unite_status_codes'
  ] loop
    execute format('revoke all on function public.%I(uuid, date, date) from public, anon, authenticated', fn);
    execute format('grant execute on function public.%I(uuid, date, date) to service_role', fn);
  end loop;
end $$;

-- ======================================================================
-- 20261010000100_campaigns.sql
-- ======================================================================
-- Phase 7: campaigns (template broadcasts) — campaigns, recipients, funnel sync,
-- reply tracking, batched dispatch and the campaign_tick cron.
--
-- Flow: the app snapshots the audience into campaign_recipients (pending / skipped),
-- the campaign_fanout handler resolves variables and calls campaign_dispatch() in
-- batches (conversation + queued message + recipient update, one transaction), the
-- outbound queue sends, status webhooks move messages forward, and a trigger mirrors
-- each message's status onto its recipient so the funnel is always consistent.

-- Campaign sends land in a conversation but must not flood the inbox: such a
-- conversation stays hidden until the patient replies (or an agent opens it).
alter table public.conversations add column campaign_only boolean not null default false;

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  channel_id uuid not null references public.channels (id) on delete restrict,
  template_id uuid not null references public.wa_templates (id) on delete restrict,
  audience_type text not null check (audience_type in ('segment', 'csv')),
  segment_id uuid references public.segments (id) on delete set null,
  csv_opt_in_confirmed boolean not null default false,   -- creator confirmed consent for CSV rows created by this campaign
  variable_map jsonb not null default '{}'::jsonb,       -- {"body.1": "contact.first_name", "header.media": "text:https://…"}
  fallbacks jsonb not null default '{}'::jsonb,          -- {"body.1": "there"} used when the mapped value is blank
  status text not null default 'preparing' check (status in (
    'preparing', 'scheduled', 'queued', 'sending', 'paused', 'completed', 'cancelled', 'failed'
  )),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  paused_reason text,
  cancelled_at timestamptz,
  retry_rounds integer not null default 0 check (retry_rounds between 0 and 3),
  retry_delay_minutes integer not null default 60 check (retry_delay_minutes between 5 and 1440),
  retry_round integer not null default 0 check (retry_round between 0 and 3),
  next_retry_at timestamptz,
  guardrails jsonb not null default '{}'::jsonb,         -- {max_failure_pct, min_sample, pause_on_red_quality}
  guard_since timestamptz,                               -- guardrails only count outcomes after this (start / last resume)
  quality_at_start text,
  stats jsonb not null default '{}'::jsonb,              -- funnel snapshot, refreshed by the stats op
  stats_refreshed_at timestamptz,
  error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((audience_type = 'segment') or segment_id is null)
);
create index campaigns_org_created_idx on public.campaigns (org_id, created_at desc);
create index campaigns_org_status_idx on public.campaigns (org_id, status);
create index campaigns_active_idx on public.campaigns (status) where status in ('scheduled', 'queued', 'sending', 'paused');
create trigger campaigns_set_updated_at before update on public.campaigns for each row execute function app.set_updated_at();
create trigger campaigns_channel_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger campaigns_template_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('wa_templates', 'template_id');
create trigger campaigns_segment_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('segments', 'segment_id');

-- ---------------------------------------------------------------------------
-- campaign_recipients: the audience snapshot and the per-recipient state machine.
--   pending → queued → sent → delivered → read      failed (terminal, unless a retry round re-queues it)
--   pending → skipped (opted out, no destination, missing variable, …)
-- ---------------------------------------------------------------------------

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'pending' check (status in (
    'pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'
  )),
  skip_reason text,
  csv_data jsonb not null default '{}'::jsonb,           -- extra CSV columns, usable as csv.<column> variables
  vars jsonb not null default '{}'::jsonb,               -- resolved template values of the last dispatch
  round integer not null default 0,
  attempts integer not null default 0,
  message_id uuid references public.messages (id) on delete set null,   -- the latest message for this recipient
  wa_message_id text,
  error_code integer,
  error_message text,
  dispatched_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_recipients_status_idx on public.campaign_recipients (campaign_id, status, created_at, id);
create index campaign_recipients_contact_idx on public.campaign_recipients (contact_id, created_at desc);
create index campaign_recipients_message_idx on public.campaign_recipients (message_id) where message_id is not null;
create index campaign_recipients_dispatched_idx on public.campaign_recipients (campaign_id, dispatched_at) where dispatched_at is not null;
create trigger campaign_recipients_set_updated_at before update on public.campaign_recipients for each row execute function app.set_updated_at();
create trigger campaign_recipients_campaign_org_check before insert or update on public.campaign_recipients
  for each row execute function app.check_parent_org('campaigns', 'campaign_id');
create trigger campaign_recipients_contact_org_check before insert or update on public.campaign_recipients
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.messages
  add constraint messages_campaign_recipient_id_fkey
  foreign key (campaign_recipient_id) references public.campaign_recipients (id) on delete set null;
create index messages_campaign_recipient_idx on public.messages (campaign_recipient_id) where campaign_recipient_id is not null;

-- ---------------------------------------------------------------------------
-- Message status → recipient status (forward only, latest message only).
-- ---------------------------------------------------------------------------

create or replace function app.sync_campaign_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.campaign_recipient_id is null or new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'sent' then
    update public.campaign_recipients r
    set status = 'sent', sent_at = coalesce(r.sent_at, now()), wa_message_id = new.wa_message_id,
        error_code = null, error_message = null, failed_at = null
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued');
  elsif new.status = 'delivered' then
    update public.campaign_recipients r
    set status = 'delivered', sent_at = coalesce(r.sent_at, now()), delivered_at = coalesce(r.delivered_at, now()),
        wa_message_id = coalesce(new.wa_message_id, r.wa_message_id)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued', 'sent');
  elsif new.status = 'read' then
    update public.campaign_recipients r
    set status = 'read', sent_at = coalesce(r.sent_at, now()), delivered_at = coalesce(r.delivered_at, now()),
        read_at = coalesce(r.read_at, now()), wa_message_id = coalesce(new.wa_message_id, r.wa_message_id)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued', 'sent', 'delivered');
  elsif new.status = 'failed' then
    update public.campaign_recipients r
    set status = 'failed', failed_at = now(), error_code = new.error_code, error_message = left(new.error_message, 500)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status not in ('read', 'skipped', 'failed');
  end if;
  return new;
end;
$$;
create trigger messages_sync_campaign_recipient after update of status on public.messages
  for each row execute function app.sync_campaign_recipient();

-- A patient message within 7 days of a campaign message in the same conversation
-- counts as a reply to the most recent campaign message (reactions do not count).
create or replace function app.mark_campaign_replied()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  if new.direction <> 'in' or new.kind = 'reaction' then
    return new;
  end if;
  select m.campaign_recipient_id into v_recipient
  from public.messages m
  where m.conversation_id = new.conversation_id
    and m.direction = 'out'
    and m.campaign_recipient_id is not null
    and m.at <= new.at
    and m.at >= new.at - interval '7 days'
  order by m.at desc
  limit 1;
  if v_recipient is not null then
    update public.campaign_recipients set replied_at = new.at where id = v_recipient and replied_at is null;
  end if;
  return new;
end;
$$;
create trigger messages_mark_campaign_replied after insert on public.messages
  for each row when (new.direction = 'in') execute function app.mark_campaign_replied();

-- ---------------------------------------------------------------------------
-- Batched dispatch. One call handles up to a few hundred recipients:
-- for each still-pending recipient (row-locked, SKIP LOCKED so two workers never
-- double-dispatch) it either marks it skipped, or finds/creates the live
-- conversation, inserts the queued template message and moves the recipient to
-- 'queued'. The caller then pushes the returned message ids to the outbound queue.
--   p_items: [{recipient_id, skip?} | {recipient_id, body, spec, vars}]
-- ---------------------------------------------------------------------------

create or replace function public.campaign_dispatch(p_campaign_id uuid, p_items jsonb)
returns table (recipient_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns;
  item jsonb;
  r public.campaign_recipients;
  v_conv uuid;
  v_msg uuid;
begin
  select * into c from public.campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into r from public.campaign_recipients cr
    where cr.id = (item ->> 'recipient_id')::uuid and cr.campaign_id = p_campaign_id and cr.status = 'pending'
    for update skip locked;
    if r.id is null then
      continue;
    end if;
    if item ->> 'skip' is not null then
      update public.campaign_recipients set status = 'skipped', skip_reason = left(item ->> 'skip', 200) where id = r.id;
      continue;
    end if;

    select id into v_conv from public.conversations
    where channel_id = c.channel_id and contact_id = r.contact_id and status <> 'closed';
    if v_conv is null then
      insert into public.conversations (org_id, channel_id, contact_id, status, campaign_only, opened_at)
      values (c.org_id, c.channel_id, r.contact_id, 'waiting', true, now())
      on conflict (channel_id, contact_id) where status <> 'closed' do nothing
      returning id into v_conv;
      if v_conv is null then
        select id into v_conv from public.conversations
        where channel_id = c.channel_id and contact_id = r.contact_id and status <> 'closed';
      end if;
    end if;

    insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, campaign_recipient_id, at)
    values (c.org_id, v_conv, 'out', 'template', item ->> 'body', jsonb_build_object('send', item -> 'spec'), 'queued', r.id, now())
    returning id into v_msg;

    update public.conversations
    set last_message_at = now(), last_message_preview = left(coalesce(item ->> 'body', ''), 140), last_message_direction = 'out'
    where id = v_conv;

    update public.campaign_recipients
    set status = 'queued', vars = coalesce(item -> 'vars', '{}'::jsonb), attempts = attempts + 1,
        dispatched_at = now(), message_id = v_msg, round = c.retry_round,
        error_code = null, error_message = null, failed_at = null, skip_reason = null
    where id = r.id;

    recipient_id := r.id;
    message_id := v_msg;
    return next;
  end loop;
end;
$$;
revoke all on function public.campaign_dispatch(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.campaign_dispatch(uuid, jsonb) to service_role;

-- Re-queue failed recipients whose error code is retryable (round bump done by the caller).
create or replace function public.campaign_requeue_failed(p_campaign_id uuid, p_codes integer[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.campaign_recipients
  set status = 'pending', error_message = null
  where campaign_id = p_campaign_id and status = 'failed' and error_code = any (p_codes);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.campaign_requeue_failed(uuid, integer[]) from public, anon, authenticated;
grant execute on function public.campaign_requeue_failed(uuid, integer[]) to service_role;

-- Funnel counters. sent/delivered/read are cumulative (a read message was also delivered and sent).
create or replace function public.campaign_funnel(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*),
    'eligible', count(*) filter (where status <> 'skipped'),
    'pending', count(*) filter (where status = 'pending'),
    'queued', count(*) filter (where status = 'queued'),
    'sent', count(*) filter (where status in ('sent', 'delivered', 'read')),
    'delivered', count(*) filter (where status in ('delivered', 'read')),
    'read', count(*) filter (where status = 'read'),
    'replied', count(*) filter (where replied_at is not null),
    'failed', count(*) filter (where status = 'failed'),
    'skipped', count(*) filter (where status = 'skipped')
  )
  from public.campaign_recipients
  where campaign_id = p_campaign_id;
$$;
revoke all on function public.campaign_funnel(uuid) from public, anon, authenticated;
grant execute on function public.campaign_funnel(uuid) to service_role;

-- Batched enqueue (pgmq.send_batch) for the fanout handler.
create or replace function public.job_enqueue_batch(p_queue text, p_payloads jsonb[], p_delay integer default 0)
returns bigint[]
language sql
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x), '{}'::bigint[])
  from pgmq.send_batch(p_queue, p_payloads, greatest(coalesce(p_delay, 0), 0)) as x;
$$;
revoke all on function public.job_enqueue_batch(text, jsonb[], integer) from public, anon, authenticated;
grant execute on function public.job_enqueue_batch(text, jsonb[], integer) to service_role;

-- ---------------------------------------------------------------------------
-- Audience snapshots. Mirrors lib/campaigns/recipients.ts classifyRecipient()
-- (a DB test keeps the two in step): MARKETING templates need an explicit opt-in
-- and no stop_marketing; every audience needs a phone or a BSUID.
-- ---------------------------------------------------------------------------

create or replace function app.campaign_skip_reason(
  p_deleted_at timestamptz, p_phone text, p_bsuid text, p_opt_in boolean, p_stop boolean, p_marketing boolean
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_deleted_at is not null then 'deleted'
    when p_phone is null and p_bsuid is null then 'no_destination'
    when p_marketing and coalesce(p_stop, false) then 'stop_marketing'
    when p_marketing and p_opt_in is not true then 'no_opt_in'
    else null
  end;
$$;

-- Segment audience: p_where/p_params come from the lib/filters compiler (parameterised,
-- same contract as contacts_ids). Dry run only counts. Returns {total, eligible, skipped:{reason:n}}.
create or replace function public.campaign_snapshot_segment(
  p_org_id uuid, p_campaign_id uuid, p_where text, p_params jsonb, p_marketing boolean,
  p_limit integer, p_dry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  if not p_dry and not exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id) then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  execute format($q$
    with src as (
      select c.id,
             app.campaign_skip_reason(c.deleted_at, c.phone_e164, c.wa_bsuid, c.promotions_opt_in, c.stop_marketing, $3) as reason
      from public.contacts c
      where c.org_id = $2 and c.deleted_at is null and (%s)
      order by c.created_at, c.id
      limit $4
    ), ins as (
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, skip_reason)
      select $2, $5, id, case when reason is null then 'pending' else 'skipped' end, reason
      from src where not $6
      on conflict (campaign_id, contact_id) do nothing
      returning 1
    )
    select jsonb_build_object(
      'total', (select count(*) from src),
      'eligible', (select count(*) from src where reason is null),
      'skipped', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) as n from src where reason is not null group by reason) x), '{}'::jsonb)
    )
  $q$, p_where) into v_result
  using coalesce(p_params, '[]'::jsonb), p_org_id, p_marketing, greatest(1, p_limit), p_campaign_id, coalesce(p_dry, false);
  return v_result;
end;
$$;
revoke all on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean) from public, anon, authenticated;
grant execute on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean) to service_role;

-- CSV audience: rows are [{phone_e164, first_name, last_name, data}]. Rows are matched to existing contacts
-- by primary or alternate phone; unknown numbers become new contacts (source 'campaign_csv') only when the
-- template is not MARKETING or the creator confirmed consent (stored as promotions_opt_in). Existing contacts
-- keep their own consent record. Dry run only counts. Returns {total, eligible, created, skipped:{reason:n}}.
create or replace function public.campaign_add_csv_rows(
  p_org_id uuid, p_campaign_id uuid, p_rows jsonb, p_marketing boolean, p_confirmed boolean,
  p_user uuid, p_dry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v public.contacts;
  v_reason text;
  v_phone text;
  v_total integer := 0;
  v_eligible integer := 0;
  v_created integer := 0;
  v_skipped jsonb := '{}'::jsonb;
begin
  if not p_dry and not exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id) then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_total := v_total + 1;
    v_phone := r ->> 'phone_e164';
    v := null;
    select * into v from public.contacts where org_id = p_org_id and phone_e164 = v_phone and deleted_at is null;
    if v.id is null then
      select c.* into v
      from public.contact_phones cp join public.contacts c on c.id = cp.contact_id
      where cp.org_id = p_org_id and cp.phone_e164 = v_phone and c.deleted_at is null
      limit 1;
    end if;

    if v.id is null then
      if p_marketing and not coalesce(p_confirmed, false) then
        v_skipped := jsonb_set(v_skipped, '{no_opt_in}', to_jsonb(coalesce((v_skipped ->> 'no_opt_in')::integer, 0) + 1));
        continue;
      end if;
      v_created := v_created + 1;
      v_eligible := v_eligible + 1;
      if p_dry then
        continue;
      end if;
      insert into public.contacts (org_id, first_name, last_name, phone_e164, source, promotions_opt_in, created_by)
      values (p_org_id, coalesce(r ->> 'first_name', ''), coalesce(r ->> 'last_name', ''), v_phone, 'campaign_csv', coalesce(p_confirmed, false), p_user)
      on conflict (org_id, phone_e164) where phone_e164 is not null and deleted_at is null do nothing
      returning * into v;
      if v.id is null then
        select * into v from public.contacts where org_id = p_org_id and phone_e164 = v_phone and deleted_at is null;
      end if;
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, csv_data)
      values (p_org_id, p_campaign_id, v.id, 'pending', coalesce(r -> 'data', '{}'::jsonb))
      on conflict (campaign_id, contact_id) do nothing;
      continue;
    end if;

    v_reason := app.campaign_skip_reason(v.deleted_at, v.phone_e164, v.wa_bsuid, v.promotions_opt_in, v.stop_marketing, p_marketing);
    if v_reason is null then
      v_eligible := v_eligible + 1;
    else
      v_skipped := jsonb_set(v_skipped, array[v_reason], to_jsonb(coalesce((v_skipped ->> v_reason)::integer, 0) + 1));
    end if;
    if not p_dry then
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, skip_reason, csv_data)
      values (p_org_id, p_campaign_id, v.id, case when v_reason is null then 'pending' else 'skipped' end, v_reason, coalesce(r -> 'data', '{}'::jsonb))
      on conflict (campaign_id, contact_id) do nothing;
    end if;
  end loop;
  return jsonb_build_object('total', v_total, 'eligible', v_eligible, 'created', v_created, 'skipped', v_skipped);
end;
$$;
revoke all on function public.campaign_add_csv_rows(uuid, uuid, jsonb, boolean, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.campaign_add_csv_rows(uuid, uuid, jsonb, boolean, boolean, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: campaigns.view reads; every write goes through server actions (service role).
-- ---------------------------------------------------------------------------

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

create policy campaigns_select on public.campaigns for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
create policy campaign_recipients_select on public.campaign_recipients for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));

-- Stats refresh, guardrails, scheduled starts and retry rounds are driven by the tick.
select cron.schedule('pulse:campaign_tick', '30 seconds', $$select app.ping_jobs('campaign_tick')$$);

