-- Soft delete with a restore window (docs/35_SOFT_DELETE_NOTES.md, docs/09 §2.3 Security).
--
-- What staff delete from the UI now goes to "Recently deleted" (Settings) for the organisation's restore window
-- (orgs.settings.soft_delete.restore_window_days, default 30, 1 to 90), then the nightly purge makes it permanent:
--   * contacts            contacts.deleted_at already existed (deleteContacts); the primary phone, WhatsApp id and Unite PIN
--                         are still cleared at delete (so a new record can take them) and kept in deleted_items.restore_data
--                         for the restore. At the end of the window the contact is NOT hard-deleted: conversations,
--                         appointments and clinical records point at it, and only the two-person erasure (erase_contact,
--                         privacy.manage) removes a patient's details. The purge drops the restore copy; the row stays the
--                         hidden tombstone it always was.
--   * enquiries           enquiries.deleted_at already existed (deleteEnquiries); past the window the row is deleted. Its
--                         tasks and timeline entries are kept (their enquiry link is cleared first, so nothing cascades).
--   * tasks               new tasks.deleted_at (tasks used to be hard-deleted); past the window the row is deleted.
--   * website entry points new website_entry_points.deleted_at (the only portal object that allows delete); past the window
--                         the row and its portal tags are deleted.
-- deleted_items (service role only) is the bin: one row per soft-deleted record with who and when. Only records in it are
-- listed, restorable and purged; merges and erasure also set contacts.deleted_at but never create a bin row, and an
-- erasure removes a bin row (trigger below), so an erased or merged patient can never be "restored".
--
-- Unique keys. contacts: the partial unique indexes already ignore deleted rows and the identifiers are cleared at delete, so
-- a new contact can take the number; a restore that would clash is refused ('conflict'). tasks: the "one open call task per
-- appointment" index now ignores deleted tasks; a restore that would clash is refused. website_entry_points: the
-- (org, section, source) constraint deliberately still covers deleted rows (the Airtable importer upserts on it): a person
-- re-creating the same entry point is told to restore it instead.
--
-- Default reads: the SELECT policies of enquiries, tasks and website_entry_points now hide deleted rows, and their UPDATE
-- policies refuse a deleted row (so a browser cannot delete or restore around the bin). The browser DELETE policies of
-- contacts, enquiries, tasks and website_entry_points are dropped: deletes go only through the server actions and
-- soft_delete_records (no browser code deleted these rows). contacts_select is unchanged on
-- purpose: conversations, appointments and history legitimately show merged, erased and deleted patients, and contact lists
-- already filter deleted_at. Service-role reads filter deleted_at explicitly.

-- ---------------------------------------------------------------------------
-- 1. Columns and indexes
-- ---------------------------------------------------------------------------
alter table public.tasks add column if not exists deleted_at timestamptz;
alter table public.website_entry_points add column if not exists deleted_at timestamptz;

create index if not exists tasks_org_deleted_idx on public.tasks (org_id, deleted_at) where deleted_at is not null;

-- One open call task per appointment: a task in the bin no longer blocks a new one.
drop index if exists public.tasks_open_call_per_appointment_uidx;
create unique index tasks_open_call_per_appointment_uidx on public.tasks (appointment_id)
  where appointment_id is not null and type = 'call' and not done and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. The bin
-- ---------------------------------------------------------------------------
create table public.deleted_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity text not null check (entity in ('contact', 'enquiry', 'task', 'website_entry_point')),
  record_id uuid not null,
  deleted_by uuid references public.profiles (id) on delete set null,
  deleted_at timestamptz not null default now(),
  -- contacts only: the identifiers cleared at delete ({phone_e164, wa_bsuid, external_id}); '{}' for the others
  restore_data jsonb not null default '{}'::jsonb check (jsonb_typeof(restore_data) = 'object'),
  unique (entity, record_id)
);
create index deleted_items_org_idx on public.deleted_items (org_id, deleted_at);
-- Service role only (no policies): it holds the cleared phone numbers. Server code reads it after can().
alter table public.deleted_items enable row level security;

