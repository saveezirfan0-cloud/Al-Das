-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. Safe to stop between files.

-- ======================================================================
-- 20261009000700_hardening.sql
-- ======================================================================
-- Phase 11: hardening.
--   1. Postgres-backed fixed-window rate limiter (no Redis): rate_limit_hits + rate_limit_hit().
--   2. audit_log is append-only even for the service role (RLS alone does not bind it).

-- ---------------------------------------------------------------------------
-- Rate limiter. One row per (key, window). rate_limit_hit() is an atomic
-- insert-or-increment that reports whether the call is still within the limit.
-- Keys are opaque strings built by lib/rate-limit.ts (hashed IPs, API key ids,
-- user ids); never put phone numbers or tokens in a key.
-- ---------------------------------------------------------------------------

create table public.rate_limit_hits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
create index rate_limit_hits_window_idx on public.rate_limit_hits (window_start);

alter table public.rate_limit_hits enable row level security;
-- no API policies: service role only

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, hits integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window integer := greatest(p_window_seconds, 1);
  v_start timestamptz;
  v_hits integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 then
    raise exception 'invalid rate limit key';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);
  insert into public.rate_limit_hits as r (key, window_start, hits)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  allowed := v_hits <= greatest(p_limit, 1);
  hits := v_hits;
  retry_after := case when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => v_window) - now())))::integer) end;
  return next;
end;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

select cron.schedule('pulse:housekeeping_rate_limits', '35 3 * * *', $$
  delete from public.rate_limit_hits where window_start < now() - interval '1 day';
$$);

-- ---------------------------------------------------------------------------
-- audit_log is append-only. Deleting the org cascades (orgs are never deleted
-- in normal operation) and ON DELETE SET NULL on user_id is an UPDATE of the
-- user_id column only, so both stay possible; everything else is blocked.
-- ---------------------------------------------------------------------------

create or replace function app.audit_log_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- Allow only the FK action that nulls user_id when a user is removed.
    if new.user_id is null
       and (new.id, new.org_id, new.action, new.entity, new.entity_id, new.diff, new.at)
           is not distinct from (old.id, old.org_id, old.action, old.entity, old.entity_id, old.diff, old.at) then
      return new;
    end if;
    raise exception 'audit_log is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    -- Rows may only disappear through the orgs cascade.
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'audit_log is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.audit_log_guard();

-- ---------------------------------------------------------------------------
-- Function grants. Supabase's default privileges grant EXECUTE on new public
-- functions to anon explicitly, which `revoke ... from public` does not remove.
-- The two RPCs meant for signed-in users must not be callable anonymously.
-- ---------------------------------------------------------------------------

revoke execute on function public.mark_all_notifications_read(uuid) from anon;
revoke execute on function public.set_presence(uuid, text) from anon;

-- ---------------------------------------------------------------------------
-- Bulk send pacing: slot reservation.
--
-- A message that misses its second's slot used to re-queue itself and try again
-- (and again), re-reading a heavy joined row each time. With a 2,000-message backlog at
-- 20 msg/s the retry churn cut throughput to ~7 msg/s; a 20,000-recipient campaign
-- could not finish. reserve_send_slot() instead books the first future second that still
-- has room (below p_cap), so the message is re-queued once with a delay.
--
-- Bookings are only a scheduling hint, kept in their own column (`booked`). Enforcement stays
-- in claim_send_slot() (`used`), which every send still calls at send time: a message that
-- runs late (stall, backlog ahead of it in the queue) simply fails the claim and is re-booked,
-- so catch-up can never burst past the per-number limit. A cursor per channel keeps each
-- booking O(1) however long the backlog is.
-- ---------------------------------------------------------------------------

alter table public.channel_send_slots add column booked integer not null default 0;

create table public.channel_send_cursor (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  next_slot timestamptz not null
);
alter table public.channel_send_cursor enable row level security;
-- no API policies: service role only

