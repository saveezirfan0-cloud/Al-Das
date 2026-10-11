-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.

-- ======================================================================
-- 20261010000600_flows.sql
-- ======================================================================
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

-- Immutable snapshot per publish: a run pins `flow_version` and keeps executing that graph even if the flow is edited.
create table public.flow_versions (
  flow_id uuid not null references public.flows (id) on delete cascade,
  version int not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  graph jsonb not null,
  published_by uuid references public.profiles (id) on delete set null,
  published_at timestamptz not null default now(),
  primary key (flow_id, version)
);

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
create trigger flow_versions_flow_org_check before insert or update on public.flow_versions
  for each row execute function app.check_parent_org('flows', 'flow_id');
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
alter table public.flow_versions enable row level security;
create policy flow_versions_select on public.flow_versions for select to authenticated
  using (app.has_perm(org_id, 'flows.manage'));   -- written by the publish server action (service role)

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

-- ======================================================================
-- 20261010000700_recall_reference.sql
-- ======================================================================
-- Phase 8: what the recall views read that Phases 6 and 9 do not have: a patient's chronic conditions and the
-- clinic working calendar used for "working days without reply". ref_condition_groups, ref_diagnoses and
-- seed_condition_groups come from Phase 9 (20261010000400_portal_ref_tables.sql); clinical_settings, visits and
-- appointments from Phase 6.

