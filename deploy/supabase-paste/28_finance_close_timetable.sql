-- Paste into Supabase > SQL Editor > New query, then Run. Needs 22_finance_flash.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20G: the monthly close timetable and close KPIs (docs/20_FINANCE_CONTROL_PLAN.md, slice 20G; deck slides 6, 9, 11).
--
--   * finance.close.tasks (Finance, Billing, Insurance, Cost / Payroll): see the close timetable and mark the steps you
--     own or back up. finance.close.manage marks any step and edits the template and the calendar.
--   * fin_ref_finance_settings: close_timetable_start (first close month the timetable runs for; null = OFF), weekend
--     days (ISO 1 = Monday .. 7 = Sunday; UAE default Saturday and Sunday), the inputs working day (5), the delivery
--     working day (10) and the reconciling-item age limit (60 days)
--   * fin_ref_holidays: public holidays that are not working days
--   * fin_close_steps: the checklist template (owner, backup, due working day, dependencies). Seeded with the deck's
--     steps, without names; owners are assigned in the app. The final step, "Board pack issued", is NOT a row: it is
--     the existing CEO sign-off that locks the month (fin_period_closes).
--   * fin_close_tasks: one row per close month and step. month = the month being closed; its working days are counted
--     in the month after (WD5 of October for September's close). due_wd is copied from the step when the task is made,
--     so a later template change never rewrites a past month's measure. A locked month's tasks never change (trigger).
--   * fin_close_seed_steps(), fin_close_generate_tasks(), fin_close_set_task_status(), fin_close_claim_reminders():
--     SECURITY DEFINER, service role only; the server runs can() first.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.close.tasks'),
      ('Billing', 'finance.close.tasks'),
      ('Insurance', 'finance.close.tasks'),
      ('Cost / Payroll', 'finance.close.tasks')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Settings: the working-day calendar and the measures
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column close_timetable_start date
    check (close_timetable_start is null or close_timetable_start = date_trunc('month', close_timetable_start)::date),
  add column close_weekend_days smallint[] not null default '{6,7}'
    check (close_weekend_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(close_weekend_days) <= 6),
  add column close_inputs_wd smallint not null default 5 check (close_inputs_wd between 1 and 23),
  add column close_deadline_wd smallint not null default 10 check (close_deadline_wd between 1 and 23),
  add column close_item_max_age_days integer not null default 60 check (close_item_max_age_days between 1 and 365);

create table public.fin_ref_holidays (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  holiday_on date not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, holiday_on)
);

-- ---------------------------------------------------------------------------
-- 3. The checklist template and the month's tasks
-- ---------------------------------------------------------------------------
create table public.fin_close_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{1,24}$'),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  owner_role text check (owner_role is null or char_length(owner_role) <= 60),
  owner_user_id uuid references public.profiles (id) on delete set null,
  backup_user_id uuid references public.profiles (id) on delete set null,
  due_wd smallint not null check (due_wd between 1 and 23),
  depends_on text[] not null default '{}' check (cardinality(depends_on) <= 10),
  evidence_hint text check (evidence_hint is null or char_length(evidence_hint) <= 200),
  active boolean not null default true,
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check (not (code = any (depends_on))),
  check (backup_user_id is null or owner_user_id is null or backup_user_id <> owner_user_id)
);
create trigger fin_close_steps_set_updated_at before update on public.fin_close_steps
  for each row execute function app.set_updated_at();

create table public.fin_close_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  step_code text not null,
  due_wd smallint not null check (due_wd between 1 and 23),
  status text not null default 'open' check (status in ('open', 'done', 'blocked')),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 300),
  note text check (note is null or char_length(note) <= 500),
  done_by uuid references public.profiles (id) on delete set null,
  done_at timestamptz,
  reminded_on date,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, month, step_code),
  foreign key (org_id, step_code) references public.fin_close_steps (org_id, code),
  -- "if a date is unrealistic, name the dependency": a blocked step says what it is waiting for
  check (status <> 'blocked' or btrim(coalesce(blocked_reason, '')) <> ''),
  check ((status = 'done') = (done_at is not null))
);
create index fin_close_tasks_org_month_idx on public.fin_close_tasks (org_id, month);
create trigger fin_close_tasks_set_updated_at before update on public.fin_close_tasks
  for each row execute function app.set_updated_at();

