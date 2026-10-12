-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.

-- ======================================================================
-- 20261010000200_templates.sql
-- ======================================================================
-- Phase 4: template builder — authoring metadata on wa_templates and the nightly Meta sync.
--
-- wa_templates already mirrors Meta (Phase 3). The builder adds local drafts (status 'DRAFT',
-- no meta_template_id), who authored a template, when it was last submitted, and which
-- gallery entry it started from. RLS is unchanged: members read, templates.manage writes
-- (the app writes through server actions with the service role after can()).

alter table public.wa_templates
  add column created_by uuid references public.profiles (id) on delete set null,
  add column submitted_at timestamptz,
  add column gallery_key text;

create index wa_templates_waba_status_idx on public.wa_templates (org_id, waba_id, status) where archived_at is null;

-- Nightly pull of every WABA's templates (statuses and categories can change without a webhook).
select cron.schedule('pulse:templates_sync', '40 3 * * *', $$select app.ping_jobs('templates_sync')$$);

-- ======================================================================
-- 20261010000300_enquiries.sql
-- ======================================================================
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

-- ======================================================================
-- 20261010000400_portal_ref_tables.sql
-- ======================================================================
-- Phase 9: clinical reference tables (promoted from supabase/drafts/0100_clinical_reference.sql).
-- ref_condition_groups, ref_diagnoses, ref_medications, ref_items and seed_condition_groups().
-- The helpers (app.has_perm_wild, app.add_tenant_rls), ref_medication_classes and clinical_settings
-- already exist from Phase 6 (20261009000900_rls_helpers, 20261009000950_clinical_core), so they are
-- not repeated here. Reference data is written by the importer / Unite sync (service role) and, in
-- the portal, through lib/portal/service after a can() check; staff members only read it via RLS.

-- ---------------------------------------------------------------------------
-- ref_condition_groups — "Mapped condition group" (Unite.Diagnosis fldyz11Dj5wK2y2S8)
-- messageable=false for the mental-health groups that Chronic Recall Groups strips.
-- ---------------------------------------------------------------------------
create table if not exists public.ref_condition_groups (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  key                          text not null,                 -- stable snake_case key used as recall segment_key
  name                         text not null,                 -- Airtable choice name, verbatim
  messageable                  boolean not null default true,
  sort                         int  not null default 100,     -- primary-condition priority (OQ-15)
  follow_up_interval_days      int,                           -- "Every 3 months" → 90
  regular_medication_examples  text,
  monitoring_labs_cpt          text,
  monitoring_procedures_cpt    text,
  typical_visit_cpt            text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, name)
);

-- ---------------------------------------------------------------------------
-- ref_diagnoses — Unite.Diagnosis (tblZqf4Zcw5Kweadh), ICD-10 FY2026
-- ---------------------------------------------------------------------------
create table if not exists public.ref_diagnoses (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  code                 text not null,                          -- fldld9DKnsoLK9ADK
  short_description    text,                                   -- fldlgGXBFovQBgr7N
  long_description     text,                                   -- fldXgTWsfTbPrlreE
  chronic              boolean not null default false,         -- fldIGBzWtu2QFP0Yk
  top30                boolean not null default false,         -- fldFVPiTP5g4AGaV2
  condition_group_id   uuid references public.ref_condition_groups(id),
  not_found_in_unite   boolean not null default false,         -- fldgC3rVdSM5ehgtQ "NF" (OQ-27)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, code)
);
create index if not exists ref_diagnoses_group_idx on public.ref_diagnoses (org_id, condition_group_id) where chronic;