create table if not exists public.contact_chronic_conditions (
  org_id            uuid not null references public.orgs(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  ref_diagnosis_id  uuid not null references public.ref_diagnoses(id),
  source            text not null default 'unite',
  noted_at          date,
  primary key (contact_id, ref_diagnosis_id)
);

create table if not exists public.clinic_calendar (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete cascade,   -- null = org default
  working_weekdays  int[] not null default '{1,2,3,4,5,6}',                     -- ISO: 1=Mon ... 7=Sun
  holidays          date[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists clinic_calendar_org_default on public.clinic_calendar (org_id) where location_id is null;
create unique index if not exists clinic_calendar_org_location on public.clinic_calendar (org_id, location_id) where location_id is not null;

create or replace function public.is_working_day(p_org uuid, p_day date, p_location uuid default null)
returns boolean language sql stable as $$
  with cal as (
    select * from public.clinic_calendar
    where org_id = p_org and (location_id = p_location or location_id is null)
    order by location_id nulls last limit 1)
  select coalesce(
    (select extract(isodow from p_day)::int = any(working_weekdays) and not (p_day = any(holidays)) from cal),
    extract(isodow from p_day)::int between 1 and 5);   -- no calendar row: Mon-Fri (documented fallback)
$$;

create or replace function public.workdays_between(p_org uuid, p_from date, p_to date, p_location uuid default null)
returns int language sql stable as $$
  select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') g
  where public.is_working_day(p_org, g::date, p_location);
$$;

select app.add_tenant_rls('contact_chronic_conditions');
select app.add_tenant_rls('clinic_calendar', 'portal.clinic_calendar.write');

-- ======================================================================
-- 20261010000800_recall.sql
-- ======================================================================
-- Phase 8: recall programmes, sends and views (from supabase/drafts/0104_recall.sql).
-- Builds on Phase 6 (visits, clinical_settings, appointments) and 20261010000700_recall_reference.sql.

-- 0104_recall.sql  (DRAFT — Phase 0)
-- Recall programmes (chronic 90-day, birthday, screenings, dormant) and the per-patient send log.
-- Replaces: Unite patient flag columns, Campaigns.Birthday Messages, Campaigns.Chronic Recall Messages,
-- Make scenarios 4049277, 5882746, 5916036 and the 9 inactive screening scenarios.
-- Depends on 0101, 0102, Phase 2 (contacts), Phase 3 (messages), Phase 4 (wa_templates), Phase 6 (appointments).

do $$ begin
  if not exists (select 1 from pg_type where typname = 'recall_kind') then
    create type public.recall_kind as enum ('chronic','birthday','screening','dormant','post_visit','no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_repeat_policy') then
    create type public.recall_repeat_policy as enum ('once','per_cycle');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_send_status') then
    create type public.recall_send_status as enum
      ('eligible','queued','sent','delivered','read','failed','skipped_no_template','skipped_opted_out','excluded','cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_follow_up_status') then
    create type public.recall_follow_up_status as enum ('called','no_response','booked');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- recall_programmes
-- ---------------------------------------------------------------------------
create table if not exists public.recall_programmes (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  key                       text not null,                       -- chronic_90d, birthday, annual_checkup, pap_smear, dental, skin_check, colonoscopy, pre_menopause, menopause, dormant
  name                      text not null,
  kind                      public.recall_kind not null,
  status                    text not null default 'draft',       -- draft | active | paused
  eligibility_view          text,                                -- name of the SQL view that lists eligible contacts (org_id, contact_id, segment_key, cycle_key, …)
  cron_expression           text,                                -- pg_cron schedule (Asia/Dubai semantics handled by the job)
  min_days_since_visit      int,                                 -- e.g. 330 for annual checkup; chronic reads clinical_settings instead
  repeat_policy             public.recall_repeat_policy not null default 'per_cycle',
  max_per_run               int not null default 100,
  send_mode_override        text,                                -- null = use clinical_settings.recall_send_mode
  requires_marketing_opt_in boolean not null default true,       -- marketing-category templates need promotions_opt_in
  requires_clinical_consent boolean not null default false,
  config                    jsonb not null default '{}'::jsonb,  -- programme-specific (age bands, steps for post_visit, …)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, key)
);

-- segment_key → template. No default row for chronic (fail closed, OQ-24); '*' may be used by other programmes.
create table if not exists public.recall_programme_templates (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  programme_id                 uuid not null references public.recall_programmes(id) on delete cascade,
  segment_key                  text not null,                    -- condition group key | gender_band | '*'
  wa_template_id               uuid references public.wa_templates(id),
  legacy_sanoflow_template_id  text,                             -- 13159 … 13170, 12289 … 12296, 11885
  variables_map                jsonb not null default '{}'::jsonb, -- {{1}} → contact.first_name etc.
  active                       boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (programme_id, segment_key)
);

-- ---------------------------------------------------------------------------
-- recall_sends — one row per contact per programme per cycle
-- ---------------------------------------------------------------------------
create table if not exists public.recall_sends (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null references public.orgs(id) on delete cascade,
  programme_id                    uuid not null references public.recall_programmes(id) on delete cascade,
  contact_id                      uuid not null references public.contacts(id) on delete cascade,
  cycle_key                       text not null,                 -- chronic: last_visit_date; birthday: year; once-programmes: 'once'
  segment_key                     text,                          -- condition group | gender_band
  template_id                     uuid references public.recall_programme_templates(id),
  legacy_template_ref             text,                          -- Sanoflow template id used historically
  send_mode                       text not null default 'test',  -- test | live
  status                          public.recall_send_status not null default 'eligible',
  eligible_at                     timestamptz,
  sent_at                         timestamptz,
  sent_to_phone_e164              text,                          -- the number actually messaged (test numbers in test mode)
  message_id                      uuid references public.messages(id),
  last_visit_date_at_send         date,
  days_since_last_visit_at_send   int,
  replied_at                      timestamptz,
  reply_message_id                uuid references public.messages(id),
  booked_at                       timestamptz,
  appointment_id                  uuid references public.appointments(id),
  follow_up_status                public.recall_follow_up_status,
  assigned_user_id                uuid references public.profiles(id),
  outcome                         text,                          -- offer_redeemed, wants_booking, declined, …
  notes                           text,
  source                          text not null default 'engine', -- engine | airtable_import
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (programme_id, contact_id, cycle_key),
  -- "Always fill in Booking Date when setting this to Booked."
  constraint booked_requires_date check (follow_up_status is distinct from 'booked' or booked_at is not null)
);
create index if not exists recall_sends_open_idx on public.recall_sends (org_id, programme_id, contact_id) where replied_at is null and status in ('sent','delivered','read');
create index if not exists recall_sends_sent_idx on public.recall_sends (org_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Per-contact visit statistics (replaces Unite First/Last Visit Date, Time Elapsed)
create or replace view public.v_contact_visit_stats with (security_invoker = true) as
select v.org_id, v.contact_id,
       min(v.visit_date) as first_visit_date,
       max(v.visit_date) as last_visit_date,
       (current_date - max(v.visit_date))::int as days_since_last_visit,
       count(*)::int as visit_count
from public.visits v
where v.contact_id is not null and not v.is_test_record
group by v.org_id, v.contact_id;

-- Chronic recall eligibility (R-20…R-22). Threshold from clinical_settings (fail closed: NULL → nobody eligible).
create or replace view public.v_chronic_recall_eligibility with (security_invoker = true) as
with groups as (
  select cc.org_id, cc.contact_id,
         array_agg(distinct g.key order by g.key) as all_group_keys,
         (array_agg(g.key order by g.sort, g.key) filter (where g.messageable))[1] as primary_condition_group,
         array_remove(array_agg(distinct case when g.messageable then g.key end), null) as messageable_groups
  from public.contact_chronic_conditions cc
  join public.ref_diagnoses d on d.id = cc.ref_diagnosis_id
  join public.ref_condition_groups g on g.id = d.condition_group_id
  group by cc.org_id, cc.contact_id
),
prog as (select id, org_id from public.recall_programmes where key = 'chronic_90d')
select c.org_id, c.id as contact_id,
       s.last_visit_date, s.days_since_last_visit,
       g.primary_condition_group, g.messageable_groups,
       public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') as min_days,
       (s.last_visit_date::text) as cycle_key,
       (   c.phone_e164 is not null
       and not coalesce(c.stop_marketing, false)
       and not coalesce(c.is_test_record, false)
       and g.primary_condition_group is not null
       and public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') is not null
       and s.days_since_last_visit >= public.clinical_setting_num(c.org_id, 'chronic_recall_min_days')
       and not exists (select 1 from public.recall_sends rs join prog p on p.id = rs.programme_id
                       where rs.contact_id = c.id and rs.cycle_key = s.last_visit_date::text
                         and rs.status not in ('cancelled','failed'))
       ) as eligible
from public.contacts c
join public.v_contact_visit_stats s on s.contact_id = c.id and s.org_id = c.org_id
join groups g on g.contact_id = c.id and g.org_id = c.org_id;

-- Birthday eligibility (OQ-17, OQ-18). 29 Feb → 1 Mar in non-leap years.
create or replace view public.v_birthday_today with (security_invoker = true) as
select c.org_id, c.id as contact_id, c.gender,
       extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob))::int as age_today,
       case
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 20 and 29 then 'm_20_29'
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 30 and 39 then 'm_30_39'
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) >= 40 then 'm_40_plus'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 18 and 35 then 'f_18_35'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 36 and 45 then 'f_36_45'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 46 and 65 then 'f_46_65'
         else null
       end as segment_key,
       extract(year from (now() at time zone 'Asia/Dubai'))::text as cycle_key