-- A locked month's timetable is history: no insert, change or delete (all roles). A task's identity never changes.
-- A row with no month (the cross-org probe in the security tests) passes through untouched so RLS answers.
create or replace function app.fin_close_task_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_month date;
begin
  if tg_op = 'DELETE' then
    v_org := old.org_id;
    v_month := old.month;
  else
    v_org := new.org_id;
    v_month := new.month;
  end if;
  if tg_op = 'UPDATE' and (new.org_id, new.month, new.step_code) is distinct from (old.org_id, old.month, old.step_code) then
    raise exception 'a close task cannot move to another month or step' using errcode = 'check_violation';
  end if;
  if v_org is not null and v_month is not null and app.fin_month_is_locked(v_org, v_month)
     and exists (select 1 from public.orgs o where o.id = v_org) then
    raise exception 'this month is locked; its close timetable cannot change' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_close_task_guard() from public, anon, authenticated;
create trigger fin_close_tasks_guard before insert or update or delete on public.fin_close_tasks
  for each row execute function app.fin_close_task_guard();

-- ---------------------------------------------------------------------------
-- 4. RLS: staff read with a close permission; every write is a server action (service role after can())
-- ---------------------------------------------------------------------------
alter table public.fin_ref_holidays enable row level security;
alter table public.fin_close_steps enable row level security;
alter table public.fin_close_tasks enable row level security;

create policy fin_ref_holidays_select on public.fin_ref_holidays for select to authenticated
  using (app.has_perm(org_id, 'finance.close.view') or app.has_perm(org_id, 'finance.close.manage')
      or app.has_perm(org_id, 'finance.close.tasks'));
create policy fin_close_steps_select on public.fin_close_steps for select to authenticated
  using (app.has_perm(org_id, 'finance.close.view') or app.has_perm(org_id, 'finance.close.manage')
      or app.has_perm(org_id, 'finance.close.tasks'));
create policy fin_close_tasks_select on public.fin_close_tasks for select to authenticated
  using (app.has_perm(org_id, 'finance.close.view') or app.has_perm(org_id, 'finance.close.manage')
      or app.has_perm(org_id, 'finance.close.tasks'));

