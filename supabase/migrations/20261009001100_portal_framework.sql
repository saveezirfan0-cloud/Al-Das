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
