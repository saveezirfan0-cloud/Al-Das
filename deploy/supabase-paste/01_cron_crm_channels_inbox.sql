-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. Safe to stop between files.

-- ======================================================================
-- 20261008000500_cron.sql
-- ======================================================================
-- Phase 1 / 5: pg_cron + pg_net drive the queue handlers.
--
-- Every few seconds pg_cron calls app.ping_jobs('<queue>'), which POSTs to
-- <app_url>/api/jobs/<queue> with the X-Job-Secret header. The URL and secret
-- come from Supabase Vault. After deploying, run once in the SQL editor:
--
--   select vault.create_secret('https://pulse.example.com', 'app_url');
--   select vault.create_secret('<same value as JOB_SECRET env>', 'job_secret');
--
-- Until both secrets exist, ping_jobs is a no-op (it raises a NOTICE).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function app.ping_jobs(p_queue text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'app_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'job_secret' limit 1;
  if v_url is null or v_secret is null then
    raise notice 'app.ping_jobs: vault secrets app_url/job_secret are not set; skipping %', p_queue;
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/api/jobs/' || p_queue,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Job-Secret', v_secret),
    body := jsonb_build_object('source', 'pg_cron', 'queue', p_queue),
    timeout_milliseconds := 55000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function app.ping_jobs(text) from public, anon, authenticated;

-- Schedules. pg_cron supports "N seconds" intervals (1–59).
-- Hot paths every 10s, slower lanes every 30s. Idempotent: unschedule first.
do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname like 'pulse:%' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:scheduler',         '10 seconds', $$select app.ping_jobs('scheduler')$$);
select cron.schedule('pulse:meta_events',       '10 seconds', $$select app.ping_jobs('meta_events')$$);
select cron.schedule('pulse:outbound_priority', '10 seconds', $$select app.ping_jobs('outbound_priority')$$);
select cron.schedule('pulse:outbound',          '10 seconds', $$select app.ping_jobs('outbound')$$);
select cron.schedule('pulse:flow_steps',        '10 seconds', $$select app.ping_jobs('flow_steps')$$);
select cron.schedule('pulse:media_fetch',       '10 seconds', $$select app.ping_jobs('media_fetch')$$);
select cron.schedule('pulse:notifications',     '10 seconds', $$select app.ping_jobs('notifications')$$);
select cron.schedule('pulse:campaign_fanout',   '30 seconds', $$select app.ping_jobs('campaign_fanout')$$);
select cron.schedule('pulse:webhooks_out',      '30 seconds', $$select app.ping_jobs('webhooks_out')$$);
select cron.schedule('pulse:unite_sync',        '30 seconds', $$select app.ping_jobs('unite_sync')$$);
select cron.schedule('pulse:kb_ingest',         '30 seconds', $$select app.ping_jobs('kb_ingest')$$);

-- Housekeeping: keep job_runs for 14 days, dead letters that were resolved for 30 days,
-- finished scheduled_jobs for 7 days, pg_net responses for 1 day.
select cron.schedule('pulse:housekeeping', '15 3 * * *', $$
  delete from public.job_runs where started_at < now() - interval '14 days';
  delete from public.dead_letters where resolved_at is not null and resolved_at < now() - interval '30 days';
  delete from public.scheduled_jobs where done_at is not null and done_at < now() - interval '7 days';
  delete from net._http_response where created < now() - interval '1 day';
$$);

-- Cron visibility for the System Health page (service role only).
create or replace function public.job_cron_status()
returns table (jobname text, schedule text, active boolean, last_status text, last_start timestamptz, last_end timestamptz)
language sql
security definer
set search_path = ''
as $$
  select j.jobname::text, j.schedule::text, j.active,
         d.status::text, d.start_time, d.end_time
  from cron.job j
  left join lateral (
    select status, start_time, end_time
    from cron.job_run_details r
    where r.jobid = j.jobid
    order by start_time desc
    limit 1
  ) d on true
  where j.jobname like 'pulse:%'
  order by j.jobname;
$$;
revoke all on function public.job_cron_status() from public, anon, authenticated;
grant execute on function public.job_cron_status() to service_role;

-- ======================================================================
-- 20261008000700_crm.sql
-- ======================================================================
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

-- ======================================================================
-- 20261008000800_channels.sql
-- ======================================================================
-- Phase 3 / 1: WhatsApp channels, per-number send slots, webhook ingress log, templates.

