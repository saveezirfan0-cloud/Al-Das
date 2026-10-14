-- Phase F (docs/34_CLINIC_OS_PLAN.md): inbox, Patient 360 and tasks v2.
--
--   conversations.snoozed_until / snoozed_by   a snoozed chat leaves the working folders until the time set; a
--                                              scheduled_jobs row (inbox.unsnooze) brings it back; a new patient
--                                              message or closing the chat clears the snooze at once (trigger).
--   search_messages()                          message-text search inside one organisation: SECURITY INVOKER, so the
--                                              caller's own RLS on messages and conversations decides what is found;
--                                              trigram index, at least 3 characters, at most 50 hits, a short snippet
--                                              around the match only (never the whole message). The query is never
--                                              stored or logged.
--   tasks                                      + priority, status (todo / in_progress / blocked / done, kept in step
--                                              with the old `done` flag by trigger), team, the chat it came from,
--                                              recurrence (daily / weekly / monthly), series and occurrence key (one
--                                              row per series and date, or per checklist template and day), and the
--                                              daily checklist template it was made from.
--   task_checklist_items                       subtasks / checklist lines of a task.
--   task_comments                              comments with @mentions (user ids only).
--   task_attachments                           Media Library files on a task (media_asset_usage() counts them).
--   task_checklist_templates                   per-branch opening / closing checklists that tasks_daily turns into a
--                                              task with its checklist each morning (idempotent per template and day).
--
-- Tables have SELECT policies only (tasks.view, and the task itself must be visible to the caller: its branch rule and
-- soft delete come from the tasks policy). Every write is a server action using the service role after can().
-- Templates follow the branch rule on their branch. task_spawn_next() and task_generate_checklists() are service-role
-- only and idempotent (unique occurrence key). Record history is attached to task_checklist_templates.

-- ---------------------------------------------------------------------------
-- 1. Snooze
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column snoozed_until timestamptz,
  add column snoozed_by uuid references public.profiles (id) on delete set null;
create index conversations_snoozed_idx on public.conversations (org_id, snoozed_until) where snoozed_until is not null;

-- A patient writing again, or the chat being closed, ends a snooze straight away (the job then finds nothing to do).
create or replace function app.conversation_snooze_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.snoozed_until is not null
     and ((new.last_inbound_at is not null
           and new.last_inbound_at is distinct from old.last_inbound_at
           and (old.last_inbound_at is null or new.last_inbound_at > old.last_inbound_at))
          or (new.status = 'closed' and old.status is distinct from 'closed')) then
    new.snoozed_until := null;
    new.snoozed_by := null;
  end if;
  return new;
end;
$$;
create trigger conversations_snooze_reset before update of last_inbound_at, status on public.conversations
  for each row execute function app.conversation_snooze_reset();

-- ---------------------------------------------------------------------------
-- 2. Message-text search
-- ---------------------------------------------------------------------------
create index messages_body_trgm_idx on public.messages using gin (body gin_trgm_ops) where body is not null;

