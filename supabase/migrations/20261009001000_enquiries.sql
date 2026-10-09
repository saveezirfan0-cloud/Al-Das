-- Phase 5: Enquiries (pipelines, stages, enquiries, saved views) and Tasks.
--
-- Status and stage are separate on purpose: status is the outcome (open / won / lost / disqualified),
-- stage is the position inside a pipeline. The DB keeps the invariants the UI relies on:
--   * a stage belongs to the enquiry's pipeline
--   * stage_entered_at moves with the stage, and every stage move is written to enquiry_stage_history
--   * closed_at is set exactly when the status is not open; reasons only exist on lost / disqualified
--   * every referenced contact / channel / location / specialist / service belongs to the same org
-- Writes in the app go through server actions (service role after can()); the policies are the net.

-- ---------------------------------------------------------------------------
-- Pipelines and stages
-- ---------------------------------------------------------------------------

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  sort integer not null default 0,
  card_fields text[] not null default '{}',            -- extra fields shown on Kanban cards
  default_team_id uuid references public.teams (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index pipelines_org_idx on public.pipelines (org_id, sort);

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  pipeline_id uuid not null references public.pipelines (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  color text not null default 'slate',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pipeline_id, name)
);
create index stages_pipeline_idx on public.stages (pipeline_id, sort);

create trigger stages_pipeline_org_check before insert or update of pipeline_id on public.stages
  for each row execute function app.check_parent_org('pipelines', 'pipeline_id');
create trigger pipelines_team_org_check before insert or update of default_team_id on public.pipelines
  for each row execute function app.check_parent_org('teams', 'default_team_id');

-- ---------------------------------------------------------------------------
-- Enquiries
-- ---------------------------------------------------------------------------

-- Per-org running enquiry number (human friendly reference). No policies: only the trigger touches it.
create table public.enquiry_counters (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  last_number bigint not null default 0
);

create table public.enquiries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  number bigint not null default 0,                    -- replaced by the trigger below
  pipeline_id uuid not null references public.pipelines (id) on delete restrict,
  stage_id uuid not null references public.stages (id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'disqualified')),
  lost_reason text check (lost_reason is null or length(lost_reason) <= 300),
  title text not null default '' check (length(title) <= 200),
  contact_id uuid references public.contacts (id) on delete set null,
  channel_id uuid references public.channels (id) on delete set null,
  source text check (source is null or length(source) <= 80),
  location_id uuid references public.locations (id) on delete set null,
  department_id uuid references public.departments (id) on delete set null,
  specialist_id uuid references public.specialists (id) on delete set null,
  service_id uuid references public.services (id) on delete set null,
  appointment_at timestamptz,
  assignee_id uuid references public.profiles (id) on delete set null,
  est_value numeric(12, 2) check (est_value is null or est_value >= 0),
  custom jsonb not null default '{}'::jsonb,
  stage_entered_at timestamptz not null default now(),
  closed_at timestamptz,
  sla_alerted_at timestamptz,                          -- set once per stage visit by the SLA sweep
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(custom) = 'object')
);
create unique index enquiries_org_number_uidx on public.enquiries (org_id, number);
create index enquiries_board_idx on public.enquiries (org_id, pipeline_id, status, stage_id);
create index enquiries_contact_idx on public.enquiries (contact_id, created_at desc);
create index enquiries_assignee_idx on public.enquiries (assignee_id) where assignee_id is not null;
create index enquiries_sla_idx on public.enquiries (stage_entered_at) where status = 'open';

alter table public.timeline_events
  add constraint timeline_events_enquiry_fk foreign key (enquiry_id) references public.enquiries (id) on delete cascade;

create trigger enquiries_pipeline_org_check before insert or update of pipeline_id on public.enquiries
  for each row execute function app.check_parent_org('pipelines', 'pipeline_id');
create trigger enquiries_stage_org_check before insert or update of stage_id on public.enquiries
  for each row execute function app.check_parent_org('stages', 'stage_id');
create trigger enquiries_contact_org_check before insert or update of contact_id on public.enquiries
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger enquiries_channel_org_check before insert or update of channel_id on public.enquiries
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger enquiries_location_org_check before insert or update of location_id on public.enquiries
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger enquiries_department_org_check before insert or update of department_id on public.enquiries
  for each row execute function app.check_parent_org('departments', 'department_id');
