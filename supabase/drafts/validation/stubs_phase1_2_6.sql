-- Validation-only stubs. NOT a migration.
-- Minimal versions of the Phase 1/2/3/4/6 core tables (docs/02 §3) that the drafts reference,
-- plus a stand-in for Supabase's auth.uid(). Used by validation/run.sh on a scratch database.

create extension if not exists pgcrypto;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Dubai'
);
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  first_name text, last_name text
);
create table if not exists public.memberships (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'agent',
  primary key (org_id, user_id)
);
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null
);
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

-- RLS on the stub tables so the cross-org test is meaningful end to end
alter table public.contacts enable row level security;
create policy contacts_member on public.contacts for all
  using (exists (select 1 from public.memberships m where m.org_id = contacts.org_id and m.user_id = auth.uid()));

-- an unprivileged role that behaves like Supabase's "authenticated"
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if;
end $$;
grant usage on schema public, auth to app_user;
alter default privileges in schema public grant select, insert, update, delete on tables to app_user;
alter default privileges in schema public grant usage, select on sequences to app_user;
alter default privileges in schema public grant execute on functions to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant execute on all functions in schema auth to app_user;
