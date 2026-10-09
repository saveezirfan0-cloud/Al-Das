-- Phase 5 / 1: enquiries + tasks.
-- pipelines + stages, enquiries (per-org numbering, SLA columns), saved views,
-- assignment rules, tasks, search RPCs and realtime. Every table carries org_id
-- and is protected by RLS keyed on memberships; cross-table FKs are org-checked.
-- The location / department / specialist / service lists are Phase 6's tables
-- (20261009000910_appointments.sql); enquiries reference them.

-- ---------------------------------------------------------------------------
-- Pipelines and stages
-- ---------------------------------------------------------------------------

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  card_fields text[] not null default '{number,contact,source,created_at}',
  sla_minutes integer check (sla_minutes is null or sla_minutes between 1 and 10080),  -- overrides the org default
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index pipelines_one_default_uidx on public.pipelines (org_id) where is_default;

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  pipeline_id uuid not null references public.pipelines (id) on delete cascade,
  name text not null,
  color text not null default 'gray',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pipeline_id, name)
);
create index stages_pipeline_idx on public.stages (pipeline_id, sort);

-- ---------------------------------------------------------------------------
-- Enquiries
-- ---------------------------------------------------------------------------

create table public.enquiry_counters (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  last_number integer not null default 0
);

create table public.enquiries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  number integer not null default 0,                  -- per-org; 0 = assign the next number (trigger)
  pipeline_id uuid not null references public.pipelines (id) on delete restrict,
  stage_id uuid not null references public.stages (id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'disqualified')),
  lost_reason text,
  contact_id uuid references public.contacts (id) on delete set null,
  title text not null,
  channel_id uuid references public.channels (id) on delete set null,
  source text,
  assignee_id uuid references public.profiles (id) on delete set null,
  est_value numeric(12, 2) check (est_value is null or est_value >= 0),
  location_id uuid references public.locations (id) on delete set null,
  department_id uuid references public.departments (id) on delete set null,
  specialist_id uuid references public.specialists (id) on delete set null,
  service_id uuid references public.services (id) on delete set null,
  appt_date timestamptz,
  custom jsonb not null default '{}'::jsonb,
  stage_entered_at timestamptz not null default now(),
  closed_at timestamptz,
  sla_due_at timestamptz,                             -- created_at + SLA; cleared once first_touch_at is set
  first_touch_at timestamptz,
  sla_breached_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  check (jsonb_typeof(custom) = 'object'),
  -- lost / disqualified always carry a reason; open / won never do.
  check (
    (status in ('lost', 'disqualified') and lost_reason is not null and btrim(lost_reason) <> '')
    or (status in ('open', 'won') and lost_reason is null)
  ),
  check ((status = 'open') = (closed_at is null))
);
create index enquiries_board_idx on public.enquiries (org_id, pipeline_id, stage_id, stage_entered_at desc)
  where deleted_at is null and status = 'open';
create index enquiries_org_created_idx on public.enquiries (org_id, created_at desc) where deleted_at is null;
create index enquiries_assignee_idx on public.enquiries (org_id, assignee_id) where deleted_at is null;
create index enquiries_contact_idx on public.enquiries (contact_id) where contact_id is not null;
create index enquiries_sla_idx on public.enquiries (sla_due_at) where sla_due_at is not null and first_touch_at is null and status = 'open';
create index enquiries_custom_gin_idx on public.enquiries using gin (custom jsonb_path_ops);
create index enquiries_title_trgm_idx on public.enquiries using gin (title gin_trgm_ops);

-- Next per-org enquiry number. Service role only; the BEFORE INSERT trigger below is the usual caller.
create or replace function app.next_enquiry_number(p_org_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.enquiry_counters (org_id, last_number) values (p_org_id, 1)
  on conflict (org_id) do update set last_number = public.enquiry_counters.last_number + 1
  returning last_number;
$$;
revoke all on function app.next_enquiry_number(uuid) from public, anon, authenticated;
grant execute on function app.next_enquiry_number(uuid) to service_role;

-- Numbering, stage ↔ pipeline consistency, stage timing and status bookkeeping.
create or replace function app.enquiries_normalize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and coalesce(new.number, 0) = 0 then
    new.number := app.next_enquiry_number(new.org_id);
  end if;
  if not exists (
    select 1 from public.stages s
    where s.id = new.stage_id and s.pipeline_id = new.pipeline_id and s.org_id = new.org_id
  ) then
    raise exception 'stage % does not belong to pipeline % in org %', new.stage_id, new.pipeline_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.stage_id is distinct from old.stage_id or new.pipeline_id is distinct from old.pipeline_id) then
    new.stage_entered_at := now();
  end if;
  if new.status = 'open' then
    new.closed_at := null;
    new.lost_reason := null;
  else
    if new.closed_at is null then
      new.closed_at := now();
    end if;
    if new.status = 'won' then
      new.lost_reason := null;
    end if;
  end if;
  if new.lost_reason is not null then
    new.lost_reason := btrim(new.lost_reason);
  end if;
  new.title := btrim(new.title);
  return new;
