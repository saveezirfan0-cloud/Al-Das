-- Phase 8: flow engine tables.
--   flows            one row per flow; `graph` is the editable draft, `published_graph` what runs use
--   flow_runs        one run per (flow, contact/conversation); pinned to `flow_version`
--   flow_run_steps   per-node trace written BEFORE side effects (idempotent replay + Logs page)
--   flow_variables   workspace variables referenced as {vars.KEY}
-- The engine is driven by the `flow_steps` pgmq queue (one job per node) and `scheduled_jobs` for waits.

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  trigger_type text not null default 'shortcut' check (trigger_type in (
    'conversation_opened', 'conversation_closed', 'conversation_waiting', 'template_button',
    'shortcut', 'enquiry_added', 'enquiry_stage_updated', 'enquiry_status_updated',
    'webhook', 'recurring', 'appointment_created', 'appointment_updated', 'appointment_status_changed')),
  trigger_config jsonb not null default '{}'::jsonb,   -- { conditions: FilterGroup, cron, webhook_token_hash, template_id, … }
  channel_id uuid references public.channels (id) on delete set null,
  pipeline_id uuid,                                    -- Phase 5 adds the FK
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  published_graph jsonb,
  version int not null default 0,
  published_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(graph) = 'object'),
  check (jsonb_typeof(trigger_config) = 'object')
);
create index flows_org_status_idx on public.flows (org_id, status);
create index flows_org_trigger_idx on public.flows (org_id, trigger_type) where status = 'active';

create table public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  flow_id uuid not null references public.flows (id) on delete cascade,
  flow_version int not null,
  contact_id uuid references public.contacts (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  enquiry_id uuid,                                     -- Phase 5 adds the FK
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_node_id text,
  context jsonb not null default '{}'::jsonb,          -- { vars: {}, trigger: {}, steps: { <node>: { response } } }
  waiting_for jsonb,                                   -- { kind: 'reply'|'timer'|'button', node_id, timeout_job_id, … }
  step_count int not null default 0,
  parent_run_id uuid references public.flow_runs (id) on delete set null,
  started_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index flow_runs_flow_idx on public.flow_runs (flow_id, status);
create index flow_runs_org_started_idx on public.flow_runs (org_id, started_at desc);
create index flow_runs_conversation_idx on public.flow_runs (conversation_id) where conversation_id is not null;
-- One live bot run per conversation: starting another while one runs/waits must fail (or be cancelled first).
create unique index flow_runs_one_live_per_conversation_uidx on public.flow_runs (conversation_id)
  where conversation_id is not null and status in ('running', 'waiting') and parent_run_id is null;

create table public.flow_run_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  run_id uuid not null references public.flow_runs (id) on delete cascade,
  seq int not null,                                    -- 1-based order inside the run (max 200)
  node_id text not null,
  node_type text not null,
  status text not null default 'running' check (status in ('running', 'ok', 'waiting', 'skipped', 'failed')),
  input jsonb,
  output jsonb,
  error text,
  at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, seq)
);
create index flow_run_steps_run_idx on public.flow_run_steps (run_id, seq);