-- ---------------------------------------------------------------------------
-- 5. The standard steps (deck slide 9 and the finance meeting). Idempotent: an edited step is never overwritten.
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_seed_steps(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.fin_close_steps (org_id, code, title, owner_role, due_wd, depends_on, evidence_hint, sort_order)
  values
    (p_org_id, 'INS_SUBMISSIONS', 'Insurance submissions and resubmissions for the month complete', 'Insurance (Diligence)', 5, '{}',
     'Diligence submission and resubmission reports for the month', 10),
    (p_org_id, 'DILIGENCE_REC', 'Diligence reconciliation complete', 'Insurance (Diligence)', 5, '{INS_SUBMISSIONS}',
     'Latest Diligence file committed in Pulse; outstanding items listed', 20),
    (p_org_id, 'REVENUE_UNITE', 'Revenue reconciled to Unite', 'Revenue and receivables', 5, '{}',
     'Unite revenue report agreed to the month''s figures', 30),
    (p_org_id, 'BANK_CASH', 'Bank and cash reconciled', 'Revenue and receivables', 5, '{}',
     'Bank statements, card settlements and cash-ups agreed', 40),
    (p_org_id, 'SUPPLIER_INVOICES', 'Supplier invoices booked', 'Costs and payables', 5, '{}',
     'Purchase entries posted in Tally', 50),
    (p_org_id, 'HR_INPUTS', 'HR inputs submitted (joiners, leavers, changes)', 'HR', 5, '{}',
     'HR change list for the month', 60),
    (p_org_id, 'LAB_REFERRALS', 'Lab and referral invoices checked', 'Costs and payables', 7, '{}',
     'Lab reports arrive by the 7th or 8th; checked against what Unite billed', 70),
    (p_org_id, 'REVENUE_SHARES', 'Doctor revenue shares and staff incentives calculated', 'Finance Manager', 7,
     '{REVENUE_UNITE,LAB_REFERRALS,HR_INPUTS}', 'Calculation with its source data, verified', 80),
    (p_org_id, 'TALLY_CLOSE', 'Tally close substantially complete', 'Costs and payables', 7, '{SUPPLIER_INVOICES,BANK_CASH}',
     'Tally trial balance', 90),
    (p_org_id, 'DRAFT_ACCOUNTS', 'Draft management accounts', 'Finance Manager', 8,
     '{TALLY_CLOSE,REVENUE_SHARES,DILIGENCE_REC}', 'Draft P&L and balance sheet', 100)
  on conflict (org_id, code) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fin_close_seed_steps(uuid) from public, anon, authenticated;
grant execute on function public.fin_close_seed_steps(uuid) to service_role;

select public.fin_close_seed_steps(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- 6. Make a close month's tasks from the active steps (idempotent; nothing for a locked month)
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_generate_tasks(p_org_id uuid, p_month date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'month must be the first day of a month' using errcode = 'invalid_parameter_value';
  end if;
  if app.fin_month_is_locked(p_org_id, p_month) then
    return 0;
  end if;
  insert into public.fin_close_tasks (org_id, month, step_code, due_wd)
  select p_org_id, p_month, s.code, s.due_wd
  from public.fin_close_steps s
  where s.org_id = p_org_id and s.active
  on conflict (org_id, month, step_code) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fin_close_generate_tasks(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_close_generate_tasks(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Mark a task open / done / blocked. p_any_step = the caller holds finance.close.manage (checked by the server);
--    otherwise only the step's owner or backup may change it. Blocked needs the dependency it waits for.
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_set_task_status(
  p_org_id uuid, p_task_id uuid, p_user_id uuid, p_status text, p_reason text, p_note text, p_any_step boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.fin_close_tasks;
  v_owner uuid;
  v_backup uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_status is null or p_status not in ('open', 'done', 'blocked') then
    raise exception 'unknown status' using errcode = 'check_violation';
  end if;
  select * into v_task from public.fin_close_tasks where id = p_task_id and org_id = p_org_id for update;
  if not found then
    raise exception 'close task not found' using errcode = 'no_data_found';
  end if;
  if not coalesce(p_any_step, false) then
    select s.owner_user_id, s.backup_user_id into v_owner, v_backup
    from public.fin_close_steps s where s.org_id = p_org_id and s.code = v_task.step_code;
    if not coalesce(p_user_id in (v_owner, v_backup), false) then
      raise exception 'only the owner or the backup of this step can change it' using errcode = '42501';
    end if;
  end if;
  if p_status = 'blocked' and v_reason is null then
    raise exception 'say what the step is waiting for' using errcode = 'check_violation';
  end if;
  update public.fin_close_tasks
     set status = p_status,
         blocked_reason = case when p_status = 'blocked' then v_reason end,
         note = nullif(btrim(coalesce(p_note, '')), ''),
         done_by = case when p_status <> 'done' then null
                        when v_task.status = 'done' then v_task.done_by else p_user_id end,
         done_at = case when p_status <> 'done' then null
                        when v_task.status = 'done' then v_task.done_at else now() end,
         updated_by = p_user_id
   where id = v_task.id;
  return jsonb_build_object('month', v_task.month, 'step_code', v_task.step_code, 'from', v_task.status, 'to', p_status);
end;
$$;
revoke all on function public.fin_close_set_task_status(uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.fin_close_set_task_status(uuid, uuid, uuid, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Claim today's reminder for due / overdue tasks: each task once per day, never twice (a retry claims nothing).
--    The server works out which tasks are due (working days) and passes their ids; done tasks and locked months are
--    skipped here as well.
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_claim_reminders(p_org_id uuid, p_task_ids uuid[], p_today date)
returns table (task_id uuid, owner_user_id uuid)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.fin_close_tasks t
       set reminded_on = p_today
     where t.org_id = p_org_id
       and t.id = any (p_task_ids)
       and t.status <> 'done'
       and (t.reminded_on is null or t.reminded_on < p_today)
       and not app.fin_month_is_locked(t.org_id, t.month)
    returning t.id, t.step_code
  )
  select c.id, s.owner_user_id
  from claimed c
  left join public.fin_close_steps s on s.org_id = p_org_id and s.code = c.step_code;
$$;
revoke all on function public.fin_close_claim_reminders(uuid, uuid[], date) from public, anon, authenticated;
grant execute on function public.fin_close_claim_reminders(uuid, uuid[], date) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261029000100', 'finance_close_timetable') on conflict (version) do nothing;