create or replace function public.reserve_send_slot(p_channel_id uuid, p_cap integer)
returns integer                                  -- seconds from now until the booked slot (>= 1)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap integer := greatest(p_cap, 1);
  v_now timestamptz := date_trunc('second', now());
  v_slot timestamptz;
  v_booked integer;
begin
  insert into public.channel_send_cursor (channel_id, next_slot)
  values (p_channel_id, v_now + interval '1 second')
  on conflict (channel_id) do nothing;

  -- Serialises bookings per channel; the row is held only for this call.
  select greatest(c.next_slot, v_now + interval '1 second') into v_slot
  from public.channel_send_cursor c
  where c.channel_id = p_channel_id
  for update;

  loop
    v_booked := null;
    insert into public.channel_send_slots as s (channel_id, slot, used, booked)
    values (p_channel_id, v_slot, 0, 1)
    on conflict (channel_id, slot) do update set booked = s.booked + 1
      where s.booked < v_cap
    returning s.booked into v_booked;
    exit when v_booked is not null;
    v_slot := v_slot + interval '1 second';
  end loop;

  update public.channel_send_cursor set next_slot = v_slot where channel_id = p_channel_id;
  return greatest(1, ceil(extract(epoch from (v_slot - now())))::integer);
end;
$$;
revoke all on function public.reserve_send_slot(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_send_slot(uuid, integer) to service_role;

-- Seconds until the earliest delayed (never-read, not yet visible) message in a queue becomes
-- visible; null when nothing is waiting on a delay. Lets a drain tick stay awake for reserved
-- sends instead of leaving them to pile up until the next 10 s cron tick.
create or replace function public.job_next_due(p_queue text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due integer;
begin
  if p_queue !~ '^[a-z_]{1,40}$' then
    raise exception 'invalid queue name';
  end if;
  execute format(
    'select ceil(extract(epoch from (min(vt) - now())))::integer from pgmq.%I where read_ct = 0 and vt > now()',
    'q_' || p_queue
  ) into v_due;
  return v_due;
end;
$$;
revoke all on function public.job_next_due(text) from public, anon, authenticated;
grant execute on function public.job_next_due(text) to service_role;

-- ======================================================================
-- 20261009000800_reconcile.sql
-- ======================================================================
-- Phase 11: counts-only snapshot used by `pnpm reconcile` (migration sign-off).
-- Returns numbers, never rows: no names, phones or message text leave the database.
-- Service role only.

create or replace function public.reconcile_snapshot(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'refs', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.external_refs where org_id = p_org_id group by source, entity) r
    ), '{}'::jsonb),
    'reviews_open', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'open' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_dismissed', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'dismissed' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_resolved', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'resolved' group by source, entity) r
    ), '{}'::jsonb),
    'orphan_refs', (
      select count(*) from public.external_refs r
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and not exists (select 1 from public.contacts c where c.id = r.local_id)
    ),
    'refs_to_deleted_contacts', (
      select count(*) from public.external_refs r
      join public.contacts c on c.id = r.local_id
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and c.deleted_at is not null and c.merged_into_id is null
    ),
    'contacts_live', (select count(*) from public.contacts where org_id = p_org_id and deleted_at is null),
    'contacts_imported', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null and source in ('import_airtable', 'import_sanoflow', 'import_csv')
    ),
    'contacts_without_identifier', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null
        and phone_e164 is null and wa_bsuid is null and external_id is null
    ),
    'duplicate_alternate_phones', (
      select count(*) from (
        select cp.phone_e164
        from public.contact_phones cp
        join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
        where cp.org_id = p_org_id
        group by cp.phone_e164
        having count(distinct cp.contact_id) > 1
      ) d
    ),
    'alternate_phone_is_other_primary', (
      select count(*) from public.contact_phones cp
      join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
      join public.contacts o on o.org_id = cp.org_id and o.phone_e164 = cp.phone_e164
        and o.deleted_at is null and o.id <> cp.contact_id
      where cp.org_id = p_org_id
    ),
    'merge_chains_over_1', (
      select count(*) from public.contacts c
      join public.contacts m on m.id = c.merged_into_id
      where c.org_id = p_org_id and m.merged_into_id is not null
    )
  );