-- ---------------------------------------------------------------------------
-- channels: one row per WhatsApp number (phone_number_id) connected to the org.
-- The System User token lives in channel_secrets (service role only), encrypted
-- with AES-256-GCM by lib/crypto.ts.
-- ---------------------------------------------------------------------------

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  type text not null default 'whatsapp' check (type in ('whatsapp')),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  waba_id text not null,
  phone_number_id text not null unique,
  display_phone text,                                -- as reported by Meta (+971 4 ...), not a contact's phone
  verified_name text,
  business_id text,
  quality_rating text,                               -- GREEN | YELLOW | RED | UNKNOWN
  messaging_limit_tier text,                         -- TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED
  name_status text,
  is_coexistence boolean not null default false,
  catalog_id text,
  send_rate_per_sec integer not null default 20 check (send_rate_per_sec between 1 and 1000),
  business_profile jsonb not null default '{}'::jsonb,   -- about, address, description, email, websites, vertical, profile_picture_url
  meta jsonb not null default '{}'::jsonb,               -- raw phone fields, account_update payloads, last sync
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index channels_org_idx on public.channels (org_id, status);
create trigger channels_set_updated_at before update on public.channels for each row execute function app.set_updated_at();

alter table public.channels enable row level security;
create policy channels_select on public.channels for select to authenticated
  using (app.is_org_member(org_id));
-- Writes are server-side only (settings.manage checks, then the service role).

create table public.channel_secrets (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  access_token_enc text not null,                    -- lib/crypto.ts encrypt(); null row = use META_SYSTEM_USER_TOKEN
  updated_at timestamptz not null default now()
);
alter table public.channel_secrets enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- Per-number rate limit: one row per (channel, second). claim_send_slot() is an
-- atomic insert-or-increment that fails once the second is full, so parallel
-- drains never exceed the per-number limit. Rows are swept by housekeeping.
-- ---------------------------------------------------------------------------

create table public.channel_send_slots (
  channel_id uuid not null references public.channels (id) on delete cascade,
  slot timestamptz not null,                         -- truncated to the second
  used integer not null default 0,
  primary key (channel_id, slot)
);

create or replace function public.claim_send_slot(p_channel_id uuid, p_limit integer, p_at timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot timestamptz := date_trunc('second', p_at);
  v_used integer;
begin
  insert into public.channel_send_slots (channel_id, slot, used)
  values (p_channel_id, v_slot, 1)
  on conflict (channel_id, slot) do update
    set used = public.channel_send_slots.used + 1
    where public.channel_send_slots.used < greatest(p_limit, 1)
  returning used into v_used;
  return v_used is not null;
end;
$$;
revoke all on function public.claim_send_slot(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_send_slot(uuid, integer, timestamptz) to service_role;

alter table public.channel_send_slots enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- webhook_events_in: every verified Meta POST is stored raw before anything
-- else happens, then referenced by id from the meta_events queue.
-- ---------------------------------------------------------------------------

create table public.webhook_events_in (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'meta',
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  attempts integer not null default 0
);
create index webhook_events_in_pending_idx on public.webhook_events_in (received_at) where processed_at is null;
create index webhook_events_in_received_idx on public.webhook_events_in (received_at desc);

alter table public.webhook_events_in enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- wa_templates: Meta message templates per WABA (mirrors Meta; Phase 4 builds
-- the editor). Status/category/quality webhooks update rows here.
-- ---------------------------------------------------------------------------

create table public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete set null,
  waba_id text not null,
  meta_template_id text,
  name text not null,
  language text not null,
  category text not null default 'UTILITY',          -- MARKETING | UTILITY | AUTHENTICATION
  status text not null default 'PENDING',            -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED | IN_APPEAL | ...
  type text not null default 'standard' check (type in ('standard', 'media_interactive', 'carousel')),
  components jsonb not null default '[]'::jsonb,     -- Meta components array
  variable_map jsonb not null default '{}'::jsonb,   -- {"body.1": "contact.first_name", ...}
  parameter_format text not null default 'positional' check (parameter_format in ('positional', 'named')),
  retry_on_fail boolean not null default false,
  rejected_reason text,
  quality text,                                      -- GREEN | YELLOW | RED | UNKNOWN
  archived_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, name, language)
);
create index wa_templates_org_idx on public.wa_templates (org_id, status);
create index wa_templates_meta_id_idx on public.wa_templates (meta_template_id) where meta_template_id is not null;
create trigger wa_templates_set_updated_at before update on public.wa_templates for each row execute function app.set_updated_at();

alter table public.wa_templates enable row level security;
create policy wa_templates_select on public.wa_templates for select to authenticated
  using (app.is_org_member(org_id));
create policy wa_templates_insert on public.wa_templates for insert to authenticated
  with check (app.has_perm(org_id, 'templates.manage'));