create trigger enquiries_specialist_org_check before insert or update of specialist_id on public.enquiries
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger enquiries_service_org_check before insert or update of service_id on public.enquiries
  for each row execute function app.check_parent_org('services', 'service_id');

-- Number assignment (same pattern as appointments).
create or replace function app.assign_enquiry_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.number is null or new.number = 0 then
    insert into public.enquiry_counters as c (org_id, last_number) values (new.org_id, 1)
    on conflict (org_id) do update set last_number = c.last_number + 1
    returning c.last_number into new.number;
  end if;
  return new;
end;
$$;
create trigger enquiries_assign_number before insert on public.enquiries
  for each row execute function app.assign_enquiry_number();

-- The stage must belong to the enquiry's pipeline (and org).
create or replace function app.check_enquiry_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.stages s
    where s.id = new.stage_id and s.pipeline_id = new.pipeline_id and s.org_id = new.org_id
  ) then
    raise exception 'stage does not belong to the enquiry pipeline' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger enquiries_stage_pipeline_check before insert or update of stage_id, pipeline_id on public.enquiries
  for each row execute function app.check_enquiry_stage();

-- Keeps stage_entered_at, closed_at and the reasons consistent whatever wrote the row.
create or replace function app.enquiry_invariants()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.stage_id is distinct from old.stage_id then
    new.stage_entered_at := now();
    new.sla_alerted_at := null;
  end if;
  if new.status = 'open' then
    new.closed_at := null;
    new.lost_reason := null;
  else
    new.closed_at := coalesce(new.closed_at, now());
    if new.status = 'won' then
      new.lost_reason := null;
    end if;
  end if;
  return new;
end;
$$;
create trigger enquiries_invariants before insert or update on public.enquiries
  for each row execute function app.enquiry_invariants();
create trigger enquiries_set_updated_at before update on public.enquiries
  for each row execute function app.set_updated_at();
create trigger pipelines_set_updated_at before update on public.pipelines
  for each row execute function app.set_updated_at();
create trigger stages_set_updated_at before update on public.stages
  for each row execute function app.set_updated_at();

-- Stage history (feeds Phase 10's time-in-stage reports).
create table public.enquiry_stage_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  enquiry_id uuid not null references public.enquiries (id) on delete cascade,
  stage_id uuid references public.stages (id) on delete set null,
  stage_name text not null,                            -- snapshot: stages can be renamed or removed
  entered_at timestamptz not null default now(),
  left_at timestamptz
);
create index enquiry_stage_history_enquiry_idx on public.enquiry_stage_history (enquiry_id, entered_at);

create or replace function app.record_enquiry_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if tg_op = 'UPDATE' then
    if new.stage_id is not distinct from old.stage_id then
      return new;
    end if;
    update public.enquiry_stage_history set left_at = now()
    where enquiry_id = new.id and left_at is null;
  end if;
  select name into v_name from public.stages where id = new.stage_id;
  insert into public.enquiry_stage_history (org_id, enquiry_id, stage_id, stage_name, entered_at)
  values (new.org_id, new.id, new.stage_id, coalesce(v_name, ''), now());
  return new;
end;
$$;
create trigger enquiries_record_stage after insert or update of stage_id on public.enquiries
  for each row execute function app.record_enquiry_stage();

-- Saved views: private, shared with teams, or with everyone.
create table public.enquiry_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  pipeline_id uuid references public.pipelines (id) on delete cascade,
  filter jsonb not null default '{}'::jsonb,
  columns jsonb not null default '[]'::jsonb,
  shared_team_ids uuid[] not null default '{}',
  shared_with_all boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(filter) = 'object'),
  check (jsonb_typeof(columns) = 'array')
);
create index enquiry_views_org_idx on public.enquiry_views (org_id, owner_id);
create trigger enquiry_views_pipeline_org_check before insert or update of pipeline_id on public.enquiry_views
  for each row execute function app.check_parent_org('pipelines', 'pipeline_id');