$$;

revoke all on function public.reconcile_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_snapshot(uuid) to service_role;

-- ======================================================================
-- 20261009000900_rls_helpers.sql
-- ======================================================================
-- Phase 6: shared RLS helpers used by the appointment, Unite and clinical tables.
--   app.has_perm_wild  honours the prefix wildcards lib/auth/can.ts understands
--                      ('*', 'portal.*', 'portal.*.read'); app.has_perm is exact-match only (OQ-47).
--   app.add_tenant_rls enables RLS with per-operation policies in the Phase 1 style.
-- Promoted from supabase/drafts/0100_clinical_reference.sql.

-- ---------------------------------------------------------------------------
-- app.has_perm_wild — like app.has_perm (Phase 1) but honours the prefix wildcards that
-- lib/auth/can.ts already understands: '*', 'portal.*' (any portal object, read or write) and
-- 'portal.*.read' (read on any object). Phase 1's SQL has_perm matches exact keys only (OQ-47).
-- ---------------------------------------------------------------------------
create or replace function app.has_perm_wild(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    cross join lateral jsonb_array_elements_text(r.permissions) as perm(key)
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        perm.key = '*'
        or perm.key = p_perm
        -- 'portal.*'  matches 'portal.<anything>' (one or more segments)
        or (perm.key like '%.*' and p_perm like replace(perm.key, '.*', '.%'))
        -- 'portal.*.read' matches 'portal.<one segment>.read'
        or (perm.key like '%.*.%' and p_perm ~ ('^' || replace(replace(perm.key, '.', '\.'), '*', '[^.]+') || '$'))
      )
  );
