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