create trigger enquiry_views_set_updated_at before update on public.enquiry_views
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  type text not null default 'todo' check (type in ('todo', 'call', 'follow_up', 'meeting', 'email', 'other')),
  subject text not null check (length(btrim(subject)) between 1 and 200),
  notes text check (notes is null or length(notes) <= 4000),
  due_at timestamptz,
  assignee_id uuid references public.profiles (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  enquiry_id uuid references public.enquiries (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  done boolean not null default false,
  done_at timestamptz,
  completed_by uuid references public.profiles (id) on delete set null,
  due_notified_at timestamptz,                         -- set once by the due sweep
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (done or done_at is null)
);
create index tasks_org_open_idx on public.tasks (org_id, done, due_at);
create index tasks_assignee_idx on public.tasks (assignee_id, done, due_at) where assignee_id is not null;
create index tasks_enquiry_idx on public.tasks (enquiry_id) where enquiry_id is not null;
create index tasks_contact_idx on public.tasks (contact_id) where contact_id is not null;

create trigger tasks_contact_org_check before insert or update of contact_id on public.tasks
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger tasks_enquiry_org_check before insert or update of enquiry_id on public.tasks
  for each row execute function app.check_parent_org('enquiries', 'enquiry_id');
create trigger tasks_appointment_org_check before insert or update of appointment_id on public.tasks
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- Pipelines and stages are configuration: any member reads, settings.manage writes.
select app.add_tenant_rls('pipelines', 'settings.manage');
select app.add_tenant_rls('stages', 'settings.manage');

alter table public.enquiry_counters enable row level security;   -- no policies: trigger-only

alter table public.enquiries enable row level security;
create policy enquiries_select on public.enquiries for select to authenticated
  using (app.has_perm_wild(org_id, 'enquiries.view'));
create policy enquiries_insert on public.enquiries for insert to authenticated
  with check (app.has_perm_wild(org_id, 'enquiries.manage'));
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm_wild(org_id, 'enquiries.manage'))
  with check (app.has_perm_wild(org_id, 'enquiries.manage'));
create policy enquiries_delete on public.enquiries for delete to authenticated
  using (app.has_perm_wild(org_id, 'enquiries.manage'));

-- History is written by the security-definer trigger; readers need enquiries.view.
alter table public.enquiry_stage_history enable row level security;
create policy enquiry_stage_history_select on public.enquiry_stage_history for select to authenticated
  using (app.has_perm_wild(org_id, 'enquiries.view'));

alter table public.enquiry_views enable row level security;
create policy enquiry_views_select on public.enquiry_views for select to authenticated
  using (
    app.is_org_member(org_id) and app.has_perm_wild(org_id, 'enquiries.view') and (
      owner_id = auth.uid()
      or shared_with_all
      or shared_team_ids && array(select app.user_team_ids(org_id))
    )
  );
create policy enquiry_views_insert on public.enquiry_views for insert to authenticated
  with check (owner_id = auth.uid() and app.has_perm_wild(org_id, 'enquiries.view'));
create policy enquiry_views_update on public.enquiry_views for update to authenticated
  using (owner_id = auth.uid() and app.is_org_member(org_id))
  with check (owner_id = auth.uid() and app.is_org_member(org_id));
create policy enquiry_views_delete on public.enquiry_views for delete to authenticated
  using (owner_id = auth.uid() and app.is_org_member(org_id));

alter table public.tasks enable row level security;
create policy tasks_select on public.tasks for select to authenticated
  using (app.has_perm_wild(org_id, 'tasks.manage') or (assignee_id = auth.uid() and app.is_org_member(org_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.has_perm_wild(org_id, 'tasks.manage'));
create policy tasks_update on public.tasks for update to authenticated
  using (app.has_perm_wild(org_id, 'tasks.manage'))
  with check (app.has_perm_wild(org_id, 'tasks.manage'));
create policy tasks_delete on public.tasks for delete to authenticated
  using (app.has_perm_wild(org_id, 'tasks.manage'));

-- ---------------------------------------------------------------------------
-- Realtime (board and task list refresh) and the housekeeping sweep (SLA + task due notices)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.enquiries;
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

select cron.schedule('pulse:enquiries_housekeeping', '*/5 * * * *', $$select app.ping_jobs('enquiries_housekeeping')$$);