$$;
grant execute on function app.has_perm_wild(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared helper: tenant RLS in the Phase 1 style (per-operation policies, `to authenticated`).
--   select  → any active org member
--   writes  → app.has_perm_wild(org_id, p_write_perm) when a permission key is given;
--             otherwise no write policy (server-side / service role only, like the jobs tables)
-- Also installs the updated_at trigger when the table has that column.
-- ---------------------------------------------------------------------------
create or replace function app.add_tenant_rls(p_table text, p_write_perm text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (app.is_org_member(org_id))',
                 p_table || '_select', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  if p_write_perm is not null then
    execute format('create policy %I on public.%I for insert to authenticated with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_insert', p_table, p_write_perm);
    execute format('create policy %I on public.%I for update to authenticated using (app.has_perm_wild(org_id, %L)) with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_update', p_table, p_write_perm, p_write_perm);
    execute format('create policy %I on public.%I for delete to authenticated using (app.has_perm_wild(org_id, %L))',
                   p_table || '_delete', p_table, p_write_perm);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = p_table and column_name = 'updated_at') then
    execute format('drop trigger if exists %I on public.%I', p_table || '_set_updated_at', p_table);
    execute format('create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
                   p_table || '_set_updated_at', p_table);
  end if;
end;
$$;


-- ======================================================================
-- 20261009000910_appointments.sql
-- ======================================================================
-- Phase 6 (6a): appointments.
-- Locations, departments, services, specialists (with the Unite doctor id), working hours,
-- time blocks, appointments and their reminders. Booking rules and the notification template
-- mapping live in orgs.settings->'appointments' (lib/appointments/settings.ts).
-- Every tenant table carries org_id and is protected by RLS keyed on memberships.

-- ---------------------------------------------------------------------------
-- Settings-side tables: every member reads, settings.manage writes.
-- ---------------------------------------------------------------------------

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  timezone text not null default 'Asia/Dubai',
  address text,
  photo_path text,
  external_id text,                                   -- Unite clinic_id (DHA licence of the branch)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index locations_org_external_uidx on public.locations (org_id, external_id) where external_id is not null;

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  department_id uuid references public.departments (id) on delete set null,
  name text not null,
  duration_min integer not null default 30 check (duration_min between 5 and 480),
  price numeric(10, 2) check (price is null or price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index services_department_idx on public.services (department_id);

create table public.specialists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  title text,
  photo_path text,
  department_id uuid references public.departments (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  external_id text,                                   -- Unite doctor id
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index specialists_org_external_uidx on public.specialists (org_id, external_id) where external_id is not null;
create index specialists_department_idx on public.specialists (department_id);

create table public.specialist_locations (
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  primary key (specialist_id, location_id)
);
create index specialist_locations_location_idx on public.specialist_locations (location_id);

create table public.specialist_services (
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (specialist_id, service_id)
);
create index specialist_services_service_idx on public.specialist_services (service_id);

-- Weekly working hours per specialist and location. weekday is ISO (1 = Monday … 7 = Sunday);
-- start_min/end_min are minutes after local midnight in the location's timezone.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_min smallint not null check (start_min between 0 and 1439),
  end_min smallint not null check (end_min between 1 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_min > start_min)
);
create index working_hours_specialist_idx on public.working_hours (specialist_id, location_id, weekday);

-- ---------------------------------------------------------------------------
-- Operational tables: appointments.view reads, appointments.manage writes.
-- ---------------------------------------------------------------------------

create table public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index time_blocks_specialist_idx on public.time_blocks (specialist_id, starts_at);

-- Per-org running appointment number (human friendly reference).
create table public.appointment_counters (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  last_number bigint not null default 0
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  number bigint not null,
  -- Unite appointments for a patient that is still in the Sync Review queue have no contact yet.
  contact_id uuid references public.contacts (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  specialist_id uuid references public.specialists (id) on delete set null,
  service_id uuid references public.services (id) on delete set null,
  department_id uuid references public.departments (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'awaiting'
    check (status in ('awaiting', 'confirmed', 'cancelled', 'completed', 'no_show')),
  channel_id uuid references public.channels (id) on delete set null,
  notes text,
  notify_early boolean not null default false,
  source text not null default 'portal' check (source in ('portal', 'unite', 'bot')),
  external_id text,                                   -- Unite appointmentid
  external_status text,                               -- raw Unite status code
  unite_clinic_id text,                               -- DHA licence of the branch as sent by Unite
  custom jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (jsonb_typeof(custom) = 'object'),
  check (contact_id is not null or source = 'unite')
);
create unique index appointments_org_number_uidx on public.appointments (org_id, number);
create unique index appointments_org_external_uidx on public.appointments (org_id, source, external_id)
  where external_id is not null;
create index appointments_org_starts_idx on public.appointments (org_id, starts_at);
create index appointments_specialist_starts_idx on public.appointments (specialist_id, starts_at);
create index appointments_contact_idx on public.appointments (contact_id, starts_at desc);

create or replace function app.assign_appointment_number()
returns trigger
language plpgsql
security definer  -- appointment_counters has no policies; the trigger bumps it on behalf of the caller
set search_path = ''
as $$
begin
  if new.number is null or new.number = 0 then
    insert into public.appointment_counters as c (org_id, last_number) values (new.org_id, 1)
    on conflict (org_id) do update set last_number = c.last_number + 1
    returning c.last_number into new.number;
  end if;
  return new;
end;
$$;
-- number is NOT NULL, so give inserts a placeholder that the trigger replaces.
alter table public.appointments alter column number set default 0;
create trigger appointments_assign_number before insert on public.appointments
  for each row execute function app.assign_appointment_number();

-- One row per reminder slot (idx 1..3) of an appointment.
create table public.appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  idx smallint not null check (idx between 1 and 3),
  due_at timestamptz not null,
  sent_at timestamptz,
  message_id uuid references public.messages (id) on delete set null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'failed', 'excluded', 'cancelled')),
  exclusion_reason text,
  error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, idx)
);
create index appointment_reminders_due_idx on public.appointment_reminders (org_id, due_at) where status = 'scheduled';
create index appointment_reminders_message_idx on public.appointment_reminders (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- Org consistency: every referenced row must belong to the same org.
-- ---------------------------------------------------------------------------

create trigger services_department_org_check before insert or update on public.services
  for each row execute function app.check_parent_org('departments', 'department_id');
create trigger specialists_department_org_check before insert or update on public.specialists
  for each row execute function app.check_parent_org('departments', 'department_id');
create trigger specialist_locations_specialist_org_check before insert or update on public.specialist_locations
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger specialist_locations_location_org_check before insert or update on public.specialist_locations
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger specialist_services_specialist_org_check before insert or update on public.specialist_services
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger specialist_services_service_org_check before insert or update on public.specialist_services
  for each row execute function app.check_parent_org('services', 'service_id');
create trigger working_hours_specialist_org_check before insert or update on public.working_hours
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger working_hours_location_org_check before insert or update on public.working_hours
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger time_blocks_specialist_org_check before insert or update on public.time_blocks
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger time_blocks_location_org_check before insert or update on public.time_blocks
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger appointments_contact_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger appointments_location_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger appointments_specialist_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger appointments_service_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('services', 'service_id');
create trigger appointments_department_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('departments', 'department_id');
create trigger appointments_channel_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger appointment_reminders_appointment_org_check before insert or update on public.appointment_reminders
  for each row execute function app.check_parent_org('appointments', 'appointment_id');

-- updated_at triggers
create trigger locations_set_updated_at before update on public.locations for each row execute function app.set_updated_at();
create trigger departments_set_updated_at before update on public.departments for each row execute function app.set_updated_at();
create trigger services_set_updated_at before update on public.services for each row execute function app.set_updated_at();
create trigger specialists_set_updated_at before update on public.specialists for each row execute function app.set_updated_at();
create trigger working_hours_set_updated_at before update on public.working_hours for each row execute function app.set_updated_at();
create trigger time_blocks_set_updated_at before update on public.time_blocks for each row execute function app.set_updated_at();
create trigger appointments_set_updated_at before update on public.appointments for each row execute function app.set_updated_at();
create trigger appointment_reminders_set_updated_at before update on public.appointment_reminders for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.locations enable row level security;
alter table public.departments enable row level security;
alter table public.services enable row level security;
alter table public.specialists enable row level security;
alter table public.specialist_locations enable row level security;
alter table public.specialist_services enable row level security;
alter table public.working_hours enable row level security;
alter table public.time_blocks enable row level security;
alter table public.appointment_counters enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_reminders enable row level security;

-- Catalogue tables: any member reads (the booking drawer needs them); settings.manage writes.
do $$
declare
  t text;
begin
  foreach t in array array['locations', 'departments', 'services', 'specialists', 'specialist_locations', 'specialist_services', 'working_hours']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (app.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (app.has_perm(org_id, ''settings.manage''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (app.has_perm(org_id, ''settings.manage'')) with check (app.has_perm(org_id, ''settings.manage''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (app.has_perm(org_id, ''settings.manage''))', t || '_delete', t);
  end loop;
end;
$$;

-- time blocks and appointments: appointments.view reads, appointments.manage writes.
create policy time_blocks_select on public.time_blocks for select to authenticated
  using (app.has_perm(org_id, 'appointments.view'));
create policy time_blocks_insert on public.time_blocks for insert to authenticated
  with check (app.has_perm(org_id, 'appointments.manage'));
create policy time_blocks_update on public.time_blocks for update to authenticated
  using (app.has_perm(org_id, 'appointments.manage'))
  with check (app.has_perm(org_id, 'appointments.manage'));
create policy time_blocks_delete on public.time_blocks for delete to authenticated
  using (app.has_perm(org_id, 'appointments.manage'));

create policy appointments_select on public.appointments for select to authenticated
  using (app.has_perm(org_id, 'appointments.view'));
create policy appointments_insert on public.appointments for insert to authenticated
  with check (app.has_perm(org_id, 'appointments.manage'));
create policy appointments_update on public.appointments for update to authenticated
  using (app.has_perm(org_id, 'appointments.manage'))
  with check (app.has_perm(org_id, 'appointments.manage'));
create policy appointments_delete on public.appointments for delete to authenticated
  using (app.has_perm(org_id, 'appointments.manage'));

-- reminders are written by jobs only; staff read them.
create policy appointment_reminders_select on public.appointment_reminders for select to authenticated
  using (app.has_perm(org_id, 'appointments.view'));
-- appointment_counters has RLS on and no policies: only the security definer trigger touches it.

-- ======================================================================
-- 20261009000920_appointments_ext.sql
-- ======================================================================
-- Phase 6 (6a): reminder support tables promoted from supabase/drafts/0105_appointment_reminders_ext.sql.
-- appointments / appointment_reminders already carry the extra columns (20261009000100_appointments.sql).

-- Unite appointment status codes seen in the log (AAC, ACF, APH, CNR, CVI, YTC, NSW). Meanings: OQ-23.
create table public.unite_appointment_status_map (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  code        text not null,
  status      text,                               -- appointments.status value (awaiting | confirmed | cancelled | no_show | completed | …) — null until confirmed
  label       text,
  counts_as_no_show boolean not null default false,
  primary key (org_id, code)
);

create or replace function public.seed_unite_appointment_status_map(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.unite_appointment_status_map (org_id, code, status, label, counts_as_no_show) values
    (p_org, 'AAC', null, 'Unite code AAC (meaning to confirm)', false),
    (p_org, 'ACF', null, 'Unite code ACF (confirmed?)',         false),
    (p_org, 'APH', null, 'Unite code APH (meaning to confirm)', false),
    (p_org, 'CNR', null, 'Unite code CNR (cancelled?)',         false),
    (p_org, 'CVI', null, 'Unite code CVI (meaning to confirm)', false),
    (p_org, 'YTC', null, 'Unite code YTC (yet to confirm?)',    false),
    (p_org, 'NSW', null, 'Unite code NSW (no-show?)',           false)
  on conflict do nothing;
$$;

-- Exclusion lists that were hard-coded in the Make filters (OQ-21)
create table public.reminder_exclusions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  kind        text not null check (kind in ('placeholder_name','doctor','department','location')),
  match_type  text not null default 'equals' check (match_type in ('equals','contains')),
  value       text not null,
  reason      text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, kind, match_type, value)
);

create or replace function public.seed_reminder_exclusions(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.reminder_exclusions (org_id, kind, match_type, value, reason) values
    (p_org, 'placeholder_name', 'equals',   'SHORELINE',   'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'block',       'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'contains', 'break',       'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'golden mile', 'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'meadows',     'Unite placeholder booking (from Make filter)'),
    (p_org, 'doctor', 'equals',   'Dr. Tod Cahil',       'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Abdel Malek',  'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Luka Ciglic',         'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Hermina',      'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'contains', 'Patricia Oliveira',   'Excluded in Make filter; reason unknown (OQ-21)')
  on conflict do nothing;
$$;

create or replace function public.is_reminder_excluded(p_org uuid, p_patient_name text, p_doctor_name text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.reminder_exclusions x
    where x.org_id = p_org and x.active
      and (
        (x.kind = 'placeholder_name' and x.match_type = 'equals'   and lower(coalesce(p_patient_name,'')) = lower(x.value)) or
        (x.kind = 'placeholder_name' and x.match_type = 'contains' and lower(coalesce(p_patient_name,'')) like '%' || lower(x.value) || '%') or
        (x.kind = 'doctor'           and x.match_type = 'equals'   and coalesce(p_doctor_name,'') = x.value) or
        (x.kind = 'doctor'           and x.match_type = 'contains' and coalesce(p_doctor_name,'') like '%' || x.value || '%')
      ));
$$;

-- Dashboard parity with the Airtable "Doctor & Department Performance" interface
create or replace view public.v_appointment_reminder_stats with (security_invoker = true) as
select a.org_id, a.location_id, a.specialist_id, a.external_status,
       date_trunc('day', r.sent_at)::date as sent_day,
       count(r.id) filter (where r.status = 'sent')     as reminders_sent,
       count(r.id) filter (where r.status = 'failed')   as reminders_failed,
       count(r.id) filter (where r.status = 'excluded') as reminders_excluded,
       count(distinct a.contact_id) as patients_contacted
from public.appointment_reminders r
join public.appointments a on a.id = r.appointment_id
group by a.org_id, a.location_id, a.specialist_id, a.external_status, date_trunc('day', r.sent_at)::date;

select app.add_tenant_rls('unite_appointment_status_map', 'appointments.manage');
select app.add_tenant_rls('reminder_exclusions',          'appointments.manage');
revoke all on function public.seed_unite_appointment_status_map(uuid), public.seed_reminder_exclusions(uuid) from public, anon, authenticated;
grant execute on function public.seed_unite_appointment_status_map(uuid), public.seed_reminder_exclusions(uuid) to service_role;

-- ======================================================================
-- 20261009000930_appointment_jobs.sql
-- ======================================================================
-- Phase 6 (6a): queue + cron for appointment reminders.
--   appointments queue : scheduled_jobs of kind 'appointment.reminder' land here (lib/jobs/handlers/appointments.ts)
--   appointments_sweep : maintenance task (every 5 min) that reconciles reminders after booking-rule edits
-- Queue names must stay in sync with lib/jobs/queues.ts.

select pgmq.create('appointments');

select cron.schedule('pulse:appointments',       '10 seconds', $$select app.ping_jobs('appointments')$$);
select cron.schedule('pulse:appointments_sweep', '*/5 * * * *', $$select app.ping_jobs('appointments_sweep')$$);

-- ======================================================================
-- 20261009000940_unite.sql
-- ======================================================================
-- Phase 6 (6b): Unite EMR sync plumbing. Unite is READ-ONLY here (CLAUDE.md rule 7).
--
-- The Finance module (…0600_finance_capture.sql) already owns integration_accounts (encrypted
-- credentials + token cache in config_enc) and unite_api_calls (call log). The appointment/patient sync
-- shares both: one set of credentials, one token cache. This migration only adds what the sync needs.
--
--   integration_accounts.config / consecutive_failures / breaker_open_until : non-secret sync settings
--                          (endpoint paths, feature flags) and the circuit breaker
--   sync_cursors         : where each incremental sync (source/entity/scope) got to.
--   sync_reviews.incoming: what Unite sent for a patient we could not match unambiguously.
--
-- The Unite Finance API is sync-once (each call permanently dequeues records). Nothing in the sync
-- calls it; only the guarded, feature-flagged finance_capture job does.

alter table public.integration_accounts
  add column config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  add column consecutive_failures integer not null default 0,
  add column breaker_open_until timestamptz;

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null,                                -- 'unite'
  entity text not null,                                -- 'appointments' | 'patients' | 'doctors'
  scope text not null default '',                      -- e.g. the clinic id for per-branch syncs
  cursor jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, entity, scope)
);
create trigger sync_cursors_set_updated_at before update on public.sync_cursors
  for each row execute function app.set_updated_at();
alter table public.sync_cursors enable row level security;
create policy sync_cursors_select on public.sync_cursors for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

alter table public.sync_reviews add column incoming jsonb not null default '{}'::jsonb;

-- Schedules. pg_cron runs in UTC: Dubai (UTC+4) 07:00–22:00 → 03:00–17:59 UTC.
select cron.schedule('pulse:unite_enqueue', '*/15 3-17 * * *', $$select app.ping_jobs('unite_enqueue')$$);
select cron.schedule('pulse:unite_nightly', '30 18 * * *', $$select app.ping_jobs('unite_nightly')$$);
select cron.schedule('pulse:unite_housekeeping', '40 3 * * *', $$
  delete from public.unite_api_calls where at < now() - interval '30 days';
$$);