end;
$$;
create trigger enquiries_normalize before insert or update on public.enquiries
  for each row execute function app.enquiries_normalize();

-- Assignees must belong to the org (profiles are global).
create or replace function app.check_member_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  v_user := (to_jsonb(new) ->> tg_argv[0])::uuid;
  if v_user is null then
    return new;
  end if;
  if not exists (select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = v_user) then
    raise exception 'user % is not a member of org %', v_user, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create table public.enquiry_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  pipeline_id uuid references public.pipelines (id) on delete set null,
  mode text not null default 'kanban' check (mode in ('kanban', 'table')),
  filter jsonb not null default '{}'::jsonb,          -- lib/filters AST
  columns jsonb not null default '[]'::jsonb,         -- visible table columns, in order
  shared_team_ids uuid[] not null default '{}',
  shared_all boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(columns) = 'array')
);
create index enquiry_views_org_idx on public.enquiry_views (org_id);

-- First matching enabled rule (lowest sort) assigns a new enquiry.
create table public.enquiry_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  enabled boolean not null default true,
  conditions jsonb not null default '{}'::jsonb,      -- {"pipeline_ids":[],"sources":[],"channel_ids":[],"location_ids":[],"department_ids":[]}
  action jsonb not null,                              -- {"type":"user","user_id":"…"} | {"type":"team_round_robin","team_id":"…"}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(conditions) = 'object'),
  check (jsonb_typeof(action) = 'object')
);
create index enquiry_assignment_rules_org_idx on public.enquiry_assignment_rules (org_id, sort);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  type text not null default 'follow_up' check (type in ('call', 'follow_up', 'email', 'meeting', 'other')),
  subject text not null,
  notes text,
  due_at timestamptz not null,
  assignee_id uuid references public.profiles (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  enquiry_id uuid references public.enquiries (id) on delete cascade,
  done boolean not null default false,
  done_at timestamptz,
  completed_by uuid references public.profiles (id) on delete set null,
  due_notified_for timestamptz,                       -- the due_at the reminder last fired for
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (done = (done_at is not null))
);
create index tasks_open_due_idx on public.tasks (org_id, due_at) where not done;
create index tasks_assignee_idx on public.tasks (org_id, assignee_id, due_at) where not done;
create index tasks_enquiry_idx on public.tasks (enquiry_id) where enquiry_id is not null;
create index tasks_contact_idx on public.tasks (contact_id) where contact_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at + org integrity triggers
-- ---------------------------------------------------------------------------

create trigger pipelines_set_updated_at before update on public.pipelines for each row execute function app.set_updated_at();
create trigger stages_set_updated_at before update on public.stages for each row execute function app.set_updated_at();
create trigger enquiries_set_updated_at before update on public.enquiries for each row execute function app.set_updated_at();
create trigger enquiry_views_set_updated_at before update on public.enquiry_views for each row execute function app.set_updated_at();
create trigger enquiry_assignment_rules_set_updated_at before update on public.enquiry_assignment_rules for each row execute function app.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks for each row execute function app.set_updated_at();

create trigger stages_pipeline_org_check before insert or update of pipeline_id on public.stages
  for each row execute function app.check_parent_org('pipelines', 'pipeline_id');

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
create trigger enquiries_assignee_member_check before insert or update of assignee_id on public.enquiries
  for each row execute function app.check_member_org('assignee_id');

create trigger enquiry_views_pipeline_org_check before insert or update of pipeline_id on public.enquiry_views
  for each row execute function app.check_parent_org('pipelines', 'pipeline_id');

create trigger tasks_contact_org_check before insert or update of contact_id on public.tasks
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger tasks_enquiry_org_check before insert or update of enquiry_id on public.tasks
  for each row execute function app.check_parent_org('enquiries', 'enquiry_id');
create trigger tasks_assignee_member_check before insert or update of assignee_id on public.tasks
  for each row execute function app.check_member_org('assignee_id');