create policy wa_templates_update on public.wa_templates for update to authenticated
  using (app.has_perm(org_id, 'templates.manage'))
  with check (app.has_perm(org_id, 'templates.manage'));
create policy wa_templates_delete on public.wa_templates for delete to authenticated
  using (app.has_perm(org_id, 'templates.manage'));

-- Housekeeping additions (pg_cron stub in tests is a no-op).
select cron.schedule('pulse:housekeeping_phase3', '25 3 * * *', $$
  delete from public.channel_send_slots where slot < now() - interval '1 hour';
  delete from public.webhook_events_in where processed_at is not null and received_at < now() - interval '30 days';
$$);

-- ======================================================================
-- 20261008000900_inbox.sql
-- ======================================================================
-- Phase 3 / 2: inbox — conversations, messages, labels, quick replies,
-- categories, saved views, round-robin picker, realtime, media bucket.
-- Extends Phase 2's CRM: contacts get wa_profile_name, mentions get their
-- message/conversation FKs, and inbox roles may read contacts.

alter table public.contacts add column if not exists wa_profile_name text;  -- profile.name from the last inbound webhook

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.conv_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'waiting', 'closed')),
  assignee_user_id uuid references public.profiles (id) on delete set null,
  assignee_team_id uuid references public.teams (id) on delete set null,
  bot_active boolean not null default false,
  flow_run_id uuid,                                  -- Phase 8
  last_inbound_at timestamptz,                       -- drives the 24h customer-service window
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text check (last_message_direction is null or last_message_direction in ('in', 'out', 'note')),
  unread_count integer not null default 0 check (unread_count >= 0),
  unread_alerted_at timestamptz,                     -- last "unread assigned conversation" email alert
  category_id uuid references public.conv_categories (id) on delete set null,
  summary text,
  ai_tags text[] not null default '{}',
  ad_referral jsonb,                                 -- CTWA referral captured on open
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live conversation per contact per number.
create unique index conversations_live_idx on public.conversations (channel_id, contact_id) where status <> 'closed';
create index conversations_org_list_idx on public.conversations (org_id, status, last_message_at desc nulls last);
create index conversations_org_assignee_idx on public.conversations (org_id, assignee_user_id) where status <> 'closed';
create index conversations_org_team_idx on public.conversations (org_id, assignee_team_id) where status <> 'closed';
create index conversations_contact_idx on public.conversations (contact_id, last_message_at desc);
create trigger conversations_set_updated_at before update on public.conversations for each row execute function app.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out', 'note')),
  kind text not null check (kind in (
    'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts',
    'interactive', 'button', 'reaction', 'template', 'order', 'system', 'unsupported', 'note'
  )),
  body text,                                         -- text body / caption / note text
  payload jsonb not null default '{}'::jsonb,        -- raw Meta message object (in) or send payload (out)
  media_path text,                                   -- Supabase Storage path in the wa-media bucket
  media_mime text,
  media_filename text,
  media_meta_id text,                                -- Meta media id (inbound: to fetch; outbound: after upload)
  wa_message_id text,
  reply_to_wa_message_id text,
  status text not null default 'received' check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code integer,
  error_message text,
  sent_by_user_id uuid references public.profiles (id) on delete set null,
  flow_run_id uuid,
  campaign_recipient_id uuid,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index messages_wa_message_id_idx on public.messages (wa_message_id) where wa_message_id is not null;
create index messages_conversation_at_idx on public.messages (conversation_id, at);
create index messages_org_failed_idx on public.messages (org_id, at desc) where status = 'failed';
create index messages_org_media_idx on public.messages (org_id, conversation_id) where media_path is not null;
create trigger messages_set_updated_at before update on public.messages for each row execute function app.set_updated_at();

create table public.conversation_labels (
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null,
  primary key (conversation_id, tag_id)
);
create index conversation_labels_org_added_idx on public.conversation_labels (org_id, added_at);

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  shortcut text not null check (shortcut ~ '^[a-z0-9_-]{1,40}$'),
  text text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, shortcut)
);
create trigger quick_replies_set_updated_at before update on public.quick_replies for each row execute function app.set_updated_at();

create table public.inbox_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  filter jsonb not null default '{}'::jsonb,
  shared_team_ids uuid[] not null default '{}',
  shared_all boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbox_views_org_idx on public.inbox_views (org_id);
create trigger inbox_views_set_updated_at before update on public.inbox_views for each row execute function app.set_updated_at();