-- ---------------------------------------------------------------------------
-- ref_medications — Unite.Medication (tblLM2BXjA680GQws), DDC/local codes
-- ---------------------------------------------------------------------------
create table if not exists public.ref_medications (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  ddc_code             text not null,                          -- fld7kgxlA3c0kjFdW (Unite local code)
  trade_name           text,                                   -- fldvBHlyQEFGX1UFS
  status               text,                                   -- fldDwPzpHS7bHGZbj
  scientific_code      text,                                   -- fld6erxHG8rlNl7Zr
  scientific_name      text,                                   -- fldIea5PEr6Tk50tY
  strength             text,                                   -- fldsXKIf7k6HF3jhW
  dosage_form          text,                                   -- fld7ovnGh11wewXqw
  route                text,                                   -- flduJNhd0tBaFqDoT
  package_price        numeric(12,2),                          -- fldQPwna6WcQkIsrb
  granular_unit        text,                                   -- fldGFRp4X68CfAO6k
  registered_owner     text,                                   -- fldlWj6a725a6l54H
  source_updated_on    date,                                   -- fldGvn9X6b6sNY9Xi
  source               text,                                   -- fldkhVVFyNnSz5T4n
  is_ebp               boolean,                                -- fldQQsGZMJDEmcIkL
  medicine_type        text,                                   -- fldOr4Wf4rSrjTDwV  (advisory only, R-05)
  all_medicine_types   text[],                                 -- fld15ltyTEfiugYam  split on ' + '
  icd_codes            text,                                   -- fldma2rcVXZDIDsuY
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, ddc_code)
);

-- ---------------------------------------------------------------------------
-- ref_items — Unite.Items (tblTJtk6aIMbwpoA2) merged with PTF.CPT Master (tblopYbHPAbTi4QeX)
-- ---------------------------------------------------------------------------
create table if not exists public.ref_items (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.orgs(id) on delete cascade,
  code                    text not null,                       -- fld0i0BQItTWZpTm5 / fldjaLpahs9NgSFAF
  description             text,                                -- fldB4i14uDiaFt0Qv / fldX4POEMd2VY8FKc
  item_type               text,                                -- fldDUW6cM6saCg5m8 normalised (TEST, RADIOLOGY, PROCEDURES, DRUGS, VACCINE, CONSUMABLES, SERVICE, …)
  test_category           text,                                -- fldqsVvaiGRe59o9w (CPT Master)
  patient_message_group   text,                                -- fldyLyowekQPhpFnr (CPT Master)
  doctor_verified         boolean not null default false,      -- fldi4vFfiPdSU7ZxC "must be checked by a doctor before use in live automations"
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, code)
);

-- RLS: members read; no direct write policy (service role only, like the other sync-owned tables).
select app.add_tenant_rls('ref_condition_groups');
select app.add_tenant_rls('ref_diagnoses');
select app.add_tenant_rls('ref_medications');
select app.add_tenant_rls('ref_items');

-- ---------------------------------------------------------------------------
-- Seed helper: condition groups (names verbatim from the Airtable select).
-- Run per org from the importer: select public.seed_condition_groups('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_condition_groups(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.ref_condition_groups (org_id, key, name, messageable, sort, follow_up_interval_days)
  values
    (p_org, 'hypertension',   'Hypertension / Hypertensive disease',  true,  10, 90),
    (p_org, 'diabetes',       'Diabetes mellitus (Type 1/2/other)',    true,  20, 90),
    (p_org, 'hyperlipidemia', 'Hyperlipidemia',                        true,  30, 90),
    (p_org, 'hypothyroidism', 'Hypothyroidism',                        true,  40, 90),
    (p_org, 'ckd',            'Chronic kidney disease',                true,  50, 90),
    (p_org, 'asthma',         'Asthma',                                true,  60, 90),
    (p_org, 'copd',           'COPD',                                  true,  70, 90),
    (p_org, 'ra',             'Rheumatoid arthritis',                  true,  80, 90),
    (p_org, 'af',             'Atrial fibrillation / flutter',         true,  90, 90),
    (p_org, 'epilepsy',       'Epilepsy',                              true, 100, 90),
    (p_org, 'depression',     'Depression (major)',                    false, 900, 90),  -- never messaged (R-20, OQ-25)
    (p_org, 'anxiety',        'Anxiety disorders',                     false, 910, 90)   -- never messaged
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_condition_groups(uuid) from public, anon, authenticated;
grant execute on function public.seed_condition_groups(uuid) to service_role;

-- ======================================================================
-- 20261010000500_portal_framework.sql
-- ======================================================================
-- Phase 9: back-office portal framework.
-- Registry (portal_objects), saved views, generic timeline / comments / attachments for any
-- portal record, a table-agnostic search RPC, and the first Airtable-derived config table
-- (website_entry_points). Reference tables come from migration ...1000 (portal_ref_tables).
--
-- Permissions: read = the object's read_perm (portal.<key>.read by default; PHI-adjacent objects
-- can name a stricter key), write = its write_perm. RLS uses app.has_perm_wild (Phase 6) so
-- 'portal.*' and 'portal.*.read' (roles Manager / Agent) are honoured in SQL like lib/auth/can.ts.