-- Timeline rows may now belong to an enquiry without a contact.
alter table public.timeline_events alter column contact_id drop not null;
alter table public.timeline_events
  add constraint timeline_events_subject_check check (contact_id is not null or enquiry_id is not null);
alter table public.timeline_events
  add constraint timeline_events_enquiry_fk foreign key (enquiry_id) references public.enquiries (id) on delete cascade;
create trigger timeline_events_enquiry_org_check before insert or update of enquiry_id on public.timeline_events
  for each row execute function app.check_parent_org('enquiries', 'enquiry_id');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.pipelines enable row level security;
alter table public.stages enable row level security;
alter table public.enquiry_counters enable row level security;
alter table public.enquiries enable row level security;
alter table public.enquiry_views enable row level security;
alter table public.enquiry_assignment_rules enable row level security;
alter table public.tasks enable row level security;

-- Pipelines and stages: enquiry readers see them; settings.manage edits.
create policy pipelines_select on public.pipelines for select to authenticated using (app.has_perm(org_id, 'enquiries.view'));
create policy pipelines_insert on public.pipelines for insert to authenticated with check (app.has_perm(org_id, 'settings.manage'));
create policy pipelines_update on public.pipelines for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
create policy pipelines_delete on public.pipelines for delete to authenticated using (app.has_perm(org_id, 'settings.manage'));

create policy stages_select on public.stages for select to authenticated using (app.has_perm(org_id, 'enquiries.view'));
create policy stages_insert on public.stages for insert to authenticated with check (app.has_perm(org_id, 'settings.manage'));
create policy stages_update on public.stages for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
create policy stages_delete on public.stages for delete to authenticated using (app.has_perm(org_id, 'settings.manage'));

-- enquiry_counters: no policies — only the service role and the numbering trigger touch it.

-- enquiries: enquiries.view reads, enquiries.manage creates/edits, enquiries.delete removes.
create policy enquiries_select on public.enquiries for select to authenticated using (app.has_perm(org_id, 'enquiries.view'));
create policy enquiries_insert on public.enquiries for insert to authenticated with check (app.has_perm(org_id, 'enquiries.manage'));
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm(org_id, 'enquiries.manage')) with check (app.has_perm(org_id, 'enquiries.manage'));
create policy enquiries_delete on public.enquiries for delete to authenticated using (app.has_perm(org_id, 'enquiries.delete'));

-- Saved views: owner, everyone (shared_all) or the owner's teams. Writes are server-side (service role after can()).
create policy enquiry_views_select on public.enquiry_views for select to authenticated
  using (
    app.has_perm(org_id, 'enquiries.view') and (
      owner_id = auth.uid() or shared_all
      or shared_team_ids && array(select app.user_team_ids(org_id))
    )
  );

create policy enquiry_assignment_rules_select on public.enquiry_assignment_rules for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));
create policy enquiry_assignment_rules_insert on public.enquiry_assignment_rules for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy enquiry_assignment_rules_update on public.enquiry_assignment_rules for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
create policy enquiry_assignment_rules_delete on public.enquiry_assignment_rules for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

create policy tasks_select on public.tasks for select to authenticated using (app.has_perm(org_id, 'tasks.view'));
create policy tasks_insert on public.tasks for insert to authenticated with check (app.has_perm(org_id, 'tasks.manage'));
create policy tasks_update on public.tasks for update to authenticated
  using (app.has_perm(org_id, 'tasks.manage')) with check (app.has_perm(org_id, 'tasks.manage'));
create policy tasks_delete on public.tasks for delete to authenticated using (app.has_perm(org_id, 'tasks.manage'));

-- ---------------------------------------------------------------------------
-- Search RPCs (service role only). Same contract as contacts_search: the WHERE
-- fragment comes from lib/filters (to-sql.ts) over alias `e`; values travel in
-- p_params ($1). The functions pin org_id and soft-deletes themselves.
-- p_q is free text (number, title, contact name/phone); LIKE wildcards are escaped by the caller.
-- ---------------------------------------------------------------------------

