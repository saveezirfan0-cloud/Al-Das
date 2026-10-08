-- Phase 2 / 1: patient CRM core.
-- contacts, alternate phones, tags, custom fields, segments, timeline, grid
-- preferences, external_refs (import dedupe), sync_reviews (ambiguous matches)
-- and a minimal mentions table (Phase 3 adds the FKs to messages/conversations).
-- Every tenant table carries org_id and is protected by RLS keyed on memberships.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  full_name text generated always as (btrim(first_name || ' ' || last_name)) stored,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  wa_bsuid text,                                      -- WhatsApp business-scoped user id (may be the only identifier)
  email text,
  gender text check (gender is null or gender in ('female', 'male', 'other', 'unknown')),
  nationality text,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  language text,
  dob date,
  label text,
  owner_id uuid references public.profiles (id) on delete set null,
  assignee_id uuid references public.profiles (id) on delete set null,
  source text not null default 'manual',              -- manual | inbox | import_csv | import_sanoflow | import_airtable | unite | api | flow
  external_id text,                                   -- Unite patient PIN
  promotions_opt_in boolean not null default false,
  stop_marketing boolean not null default false,
  custom jsonb not null default '{}'::jsonb,
  last_interaction_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  merged_into_id uuid references public.contacts (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(custom) = 'object')
);
create unique index contacts_org_phone_uidx on public.contacts (org_id, phone_e164)
  where phone_e164 is not null and deleted_at is null;
create unique index contacts_org_bsuid_uidx on public.contacts (org_id, wa_bsuid)
  where wa_bsuid is not null and deleted_at is null;
create unique index contacts_org_external_uidx on public.contacts (org_id, external_id)
  where external_id is not null and deleted_at is null;
create index contacts_org_created_idx on public.contacts (org_id, created_at desc) where deleted_at is null;
create index contacts_org_last_interaction_idx on public.contacts (org_id, last_interaction_at desc nulls last) where deleted_at is null;
create index contacts_org_email_idx on public.contacts (org_id, lower(email)) where email is not null;
create index contacts_org_name_dob_idx on public.contacts (org_id, lower(full_name), dob) where deleted_at is null;
create index contacts_full_name_trgm_idx on public.contacts using gin (full_name gin_trgm_ops);
create index contacts_phone_trgm_idx on public.contacts using gin (phone_e164 gin_trgm_ops);
create index contacts_custom_gin_idx on public.contacts using gin (custom jsonb_path_ops);

create table public.contact_phones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  label text,
  created_at timestamptz not null default now(),
  unique (contact_id, phone_e164)
);
create index contact_phones_org_phone_idx on public.contact_phones (org_id, phone_e164);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  color text not null default 'gray',
  scope text not null default 'contact' check (scope in ('contact', 'enquiry', 'conversation')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, scope, name)
);

create table public.contact_tags (
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);
create index contact_tags_tag_idx on public.contact_tags (tag_id, contact_id);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity text not null default 'contact' check (entity in ('contact', 'enquiry', 'appointment')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text not null,
  type text not null check (type in ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email', 'phone')),
  options jsonb not null default '[]'::jsonb,         -- [{"value":"a","label":"A"}] for select types
  required boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity, key),
  check (jsonb_typeof(options) = 'array')
);

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('static', 'dynamic')),
  filter jsonb,                                       -- lib/filters AST (dynamic only)
  drip_flow_id uuid,                                  -- Phase 8 adds the FK
  member_count integer not null default 0,
  count_refreshed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  check ((kind = 'dynamic') = (filter is not null))
);

create table public.segment_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  segment_id uuid not null references public.segments (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (segment_id, contact_id)
);
create index segment_members_contact_idx on public.segment_members (contact_id);

create table public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  enquiry_id uuid,                                    -- Phase 5 adds the FK
  type text not null,                                 -- contact.created, contact.updated, note, tag.added, merge, import, ...
  actor_type text not null default 'user' check (actor_type in ('user', 'system', 'contact', 'job')),
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index timeline_events_contact_idx on public.timeline_events (org_id, contact_id, at desc);
create index timeline_events_enquiry_idx on public.timeline_events (enquiry_id, at desc) where enquiry_id is not null;

