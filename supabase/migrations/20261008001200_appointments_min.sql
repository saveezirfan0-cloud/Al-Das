-- Phase 8: minimal appointment tables + the contact columns the clinical/recall drafts rely on.
-- Phases 5-7 were not built when Phase 8 landed. Only the columns referenced by supabase/drafts 0102/0104/0105
-- and the recall engine exist here; Phase 6 EXTENDS these tables with ALTER TABLE (never recreate).

alter table public.contacts
  add column if not exists is_test_record boolean not null default false,
  add column if not exists clinical_messaging_consent boolean not null default false;

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  external_id text,                                   -- DHA facility licence / Unite clinic id
  timezone text not null default 'Asia/Dubai',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index locations_org_external_uidx on public.locations (org_id, external_id) where external_id is not null;

create table public.specialists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index specialists_org_external_uidx on public.specialists (org_id, external_id) where external_id is not null;

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  location_id uuid references public.locations (id) on delete set null,
  specialist_id uuid references public.specialists (id) on delete set null,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'awaiting',            -- awaiting | confirmed | cancelled | no_show | completed
  external_id text,                                   -- Unite appointment id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index appointments_org_external_uidx on public.appointments (org_id, external_id) where external_id is not null;
create index appointments_org_starts_idx on public.appointments (org_id, starts_at);

create table public.appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  idx int not null,
  due_at timestamptz,
  sent_at timestamptz
);

create trigger appointments_contact_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger appointments_location_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger appointments_specialist_org_check before insert or update on public.appointments
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

alter table public.appointment_reminders enable row level security;
create policy appointment_reminders_select on public.appointment_reminders for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id and app.is_org_member(a.org_id)));

select app.add_tenant_rls('locations',    'settings.manage');
select app.add_tenant_rls('specialists',  'settings.manage');
select app.add_tenant_rls('appointments', 'appointments.manage');
