-- Validation-only stubs. NOT a migration.
-- Phase 1 is real (supabase/migrations + supabase/test/auth-stub.sql are applied first).
-- These are minimal stand-ins for the Phase 2/3/4/6 core tables (docs/02 §3) that the drafts reference.

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null, external_id text
);
create table if not exists public.specialists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null, external_id text
);
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  first_name text, last_name text,
  phone_e164 text, gender text, dob date,
  external_id text,
  stop_marketing boolean not null default false,
  promotions_opt_in boolean not null default false,
  clinical_messaging_consent boolean not null default false,
  is_test_record boolean not null default false,
  custom jsonb not null default '{}'::jsonb
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text
);
create table if not exists public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text
);
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  location_id uuid references public.locations(id),
  specialist_id uuid references public.specialists(id),
  starts_at timestamptz, ends_at timestamptz,
  status text, external_id text
);
create table if not exists public.appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  idx int not null,
  due_at timestamptz, sent_at timestamptz
);

-- RLS on the contacts stub so cross-org checks through views are meaningful end to end
alter table public.contacts enable row level security;
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select to authenticated using (app.is_org_member(org_id));