-- The restore window in days for an org's settings: default 30, never below 1 or above 90.
create or replace function app.restore_window_days(p_settings jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    case when jsonb_typeof(p_settings #> '{soft_delete,restore_window_days}') = 'number'
         then greatest(1, least(90, round((p_settings #>> '{soft_delete,restore_window_days}')::numeric)))::integer end,
    30);
$$;
grant execute on function app.restore_window_days(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Default reads hide deleted rows; browsers cannot move a row in or out of the bin
-- ---------------------------------------------------------------------------
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and deleted_at is null);
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (app.has_perm(org_id, 'tasks.manage') and deleted_at is null)
  with check (app.has_perm(org_id, 'tasks.manage') and deleted_at is null);

-- From 20261123000100_branch_access.sql (restricted enquiry view and branch), plus deleted_at.
drop policy if exists enquiries_select on public.enquiries;
create policy enquiries_select on public.enquiries for select to authenticated
  using (app.has_perm(org_id, 'enquiries.view')
         and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by)
         and app.location_visible_to(org_id, auth.uid(), location_id)
         and deleted_at is null);
drop policy if exists enquiries_update on public.enquiries;
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm(org_id, 'enquiries.manage')
         and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by)
         and app.location_visible_to(org_id, auth.uid(), location_id)
         and deleted_at is null)
  with check (app.has_perm(org_id, 'enquiries.manage') and deleted_at is null);

-- From app.add_tenant_rls('website_entry_points', 'portal.website_entry_points.write'), plus deleted_at.
drop policy if exists website_entry_points_select on public.website_entry_points;
create policy website_entry_points_select on public.website_entry_points for select to authenticated
  using (app.is_org_member(org_id) and deleted_at is null);
drop policy if exists website_entry_points_update on public.website_entry_points;
create policy website_entry_points_update on public.website_entry_points for update to authenticated
  using (app.has_perm_wild(org_id, 'portal.website_entry_points.write') and deleted_at is null)
  with check (app.has_perm_wild(org_id, 'portal.website_entry_points.write') and deleted_at is null);

-- Deletes go only through the bin (server action, then soft_delete_records): a browser can no longer remove these rows.
-- (A patient's details are removed only by erase_contact, two people.)
drop policy if exists contacts_delete on public.contacts;
drop policy if exists enquiries_delete on public.enquiries;
drop policy if exists tasks_delete on public.tasks;
drop policy if exists website_entry_points_delete on public.website_entry_points;

-- ---------------------------------------------------------------------------
-- 4. Delete into the bin. Service role only; the server action ran can() and records the audit row.
--    Returns the ids actually moved (already deleted, erased or other-org ids are skipped).
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_records(p_org uuid, p_entity text, p_ids uuid[], p_actor uuid default null)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
  v_now timestamptz := now();
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return v_ids;
  end if;

  if p_entity = 'contact' then
    select coalesce(array_agg(id), '{}') into v_ids from (
      select id from public.contacts
       where org_id = p_org and id = any (p_ids) and deleted_at is null and erased_at is null and merged_into_id is null
       order by id for update) s;
    insert into public.deleted_items (org_id, entity, record_id, deleted_by, deleted_at, restore_data)
    select p_org, 'contact', c.id, p_actor, v_now,
           jsonb_strip_nulls(jsonb_build_object('phone_e164', c.phone_e164, 'wa_bsuid', c.wa_bsuid, 'external_id', c.external_id))
      from public.contacts c where c.id = any (v_ids)
    on conflict (entity, record_id) do update
      set org_id = excluded.org_id, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at,
          restore_data = excluded.restore_data;
    -- As before: the identifiers are freed so a new record can take the number.
    update public.contacts set deleted_at = v_now, phone_e164 = null, wa_bsuid = null, external_id = null
     where id = any (v_ids);

  elsif p_entity = 'enquiry' then
    select coalesce(array_agg(id), '{}') into v_ids from (
      select id from public.enquiries where org_id = p_org and id = any (p_ids) and deleted_at is null order by id for update) s;
    update public.enquiries set deleted_at = v_now where id = any (v_ids);

  elsif p_entity = 'task' then
    select coalesce(array_agg(id), '{}') into v_ids from (
      select id from public.tasks where org_id = p_org and id = any (p_ids) and deleted_at is null order by id for update) s;
    update public.tasks set deleted_at = v_now where id = any (v_ids);
    -- Finance links let go of the task as they did when it was hard-deleted (on delete set null); a restore does not relink.
    update public.ins_claim_followup_stages set task_id = null where org_id = p_org and task_id = any (v_ids);
    update public.ins_denial_cases set task_id = null where org_id = p_org and task_id = any (v_ids);
    update public.fin_pre_authorisations set expiry_task_id = null where org_id = p_org and expiry_task_id = any (v_ids);

  elsif p_entity = 'website_entry_point' then
    select coalesce(array_agg(id), '{}') into v_ids from (
      select id from public.website_entry_points
       where org_id = p_org and id = any (p_ids) and deleted_at is null order by id for update) s;
    update public.website_entry_points set deleted_at = v_now where id = any (v_ids);

  else
    raise exception 'unknown entity' using errcode = 'invalid_parameter_value';
  end if;

  if p_entity <> 'contact' then
    insert into public.deleted_items (org_id, entity, record_id, deleted_by, deleted_at)
    select p_org, p_entity, x, p_actor, v_now from unnest(v_ids) as x
    on conflict (entity, record_id) do update
      set org_id = excluded.org_id, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at,
          restore_data = '{}'::jsonb;
  end if;
  return v_ids;
end;
$$;
revoke all on function public.soft_delete_records(uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.soft_delete_records(uuid, text, uuid[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Restore from the bin, inside the window. Service role only (the server action checks the record's own manage
--    permission first). Answers one word:
--      restored        done
--      not_found       not in this org's bin (never deleted, already restored, purged, or erased meanwhile)
--      expired         past the restore window (the nightly purge will take it)
--      conflict        a live record now holds its phone / WhatsApp id / Unite PIN, or (task) the appointment already
--                      has an open call task
--      parent_deleted  its contact (or, for a task, its enquiry) is deleted, merged or erased: the parent row itself is
--                      checked, so this also covers parents deleted before this release, parents already purged from
--                      the bin and erased patients. A parent in the bin can be restored first.
-- ---------------------------------------------------------------------------
create or replace function public.restore_deleted_record(p_org uuid, p_entity text, p_id uuid, p_actor uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.deleted_items;
  v_days integer;
  v_contact public.contacts;
  v_task public.tasks;
  v_enquiry public.enquiries;
  v_phone text;
  v_bsuid text;
  v_ext text;
begin
  select * into v_item from public.deleted_items
   where org_id = p_org and entity = p_entity and record_id = p_id for update;
  if not found then
    return 'not_found';
  end if;
  select app.restore_window_days(o.settings) into v_days from public.orgs o where o.id = p_org;
  if v_item.deleted_at < now() - make_interval(days => v_days) then
    return 'expired';
  end if;

  if p_entity = 'contact' then
    select * into v_contact from public.contacts where id = p_id and org_id = p_org for update;
    if not found or v_contact.deleted_at is null or v_contact.erased_at is not null or v_contact.merged_into_id is not null then
      delete from public.deleted_items where id = v_item.id;
      return 'not_found';
    end if;
    v_phone := nullif(v_item.restore_data ->> 'phone_e164', '');
    v_bsuid := nullif(v_item.restore_data ->> 'wa_bsuid', '');
    v_ext := nullif(v_item.restore_data ->> 'external_id', '');
    if exists (
      select 1 from public.contacts c
       where c.org_id = p_org and c.id <> p_id and c.deleted_at is null
         and ((v_phone is not null and c.phone_e164 = v_phone)
           or (v_bsuid is not null and c.wa_bsuid = v_bsuid)
           or (v_ext is not null and c.external_id = v_ext))
    ) then
      return 'conflict';
    end if;
    update public.contacts
       set deleted_at = null,
           phone_e164 = coalesce(v_phone, phone_e164),
           wa_bsuid = coalesce(v_bsuid, wa_bsuid),
           external_id = coalesce(v_ext, external_id)
     where id = p_id;

  elsif p_entity = 'enquiry' then
    select * into v_enquiry from public.enquiries where id = p_id and org_id = p_org for update;
    if not found or v_enquiry.deleted_at is null then
      delete from public.deleted_items where id = v_item.id;
      return 'not_found';
    end if;
    if v_enquiry.contact_id is not null and exists (
      select 1 from public.contacts c
       where c.id = v_enquiry.contact_id
         and (c.deleted_at is not null or c.erased_at is not null or c.merged_into_id is not null)
    ) then
      return 'parent_deleted';
    end if;
    update public.enquiries set deleted_at = null where id = p_id;

  elsif p_entity = 'task' then
    select * into v_task from public.tasks where id = p_id and org_id = p_org for update;
    if not found or v_task.deleted_at is null then
      delete from public.deleted_items where id = v_item.id;
      return 'not_found';
    end if;
    if (v_task.contact_id is not null and exists (
          select 1 from public.contacts c
           where c.id = v_task.contact_id
             and (c.deleted_at is not null or c.erased_at is not null or c.merged_into_id is not null)))
       or (v_task.enquiry_id is not null and exists (
          select 1 from public.enquiries e where e.id = v_task.enquiry_id and e.deleted_at is not null)) then
      return 'parent_deleted';
    end if;
    begin
      update public.tasks set deleted_at = null where id = p_id;
    exception when unique_violation then
      return 'conflict';
    end;

  elsif p_entity = 'website_entry_point' then
    update public.website_entry_points set deleted_at = null where id = p_id and org_id = p_org and deleted_at is not null;
    if not found then
      delete from public.deleted_items where id = v_item.id;
      return 'not_found';
    end if;

  else
    raise exception 'unknown entity' using errcode = 'invalid_parameter_value';
  end if;

  delete from public.deleted_items where id = v_item.id;
  return 'restored';
end;
$$;
revoke all on function public.restore_deleted_record(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.restore_deleted_record(uuid, text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5b. The Recently deleted list for one member: only the kinds they may restore (p_kinds, decided by the server after
--     can()), enquiries only inside their enquiry view and branches (app.enquiry_visible_to, app.location_visible_to),
--     records that still exist and are still deleted; newest first, paged. Service role only; titles leave only through the page that ran can().
-- ---------------------------------------------------------------------------
create or replace function public.list_deleted_items(
  p_org uuid, p_user uuid, p_kinds text[], p_limit integer default 100, p_offset integer default 0
)
returns table (entity text, record_id uuid, deleted_by uuid, deleted_at timestamptz, title text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.entity, d.record_id, d.deleted_by, d.deleted_at,
         case d.entity
           when 'contact' then coalesce(nullif(c.full_name, ''), 'Unnamed contact')
           when 'enquiry' then '#' || e.number::text || ' ' || coalesce(nullif(e.title, ''), 'Untitled enquiry')
           when 'task' then coalesce(nullif(t.subject, ''), 'Untitled task')
           else w.section || ': ' || w.source_key
         end as title
    from public.deleted_items d
    left join public.contacts c
      on d.entity = 'contact' and c.id = d.record_id and c.org_id = p_org and c.deleted_at is not null
    left join public.enquiries e
      on d.entity = 'enquiry' and e.id = d.record_id and e.org_id = p_org and e.deleted_at is not null
     and app.enquiry_visible_to(e.org_id, p_user, e.assignee_id, e.created_by)
     and app.location_visible_to(e.org_id, p_user, e.location_id)
    left join public.tasks t
      on d.entity = 'task' and t.id = d.record_id and t.org_id = p_org and t.deleted_at is not null
    left join public.website_entry_points w
      on d.entity = 'website_entry_point' and w.id = d.record_id and w.org_id = p_org and w.deleted_at is not null
   where d.org_id = p_org
     and d.entity = any (coalesce(p_kinds, '{}'))
     and (c.id is not null or e.id is not null or t.id is not null or w.id is not null)
   order by d.deleted_at desc, d.id
   limit greatest(1, least(coalesce(p_limit, 100), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.list_deleted_items(uuid, uuid, text[], integer, integer) from public, anon, authenticated;
grant execute on function public.list_deleted_items(uuid, uuid, text[], integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Nightly purge (pulse:soft_delete_purge → /api/jobs/soft_delete_purge). Takes at most p_batch bin rows past each
--    org's window (oldest first, SKIP LOCKED so a restore in flight wins), makes them permanent and writes one audit row
--    per org with counts only. Idempotent: run it again and it carries on where it stopped.
-- ---------------------------------------------------------------------------
create or replace function public.purge_deleted_records(p_now timestamptz default now(), p_batch integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  v_left integer := greatest(1, least(coalesce(p_batch, 500), 5000));
  v_items uuid[];
  v_ids uuid[];
  v_n integer;
  v_contacts integer;
  v_enquiries integer;
  v_tasks integer;
  v_entry integer;
  v_total jsonb := jsonb_build_object('orgs', 0, 'contacts', 0, 'enquiries', 0, 'tasks', 0, 'website_entry_points', 0, 'more', false);
begin
  for o in
    select g.id, app.restore_window_days(g.settings) as days
      from public.orgs g
     where exists (select 1 from public.deleted_items d where d.org_id = g.id)
     order by g.id
  loop
    exit when v_left <= 0;
    select coalesce(array_agg(d.id), '{}') into v_items from (
      select id from public.deleted_items
       where org_id = o.id and deleted_at < p_now - make_interval(days => o.days)
       order by deleted_at, id
       limit v_left
       for update skip locked) d;
    continue when cardinality(v_items) = 0;
    v_left := v_left - cardinality(v_items);
    v_contacts := 0; v_enquiries := 0; v_tasks := 0; v_entry := 0;

    -- Tasks: deleted outright.
    select coalesce(array_agg(i.record_id), '{}') into v_ids from public.deleted_items i where i.id = any (v_items) and i.entity = 'task';
    delete from public.tasks where org_id = o.id and id = any (v_ids) and deleted_at is not null;
    get diagnostics v_tasks = row_count;

    -- Enquiries: their tasks and timeline entries stay (link cleared first, so nothing cascades), then the row goes.
    select coalesce(array_agg(i.record_id), '{}') into v_ids from public.deleted_items i where i.id = any (v_items) and i.entity = 'enquiry';
    if cardinality(v_ids) > 0 then
      update public.tasks set enquiry_id = null where org_id = o.id and enquiry_id = any (v_ids);
      update public.timeline_events set enquiry_id = null where org_id = o.id and enquiry_id = any (v_ids);
      delete from public.enquiries where org_id = o.id and id = any (v_ids) and deleted_at is not null;
      get diagnostics v_enquiries = row_count;
    end if;

    -- Website entry points: the row and its portal tags (record_id has no foreign key).
    select coalesce(array_agg(i.record_id), '{}') into v_ids from public.deleted_items i where i.id = any (v_items) and i.entity = 'website_entry_point';
    if cardinality(v_ids) > 0 then
      delete from public.portal_record_tags
       where org_id = o.id and object_key = 'website_entry_points' and record_id = any (v_ids);
      delete from public.website_entry_points where org_id = o.id and id = any (v_ids) and deleted_at is not null;
      get diagnostics v_entry = row_count;
    end if;

    -- Contacts: the restore copy goes; the hidden row stays (erasure is the only way to remove a patient's details).
    select count(*)::integer into v_contacts from public.deleted_items i where i.id = any (v_items) and i.entity = 'contact';

    delete from public.deleted_items where id = any (v_items);
    get diagnostics v_n = row_count;

    insert into public.audit_log (org_id, user_id, action, entity, diff)
    values (o.id, null, 'deleted_items.purged', 'deleted_item',
            jsonb_build_object('items', v_n, 'contacts', v_contacts, 'enquiries', v_enquiries, 'tasks', v_tasks,
                               'website_entry_points', v_entry, 'window_days', o.days));

    v_total := v_total || jsonb_build_object(
      'orgs', (v_total ->> 'orgs')::integer + 1,
      'contacts', (v_total ->> 'contacts')::integer + v_contacts,
      'enquiries', (v_total ->> 'enquiries')::integer + v_enquiries,
      'tasks', (v_total ->> 'tasks')::integer + v_tasks,
      'website_entry_points', (v_total ->> 'website_entry_points')::integer + v_entry);
  end loop;
  if v_left <= 0 then
    v_total := v_total || jsonb_build_object('more', true);
  end if;
  return v_total;
end;
$$;
revoke all on function public.purge_deleted_records(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.purge_deleted_records(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Erasure empties the bin row of that patient (its restore copy holds the old phone number). A trigger rather than a
--    change to erase_contact, so a later rewrite of that function cannot forget it.
-- ---------------------------------------------------------------------------
create or replace function app.erase_contact_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.deleted_items where org_id = new.org_id and entity = 'contact' and record_id = new.id;
  return new;
end;
$$;
create trigger contacts_erase_soft_delete after update of erased_at on public.contacts
  for each row when (old.erased_at is null and new.erased_at is not null)
  execute function app.erase_contact_soft_delete();

-- ---------------------------------------------------------------------------
-- 8. Realtime: after a soft delete the server broadcasts {entity, ids} on the PRIVATE channel 'soft-delete:<org id>'
--    (Realtime Authorization), so other members' open lists reload (RLS hides the UPDATE from postgres_changes).
--    Receiving needs an active membership of that org; there is no INSERT policy, so browsers cannot send (the service
--    role sends). Only created where Supabase Realtime is installed (the plain-Postgres test harness has no realtime
--    schema); the topic parser below exists everywhere and is tested.
-- ---------------------------------------------------------------------------
create or replace function app.soft_delete_topic_org(p_topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_topic ~ '^soft-delete:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substr(p_topic, 13)::uuid
  end;
$$;
grant execute on function app.soft_delete_topic_org(text) to authenticated, service_role;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists soft_delete_broadcast_receive on realtime.messages';
    execute $p$
      create policy soft_delete_broadcast_receive on realtime.messages for select to authenticated
      using (
        extension = 'broadcast'
        and app.soft_delete_topic_org((select realtime.topic())) is not null
        and app.is_org_member(app.soft_delete_topic_org((select realtime.topic())))
      )
    $p$;
  end if;
end $$;

select cron.schedule('pulse:soft_delete_purge', '50 3 * * *', $$select app.ping_jobs('soft_delete_purge')$$);
