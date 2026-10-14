-- Phase C (docs/34_CLINIC_OS_PLAN.md): the organisation in CRM. Doctors, staff, their duties and the rota.
--
--   specialists     + licence (number, authority, expiry), specialty, phone extension, short bio. No patient data.
--   staff_members   the HR record: person, job title, department, home branch, manager, linked Pulse user,
--                   employment type, dates, work contact details, visa and licence expiry. NO pay columns: pay stays
--                   in finance (fin_cost_*, finance.costs.compensation) and never appears on an HR screen.
--   staff_duties    a checklist of duties per staff member (daily / weekly / monthly / once), optionally per branch.
--   rota_shifts     who works where and when (desk, doctor in a room, nurse); one person never has two shifts at once
--                   (refused here, under a per-person advisory lock, so two people saving at once cannot both win).
--
-- Permissions: hr.view (read) and hr.manage (write). Every write is a server action that checks can() and then uses
-- the service role, so the tables have SELECT policies only. The rota is also readable with appointments.view (the
-- front desk needs to know who is on). Branch rule: app.location_visible_to() on rota_shifts.location_id and
-- staff_members.home_location_id, like the diary (Phase B). Archived staff (deleted_at) are hidden from browsers.
--
-- Expiry reminders (visa, licence; staff and doctors) run in the daily hr_maintenance task: the *_expiry_notified_at
-- columns are claimed atomically, and reset by trigger when the date changes, so each date reminds once.
-- New roles: Doctor and HR (lib/auth/permissions.ts SYSTEM_ROLES), added to every existing org here.

-- ---------------------------------------------------------------------------
-- 1. Doctors: licence and profile fields on specialists
-- ---------------------------------------------------------------------------
alter table public.specialists
  add column licence_number text check (licence_number is null or char_length(licence_number) between 1 and 60),
  add column licence_authority text not null default 'DHA'
    check (char_length(btrim(licence_authority)) between 1 and 20),
  add column licence_expires_on date,
  add column licence_expiry_notified_at timestamptz,
  add column specialty text check (specialty is null or char_length(specialty) between 1 and 100),
  add column phone_ext text check (phone_ext is null or phone_ext ~ '^[0-9]{1,6}$'),
  add column bio text check (bio is null or char_length(bio) <= 500);

create or replace function app.specialists_licence_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.licence_expires_on is distinct from old.licence_expires_on then
    new.licence_expiry_notified_at := null;
  end if;
  return new;
end;
$$;
create trigger specialists_licence_reset before update of licence_expires_on on public.specialists
  for each row execute function app.specialists_licence_reset();