-- Per-user grid layout: visible columns, order and widths per grid.
create table public.user_grid_prefs (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  grid_key text not null,                             -- 'contacts'
  prefs jsonb not null default '{}'::jsonb,           -- {"columns":[{"id":"phone","width":160}], "pageSize":100}
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id, grid_key)
);

-- Dedupe map for imports and syncs: one row per (source, entity, external id).
create table public.external_refs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null,                               -- airtable | sanoflow | unite
  entity text not null,                               -- e.g. 'app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB' or 'contact'
  external_id text not null,
  local_table text not null,
  local_id uuid not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, entity, external_id)
);
create index external_refs_local_idx on public.external_refs (local_table, local_id);

-- Ambiguous import/sync matches that a human must resolve. Never auto-merged.
create table public.sync_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null,
  entity text not null,
  external_id text not null,
  reason text not null,                               -- e.g. 'multiple_phone_matches'
  candidates jsonb not null default '[]'::jsonb,      -- [{"contact_id": "...", "matched_on": "phone"}]
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_contact_id uuid references public.contacts (id) on delete set null,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, entity, external_id)
);
create index sync_reviews_open_idx on public.sync_reviews (org_id, created_at desc) where status = 'open';

-- @mentions of staff in conversation comments. Phase 3 adds FKs to messages/conversations.
create table public.mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  conversation_id uuid,
  message_id uuid,
  mentioned_by uuid references public.profiles (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index mentions_user_idx on public.mentions (user_id, created_at desc);
create index mentions_contact_idx on public.mentions (contact_id, user_id);

-- updated_at triggers
create trigger contacts_set_updated_at before update on public.contacts for each row execute function app.set_updated_at();
create trigger tags_set_updated_at before update on public.tags for each row execute function app.set_updated_at();
create trigger custom_fields_set_updated_at before update on public.custom_fields for each row execute function app.set_updated_at();
create trigger segments_set_updated_at before update on public.segments for each row execute function app.set_updated_at();
create trigger user_grid_prefs_set_updated_at before update on public.user_grid_prefs for each row execute function app.set_updated_at();
create trigger external_refs_set_updated_at before update on public.external_refs for each row execute function app.set_updated_at();
create trigger sync_reviews_set_updated_at before update on public.sync_reviews for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------

-- Normalise contact emails; a merged contact is always soft-deleted.
create or replace function app.normalize_contact()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.first_name := btrim(new.first_name);
  new.last_name := btrim(new.last_name);
  if new.merged_into_id is not null and new.deleted_at is null then
    new.deleted_at := now();
  end if;
  if new.merged_into_id = new.id then
    raise exception 'a contact cannot be merged into itself' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger contacts_normalize before insert or update on public.contacts
  for each row execute function app.normalize_contact();

-- Child rows must carry the parent's org. TG_ARGV[0] = parent table, TG_ARGV[1] = fk column.
create or replace function app.check_parent_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_org uuid;
  v_fk uuid;
begin
  v_fk := (to_jsonb(new) ->> tg_argv[1])::uuid;
  if v_fk is null then
    return new;
  end if;
  execute format('select org_id from public.%I where id = $1', tg_argv[0]) into v_parent_org using v_fk;
  if v_parent_org is distinct from new.org_id then
    raise exception '% % does not belong to org %', tg_argv[0], v_fk, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger contact_phones_org_check before insert or update on public.contact_phones
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger contact_tags_contact_org_check before insert or update on public.contact_tags
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger contact_tags_tag_org_check before insert or update on public.contact_tags
  for each row execute function app.check_parent_org('tags', 'tag_id');
create trigger segment_members_segment_org_check before insert or update on public.segment_members
  for each row execute function app.check_parent_org('segments', 'segment_id');
create trigger segment_members_contact_org_check before insert or update on public.segment_members
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger timeline_events_org_check before insert or update on public.timeline_events
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger mentions_org_check before insert or update on public.mentions
  for each row execute function app.check_parent_org('contacts', 'contact_id');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.contacts enable row level security;
alter table public.contact_phones enable row level security;
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;
alter table public.custom_fields enable row level security;
alter table public.segments enable row level security;
alter table public.segment_members enable row level security;
alter table public.timeline_events enable row level security;
alter table public.user_grid_prefs enable row level security;
alter table public.external_refs enable row level security;
alter table public.sync_reviews enable row level security;
alter table public.mentions enable row level security;

-- contacts and their children: contacts.view reads, contacts.manage writes.
create policy contacts_select on public.contacts for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contacts_update on public.contacts for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contacts_delete on public.contacts for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

create policy contact_phones_select on public.contact_phones for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy contact_phones_insert on public.contact_phones for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_phones_update on public.contact_phones for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_phones_delete on public.contact_phones for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

create policy contact_tags_select on public.contact_tags for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy contact_tags_insert on public.contact_tags for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_tags_delete on public.contact_tags for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

-- tags: every member can read; contacts.manage creates/edits.
create policy tags_select on public.tags for select to authenticated
  using (app.is_org_member(org_id));
create policy tags_insert on public.tags for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy tags_update on public.tags for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy tags_delete on public.tags for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

-- custom fields: members read; settings.manage writes.
create policy custom_fields_select on public.custom_fields for select to authenticated
  using (app.is_org_member(org_id));
create policy custom_fields_insert on public.custom_fields for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy custom_fields_update on public.custom_fields for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy custom_fields_delete on public.custom_fields for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- segments: contacts.view reads; contacts.manage writes.
create policy segments_select on public.segments for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy segments_insert on public.segments for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy segments_update on public.segments for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy segments_delete on public.segments for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

create policy segment_members_select on public.segment_members for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy segment_members_insert on public.segment_members for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy segment_members_delete on public.segment_members for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

-- timeline: contacts.view reads; contacts.manage adds notes. Never updated or deleted via the API.
create policy timeline_events_select on public.timeline_events for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy timeline_events_insert on public.timeline_events for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage') and actor_type = 'user' and actor_id = auth.uid());

-- grid prefs: your own rows only.
create policy user_grid_prefs_select on public.user_grid_prefs for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));
create policy user_grid_prefs_insert on public.user_grid_prefs for insert to authenticated
  with check (user_id = auth.uid() and app.is_org_member(org_id));