from public.contacts c
where c.dob is not null
  and c.phone_e164 is not null
  and not coalesce(c.stop_marketing, false)
  and not coalesce(c.is_test_record, false)
  and (
        to_char(c.dob, 'MM-DD') = to_char((now() at time zone 'Asia/Dubai')::date, 'MM-DD')
     or (to_char(c.dob, 'MM-DD') = '02-29'
         and to_char((now() at time zone 'Asia/Dubai')::date, 'MM-DD') = '03-01'
         and not (extract(year from (now() at time zone 'Asia/Dubai'))::int % 4 = 0
                  and (extract(year from (now() at time zone 'Asia/Dubai'))::int % 100 <> 0
                       or extract(year from (now() at time zone 'Asia/Dubai'))::int % 400 = 0)))
  );

-- Care-coordinator call list (R-24, R-25). Replaces the "Chronic Recall Call List" interface.
create or replace view public.v_recall_call_list with (security_invoker = true) as
select rs.org_id, rs.id as recall_send_id, rs.programme_id, rs.contact_id, rs.segment_key,
       rs.sent_at, rs.follow_up_status, rs.assigned_user_id,
       rs.days_since_last_visit_at_send, rs.last_visit_date_at_send,
       case when rs.replied_at is null then ((now() at time zone 'Asia/Dubai')::date - (rs.sent_at at time zone 'Asia/Dubai')::date) end as days_waiting,
       public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date) as workdays_waiting,
       (   rs.send_mode = 'live'
       and rs.status in ('sent','delivered','read')
       and rs.replied_at is null
       and rs.follow_up_status is distinct from 'booked'
       and public.clinical_setting_num(rs.org_id, 'recall_followup_workdays') is not null
       and public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date)
             >= public.clinical_setting_num(rs.org_id, 'recall_followup_workdays')
       ) as call_now,
       (rs.days_since_last_visit_at_send > public.clinical_setting_num(rs.org_id, 'chronic_recall_overdue_days')) as overdue
from public.recall_sends rs
where rs.sent_at is not null;

-- Weekly rollup (Week Starting = Monday, Asia/Dubai)
create or replace view public.v_recall_weekly with (security_invoker = true) as
select rs.org_id, rs.programme_id, rs.send_mode,
       date_trunc('week', rs.sent_at at time zone 'Asia/Dubai')::date as week_start,
       count(*) filter (where rs.status in ('sent','delivered','read')) as sent,
       count(*) filter (where rs.status = 'failed') as failed,
       count(*) filter (where rs.replied_at is not null) as replied,
       count(*) filter (where rs.booked_at is not null) as booked,
       count(distinct rs.contact_id) as unique_contacts,
       avg(rs.days_since_last_visit_at_send) as avg_days_since_last_visit,
       count(*) filter (where rs.days_since_last_visit_at_send > public.clinical_setting_num(rs.org_id, 'chronic_recall_overdue_days')) as over_threshold