-- ---------------------------------------------------------------------------
-- 2. Staff (HR record)
-- ---------------------------------------------------------------------------
create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete set null,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  job_title text check (job_title is null or char_length(job_title) between 1 and 100),
  department_id uuid references public.departments (id) on delete set null,
  home_location_id uuid references public.locations (id) on delete set null,
  manager_staff_id uuid references public.staff_members (id) on delete set null,
  employment_type text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'locum', 'contractor', 'intern')),
  start_date date,
  end_date date,
  work_email text check (work_email is null or (char_length(work_email) <= 254 and work_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  work_phone text check (work_phone is null or work_phone ~ '^\+[1-9][0-9]{6,14}$'),
  visa_expires_on date,
  visa_expiry_notified_at timestamptz,
  licence_number text check (licence_number is null or char_length(licence_number) between 1 and 60),
  licence_expires_on date,
  licence_expiry_notified_at timestamptz,
  notes text check (notes is null or char_length(notes) <= 2000),
  specialist_id uuid references public.specialists (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_date is null or start_date is null or end_date >= start_date),
  check (manager_staff_id is null or manager_staff_id <> id)
);
create index staff_members_org_idx on public.staff_members (org_id, full_name) where deleted_at is null;
create index staff_members_home_location_idx on public.staff_members (home_location_id);
create index staff_members_manager_idx on public.staff_members (manager_staff_id);
create unique index staff_members_profile_uidx on public.staff_members (org_id, profile_id)
  where profile_id is not null and deleted_at is null;
create unique index staff_members_specialist_uidx on public.staff_members (org_id, specialist_id)
  where specialist_id is not null and deleted_at is null;
create index staff_members_visa_idx on public.staff_members (org_id, visa_expires_on)
  where visa_expires_on is not null and visa_expiry_notified_at is null and deleted_at is null;
create index staff_members_licence_idx on public.staff_members (org_id, licence_expires_on)
  where licence_expires_on is not null and licence_expiry_notified_at is null and deleted_at is null;

create trigger staff_members_set_updated_at before update on public.staff_members
  for each row execute function app.set_updated_at();
create trigger staff_members_department_org before insert or update of department_id, org_id on public.staff_members
  for each row execute function app.check_parent_org('departments', 'department_id');
create trigger staff_members_location_org before insert or update of home_location_id, org_id on public.staff_members
  for each row execute function app.check_parent_org('locations', 'home_location_id');
create trigger staff_members_manager_org before insert or update of manager_staff_id, org_id on public.staff_members
  for each row execute function app.check_parent_org('staff_members', 'manager_staff_id');
create trigger staff_members_specialist_org before insert or update of specialist_id, org_id on public.staff_members
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

-- The linked Pulse user must be a member of the same organisation; a changed expiry date reminds again.
create or replace function app.staff_members_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.profile_id is not null
     and (tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id or new.org_id is distinct from old.org_id)
     and not exists (
       select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.profile_id
     ) then
    raise exception 'The linked user is not a member of this organisation.'
      using errcode = 'check_violation', hint = 'profile_not_member';
  end if;
  if tg_op = 'UPDATE' then
    if new.visa_expires_on is distinct from old.visa_expires_on then
      new.visa_expiry_notified_at := null;
    end if;
    if new.licence_expires_on is distinct from old.licence_expires_on then
      new.licence_expiry_notified_at := null;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.staff_members_guard() from public, anon, authenticated;
create trigger staff_members_guard before insert or update on public.staff_members
  for each row execute function app.staff_members_guard();

-- ---------------------------------------------------------------------------
-- 3. Duties: a checklist per staff member
-- ---------------------------------------------------------------------------
create table public.staff_duties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  frequency text not null default 'daily' check (frequency in ('daily', 'weekly', 'monthly', 'once')),
  location_id uuid references public.locations (id) on delete set null,
  active boolean not null default true,
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index staff_duties_member_idx on public.staff_duties (staff_member_id, sort_order);
create trigger staff_duties_set_updated_at before update on public.staff_duties
  for each row execute function app.set_updated_at();
create trigger staff_duties_member_org before insert or update of staff_member_id, org_id on public.staff_duties
  for each row execute function app.check_parent_org('staff_members', 'staff_member_id');
create trigger staff_duties_location_org before insert or update of location_id, org_id on public.staff_duties
  for each row execute function app.check_parent_org('locations', 'location_id');

-- ---------------------------------------------------------------------------
-- 4. Rota: shifts per branch and day
-- ---------------------------------------------------------------------------
create table public.rota_shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  role_label text not null default 'other' check (role_label in ('front_desk', 'doctor', 'nurse', 'other')),
  room text check (room is null or char_length(room) between 1 and 40),
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at <= starts_at + interval '24 hours')
);
create index rota_shifts_location_idx on public.rota_shifts (org_id, location_id, starts_at);
create index rota_shifts_member_idx on public.rota_shifts (staff_member_id, starts_at);
create trigger rota_shifts_set_updated_at before update on public.rota_shifts
  for each row execute function app.set_updated_at();
create trigger rota_shifts_location_org before insert or update of location_id, org_id on public.rota_shifts
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger rota_shifts_member_org before insert or update of staff_member_id, org_id on public.rota_shifts
  for each row execute function app.check_parent_org('staff_members', 'staff_member_id');

-- One person, one place at a time. The per-person advisory lock serialises concurrent saves; each statement in this
-- volatile function takes a fresh snapshot, so the second saver sees the first one's committed shift and is refused.
-- Shifts touching end to start (09:00-13:00 and 13:00-17:00) are allowed. lib/organisation/rota.ts mirrors the rule
-- for the dialog's early warning; the database is the source of truth.
create or replace function app.rota_shifts_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.staff_member_id is null or new.starts_at is null or new.ends_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.staff_member_id = old.staff_member_id and new.starts_at = old.starts_at
     and new.ends_at = old.ends_at then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rota|' || new.staff_member_id::text, 34));
  if exists (
    select 1 from public.staff_members s where s.id = new.staff_member_id and s.deleted_at is not null
  ) then
    raise exception 'This person is archived; restore them before adding shifts.'
      using errcode = 'check_violation', hint = 'staff_archived';
  end if;
  if exists (
    select 1 from public.rota_shifts r
    where r.staff_member_id = new.staff_member_id
      and r.id <> new.id
      and r.starts_at < new.ends_at
      and r.ends_at > new.starts_at
  ) then
    raise exception 'This person already has a shift that overlaps this time.'
      using errcode = 'exclusion_violation', hint = 'rota_overlap';
  end if;
  return new;