create or replace function public.search_messages(p_org_id uuid, p_query text, p_limit integer default 30)
returns table (message_id uuid, conversation_id uuid, at timestamptz, direction text, snippet text)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select btrim(coalesce(p_query, '')) as term
  ), hits as (
    select m.id, m.conversation_id, m.at, m.direction, m.body,
           greatest(strpos(lower(m.body), lower(q.term)), 1) as pos,
           char_length(q.term) as len
    from public.messages m, q
    where m.org_id = p_org_id
      and char_length(q.term) between 3 and 100
      and m.body is not null
      and m.kind <> 'reaction'
      and m.body ilike '%' || replace(replace(replace(q.term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      and exists (
        select 1 from public.conversations c
        where c.id = m.conversation_id and c.org_id = p_org_id and not c.campaign_only
      )
    order by m.at desc, m.id desc
    limit least(greatest(coalesce(p_limit, 30), 1), 50)
  )
  select h.id, h.conversation_id, h.at, h.direction,
         (case when h.pos > 41 then '…' else '' end)
         || substr(h.body, greatest(h.pos - 40, 1), h.len + 80)
         || (case when h.pos + h.len + 40 < char_length(h.body) then '…' else '' end)
  from hits h
  order by h.at desc, h.id desc;
$$;
revoke all on function public.search_messages(uuid, text, integer) from public, anon;
grant execute on function public.search_messages(uuid, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Checklist templates (per branch)
-- ---------------------------------------------------------------------------
create or replace function app.task_checklist_lines_valid(p_items jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_items) = 'array'
     and jsonb_array_length(p_items) between 1 and 50
     and not exists (
       select 1 from jsonb_array_elements(p_items) e
       where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 200
     );
$$;

create table public.task_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null default 'opening' check (kind in ('opening', 'closing', 'other')),
  items jsonb not null check (app.task_checklist_lines_valid(items)),
  generate_at time not null default '06:00',
  due_time time not null default '09:00',
  assignee_id uuid references public.profiles (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index task_checklist_templates_org_idx on public.task_checklist_templates (org_id, location_id, kind);
create trigger task_checklist_templates_set_updated_at before update on public.task_checklist_templates
  for each row execute function app.set_updated_at();
create trigger task_checklist_templates_location_org before insert or update of location_id, org_id
  on public.task_checklist_templates for each row execute function app.check_parent_org('locations', 'location_id');
create trigger task_checklist_templates_team_org before insert or update of team_id, org_id
  on public.task_checklist_templates for each row execute function app.check_parent_org('teams', 'team_id');
create trigger task_checklist_templates_assignee_member before insert or update of assignee_id, org_id
  on public.task_checklist_templates for each row execute function app.check_member_org('assignee_id');

-- ---------------------------------------------------------------------------
-- 4. Tasks: priority, status, team, chat, recurrence, occurrence key, template
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  add column status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done')),
  add column team_id uuid references public.teams (id) on delete set null,
  add column conversation_id uuid references public.conversations (id) on delete set null,
  add column recurrence text check (recurrence is null or recurrence in ('daily', 'weekly', 'monthly')),
  add column series_id uuid,
  add column occurrence_key text check (occurrence_key is null or char_length(occurrence_key) between 1 and 200),
  add column checklist_template_id uuid references public.task_checklist_templates (id) on delete set null;

-- Existing finished tasks are "done". History and updated_at are left alone for this one-off backfill.
alter table public.tasks disable trigger tasks_record_history;
alter table public.tasks disable trigger tasks_set_updated_at;
update public.tasks set status = 'done' where done;
alter table public.tasks enable trigger tasks_record_history;
alter table public.tasks enable trigger tasks_set_updated_at;

alter table public.tasks add constraint tasks_status_done_check check ((status = 'done') = done);

-- One rule for status and the old done flag: changing either moves the other (lib/tasks/status.ts mirrors it).
create or replace function app.tasks_status_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.done or new.status = 'done' then
      new.done := true;
      new.status := 'done';
      new.done_at := coalesce(new.done_at, now());
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status = 'done' then
      new.done := true;
      new.done_at := coalesce(new.done_at, now());
    elsif old.status = 'done' then
      new.done := false;
      new.done_at := null;
      new.completed_by := null;
    end if;
  elsif new.done is distinct from old.done then
    if new.done then
      new.status := 'done';
      new.done_at := coalesce(new.done_at, now());
    else
      new.status := 'todo';
      new.done_at := null;
      new.completed_by := null;
    end if;
  end if;
  return new;
end;
$$;
create trigger tasks_status_sync before insert or update of status, done on public.tasks
  for each row execute function app.tasks_status_sync();

create trigger tasks_team_org_check before insert or update of team_id on public.tasks
  for each row execute function app.check_parent_org('teams', 'team_id');
create trigger tasks_conversation_org_check before insert or update of conversation_id on public.tasks
  for each row execute function app.check_parent_org('conversations', 'conversation_id');
create trigger tasks_checklist_template_org_check before insert or update of checklist_template_id on public.tasks
  for each row execute function app.check_parent_org('task_checklist_templates', 'checklist_template_id');

create unique index tasks_occurrence_uidx on public.tasks (org_id, occurrence_key) where occurrence_key is not null;
create index tasks_org_status_idx on public.tasks (org_id, status, due_at) where deleted_at is null;
create index tasks_conversation_idx on public.tasks (conversation_id) where conversation_id is not null;
create index tasks_series_idx on public.tasks (series_id, due_at) where series_id is not null;
create index tasks_checklist_template_idx on public.tasks (checklist_template_id, due_at)
  where checklist_template_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Checklist lines, comments, attachments
-- ---------------------------------------------------------------------------
create table public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid references public.profiles (id) on delete set null,
  sort_order integer not null default 100 check (sort_order between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (done = (done_at is not null))
);
create index task_checklist_items_task_idx on public.task_checklist_items (task_id, sort_order);
create trigger task_checklist_items_set_updated_at before update on public.task_checklist_items
  for each row execute function app.set_updated_at();
create trigger task_checklist_items_task_org before insert or update of task_id, org_id on public.task_checklist_items
  for each row execute function app.check_parent_org('tasks', 'task_id');

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  mentioned_user_ids uuid[] not null default '{}' check (cardinality(mentioned_user_ids) <= 20),
  created_at timestamptz not null default now()
);
create index task_comments_task_idx on public.task_comments (task_id, created_at);
create trigger task_comments_task_org before insert or update of task_id, org_id on public.task_comments
  for each row execute function app.check_parent_org('tasks', 'task_id');

create table public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (task_id, media_asset_id)
);
create index task_attachments_asset_idx on public.task_attachments (media_asset_id);
create trigger task_attachments_task_org before insert or update of task_id, org_id on public.task_attachments
  for each row execute function app.check_parent_org('tasks', 'task_id');
create trigger task_attachments_asset_org before insert or update of media_asset_id, org_id on public.task_attachments
  for each row execute function app.check_parent_org('media_assets', 'media_asset_id');

-- ---------------------------------------------------------------------------
-- 6. RLS: SELECT only; writes are server actions (service role after can()).
-- ---------------------------------------------------------------------------
alter table public.task_checklist_templates enable row level security;
alter table public.task_checklist_items enable row level security;
alter table public.task_comments enable row level security;
alter table public.task_attachments enable row level security;

create policy task_checklist_templates_select on public.task_checklist_templates for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and app.location_visible_to(org_id, auth.uid(), location_id));

-- A line, comment or attachment follows its task: the subquery runs under the tasks policy (branch rule, bin).
create policy task_checklist_items_select on public.task_checklist_items for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and exists (select 1 from public.tasks t where t.id = task_id));
create policy task_comments_select on public.task_comments for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and exists (select 1 from public.tasks t where t.id = task_id));
create policy task_attachments_select on public.task_attachments for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and exists (select 1 from public.tasks t where t.id = task_id));