create or replace function public.enquiries_search(
  p_org_id uuid,
  p_where text,
  p_params jsonb,
  p_order_by text default 'e.stage_entered_at desc',
  p_limit integer default 100,
  p_offset integer default 0,
  p_q text default null,
  p_stage_id uuid default null
)
returns table (id uuid, total bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  if p_order_by is null or btrim(p_order_by) = '' then
    p_order_by := 'e.stage_entered_at desc';
  end if;
  if p_order_by !~ '^[A-Za-z0-9_.(),''%>=:* \-]+$' or p_order_by ~ ';' then
    raise exception 'invalid order by' using errcode = 'check_violation';
  end if;
  return query execute format(
    'select e.id, count(*) over() as total
       from public.enquiries e
       left join public.contacts ct on ct.id = e.contact_id
      where e.org_id = $2 and e.deleted_at is null and (%s)
        and ($6::uuid is null or e.stage_id = $6)
        and ($5::text is null or e.title ilike ''%%'' || $5 || ''%%'' or e.number::text = $5
             or ct.full_name ilike ''%%'' || $5 || ''%%'' or ct.phone_e164 like ''%%'' || $5 || ''%%'')
      order by %s, e.id limit $3 offset $4',
    p_where, p_order_by
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, greatest(1, least(coalesce(p_limit, 100), 1000)),
          greatest(0, coalesce(p_offset, 0)), nullif(btrim(p_q), ''), p_stage_id;
end;
$$;
revoke all on function public.enquiries_search(uuid, text, jsonb, text, integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.enquiries_search(uuid, text, jsonb, text, integer, integer, text, uuid) to service_role;

create or replace function public.enquiries_count(p_org_id uuid, p_where text, p_params jsonb, p_q text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  execute format(
    'select count(*) from public.enquiries e left join public.contacts ct on ct.id = e.contact_id
      where e.org_id = $2 and e.deleted_at is null and (%s)
        and ($3::text is null or e.title ilike ''%%'' || $3 || ''%%'' or e.number::text = $3
             or ct.full_name ilike ''%%'' || $3 || ''%%'' or ct.phone_e164 like ''%%'' || $3 || ''%%'')',
    p_where
  ) into v_count using coalesce(p_params, '[]'::jsonb), p_org_id, nullif(btrim(p_q), '');
  return v_count;
end;
$$;
revoke all on function public.enquiries_count(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.enquiries_count(uuid, text, jsonb, text) to service_role;

-- Matching ids (exports, bulk "select all N").
create or replace function public.enquiries_ids(p_org_id uuid, p_where text, p_params jsonb, p_q text default null, p_limit integer default 50000)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  return query execute format(
    'select e.id from public.enquiries e left join public.contacts ct on ct.id = e.contact_id
      where e.org_id = $2 and e.deleted_at is null and (%s)
        and ($3::text is null or e.title ilike ''%%'' || $3 || ''%%'' or e.number::text = $3
             or ct.full_name ilike ''%%'' || $3 || ''%%'' or ct.phone_e164 like ''%%'' || $3 || ''%%'')
      order by e.created_at, e.id limit $4',
    p_where
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, nullif(btrim(p_q), ''), greatest(1, coalesce(p_limit, 50000));
end;
$$;
revoke all on function public.enquiries_ids(uuid, text, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.enquiries_ids(uuid, text, jsonb, text, integer) to service_role;

-- Per-stage counts for the Kanban column headers.
create or replace function public.enquiries_stage_counts(p_org_id uuid, p_where text, p_params jsonb, p_q text default null)
returns table (stage_id uuid, total bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  return query execute format(
    'select e.stage_id, count(*) from public.enquiries e left join public.contacts ct on ct.id = e.contact_id
      where e.org_id = $2 and e.deleted_at is null and (%s)
        and ($3::text is null or e.title ilike ''%%'' || $3 || ''%%'' or e.number::text = $3
             or ct.full_name ilike ''%%'' || $3 || ''%%'' or ct.phone_e164 like ''%%'' || $3 || ''%%'')
      group by e.stage_id',
    p_where
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, nullif(btrim(p_q), '');
end;
$$;
revoke all on function public.enquiries_stage_counts(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.enquiries_stage_counts(uuid, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Existing orgs: new permission keys on the system roles (custom roles are left alone).
-- tasks.view follows tasks.manage; export/delete go to Manager only.
-- ---------------------------------------------------------------------------

update public.roles
set permissions = permissions || '["tasks.view"]'::jsonb
where is_system and permissions ? 'tasks.manage' and not (permissions ? 'tasks.view');

update public.roles
set permissions = permissions || '["enquiries.export", "enquiries.delete"]'::jsonb
where is_system and name = 'Manager' and permissions ? 'enquiries.manage'
  and not (permissions ? 'enquiries.export');

-- ---------------------------------------------------------------------------
-- Realtime: enquiries and tasks stream to the board and task list (RLS applies).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.enquiries;
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
alter table public.enquiries replica identity full;
alter table public.tasks replica identity full;
