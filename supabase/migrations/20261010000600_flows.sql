-- Phase 8: Flows (bot / automation engine).
--
--   flows            one row per flow: trigger, conditions, draft graph, live version number
--   flow_versions    immutable published graphs; a run pins (flow_id, flow_version)
--   flow_runs        one execution; at most one live (running|waiting) run per conversation
--   flow_run_steps   the step trace shown on the Logs page (no message bodies, see CLAUDE.md rule 9)
--   flow_variables   org-level variables ({vars.KEY}) with defaults, managed on the Flows page
--   flow_locks       per-conversation (or per-run) lease taken around every step
--
-- Writes to runs / steps / versions / locks go through server code with the service role after
-- can(); members can read runs and steps, only flows.manage can change flows and variables.

-- ---------------------------------------------------------------------------
-- flows
-- ---------------------------------------------------------------------------
create table public.flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  trigger_type text not null check (trigger_type in (
    'conversation_opened', 'conversation_closed', 'conversation_waiting',
    'template_button_reply', 'shortcut',
    'enquiry_added', 'enquiry_stage_updated', 'enquiry_status_updated',
    'incoming_webhook', 'recurring',
    'appointment_created', 'appointment_updated'
  )),
  trigger_config jsonb not null default '{}'::jsonb,   -- { channel_id?, pipeline_id?, cron?, timezone?, button_ids? }
  conditions jsonb,                                    -- lib/filters AST evaluated against the event context
  channel_id uuid references public.channels (id) on delete set null,
  draft_graph jsonb not null default '{"nodes": [], "edges": []}'::jsonb,
  version integer not null default 0,                  -- 0 = never published
  published_at timestamptz,
  published_by uuid references public.profiles (id) on delete set null,
  webhook_token_hash text,                             -- sha256 of the incoming-webhook secret (shown once)
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(trigger_config) = 'object'),
  check (jsonb_typeof(draft_graph) = 'object')
);
create index flows_org_status_idx on public.flows (org_id, status, trigger_type);
create unique index flows_webhook_token_uidx on public.flows (webhook_token_hash) where webhook_token_hash is not null;

create table public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  flow_id uuid not null references public.flows (id) on delete cascade,
  version integer not null check (version >= 1),
  graph jsonb not null,
  published_at timestamptz not null default now(),
  published_by uuid references public.profiles (id) on delete set null,
  unique (flow_id, version)
);

-- ---------------------------------------------------------------------------
-- runs and steps
-- ---------------------------------------------------------------------------
create table public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  flow_id uuid not null references public.flows (id) on delete cascade,
  flow_version integer not null,
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  conversation_id uuid references public.conversations (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  context jsonb not null default '{}'::jsonb,          -- ids only (enquiry_id, appointment_id, message_id, ...)
  event jsonb not null default '{}'::jsonb,            -- trimmed trigger payload ({event.*}); webhook bodies live here
  vars jsonb not null default '{}'::jsonb,             -- {vars.KEY}
  steps jsonb not null default '{}'::jsonb,            -- {steps.<node>.response...}
  current_node_id text,
  step_count integer not null default 0,
  wait jsonb,                                          -- null | { type: 'reply' | 'time', node_id, token, expires_at }
  wait_seq integer not null default 0,
  trigger_key text,                                    -- event idempotency: one run per (flow, key)
  parent_run_id uuid references public.flow_runs (id) on delete set null,
  depth integer not null default 0 check (depth between 0 and 5),
  started_by uuid references public.profiles (id) on delete set null,
  error text,
  cancel_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(vars) = 'object' and jsonb_typeof(steps) = 'object' and jsonb_typeof(context) = 'object' and jsonb_typeof(event) = 'object')
);
-- One bot run per conversation at a time.
create unique index flow_runs_live_conversation_uidx on public.flow_runs (conversation_id)
  where conversation_id is not null and status in ('running', 'waiting');
