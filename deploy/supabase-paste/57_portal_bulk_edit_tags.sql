-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Portal bulk edit and tags (docs/33_PORTAL_BULK_EDIT_TAGS_NOTES.md). Needs every earlier file first, up to and
-- including 55_sanoflow_parity_followups.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Adds tag scope 'portal', public.portal_record_tags (read with the portal object's read key, written by the server
-- only) and public.portal_bulk_update (service role only). The migration-history line is at the bottom of this file.

-- ======================================================================
-- 20261117000100_portal_bulk_edit_tags.sql
-- ======================================================================
-- Portal bulk edit and tags (docs/33_PORTAL_BULK_EDIT_TAGS_NOTES.md).
--
-- 1. Tags with scope 'portal'. public.tags allowed contact, enquiry and conversation; 'portal' joins them. Portal tags
--    are attached to portal records (reference and configuration objects registered in portal_objects) through
--    portal_record_tags. Reading follows the object's own read key (app.portal_can_read, the same rule as comments,
--    timeline and attachments); there are no write policies: the server writes with the service role after can()
--    (the object's write key), like every other portal write.
-- 2. public.portal_bulk_update: sets one column on up to 500 records of ONE object in ONE organisation, in a single
--    statement. Service role only. Rows of another organisation are never touched (org_id is part of the WHERE),
--    rows that already hold the value are skipped, and the record_history trigger on the portal tables names the
--    person through the x-pulse-actor header like a single edit.
--
-- Portal records are reference data (diagnoses, medications, items, website entry points), not patients, so erasure
-- and contact merges do not reach them.

-- ---------------------------------------------------------------------------
-- 1. Tag scope 'portal'
-- ---------------------------------------------------------------------------
alter table public.tags drop constraint tags_scope_check;
alter table public.tags add constraint tags_scope_check
  check (scope in ('contact', 'enquiry', 'conversation', 'portal'));

create table public.portal_record_tags (
  org_id uuid not null references public.orgs (id) on delete cascade,
  object_key text not null check (object_key ~ '^[a-z][a-z0-9_]{0,48}$'),
  record_id uuid not null,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, object_key, record_id, tag_id)
);
create index portal_record_tags_tag_idx on public.portal_record_tags (tag_id, object_key, record_id);

create trigger portal_record_tags_tag_org_check before insert or update on public.portal_record_tags
  for each row execute function app.check_parent_org('tags', 'tag_id');

-- The tag must be a portal tag, and the record must exist in the object's table in the same organisation
-- (record_id points at a different table per object, so a foreign key cannot say this).
create or replace function app.portal_record_tags_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_found boolean;
begin
  -- missing values are the NOT NULL constraints' job (and row security answers first for another org)
  if new.tag_id is null or new.object_key is null or new.record_id is null then
    return new;
  end if;
  if not exists (select 1 from public.tags t where t.id = new.tag_id and t.scope = 'portal') then
    raise exception 'tag % is not a portal tag', new.tag_id using errcode = 'check_violation';
  end if;
  v_table := app.portal_table(new.org_id, new.object_key);   -- raises for an unknown or disabled object
  execute format('select exists (select 1 from public.%I r where r.id = $1 and r.org_id = $2)', v_table)
    into v_found using new.record_id, new.org_id;
  if not v_found then
    raise exception 'portal record not found' using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;
create trigger portal_record_tags_check before insert or update on public.portal_record_tags
  for each row execute function app.portal_record_tags_check();

alter table public.portal_record_tags enable row level security;
create policy portal_record_tags_select on public.portal_record_tags for select to authenticated
  using (app.portal_can_read(org_id, object_key));

-- ---------------------------------------------------------------------------
-- 2. Bulk update of one column
-- ---------------------------------------------------------------------------
create or replace function public.portal_bulk_update(
  p_org_id uuid,
  p_object_key text,
  p_ids uuid[],
  p_column text,
  p_value jsonb
)
returns table (record_id uuid, old_value jsonb, new_value jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := app.portal_table(p_org_id, p_object_key);
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'at most 500 records at a time' using errcode = 'check_violation';
  end if;
  if p_column is null or p_column !~ '^[a-z][a-z0-9_]{0,62}$'
     or p_column in ('id', 'org_id', 'created_at', 'updated_at')
     or not exists (
       select 1 from pg_catalog.pg_attribute a
        where a.attrelid = format('public.%I', v_table)::regclass
          and a.attname = p_column and a.attnum > 0 and not a.attisdropped
     ) then
    raise exception 'unknown column' using errcode = 'undefined_column';
  end if;
  -- jsonb_populate_record casts the value to the column's own type (text, numeric, boolean, date, uuid, text[] ...).
  return query execute format($q$
    with target as (
      select (jsonb_populate_record(null::public.%1$I, jsonb_build_object(%2$L, $3))).%2$I as v
    ),
    before as (
      select c.id, to_jsonb(c) -> %2$L as old
        from public.%1$I c, target t
       where c.org_id = $1 and c.id = any($2) and c.%2$I is distinct from t.v
       for update of c
    ),
    upd as (
      update public.%1$I c set %2$I = t.v
        from before b, target t
       where c.id = b.id and c.org_id = $1
      returning c.id, to_jsonb(c) -> %2$L as new
    )
    select u.id, b.old, u.new from upd u join before b on b.id = u.id
  $q$, v_table, p_column) using p_org_id, p_ids, coalesce(p_value, 'null'::jsonb);
end;
$$;
revoke all on function public.portal_bulk_update(uuid, text, uuid[], text, jsonb) from public, anon, authenticated;
grant execute on function public.portal_bulk_update(uuid, text, uuid[], text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Tag writes per scope. The Phase 1 policies let any contacts.manage holder write a tag of ANY scope from the
-- browser; the app writes tags only from the server (after the scope's own can()), so these restrictive policies
-- make the database agree with it: each scope needs its own permission, and a tag never changes scope (the
-- portal_record_tags / enquiry_tags triggers check the scope only when a link is written).
-- ---------------------------------------------------------------------------
create or replace function app.tag_scope_writable(p_org_id uuid, p_scope text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope
           when 'contact' then app.has_perm_wild(p_org_id, 'contacts.manage')
           when 'enquiry' then app.has_perm_wild(p_org_id, 'enquiries.manage')
           when 'conversation' then app.has_perm_wild(p_org_id, 'settings.manage')
           when 'portal' then app.has_perm_wild(p_org_id, 'portal.tags.manage')
           else false
         end;
$$;
revoke all on function app.tag_scope_writable(uuid, text) from public;
grant execute on function app.tag_scope_writable(uuid, text) to authenticated, service_role;

create policy tags_scope_insert on public.tags as restrictive for insert to authenticated
  with check (app.tag_scope_writable(org_id, scope));
create policy tags_scope_update on public.tags as restrictive for update to authenticated
  using (app.tag_scope_writable(org_id, scope))
  with check (app.tag_scope_writable(org_id, scope));
create policy tags_scope_delete on public.tags as restrictive for delete to authenticated
  using (app.tag_scope_writable(org_id, scope));

create or replace function app.tags_scope_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scope is distinct from old.scope then
    raise exception 'A tag cannot change scope' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tags_scope_fixed before update of scope on public.tags
  for each row execute function app.tags_scope_fixed();

insert into supabase_migrations.schema_migrations (version, name) values ('20261117000100', 'portal_bulk_edit_tags') on conflict (version) do nothing;