create table public.flow_variables (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  value text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

-- Real FKs for the columns earlier phases left open.
alter table public.conversations
  add constraint conversations_flow_run_fk foreign key (flow_run_id) references public.flow_runs (id) on delete set null;
alter table public.messages
  add constraint messages_flow_run_fk foreign key (flow_run_id) references public.flow_runs (id) on delete set null;
alter table public.segments
  add constraint segments_drip_flow_fk foreign key (drip_flow_id) references public.flows (id) on delete set null;

-- Child rows must carry the parent's org.
create trigger flows_channel_org_check before insert or update on public.flows
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger flow_runs_flow_org_check before insert or update on public.flow_runs
  for each row execute function app.check_parent_org('flows', 'flow_id');
create trigger flow_runs_contact_org_check before insert or update on public.flow_runs
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger flow_runs_conversation_org_check before insert or update on public.flow_runs
  for each row execute function app.check_parent_org('conversations', 'conversation_id');
create trigger flow_run_steps_run_org_check before insert or update on public.flow_run_steps
  for each row execute function app.check_parent_org('flow_runs', 'run_id');

create trigger flows_set_updated_at before update on public.flows for each row execute function app.set_updated_at();
create trigger flow_runs_set_updated_at before update on public.flow_runs for each row execute function app.set_updated_at();
create trigger flow_variables_set_updated_at before update on public.flow_variables for each row execute function app.set_updated_at();

-- Counters for the Flows list: ✅ completed / ⚠️ failed / ⏳ running+waiting.
create view public.v_flow_run_counts with (security_invoker = true) as
select f.org_id, f.id as flow_id,
       count(r.id) filter (where r.status = 'completed') as completed,
       count(r.id) filter (where r.status = 'failed') as failed,
       count(r.id) filter (where r.status in ('running', 'waiting')) as pending
from public.flows f
left join public.flow_runs r on r.flow_id = f.id
group by f.org_id, f.id;

-- RLS: members with flows.manage read and write; runs/steps are written by the engine (service role),
-- readable by flows.manage so the Logs page works under the user's session.
alter table public.flows enable row level security;
alter table public.flow_runs enable row level security;
alter table public.flow_run_steps enable row level security;
alter table public.flow_variables enable row level security;

create policy flows_select on public.flows for select to authenticated
  using (app.has_perm(org_id, 'flows.manage') or app.has_perm(org_id, 'inbox.send'));
create policy flows_insert on public.flows for insert to authenticated
  with check (app.has_perm(org_id, 'flows.manage'));
create policy flows_update on public.flows for update to authenticated
  using (app.has_perm(org_id, 'flows.manage')) with check (app.has_perm(org_id, 'flows.manage'));
create policy flows_delete on public.flows for delete to authenticated
  using (app.has_perm(org_id, 'flows.manage'));

create policy flow_runs_select on public.flow_runs for select to authenticated
  using (app.has_perm(org_id, 'flows.manage'));
create policy flow_run_steps_select on public.flow_run_steps for select to authenticated
  using (app.has_perm(org_id, 'flows.manage'));

create policy flow_variables_select on public.flow_variables for select to authenticated
  using (app.has_perm(org_id, 'flows.manage'));
create policy flow_variables_insert on public.flow_variables for insert to authenticated
  with check (app.has_perm(org_id, 'flows.manage'));
create policy flow_variables_update on public.flow_variables for update to authenticated
  using (app.has_perm(org_id, 'flows.manage')) with check (app.has_perm(org_id, 'flows.manage'));
create policy flow_variables_delete on public.flow_variables for delete to authenticated
  using (app.has_perm(org_id, 'flows.manage'));

-- Per-conversation lease lock. Job handlers talk to Postgres through PostgREST (one transaction per call),
-- so a pg_advisory_xact_lock would be released immediately; a short lease row is held across the whole step.
-- key = conversation id (or run id when the run has no conversation). Expired leases can be stolen.
create table public.flow_locks (
  key uuid primary key,
  owner uuid not null,
  expires_at timestamptz not null
);
alter table public.flow_locks enable row level security;   -- no policies: service role only

create or replace function public.claim_flow_lock(p_key uuid, p_owner uuid, p_ttl_seconds int default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  insert into public.flow_locks as l (key, owner, expires_at)
  values (p_key, p_owner, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where l.expires_at < now() or l.owner = excluded.owner
  returning owner into v_owner;
  return v_owner is not null;
end;
$$;

create or replace function public.release_flow_lock(p_key uuid, p_owner uuid)
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.flow_locks where key = p_key and owner = p_owner $$;

revoke all on function public.claim_flow_lock(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.release_flow_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_flow_lock(uuid, uuid, int) to service_role;
grant execute on function public.release_flow_lock(uuid, uuid) to service_role;