end;
$$;
revoke all on function app.rota_shifts_no_overlap() from public, anon, authenticated;
create trigger rota_shifts_no_overlap before insert or update on public.rota_shifts
  for each row execute function app.rota_shifts_no_overlap();

-- ---------------------------------------------------------------------------
-- 5. RLS: SELECT only; every write is a server action (service role after can('hr.manage')).
-- ---------------------------------------------------------------------------
alter table public.staff_members enable row level security;
alter table public.staff_duties enable row level security;
alter table public.rota_shifts enable row level security;

create policy staff_members_select on public.staff_members for select to authenticated
  using (app.has_perm(org_id, 'hr.view')
         and deleted_at is null
         and app.location_visible_to(org_id, auth.uid(), home_location_id));

-- A duty follows its staff member's visibility (the subquery runs under staff_members' own policy) and its branch.
create policy staff_duties_select on public.staff_duties for select to authenticated
  using (app.has_perm(org_id, 'hr.view')
         and app.location_visible_to(org_id, auth.uid(), location_id)
         and exists (select 1 from public.staff_members s where s.id = staff_member_id));

create policy rota_shifts_select on public.rota_shifts for select to authenticated
  using ((app.has_perm(org_id, 'hr.view') or app.has_perm(org_id, 'appointments.view'))
         and app.location_visible_to(org_id, auth.uid(), location_id));

-- ---------------------------------------------------------------------------
-- 6. Record history (Phase 15): staff records and shifts name who changed them
-- ---------------------------------------------------------------------------
select app.enable_record_history('staff_members', 'visa_expiry_notified_at,licence_expiry_notified_at');
select app.enable_record_history('rota_shifts');

-- From the last definition (20261109000900_accounting_integration.sql), every earlier table kept; the two new ones
-- need hr.view.
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
    when 'fin_pre_authorisations' then app.has_perm(p_org_id, 'finance.preauth.manage')
    when 'fin_eligibility_checks' then app.has_perm(p_org_id, 'finance.eligibility.manage')
    when 'ins_denial_cases' then app.has_perm(p_org_id, 'finance.denials.manage')
    when 'fin_period_closes' then app.has_perm(p_org_id, 'finance.close.view')
    when 'acc_accounts' then app.acc_can_view(p_org_id)
    when 'acc_journals' then app.acc_can_read_journals(p_org_id)
    when 'acc_sales_invoices' then app.acc_can_read_receivables(p_org_id)
    when 'acc_receipts' then app.acc_can_read_receivables(p_org_id)
    when 'acc_bank_transfers' then app.acc_can_read_banking(p_org_id)
    when 'acc_bank_entries' then app.acc_can_read_banking(p_org_id)
    when 'acc_cheques' then app.acc_can_read_banking(p_org_id)
    when 'acc_assets' then app.acc_can_view(p_org_id)
    when 'staff_members' then app.has_perm(p_org_id, 'hr.view')
    when 'rota_shifts' then app.has_perm(p_org_id, 'hr.view')
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Roles for existing orgs (new orgs get them from lib/auth/permissions.ts SYSTEM_ROLES)
-- ---------------------------------------------------------------------------
insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Doctor',
       'Sees their own day: today''s appointments and check-in states, their tasks and the clinical follow-up queue. Read-only on the diary.',
       '["appointments.view","contacts.view","tasks.view","tasks.manage","portal.clinical_followups.read","portal.clinical_visits.read"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'HR',
       'Staff records, duties and the rota, and the visa and licence reminders. No pay amounts (those stay in Finance).',
       '["hr.view","hr.manage"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Daily reminders (runs in the app so it can use notify())
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:hr_maintenance', '55 3 * * *', $$select app.ping_jobs('hr_maintenance')$$);
