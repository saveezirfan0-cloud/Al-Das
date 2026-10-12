-- Phase 15 (2/3): one shared, trigger-based field-level history table.
--
-- app.record_history_capture() runs AFTER insert/update/delete on a tracked table and writes one
-- record_history row with {"field": {"from": …, "to": …}} for every column that changed. The History
-- tab in the appointment, enquiry, task, template, flow and portal-record drawers reads it.
--
-- Who made the change: auth.uid() when the write came through a signed-in user's client, otherwise
-- the "x-pulse-actor" request header that the server's service-role client sends (lib/supabase/admin.ts).
-- The header is trusted only when the JWT role is service_role, which only server code holds. Writes
-- with neither (jobs, imports, the public API) are stored with a null actor and shown as "System".
--
-- Long values are cut (text to 500 characters) and large JSON values are reduced to {"changed": true}
-- so the history never becomes a second copy of a flow graph or a template body.

create table public.record_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  record_id uuid not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  actor_id uuid references auth.users (id) on delete set null,
  changes jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  at timestamptz not null default now()
);
create index record_history_record_idx on public.record_history (org_id, table_name, record_id, at desc, id desc);

-- Who may read the history of a table: whoever may read the record itself.
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
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

alter table public.record_history enable row level security;
create policy record_history_select on public.record_history for select to authenticated
  using (app.can_view_record_history(org_id, table_name));

-- History is append-only; it leaves only with the org cascade or a record erasure (erase_contact).
create or replace function app.record_history_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.actor_id is null
       and (new.id, new.org_id, new.table_name, new.record_id, new.op, new.changes, new.at)
           is not distinct from (old.id, old.org_id, old.table_name, old.record_id, old.op, old.changes, old.at) then
      return new;                                                  -- the FK action that nulls actor_id
    end if;
    raise exception 'record_history is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and coalesce(current_setting('app.history_purge', true), '') <> 'on' then
      raise exception 'record_history is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;
create trigger record_history_append_only
  before update or delete on public.record_history
  for each row execute function app.record_history_guard();

-- Shortens a value for storage in the history.
create or replace function app.history_value(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'string' then
      case when char_length(p_value #>> '{}') > 500
           then to_jsonb(left(p_value #>> '{}', 500) || '…')
           else p_value end
    when 'object' then case when length(p_value::text) > 300 then '{"changed": true}'::jsonb else p_value end
    when 'array' then case when length(p_value::text) > 300 then '{"changed": true}'::jsonb else p_value end
    else p_value
  end;
$$;

create or replace function app.record_history_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'search', 'embedding'];
  v_key text;
  v_actor uuid;
  v_headers jsonb;
  v_role text;
  v_row jsonb;
begin
  if TG_NARGS > 0 and TG_ARGV[0] <> '' then
    v_skip := v_skip || string_to_array(TG_ARGV[0], ',');
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    if v_role = 'service_role' then
      begin
        v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
        v_actor := nullif(v_headers ->> 'x-pulse-actor', '')::uuid;
      exception when others then
        v_actor := null;                                           -- a malformed header must never break the write
      end;
    end if;
  end if;
  -- The actor must be a real user; a stale or forged id would otherwise fail the foreign key.
  if v_actor is not null and not exists (select 1 from auth.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    for v_key in select jsonb_object_keys(v_new) loop
      continue when v_key = any (v_skip);
      if v_new -> v_key is distinct from v_old -> v_key then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', app.history_value(v_old -> v_key), 'to', app.history_value(v_new -> v_key))
        );
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;                                                 -- only noise columns changed
    end if;
  end if;

  v_row := to_jsonb(case when TG_OP = 'DELETE' then OLD else NEW end);
  insert into public.record_history (org_id, table_name, record_id, op, actor_id, changes)
  values ((v_row ->> 'org_id')::uuid, TG_TABLE_NAME, (v_row ->> 'id')::uuid, lower(TG_OP), v_actor, v_changes);
  return null;
end;
$$;
revoke all on function app.record_history_capture() from public, anon, authenticated;

-- Attach the trigger to a table (idempotent). Portal tables added by later phases call this too.
create or replace function app.enable_record_history(p_table text, p_skip text default '')
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists %I on public.%I', p_table || '_record_history', p_table);
  execute format(
    'create trigger %I after insert or update or delete on public.%I for each row execute function app.record_history_capture(%L)',
    p_table || '_record_history', p_table, p_skip
  );
end;
$$;
revoke all on function app.enable_record_history(text, text) from public, anon, authenticated;

select app.enable_record_history('appointments');
select app.enable_record_history('enquiries', 'sla_due_at,sla_breached_at,first_touch_at,stage_entered_at');
select app.enable_record_history('tasks', 'due_notified_for');
select app.enable_record_history('wa_templates');
select app.enable_record_history('flows', 'last_triggered_at');
select app.enable_record_history('ref_diagnoses');
select app.enable_record_history('ref_condition_groups');
select app.enable_record_history('ref_medications');
select app.enable_record_history('ref_items');
select app.enable_record_history('ref_medication_classes');
select app.enable_record_history('website_entry_points');