create unique index flow_runs_trigger_key_uidx on public.flow_runs (flow_id, trigger_key) where trigger_key is not null;
create index flow_runs_flow_idx on public.flow_runs (org_id, flow_id, started_at desc);
create index flow_runs_live_idx on public.flow_runs (org_id, status) where status in ('running', 'waiting');
create index flow_runs_contact_idx on public.flow_runs (contact_id, started_at desc);

create table public.flow_run_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  run_id uuid not null references public.flow_runs (id) on delete cascade,
  seq integer not null check (seq >= 1),
  node_id text not null,
  node_type text not null,
  status text not null check (status in ('ok', 'waiting', 'failed', 'skipped')),
  handle text,                                         -- outgoing edge handle taken
  detail jsonb not null default '{}'::jsonb,           -- small, non-PHI summary (never message text)
  error text,
  started_at timestamptz not null default now(),
  duration_ms integer,
  unique (run_id, seq)
);
create index flow_run_steps_run_idx on public.flow_run_steps (run_id, seq);

alter table public.conversations
  add constraint conversations_flow_run_fk foreign key (flow_run_id) references public.flow_runs (id) on delete set null;
alter table public.messages
  add constraint messages_flow_run_fk foreign key (flow_run_id) references public.flow_runs (id) on delete set null;

-- ---------------------------------------------------------------------------
-- variables
-- ---------------------------------------------------------------------------
create table public.flow_variables (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  label text,
  value_type text not null default 'text' check (value_type in ('text', 'number', 'boolean')),
  default_value text check (default_value is null or char_length(default_value) <= 500),
  description text check (description is null or char_length(description) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

-- ---------------------------------------------------------------------------
-- lease lock (the "advisory lock per conversation"). PostgREST cannot hold a session advisory
-- lock across calls, so the step handler takes a short lease row instead: acquire is atomic and a
-- crashed worker's lease simply expires.
-- ---------------------------------------------------------------------------
create table public.flow_locks (
  key uuid primary key,                                -- conversation id, or run id when there is no conversation
  holder text not null,
  expires_at timestamptz not null
);

create or replace function public.flow_lock_acquire(p_key uuid, p_holder text, p_ttl_seconds integer default 30)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare got text;
begin
  insert into public.flow_locks as l (key, holder, expires_at)
  values (p_key, p_holder, now() + make_interval(secs => greatest(1, least(p_ttl_seconds, 300))))
  on conflict (key) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at < now() or l.holder = excluded.holder
  returning l.holder into got;
  return got is not null;
end;
$$;

create or replace function public.flow_lock_release(p_key uuid, p_holder text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.flow_locks where key = p_key and holder = p_holder;
$$;

revoke all on function public.flow_lock_acquire(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.flow_lock_release(uuid, text) from public, anon, authenticated;
grant execute on function public.flow_lock_acquire(uuid, text, integer) to service_role;
grant execute on function public.flow_lock_release(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- counters for the Flows list (✅ completed / ⚠️ failed / ⏳ live)
-- ---------------------------------------------------------------------------
create or replace view public.v_flow_run_counts with (security_invoker = true) as
select org_id, flow_id,
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status = 'failed')::int as failed,
       count(*) filter (where status in ('running', 'waiting'))::int as live,
       max(started_at) as last_run_at
from public.flow_runs
group by org_id, flow_id;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('flows', 'flows.manage');
select app.add_tenant_rls('flow_variables', 'flows.manage');
select app.add_tenant_rls('flow_versions');      -- written by publish (service role)
select app.add_tenant_rls('flow_runs');          -- written by the engine (service role)
select app.add_tenant_rls('flow_run_steps');
alter table public.flow_locks enable row level security;   -- service role only, no policies

-- Recurring triggers: once a minute the task starts every active recurring flow whose cron matches.
select cron.schedule('pulse:flows_recurring', '* * * * *', $$select app.ping_jobs('flows_recurring')$$);