from public.recall_sends rs
where rs.sent_at is not null
group by rs.org_id, rs.programme_id, rs.send_mode, date_trunc('week', rs.sent_at at time zone 'Asia/Dubai')::date;

-- ---------------------------------------------------------------------------
-- Seed: programmes + legacy template map. Run per org: select public.seed_recall_programmes('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_recall_programmes(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare chronic uuid; bday uuid;
begin
  insert into public.recall_programmes (org_id, key, name, kind, status, eligibility_view, cron_expression, repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, config)
  values
    (p_org, 'chronic_90d',   'Chronic condition recall',           'chronic',   'draft', 'v_chronic_recall_eligibility', '15 12 * * *', 'per_cycle', 100, false, true,  '{"threshold_setting":"chronic_recall_min_days","order_by":"days_since_last_visit desc"}'),
    (p_org, 'birthday',      'Birthday message',                   'birthday',  'draft', 'v_birthday_today',              '0 9 * * *',   'per_cycle', 1000, true, false, '{"bands":["m_20_29","m_30_39","m_40_plus","f_18_35","f_36_45","f_46_65"]}'),
    (p_org, 'annual_checkup','Annual check-up reminder (330 days)','screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{"min_days_since_visit":330}'),
    (p_org, 'dental',        'Annual dental check-up',             'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pap_smear',     'Pap smear reminder',                 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'colonoscopy',   'Colonoscopy screening',              'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'skin_check',    'Skin cancer screening & mole check', 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pre_menopause', 'Pre-menopause assessment',           'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'menopause',     'Menopause assessment',               'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'dormant',       'Dormant patient reactivation',       'dormant',   'draft', null, '0 9 * * *', 'once',      200, true, false, '{}')
  on conflict (org_id, key) do nothing;

  select id into chronic from public.recall_programmes where org_id = p_org and key = 'chronic_90d';
  select id into bday    from public.recall_programmes where org_id = p_org and key = 'birthday';

  -- Chronic: per-condition Sanoflow template ids from the live SWITCH (R-23). No default row (fail closed).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id) values
    (p_org, chronic, 'hypertension',   '13159'),
    (p_org, chronic, 'diabetes',       '13164'),
    (p_org, chronic, 'hyperlipidemia', '13163'),
    (p_org, chronic, 'hypothyroidism', '13169'),
    (p_org, chronic, 'ckd',            '13168'),
    (p_org, chronic, 'asthma',         '13162'),
    (p_org, chronic, 'copd',           '13165'),
    (p_org, chronic, 'ra',             '13161'),
    (p_org, chronic, 'af',             '13167'),
    (p_org, chronic, 'epilepsy',       '13166')
  on conflict (programme_id, segment_key) do nothing;

  -- Birthday: gender/age bands from the Make scenario (OQ-17).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id) values
    (p_org, bday, 'm_20_29',  '12294'),
    (p_org, bday, 'm_30_39',  '12295'),
    (p_org, bday, 'm_40_plus','12296'),
    (p_org, bday, 'f_18_35',  '12289'),
    (p_org, bday, 'f_36_45',  '12291'),
    (p_org, bday, 'f_46_65',  '12291')
  on conflict (programme_id, segment_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- RLS + updated_at
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('recall_programmes',          'campaigns.create');
select app.add_tenant_rls('recall_programme_templates', 'templates.manage');
select app.add_tenant_rls('recall_sends',               'portal.recall_sends.write');   -- call-list edits (follow_up_status, booked_at)
revoke all on function public.seed_recall_programmes(uuid) from public, anon, authenticated;
grant execute on function public.seed_recall_programmes(uuid) to service_role;

-- ======================================================================
-- 20261010000900_recall_phase8.sql
-- ======================================================================
-- Phase 8: recall engine additions on top of Phase 6 and 20261010000800_recall.sql.
--   * recall_programmes.last_run_at           cron de-dupe for the recall_run task
--   * flows.last_triggered_at                 cron de-dupe for recurring flows
--   * recall_clinical_messaging_enabled()     the patient-facing clinical gate, exposed to the engine
--   * seed_phase8_defaults()                  seeds a workspace for the recall pages
--   * parallel_run_*                          native-vs-Make comparison (IDs only: hashed PIN / appointment id)
-- Appointment reminders are Phase 6's (lib/appointments/reminders.ts); recall does not send them.
-- Cron entries for the recall_run / flow_recurring / parallel_run tasks are at the bottom.

alter table public.recall_programmes add column if not exists last_run_at timestamptz;
alter table public.flows add column if not exists last_triggered_at timestamptz;

-- The gate for patient-facing clinical messages. app.clinical_messaging_enabled is true only for a SIGNED-OFF
-- 'true'; allow_unsigned_defaults and proposed values never open it. Exposed (service role only) because
-- PostgREST serves only the public schema.
create or replace function public.recall_clinical_messaging_enabled(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.clinical_messaging_enabled(p_org)
$$;
revoke all on function public.recall_clinical_messaging_enabled(uuid) from public, anon, authenticated;
grant execute on function public.recall_clinical_messaging_enabled(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Parallel run (one week of native Test-mode output vs Make output before each scenario is retired)
-- Stores IDs only: ref_hash = sha256(Unite PIN / Unite appointment id). No names, phones or message bodies.
-- ---------------------------------------------------------------------------
create table public.parallel_run_scenarios (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,                          -- token | appointment_reminders | birthday | chronic_recall | chronic_update | mrd_sync | airtable_automations
  make_scenario_id text,
  name text not null,
  native_built boolean not null default false,
  parallel_started_on date,
  diffs_explained boolean not null default false,
  make_off boolean not null default false,
  blocked_reason text,                                 -- e.g. 'Needs Unite sync (Phase 6)'
  notes text,
  updated_at timestamptz not null default now(),
  primary key (org_id, scenario_key)
);

create table public.parallel_run_make_outputs (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,
  run_date date not null,
  ref_hash text not null,
  primary key (org_id, scenario_key, run_date, ref_hash)
);

create table public.parallel_run_diffs (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,
  run_date date not null,
  make_count int not null,
  native_count int not null,
  only_in_make text[] not null default '{}',
  only_in_native text[] not null default '{}',
  reason text,                                         -- every difference needs an explanation before Make is switched off
  explained boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (org_id, scenario_key, run_date)
);

create or replace function public.seed_parallel_run_scenarios(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.parallel_run_scenarios (org_id, scenario_key, make_scenario_id, name, native_built, blocked_reason) values
    (p_org, 'token',                 '3576415', 'Token (Unite auth refresh)',        false, 'Needs lib/unite (Phase 6); Unite stays untouched until then'),
    (p_org, 'appointment_reminders', '3613818', 'Appointment reminders (12:00 + 18:00)', true,  null),
    (p_org, 'birthday',              '4049277', 'Agewise birthday message',          true,  null),
    (p_org, 'chronic_recall',        '5882746', 'Chronic recall (90 day)',           true,  'Needs visits sync (Phase 6) and OQ-01 threshold sign-off'),
    (p_org, 'chronic_update',        '5916036', 'Chronic update (reply / booked)',   true,  null),
    (p_org, 'mrd_sync',              '5990863', 'Acute follow-up MRD sync',          false, 'Phase 6 clinical engine'),
    (p_org, 'airtable_automations',  null,      'Airtable native automations (2)',   false, 'Document then switch off (OQ-41)')
  on conflict do nothing;
$$;
revoke all on function public.seed_parallel_run_scenarios(uuid) from public, anon, authenticated;
grant execute on function public.seed_parallel_run_scenarios(uuid) to service_role;

alter table public.parallel_run_scenarios enable row level security;
alter table public.parallel_run_make_outputs enable row level security;
alter table public.parallel_run_diffs enable row level security;
create policy parallel_run_scenarios_select on public.parallel_run_scenarios for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy parallel_run_scenarios_update on public.parallel_run_scenarios for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
create policy parallel_run_diffs_select on public.parallel_run_diffs for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy parallel_run_diffs_update on public.parallel_run_diffs for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
-- make_outputs: engine/importer only (service role), no policies.

-- One call for everything the recall pages need. Idempotent (every seed is ON CONFLICT DO NOTHING).
-- Called lazily by the Recall and Parallel run pages. Phase 6 seeds its own reminder exclusions and status map.
create or replace function public.seed_phase8_defaults(p_org uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.seed_condition_groups(p_org);
  perform public.seed_clinical_settings(p_org);
  perform public.seed_recall_programmes(p_org);
  perform public.seed_parallel_run_scenarios(p_org);
end $$;
revoke all on function public.seed_phase8_defaults(uuid) from public, anon, authenticated;
grant execute on function public.seed_phase8_defaults(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cron: tasks pinged every minute; each task evaluates its own cron expressions (Asia/Dubai).
-- Names are unique, so these do not collide with the 20261008000500 unschedule loop.
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:recall_run',        '* * * * *', $$select app.ping_jobs('recall_run')$$);
select cron.schedule('pulse:flow_recurring',    '* * * * *', $$select app.ping_jobs('flow_recurring')$$);
select cron.schedule('pulse:parallel_run',      '30 20 * * *', $$select app.ping_jobs('parallel_run')$$);   -- 00:30 Asia/Dubai (UTC+4)

-- ======================================================================
-- 20261010001000_enquiry_campaign_reports.sql
-- ======================================================================
-- Phase 10 follow-up: enquiry and campaign reports, now that Phases 5 and 7 exist.
--
-- Same shape as the appointment reports (20261009001400): one security_invoker view revoked from API
-- roles as the contract, and report_* functions that aggregate in SQL, service role only.
--
-- Definitions (docs/audit/reports.md §5.1b):
--   created        enquiries whose created_at falls on the day (org timezone)
--   closed         won / lost / disqualified, by the day closed_at falls on (not the creation day)
--   conversion     won / (won + lost + disqualified), among enquiries closed in the period
--   stage history  there is no stage-history table: the timeline events written by lib/enquiries/service.ts
--                  are the history (enquiry.created -> stage_id, enquiry.stage_changed / pipeline_changed
--                  -> to_stage_id). Enquiries created before Phase 5 or imported without timeline events
--                  have no history and drop out of the funnel entries and time-in-stage.
--   time in stage  entry -> next entry; the last stay of a closed enquiry ends at closed_at; the stay an
--                  open enquiry is in right now is not counted. Bucketed by the day the stay ended.
--   team / user    the enquiry's CURRENT assignee (assignment history is not kept)
--   campaign       by the day it started (scheduled / created if it never started); drafts excluded;
--                  counts are read live from campaign_recipients

create view public.v_enquiry_facts
with (security_invoker = true) as
select e.id,
       e.org_id,
       (e.created_at at time zone o.timezone)::date as created_day,
       case when e.closed_at is not null then (e.closed_at at time zone o.timezone)::date end as closed_day,
       e.pipeline_id,
       p.name as pipeline_name,
       p.sort as pipeline_sort,
       e.stage_id,
       s.name as stage_name,
       s.sort as stage_sort,
       e.status,
       e.assignee_id,
       e.est_value,
       e.created_at,
       e.closed_at
from public.enquiries e
join public.orgs o on o.id = e.org_id
join public.pipelines p on p.id = e.pipeline_id
join public.stages s on s.id = e.stage_id
where e.deleted_at is null;

revoke all on public.v_enquiry_facts from public, anon, authenticated;
grant select on public.v_enquiry_facts to service_role;

-- Every time an enquiry entered a stage, from the timeline.
create view public.v_enquiry_stage_entries
with (security_invoker = true) as
select t.org_id,
       t.enquiry_id,
       nullif(case t.type
                when 'enquiry.created' then t.payload ->> 'stage_id'
                else t.payload ->> 'to_stage_id'
              end, '')::uuid as stage_id,
       t.at
from public.timeline_events t
where t.enquiry_id is not null
  and t.type in ('enquiry.created', 'enquiry.stage_changed', 'enquiry.pipeline_changed');

revoke all on public.v_enquiry_stage_entries from public, anon, authenticated;
grant select on public.v_enquiry_stage_entries to service_role;

create view public.v_campaign_facts
with (security_invoker = true) as
select c.id,
       c.org_id,
       c.name,
       c.status,
       c.channel_id,
       ch.name as channel_name,
       c.started_at,
       c.created_at,
       (coalesce(c.started_at, c.scheduled_at, c.created_at) at time zone o.timezone)::date as day,
       coalesce(c.started_at, c.scheduled_at, c.created_at) as placed_at
from public.campaigns c
join public.channels ch on ch.id = c.channel_id
join public.orgs o on o.id = c.org_id;

revoke all on public.v_campaign_facts from public, anon, authenticated;
grant select on public.v_campaign_facts to service_role;

create or replace function public.report_enquiries_summary(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (created integer, open_now integer, won integer, lost integer, disqualified integer, won_value numeric)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*) filter (where created_day between p_from and p_to)::integer,
         count(*) filter (where status = 'open')::integer,
         count(*) filter (where status = 'won' and closed_day between p_from and p_to)::integer,
         count(*) filter (where status = 'lost' and closed_day between p_from and p_to)::integer,
         count(*) filter (where status = 'disqualified' and closed_day between p_from and p_to)::integer,
         coalesce(sum(est_value) filter (where status = 'won' and closed_day between p_from and p_to), 0)
  from public.v_enquiry_facts
  where org_id = p_org
    and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
    and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
      select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)));
$$;

create or replace function public.report_enquiries_by_day(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (day date, created integer, won integer, lost integer, disqualified integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  made as (select created_day as day, count(*)::integer as n from f where created_day between p_from and p_to group by 1),
  closed as (
    select closed_day as day,
           count(*) filter (where status = 'won')::integer as won,
           count(*) filter (where status = 'lost')::integer as lost,
           count(*) filter (where status = 'disqualified')::integer as disqualified
    from f where closed_day between p_from and p_to group by 1
  )
  select days.day, coalesce(made.n, 0), coalesce(closed.won, 0), coalesce(closed.lost, 0), coalesce(closed.disqualified, 0)
  from days
  left join made on made.day = days.day
  left join closed on closed.day = days.day
  order by days.day;
$$;

-- One row per stage: how many enquiries entered it in the period, how many sit in it now, how many ended here.
create or replace function public.report_enquiry_funnel(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  pipeline_id uuid, pipeline_name text, stage_id uuid, stage_name text,
  entered integer, open_now integer, won_here integer, lost_here integer, disqualified_here integer
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  entries as (
    select en.stage_id, count(distinct en.enquiry_id)::integer as n
    from public.v_enquiry_stage_entries en
    join f on f.id = en.enquiry_id
    join public.orgs o on o.id = en.org_id
    where en.org_id = p_org and en.stage_id is not null
      and (en.at at time zone o.timezone)::date between p_from and p_to
    group by en.stage_id
  ),
  here as (
    select stage_id,
           count(*) filter (where status = 'open')::integer as open_now,
           count(*) filter (where status = 'won' and closed_day between p_from and p_to)::integer as won_here,
           count(*) filter (where status = 'lost' and closed_day between p_from and p_to)::integer as lost_here,
           count(*) filter (where status = 'disqualified' and closed_day between p_from and p_to)::integer as disq_here
    from f group by stage_id
  )
  select p.id, p.name, s.id, s.name,
         coalesce(entries.n, 0), coalesce(here.open_now, 0), coalesce(here.won_here, 0),
         coalesce(here.lost_here, 0), coalesce(here.disq_here, 0)
  from public.stages s
  join public.pipelines p on p.id = s.pipeline_id
  left join entries on entries.stage_id = s.id
  left join here on here.stage_id = s.id
  where s.org_id = p_org and p.archived_at is null
  order by p.sort, p.name, s.sort, s.name
  limit 300;
$$;

create or replace function public.report_enquiry_stage_times(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  pipeline_id uuid, pipeline_name text, stage_id uuid, stage_name text,
  stays integer, avg_seconds numeric, median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  ordered as (
    select en.enquiry_id, en.stage_id, en.at as entered_at,
           lead(en.at) over (partition by en.enquiry_id order by en.at, en.stage_id) as next_at
    from public.v_enquiry_stage_entries en
    where en.org_id = p_org and en.stage_id is not null
  ),
  stays as (
    select f.pipeline_id, ordered.stage_id, ordered.entered_at,
           coalesce(ordered.next_at, f.closed_at) as left_at,
           o.timezone
    from ordered
    join f on f.id = ordered.enquiry_id
    join public.orgs o on o.id = p_org
  )
  select p.id, p.name, s.id, s.name,
         count(*)::integer,
         avg(extract(epoch from (st.left_at - st.entered_at))),
         percentile_cont(0.5) within group (order by extract(epoch from (st.left_at - st.entered_at)))
  from stays st
  join public.stages s on s.id = st.stage_id
  join public.pipelines p on p.id = s.pipeline_id
  where st.left_at is not null
    and st.left_at >= st.entered_at
    and (st.left_at at time zone st.timezone)::date between p_from and p_to
  group by p.id, p.name, p.sort, s.id, s.name, s.sort
  order by p.sort, p.name, s.sort, s.name
  limit 300;
$$;

create or replace function public.report_campaigns(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (
  campaign_id uuid, name text, status text, channel_name text, started_at timestamptz,
  total integer, eligible integer, sent integer, delivered integer, read_count integer,
  replied integer, failed integer, skipped integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select c.id, c.name, c.status, c.channel_name, c.started_at,
         r.total, r.eligible, r.sent, r.delivered, r.read_count, r.replied, r.failed, r.skipped
  from public.v_campaign_facts c
  cross join lateral (
    select count(*)::integer as total,
           count(*) filter (where cr.status <> 'skipped')::integer as eligible,
           count(*) filter (where cr.status in ('sent', 'delivered', 'read'))::integer as sent,
           count(*) filter (where cr.status in ('delivered', 'read'))::integer as delivered,
           count(*) filter (where cr.status = 'read')::integer as read_count,
           count(*) filter (where cr.replied_at is not null)::integer as replied,
           count(*) filter (where cr.status = 'failed')::integer as failed,
           count(*) filter (where cr.status = 'skipped')::integer as skipped
    from public.campaign_recipients cr
    where cr.campaign_id = c.id
  ) r
  where c.org_id = p_org
    and c.status <> 'preparing'
    and c.day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or c.channel_id = any (p_channels))
  order by c.placed_at desc, c.id
  limit 100;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'report_enquiries_summary(uuid, date, date, uuid[], uuid[])',
    'report_enquiries_by_day(uuid, date, date, uuid[], uuid[])',
    'report_enquiry_funnel(uuid, date, date, uuid[], uuid[])',
    'report_enquiry_stage_times(uuid, date, date, uuid[], uuid[])',
    'report_campaigns(uuid, date, date, uuid[])'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', sig);
    execute format('grant execute on function public.%s to service_role', sig);
  end loop;
end $$;

-- ======================================================================
-- 20261010001100_task_appointment_link.sql
-- ======================================================================
-- Phase 5b: a task can point at the appointment it was raised for, and the management dashboard can
-- answer "how many enquiries turned into a booking".

-- A failed appointment reminder raises a "call patient" task (lib/jobs/handlers/appointments.ts).
alter table public.tasks add column appointment_id uuid references public.appointments (id) on delete set null;
create trigger tasks_appointment_org_check before insert or update of appointment_id on public.tasks
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
-- One open call task per appointment: the database makes the handler's "already raised" check race-proof.
create unique index tasks_open_call_per_appointment_uidx on public.tasks (appointment_id)
  where appointment_id is not null and type = 'call' and not done;

-- Conversion to appointments (docs/audit/reports.md §5.1b). Appointments carry no enquiry link, so the
-- link is the contact: an enquiry created in the period counts as booked when its contact has a
-- non-cancelled appointment starting after the enquiry was created. Enquiries with no contact never
-- count as booked. Live tables (the period is small); service role only like the other report_* functions.
create or replace function public.report_enquiry_booking_conversion(p_org uuid, p_from date, p_to date)
returns table (created integer, booked integer)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         (count(*) filter (where exists (
            select 1 from public.appointments a
            where a.org_id = p_org and a.contact_id = e.contact_id
              and a.status <> 'cancelled' and a.starts_at >= e.created_at
         )))::integer
  from public.enquiries e
  join public.orgs o on o.id = e.org_id
  where e.org_id = p_org
    and e.deleted_at is null
    and (e.created_at at time zone o.timezone)::date between p_from and p_to;
$$;
revoke all on function public.report_enquiry_booking_conversion(uuid, date, date) from public, anon, authenticated;
grant execute on function public.report_enquiry_booking_conversion(uuid, date, date) to service_role;

-- ======================================================================
-- 20261010001200_finance_ui_views.sql
-- ======================================================================
-- Finance F7: one read-only view that tells a finance user how fresh and how
-- complete the data behind the portal is ("data as of", setup checklist).
--
-- It runs with the owner's rights because the raw tables and credentials are
-- service-only, and exposes nothing but dates, counts and yes/no flags. It is
-- filtered by app.has_perm(org_id, 'finance.view'), so a member only ever sees
-- their own org and only with the Finance permission.

create or replace view public.v_fin_data_freshness with (security_invoker = false) as
select s.org_id,
       s.enabled                                                                   as capture_enabled,
       exists (select 1 from public.integration_accounts a
               where a.org_id = s.org_id and a.kind = 'unite')                     as credentials_configured,
       (select max(b.processed_at) from public.fin_raw_unite_batches b
         where b.org_id = s.org_id and b.process_status = 'processed')             as last_capture_at,
       (select max(f.committed_at) from public.fin_raw_diligence_files f
         where f.org_id = s.org_id and f.status = 'committed')                     as last_import_at,
       (select count(*) from public.fin_raw_unite_batches b where b.org_id = s.org_id)      as batch_count,
       (select count(*) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as invoice_count,
       (select count(*) from public.ins_claim_activities c where c.org_id = s.org_id)       as claim_count,
       (select count(*) from public.fin_ref_branches r
         where r.org_id = s.org_id and r.active and r.unite_clinic_long_name is not null)   as branches_mapped,
       (select count(*) from public.fin_ref_exception_rules x
         where x.org_id = s.org_id and x.active)                                   as active_rules,
       (select count(*) from public.ops_exceptions e
         where e.org_id = s.org_id and e.status in ('open', 'in_progress'))        as open_exceptions
from public.fin_capture_settings s
where app.has_perm(s.org_id, 'finance.view');

revoke all on public.v_fin_data_freshness from anon;
grant select on public.v_fin_data_freshness to authenticated, service_role;