-- Phase 2 created public.mentions (user_id, contact_id, conversation_id, message_id, mentioned_by, read_at).
alter table public.mentions
  add constraint mentions_conversation_id_fkey foreign key (conversation_id) references public.conversations (id) on delete cascade,
  add constraint mentions_message_id_fkey foreign key (message_id) references public.messages (id) on delete cascade;
create unique index mentions_message_user_idx on public.mentions (message_id, user_id) where message_id is not null;
create index mentions_user_unread_idx on public.mentions (user_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- Integrity: channel / contact / category / assignee team belong to the org.
-- ---------------------------------------------------------------------------

create or replace function app.check_conversation_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.channels where id = new.channel_id;
  if v_org is distinct from new.org_id then
    raise exception 'channel % does not belong to org %', new.channel_id, new.org_id using errcode = 'check_violation';
  end if;
  select org_id into v_org from public.contacts where id = new.contact_id;
  if v_org is distinct from new.org_id then
    raise exception 'contact % does not belong to org %', new.contact_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.assignee_team_id is not null then
    select org_id into v_org from public.teams where id = new.assignee_team_id;
    if v_org is distinct from new.org_id then
      raise exception 'team % does not belong to org %', new.assignee_team_id, new.org_id using errcode = 'check_violation';
    end if;
  end if;
  if new.assignee_user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.assignee_user_id
  ) then
    raise exception 'user % is not a member of org %', new.assignee_user_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.category_id is not null then
    select org_id into v_org from public.conv_categories where id = new.category_id;
    if v_org is distinct from new.org_id then
      raise exception 'category % does not belong to org %', new.category_id, new.org_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger conversations_org_check before insert or update on public.conversations
  for each row execute function app.check_conversation_org();

create or replace function app.check_message_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.conversation_id is null then
    return new;
  end if;
  select org_id into v_org from public.conversations where id = new.conversation_id;
  if v_org is distinct from new.org_id then
    raise exception 'conversation % does not belong to org %', new.conversation_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger messages_org_check before insert or update of conversation_id, org_id on public.messages
  for each row execute function app.check_message_org();
create trigger mentions_conversation_org_check before insert or update on public.mentions
  for each row execute function app.check_message_org();

create or replace function app.check_conversation_label_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.conversations where id = new.conversation_id;
  if v_org is distinct from new.org_id then
    raise exception 'conversation % does not belong to org %', new.conversation_id, new.org_id using errcode = 'check_violation';
  end if;
  select org_id into v_org from public.tags where id = new.tag_id;
  if v_org is distinct from new.org_id then
    raise exception 'tag % does not belong to org %', new.tag_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger conversation_labels_org_check before insert or update on public.conversation_labels
  for each row execute function app.check_conversation_label_org();

-- ---------------------------------------------------------------------------
-- Message status only moves forward. Mirrored in lib/whatsapp/status.ts.
--   received(0)  queued(1) sending(2) sent(3) delivered(4) read(5)  failed(9, terminal)
-- A late 'failed' after 'sent'/'delivered' is accepted (Meta can report it);
-- 'read' never regresses; nothing moves after 'failed'.
-- ---------------------------------------------------------------------------

create or replace function app.message_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'received' then 0
    when 'queued' then 1
    when 'sending' then 2
    when 'sent' then 3
    when 'delivered' then 4
    when 'read' then 5
    when 'failed' then 9
    else -1 end;
$$;

create or replace function app.guard_message_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reject boolean := false;
begin
  if new.status is distinct from old.status then
    if old.status = 'failed' and new.status <> 'failed' then
      v_reject := true;
    elsif app.message_status_rank(new.status) < app.message_status_rank(old.status) then
      v_reject := true;
    elsif new.status = 'failed' and old.status = 'read' then
      v_reject := true;
    end if;
    if v_reject then
      -- Keep the row as it was: a rejected transition must not leave its error behind.
      new.status := old.status;
      new.error_code := old.error_code;
      new.error_message := old.error_message;
    end if;
  end if;
  return new;
end;
$$;
create trigger messages_status_forward before update of status on public.messages
  for each row execute function app.guard_message_status();

-- Apply a status webhook. Returns true when the row changed. Service role only.
create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status text,
  p_at timestamptz,
  p_error_code integer default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
  v_id uuid;
begin
  select id, status into v_id, v_old from public.messages where wa_message_id = p_wa_message_id for update;
  if v_id is null then
    return false;
  end if;
  update public.messages
  set status = p_status,
      error_code = case when p_status = 'failed' then p_error_code else error_code end,
      error_message = case when p_status = 'failed' then left(p_error_message, 500) else error_message end
  where id = v_id
  returning status into v_new;
  return v_new is distinct from v_old;