-- ---------------------------------------------------------------------------
-- 7. Recurrence: the next task of a series (lib/tasks/recurrence.ts computes p_next_due; one rule).
--    Idempotent: one row per series and due time (occurrence key), and nothing once a later task of the series exists.
-- ---------------------------------------------------------------------------
create or replace function public.task_spawn_next(p_org_id uuid, p_task_id uuid, p_next_due timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  v_series uuid;
  v_id uuid;
begin
  select * into t from public.tasks where id = p_task_id and org_id = p_org_id;
  if not found or t.recurrence is null or t.deleted_at is not null or p_next_due is null or p_next_due <= t.due_at then
    return null;
  end if;
  v_series := coalesce(t.series_id, t.id);
  perform pg_advisory_xact_lock(hashtextextended('task_series|' || v_series::text, 35));
  if exists (
    select 1 from public.tasks x
    where x.org_id = p_org_id and (x.series_id = v_series or x.id = v_series) and x.due_at > t.due_at
  ) then
    return null;
  end if;
  insert into public.tasks (org_id, type, subject, notes, due_at, assignee_id, contact_id, enquiry_id, location_id,
                            priority, team_id, conversation_id, recurrence, series_id, occurrence_key, created_by)
  values (t.org_id, t.type, t.subject, t.notes, p_next_due, t.assignee_id, t.contact_id, t.enquiry_id, t.location_id,
          t.priority, t.team_id, t.conversation_id, t.recurrence, v_series,
          'recur:' || v_series::text || ':' || to_char(p_next_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
          t.created_by)
  on conflict (org_id, occurrence_key) where occurrence_key is not null do nothing
  returning id into v_id;
  if v_id is not null then
    insert into public.task_checklist_items (org_id, task_id, title, sort_order)
    select i.org_id, v_id, i.title, i.sort_order from public.task_checklist_items i where i.task_id = t.id;
    if t.series_id is null then
      update public.tasks set series_id = v_series where id = t.id;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.task_spawn_next(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.task_spawn_next(uuid, uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Daily checklists: each active template of an active branch, once its local generate time has passed, becomes one
--    task (due at the template's local due time) with its lines. Idempotent per template and local day.
-- ---------------------------------------------------------------------------
create or replace function public.task_generate_checklists(p_org_id uuid, p_now timestamptz default now())
returns table (task_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_local timestamp;
  v_day date;
  v_id uuid;
begin
  for r in
    select t.id, t.org_id, t.location_id, t.name, t.items, t.generate_at, t.due_time, t.assignee_id, t.team_id,
           coalesce(nullif(l.timezone, ''), nullif(o.timezone, ''), 'UTC') as tz
    from public.task_checklist_templates t
    join public.locations l on l.id = t.location_id and l.org_id = t.org_id
    join public.orgs o on o.id = t.org_id
    where t.org_id = p_org_id and t.active and l.active
    order by t.id
  loop
    v_local := timezone(r.tz, p_now);
    if v_local::time < r.generate_at then
      continue;
    end if;
    v_day := v_local::date;
    v_id := null;
    insert into public.tasks (org_id, type, subject, due_at, assignee_id, team_id, location_id, priority,
                              checklist_template_id, occurrence_key)
    values (r.org_id, 'other', r.name, timezone(r.tz, v_day + r.due_time), r.assignee_id, r.team_id, r.location_id,
            'normal', r.id, 'checklist:' || r.id::text || ':' || v_day::text)
    on conflict (org_id, occurrence_key) where occurrence_key is not null do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.task_checklist_items (org_id, task_id, title, sort_order)
      select r.org_id, v_id, btrim(e.value #>> '{}'), (e.ord * 10)::integer
      from jsonb_array_elements(r.items) with ordinality as e(value, ord);
      task_id := v_id;
      return next;
    end if;
  end loop;
end;
$$;
revoke all on function public.task_generate_checklists(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.task_generate_checklists(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Media Library: a file on an open task is in use (from 20261113000100_sf20g_campaign_ab.sql, tasks added).
-- ---------------------------------------------------------------------------
create or replace function public.media_asset_usage(p_org uuid, p_asset uuid)
returns table (kind text, ref_id uuid, ref_name text, ref_status text, blocking boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select 'template'::text, t.id, t.name, t.status,
         (t.archived_at is null and t.status not in ('REJECTED', 'DISABLED', 'DELETED', 'PENDING_DELETION'))
    from public.wa_templates t
   where t.org_id = p_org
     and jsonb_typeof(t.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(t.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'campaign'::text, c.id, c.name, c.status,
         (c.status in ('preparing', 'scheduled', 'queued', 'sending', 'paused'))
    from public.campaigns c
   where c.org_id = p_org
     and (
       (jsonb_typeof(c.variable_map) = 'object'
         and exists (select 1 from jsonb_each_text(c.variable_map) e where e.value = 'media:' || p_asset::text))
       or exists (
         select 1 from public.campaign_ab_variants v
         where v.campaign_id = c.id
           and exists (select 1 from jsonb_each_text(v.variable_map) e where e.value = 'media:' || p_asset::text)
       )
     )
  union all
  select 'campaign'::text, r.id, left('Recurring: ' || r.name, 140), 'recurring ' || r.status, (r.status = 'active')
    from public.campaign_recurrences r
   where r.org_id = p_org
     and jsonb_typeof(r.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(r.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'quick_reply'::text, q.id, q.shortcut, null::text, true
    from public.quick_replies q
   where q.org_id = p_org and q.media_asset_id = p_asset
  union all
  select 'task'::text, tk.id, left(tk.subject, 140), tk.status, (not tk.done and tk.deleted_at is null)
    from public.task_attachments a
    join public.tasks tk on tk.id = a.task_id
   where a.org_id = p_org and a.media_asset_id = p_asset;
$$;
revoke all on function public.media_asset_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_asset_usage(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Record history on checklist templates. From the last definition (20261202000100_organisation.sql), every
--     earlier table kept; the new one needs tasks.view.
-- ---------------------------------------------------------------------------
select app.enable_record_history('task_checklist_templates');

create or replace function app.can_view_record_history(p_org_id uuid, p_table text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_table
    when 'appointments' then app.has_perm(p_org_id, 'appointments.view')
    when 'enquiries' then app.has_perm(p_org_id, 'enquiries.view')
    when 'tasks' then app.has_perm(p_org_id, 'tasks.view')
    when 'wa_templates' then app.has_perm(p_org_id, 'templates.manage')
    when 'flows' then app.has_perm(p_org_id, 'flows.manage')
    when 'fin_pre_authorisations' then app.has_perm(p_org_id, 'finance.preauth.manage')
    when 'fin_eligibility_checks' then app.has_perm(p_org_id, 'finance.eligibility.manage')
    when 'ins_denial_cases' then app.has_perm(p_org_id, 'finance.denials.manage')
    when 'fin_period_closes' then app.has_perm(p_org_id, 'finance.close.view')
    when 'acc_accounts' then app.acc_can_view(p_org_id)
    when 'acc_journals' then app.acc_can_read_journals(p_org_id)
    when 'acc_sales_invoices' then app.acc_can_read_receivables(p_org_id)
    when 'acc_receipts' then app.acc_can_read_receivables(p_org_id)
    when 'acc_bank_transfers' then app.acc_can_read_banking(p_org_id)
    when 'acc_bank_entries' then app.acc_can_read_banking(p_org_id)
    when 'acc_cheques' then app.acc_can_read_banking(p_org_id)
    when 'acc_assets' then app.acc_can_view(p_org_id)
    when 'staff_members' then app.has_perm(p_org_id, 'hr.view')
    when 'rota_shifts' then app.has_perm(p_org_id, 'hr.view')
    when 'task_checklist_templates' then app.has_perm(p_org_id, 'tasks.view')
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. Realtime for the task drawer, and the hourly tasks_daily run (daily checklists; runs in the app so it can
--     schedule the due reminders).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.task_comments, public.task_checklist_items;
  end if;
end;
$$;

select cron.schedule('pulse:tasks_daily', '7 * * * *', $$select app.ping_jobs('tasks_daily')$$);