create policy user_grid_prefs_update on public.user_grid_prefs for update to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));
create policy user_grid_prefs_delete on public.user_grid_prefs for delete to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));

-- import bookkeeping: admins read; writes are server-side only.
create policy external_refs_select on public.external_refs for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));
create policy sync_reviews_select on public.sync_reviews for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- mentions: your own, within orgs you belong to; you can mark them read.
create policy mentions_select on public.mentions for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));
create policy mentions_update on public.mentions for update to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Helpers used by compiled filters
-- ---------------------------------------------------------------------------

-- Next occurrence of a month/day on or after p_today (29 Feb → 28 Feb in common years).
create or replace function app.next_anniversary(p_date date, p_today date default current_date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when p_date is null then null
    else (
      with this_year as (
        select (p_date + make_interval(years => extract(year from p_today)::int - extract(year from p_date)::int))::date as d
      )
      select case when d >= p_today then d else (d + interval '1 year')::date end from this_year
    )
  end;
$$;
grant execute on function app.next_anniversary(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPCs (service role only). The WHERE fragment is produced by lib/filters
-- (to-sql.ts) from a validated AST; values travel in p_params ($1) and are
-- never interpolated into SQL text. The functions pin org_id and soft-deletes
-- themselves, so a bad fragment can at most return fewer rows.
-- ---------------------------------------------------------------------------

create or replace function public.contacts_search(
  p_org_id uuid,
  p_where text,
  p_params jsonb,
  p_order_by text default 'c.created_at desc',
  p_limit integer default 100,
  p_offset integer default 0
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
    p_order_by := 'c.created_at desc';
  end if;
  if p_order_by !~ '^[A-Za-z0-9_.(),''%>=:* \-]+$' or p_order_by ~ ';' then
    raise exception 'invalid order by' using errcode = 'check_violation';
  end if;
  return query execute format(
    'select c.id, count(*) over() as total from public.contacts c where c.org_id = $2 and c.deleted_at is null and (%s) order by %s, c.id limit $3 offset $4',
    p_where, p_order_by
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, greatest(1, least(coalesce(p_limit, 100), 1000)), greatest(0, coalesce(p_offset, 0));
end;
$$;
revoke all on function public.contacts_search(uuid, text, jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.contacts_search(uuid, text, jsonb, text, integer, integer) to service_role;

create or replace function public.contacts_count(p_org_id uuid, p_where text, p_params jsonb)
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
    'select count(*) from public.contacts c where c.org_id = $2 and c.deleted_at is null and (%s)',
    p_where
  ) into v_count using coalesce(p_params, '[]'::jsonb), p_org_id;
  return v_count;
end;
$$;
revoke all on function public.contacts_count(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.contacts_count(uuid, text, jsonb) to service_role;

-- Stream of ids matching a filter (for exports and static-segment fills).
create or replace function public.contacts_ids(p_org_id uuid, p_where text, p_params jsonb, p_limit integer default 50000)
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
    'select c.id from public.contacts c where c.org_id = $2 and c.deleted_at is null and (%s) order by c.created_at, c.id limit $3',
    p_where
  ) using coalesce(p_params, '[]'::jsonb), p_org_id, greatest(1, coalesce(p_limit, 50000));
end;
$$;
revoke all on function public.contacts_ids(uuid, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.contacts_ids(uuid, text, jsonb, integer) to service_role;

-- Merge p_secondary into p_primary in one transaction.
-- p_fields: {"first_name": "...", "email": "..."} — resolved values to write on the primary
-- (the caller decides which side wins; blanks on the primary are filled from the secondary).
create or replace function public.merge_contacts(
  p_org_id uuid,
  p_primary_id uuid,
  p_secondary_id uuid,
  p_fields jsonb default '{}'::jsonb,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.contacts;
  s public.contacts;
begin
  if p_primary_id = p_secondary_id then
    raise exception 'cannot merge a contact into itself' using errcode = 'check_violation';
  end if;
  select * into p from public.contacts where id = p_primary_id and org_id = p_org_id and deleted_at is null for update;
  select * into s from public.contacts where id = p_secondary_id and org_id = p_org_id and deleted_at is null for update;
  if p.id is null or s.id is null then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- Free the secondary's unique identifiers before moving them.
  update public.contacts set phone_e164 = null, wa_bsuid = null, external_id = null, email = null,
    deleted_at = now(), merged_into_id = p_primary_id
  where id = p_secondary_id;

  -- Resolved scalar fields: caller-chosen values, then fill blanks from the secondary.
  update public.contacts set
    first_name = coalesce(nullif(p_fields ->> 'first_name', ''), nullif(p.first_name, ''), s.first_name),
    last_name = coalesce(nullif(p_fields ->> 'last_name', ''), nullif(p.last_name, ''), s.last_name),
    phone_e164 = coalesce(nullif(p_fields ->> 'phone_e164', ''), p.phone_e164, s.phone_e164),
    wa_bsuid = coalesce(p.wa_bsuid, s.wa_bsuid),
    email = coalesce(nullif(p_fields ->> 'email', ''), p.email, s.email),
    gender = coalesce(nullif(p_fields ->> 'gender', ''), p.gender, s.gender),
    nationality = coalesce(nullif(p_fields ->> 'nationality', ''), p.nationality, s.nationality),
    country = coalesce(nullif(p_fields ->> 'country', ''), p.country, s.country),
    language = coalesce(nullif(p_fields ->> 'language', ''), p.language, s.language),
    dob = coalesce((nullif(p_fields ->> 'dob', ''))::date, p.dob, s.dob),
    label = coalesce(nullif(p_fields ->> 'label', ''), p.label, s.label),
    owner_id = coalesce(p.owner_id, s.owner_id),
    assignee_id = coalesce(p.assignee_id, s.assignee_id),
    external_id = coalesce(nullif(p_fields ->> 'external_id', ''), p.external_id, s.external_id),
    promotions_opt_in = p.promotions_opt_in or s.promotions_opt_in,
    stop_marketing = p.stop_marketing or s.stop_marketing,      -- opt-outs always win
    custom = s.custom || p.custom,                                -- primary keys win
    last_interaction_at = greatest(p.last_interaction_at, s.last_interaction_at)
  where id = p_primary_id;

  -- The losing primary phone (if different) becomes an alternate phone.
  insert into public.contact_phones (org_id, contact_id, phone_e164, label)
  select p_org_id, p_primary_id, ph, 'merged'
  from unnest(array[p.phone_e164, s.phone_e164]) as ph
  where ph is not null and ph <> (select phone_e164 from public.contacts where id = p_primary_id)
  on conflict (contact_id, phone_e164) do nothing;

  insert into public.contact_phones (org_id, contact_id, phone_e164, label)
  select org_id, p_primary_id, phone_e164, label from public.contact_phones where contact_id = p_secondary_id
  on conflict (contact_id, phone_e164) do nothing;
  delete from public.contact_phones where contact_id = p_secondary_id;
  delete from public.contact_phones where contact_id = p_primary_id
    and phone_e164 = (select phone_e164 from public.contacts where id = p_primary_id);

  insert into public.contact_tags (org_id, contact_id, tag_id, added_by)
  select org_id, p_primary_id, tag_id, added_by from public.contact_tags where contact_id = p_secondary_id
  on conflict do nothing;
  delete from public.contact_tags where contact_id = p_secondary_id;

  insert into public.segment_members (org_id, segment_id, contact_id, added_by)
  select org_id, segment_id, p_primary_id, added_by from public.segment_members where contact_id = p_secondary_id
  on conflict do nothing;
  delete from public.segment_members where contact_id = p_secondary_id;

  update public.timeline_events set contact_id = p_primary_id where contact_id = p_secondary_id;
  update public.mentions set contact_id = p_primary_id where contact_id = p_secondary_id;
  update public.external_refs set local_id = p_primary_id where local_table = 'contacts' and local_id = p_secondary_id;
  update public.contacts set merged_into_id = p_primary_id where merged_into_id = p_secondary_id;

  insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
  values (p_org_id, p_primary_id, 'contact.merged', case when p_user_id is null then 'system' else 'user' end, p_user_id,
          jsonb_build_object('merged_contact_id', p_secondary_id));
end;
$$;
revoke all on function public.merge_contacts(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.merge_contacts(uuid, uuid, uuid, jsonb, uuid) to service_role;

-- Likely duplicates: same email, same name + DOB, or an alternate phone equal to
-- another contact's primary phone. Pairs are ordered (a < b) so each shows once.
create or replace function public.contact_duplicate_candidates(p_org_id uuid, p_limit integer default 200)
returns table (a_id uuid, b_id uuid, reason text)
language sql
security definer
set search_path = ''
as $$
  select * from (
    select least(a.id, b.id) as a_id, greatest(a.id, b.id) as b_id, 'email' as reason
    from public.contacts a
    join public.contacts b on b.org_id = a.org_id and b.id > a.id and b.deleted_at is null and lower(b.email) = lower(a.email)
    where a.org_id = p_org_id and a.deleted_at is null and a.email is not null
    union
    select least(a.id, b.id), greatest(a.id, b.id), 'name_dob'
    from public.contacts a
    join public.contacts b on b.org_id = a.org_id and b.id > a.id and b.deleted_at is null
      and lower(b.full_name) = lower(a.full_name) and b.dob = a.dob
    where a.org_id = p_org_id and a.deleted_at is null and a.dob is not null and a.full_name <> ''
    union
    select least(a.id, cp.contact_id), greatest(a.id, cp.contact_id), 'phone'
    from public.contacts a
    join public.contact_phones cp on cp.org_id = a.org_id and cp.phone_e164 = a.phone_e164 and cp.contact_id <> a.id
    join public.contacts b on b.id = cp.contact_id and b.deleted_at is null
    where a.org_id = p_org_id and a.deleted_at is null
  ) d
  order by reason, a_id
  limit greatest(1, coalesce(p_limit, 200));
$$;
revoke all on function public.contact_duplicate_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.contact_duplicate_candidates(uuid, integer) to service_role;