-- ---------------------------------------------------------------------------
-- portal_objects — which tables the portal exposes, per org. Column definitions (types,
-- labels, links) live in code (lib/portal/objects/*); this row says "enabled here, with
-- these permission keys". `config` holds per-org overrides (hidden columns, default sort).
-- ---------------------------------------------------------------------------
create table public.portal_objects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,48}$'),
  label text not null,
  icon text,
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  source_airtable_table text,                        -- '<baseId>.<tableId>' for provenance
  read_perm text not null,
  write_perm text,                                   -- null = read-only in the portal
  enabled boolean not null default true,
  sort integer not null default 100,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);
create trigger portal_objects_set_updated_at before update on public.portal_objects
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- saved_views — per-object filter / columns / sort, private or shared (modelled on inbox_views).
-- ---------------------------------------------------------------------------
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  object_key text not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  filter jsonb not null default '{}'::jsonb,
  columns jsonb not null default '[]'::jsonb,        -- [{id, hidden?, width?}] in display order
  sort jsonb not null default '[]'::jsonb,           -- [{field, dir}]
  shared_team_ids uuid[] not null default '{}',
  shared_all boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_views_object_idx on public.saved_views (org_id, object_key);
create trigger saved_views_set_updated_at before update on public.saved_views
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Generic record timeline, comments and attachments (portal records are not contacts, so
-- timeline_events / mentions / the wa-media bucket do not fit).
-- ---------------------------------------------------------------------------
create table public.portal_record_events (
  id bigserial primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  object_key text not null,
  record_id uuid not null,
  type text not null,                                -- created | updated | deleted | comment | attachment | imported
  actor_id uuid references public.profiles (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,        -- field names + old/new values; never message bodies or tokens
  created_at timestamptz not null default now()
);
create index portal_record_events_record_idx
  on public.portal_record_events (org_id, object_key, record_id, created_at desc);

create table public.portal_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  object_key text not null,
  record_id uuid not null,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  mentioned_user_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index portal_comments_record_idx
  on public.portal_comments (org_id, object_key, record_id, created_at) where deleted_at is null;
create trigger portal_comments_set_updated_at before update on public.portal_comments
  for each row execute function app.set_updated_at();

create table public.portal_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  object_key text not null,
  record_id uuid not null,
  path text not null,                                -- <org_id>/<object_key>/<record_id>/<uuid>.<ext> in bucket portal-files
  file_name text not null,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, path)
);
create index portal_attachments_record_idx
  on public.portal_attachments (org_id, object_key, record_id, created_at);

-- ---------------------------------------------------------------------------
-- website_entry_points — Campaigns.Website (tblpWst9QqYNuKpwZ): which wa.me entry point routes
-- to which team. See docs/audit/data-model-mapping.md §2.3.
-- ---------------------------------------------------------------------------
create table public.website_entry_points (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  section text not null,                             -- fld44pzWF1WiW96XW "01. General Booking"
  source_key text not null,                          -- fld87i81Uv5xEbCjh "DoctorProfile — <name>"
  channel_phone text,                                -- fldeVUgOhIlFt0fPu (clinic number, display form)
  channel_id uuid references public.channels (id) on delete set null,
  prefill_message text,                              -- fldMXt1bD5N6aTNbR wa.me prefilled text
  route_to text,                                     -- fldySS9CEPFLYnWVP "Nursing team", "<Doctor> schedule"
  route_team_id uuid references public.teams (id) on delete set null,
  priority_key text,                                 -- fld4cpDJ3LsB3Fq7k "1 - Doctor Name"
  is_dynamic boolean not null default false,         -- fld6BmbGE4MDFZENr Yes/No
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, section, source_key)
);
create index website_entry_points_org_idx on public.website_entry_points (org_id, section);
create trigger website_entry_points_channel_org_check before insert or update on public.website_entry_points
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger website_entry_points_team_org_check before insert or update on public.website_entry_points
  for each row execute function app.check_parent_org('teams', 'route_team_id');
select app.add_tenant_rls('website_entry_points', 'portal.website_entry_points.write');

-- ---------------------------------------------------------------------------
-- RLS for the portal tables. Writes go through the service role after can() checks, except
-- nothing here is writable by `authenticated` directly.
-- ---------------------------------------------------------------------------
-- Can the caller read this portal object? Looks the permission up in portal_objects so objects
-- with a stricter read key (e.g. medication classes) stay consistent across comments, timeline,
-- attachments and saved views.
create or replace function app.portal_can_read(p_org_id uuid, p_object_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.portal_objects po
    where po.org_id = p_org_id and po.key = p_object_key
      and app.has_perm_wild(p_org_id, po.read_perm)
  );
$$;
grant execute on function app.portal_can_read(uuid, text) to authenticated, service_role;

alter table public.portal_objects enable row level security;
alter table public.saved_views enable row level security;
alter table public.portal_record_events enable row level security;
alter table public.portal_comments enable row level security;
alter table public.portal_attachments enable row level security;

create policy portal_objects_select on public.portal_objects for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm_wild(org_id, read_perm));

create policy saved_views_select on public.saved_views for select to authenticated
  using (
    app.portal_can_read(org_id, object_key) and (
      owner_id = auth.uid() or shared_all
      or shared_team_ids && array(select app.user_team_ids(org_id))
    )
  );

create policy portal_record_events_select on public.portal_record_events for select to authenticated
  using (app.portal_can_read(org_id, object_key));
create policy portal_comments_select on public.portal_comments for select to authenticated
  using (deleted_at is null and app.portal_can_read(org_id, object_key));
create policy portal_attachments_select on public.portal_attachments for select to authenticated
  using (app.portal_can_read(org_id, object_key));

-- ---------------------------------------------------------------------------
-- Table-agnostic search for portal lists / exports. Service role only: the table comes from
-- portal_objects (org-scoped, validated, existence-checked), never from the caller. The WHERE
-- text is produced by lib/filters (parameterised over $1) and ORDER BY is allow-listed, the
-- same contract as contacts_search.
-- ---------------------------------------------------------------------------
create or replace function app.portal_table(p_org_id uuid, p_object_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  select table_name into v_table
  from public.portal_objects
  where org_id = p_org_id and key = p_object_key and enabled;
  if v_table is null or v_table !~ '^[a-z][a-z0-9_]{0,62}$'
     or to_regclass(format('public.%I', v_table)) is null then
    raise exception 'unknown portal object' using errcode = 'no_data_found';
  end if;
  return v_table;
end;
$$;
revoke all on function app.portal_table(uuid, text) from public, anon, authenticated;
grant execute on function app.portal_table(uuid, text) to service_role;

create or replace function public.portal_search(
  p_org_id uuid,
  p_object_key text,
  p_where text,
  p_params jsonb,
  p_order_by text,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (row_data jsonb, total bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := app.portal_table(p_org_id, p_object_key);
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  if p_order_by is null or btrim(p_order_by) = '' then
    p_order_by := 'c.created_at desc';
  end if;
  if p_order_by !~ '^[A-Za-z0-9_.(),''%>=:* \-]+$' or p_order_by ~ ';' then
    raise exception 'invalid order by' using errcode = 'check_violation';
  end if;
  return query execute format(
    'select to_jsonb(c), count(*) over() as total from public.%I c where c.org_id = $2 and (%s) order by %s, c.id limit $3 offset $4',
    v_table, p_where, p_order_by
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, greatest(1, least(coalesce(p_limit, 100), 1000)), greatest(0, coalesce(p_offset, 0));
end;
$$;
revoke all on function public.portal_search(uuid, text, text, jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.portal_search(uuid, text, text, jsonb, text, integer, integer) to service_role;

create or replace function public.portal_count(p_org_id uuid, p_object_key text, p_where text, p_params jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := app.portal_table(p_org_id, p_object_key);
  v_count bigint;
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  execute format('select count(*) from public.%I c where c.org_id = $2 and (%s)', v_table, p_where)
    into v_count using coalesce(p_params, '[]'::jsonb), p_org_id;
  return v_count;
end;
$$;
revoke all on function public.portal_count(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.portal_count(uuid, text, text, jsonb) to service_role;

create or replace function public.portal_ids(p_org_id uuid, p_object_key text, p_where text, p_params jsonb, p_limit integer default 50000)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := app.portal_table(p_org_id, p_object_key);
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  return query execute format(
    'select c.id from public.%I c where c.org_id = $2 and (%s) order by c.created_at, c.id limit $3',
    v_table, p_where
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, greatest(1, coalesce(p_limit, 50000));
end;
$$;
revoke all on function public.portal_ids(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.portal_ids(uuid, text, text, jsonb, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Registration of the generic portal objects. Clinical settings, the Follow-Up Queue and Sync
-- Review have dedicated Phase 6 screens (app/(app)/portal/*) and are not repeated here.
-- Run per org (importer, org bootstrap, seed): select public.seed_portal_objects('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_portal_objects(p_org uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.portal_objects
    (org_id, key, label, icon, table_name, source_airtable_table, read_perm, write_perm, sort)
  values
    (p_org, 'ref_diagnoses',         'Diagnoses (ICD-10)',   'stethoscope', 'ref_diagnoses',         'app7QJ2pvhADHQeBP.tblZqf4Zcw5Kweadh', 'portal.ref_diagnoses.read',         'portal.ref_diagnoses.write',         10),
    (p_org, 'ref_condition_groups',  'Condition groups',     'layers',      'ref_condition_groups',  'app7QJ2pvhADHQeBP.tblZqf4Zcw5Kweadh', 'portal.ref_condition_groups.read',  'portal.ref_condition_groups.write',  20),
    (p_org, 'ref_medications',       'Medications',          'pill',        'ref_medications',       'app7QJ2pvhADHQeBP.tblLM2BXjA680GQws', 'portal.ref_medications.read',       'portal.ref_medications.write',       30),
    (p_org, 'ref_items',             'Items & tests',        'flask',       'ref_items',             'app7QJ2pvhADHQeBP.tblTJtk6aIMbwpoA2', 'portal.ref_items.read',             'portal.ref_items.write',             40),
    (p_org, 'ref_medication_classes','Medication classes',   'tag',         'ref_medication_classes','appH2jHpsNR1nqEQ2.tblIxa5xUOG3GRwmt', 'portal.clinical_visits.read',        'portal.medication_classes.write',      50),
    (p_org, 'website_entry_points',  'Website entry points', 'globe',       'website_entry_points',  'appkOnjPr1SMD83CP.tblpWst9QqYNuKpwZ', 'portal.website_entry_points.read',  'portal.website_entry_points.write',  70)
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_portal_objects(uuid) from public, anon, authenticated;
grant execute on function public.seed_portal_objects(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for portal attachments. Paths: <org_id>/<object_key>/<record_id>/<uuid>.<ext>.
-- Members read via RLS; uploads are server-signed. Guarded so it also applies on plain Postgres.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('portal-files', 'portal-files', false, 26214400)
    on conflict (id) do nothing;
    execute $p$
      create policy portal_files_select on storage.objects for select to authenticated
        using (bucket_id = 'portal-files' and app.is_org_member(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;