end;
$$;
revoke all on function public.apply_message_status(text, text, timestamptz, integer, text) from public, anon, authenticated;
grant execute on function public.apply_message_status(text, text, timestamptz, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Round-robin: next online member of a team (rr_weight > 0), least recently
-- assigned first. Updates last_assigned_at atomically. Null when nobody is online.
-- ---------------------------------------------------------------------------

create or replace function public.pick_round_robin_assignee(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select tm.user_id into v_user
  from public.team_members tm
  join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
  where tm.team_id = p_team_id
    and tm.org_id = p_org_id
    and tm.rr_weight > 0
    and m.status = 'active'
    and m.presence = 'online'
  order by tm.last_assigned_at asc nulls first, tm.rr_weight desc, tm.user_id
  limit 1
  for update of tm skip locked;
  if v_user is null then
    return null;
  end if;
  update public.team_members set last_assigned_at = now() where team_id = p_team_id and user_id = v_user;
  return v_user;
end;
$$;
revoke all on function public.pick_round_robin_assignee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pick_round_robin_assignee(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS. Visibility: inbox.view_all sees every conversation in the org; other
-- members see conversations assigned to them, to one of their teams, or unassigned.
-- All inbox writes go through server actions (service role after can()).
-- ---------------------------------------------------------------------------

create or replace function app.user_team_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tm.team_id from public.team_members tm where tm.org_id = p_org_id and tm.user_id = auth.uid();
$$;

create or replace function app.can_view_conversation(p_org_id uuid, p_assignee_user_id uuid, p_assignee_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_org_member(p_org_id) and (
    app.has_perm(p_org_id, 'inbox.view_all')
    or p_assignee_user_id = auth.uid()
    or (p_assignee_team_id is not null and p_assignee_team_id in (select app.user_team_ids(p_org_id)))
    or (p_assignee_user_id is null and p_assignee_team_id is null)
  );
$$;
grant execute on function app.user_team_ids(uuid), app.can_view_conversation(uuid, uuid, uuid) to authenticated, service_role;

alter table public.conv_categories enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_labels enable row level security;
alter table public.quick_replies enable row level security;
alter table public.inbox_views enable row level security;

create policy conv_categories_select on public.conv_categories for select to authenticated
  using (app.is_org_member(org_id));

-- Inbox roles need the patient behind a conversation even without contacts.view.
drop policy contacts_select on public.contacts;
create policy contacts_select on public.contacts for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'contacts.view') or app.has_perm(org_id, 'inbox.send') or app.has_perm(org_id, 'inbox.view_all')));
drop policy contact_phones_select on public.contact_phones;
create policy contact_phones_select on public.contact_phones for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'contacts.view') or app.has_perm(org_id, 'inbox.send') or app.has_perm(org_id, 'inbox.view_all')));

create policy conversations_select on public.conversations for select to authenticated
  using (app.can_view_conversation(org_id, assignee_user_id, assignee_team_id));

create policy messages_select on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and app.can_view_conversation(c.org_id, c.assignee_user_id, c.assignee_team_id)
  ));

create policy conversation_labels_select on public.conversation_labels for select to authenticated
  using (app.is_org_member(org_id));

create policy quick_replies_select on public.quick_replies for select to authenticated
  using (app.is_org_member(org_id));

create policy inbox_views_select on public.inbox_views for select to authenticated
  using (
    app.is_org_member(org_id) and (
      owner_id = auth.uid() or shared_all
      or shared_team_ids && array(select app.user_team_ids(org_id))
    )
  );


-- ---------------------------------------------------------------------------
-- Realtime: conversations, messages and mentions stream to the inbox (RLS applies).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.conversations;
    alter publication supabase_realtime add table public.messages;
    alter publication supabase_realtime add table public.mentions;
  end if;
end $$;
alter table public.conversations replica identity full;
alter table public.messages replica identity full;
alter table public.mentions replica identity full;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for WhatsApp media and attachments.
-- Paths: <org_id>/<conversation_id>/<message_id>.<ext>. Members read via RLS;
-- uploads happen server-side (signed upload URLs) with the service role.
-- Guarded so the migration also applies on a plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('wa-media', 'wa-media', false, 104857600)
    on conflict (id) do nothing;
    execute $p$
      create policy wa_media_select on storage.objects for select to authenticated
        using (bucket_id = 'wa-media' and app.is_org_member(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;

-- Inbox housekeeping (auto-close, auto-remove labels, unread alerts) runs in the
-- app so it can read org settings and send email: pg_cron pings the task route.
select cron.schedule('pulse:inbox_housekeeping', '*/5 * * * *', $$select app.ping_jobs('inbox_housekeeping')$$);

