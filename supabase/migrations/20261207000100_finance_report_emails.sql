-- Phase G (docs/34_CLINIC_OS_PLAN.md): scheduled report e-mails (the daily flash and the monthly summary).
--
--   * finance.report_emails.manage (Finance, Finance Manager): choose when each report is e-mailed and to which members
--     (Settings, Finance setup, Report e-mails). Members only, never typed addresses; each recipient must hold the
--     report's own key when it is sent (finance.flash.view / finance.view), re-checked by the job on every send.
--   * fin_report_schedules: one row per organisation and report kind (on/off, local send time, day of the month for the
--     monthly summary, the recipients' user ids). A table rather than orgs.settings: the job reads every organisation's
--     schedules in one query, the run claims below need a parent row to point at, and orgs.settings is validated by the
--     finance access window trigger, which a schedule has nothing to do with.
--   * fin_report_schedule_runs: one row per schedule and period (the flash day or the summary month), claimed once by
--     fin_report_schedule_claim() before anything is queued, so a retry, an overlapping cron run or a second app server
--     never sends the same report twice. Status, counts and a reason code only: never an address, a name or a figure.
--   * pg_cron runs /api/jobs/finance_report_emails every 10 minutes; nothing is sent until a schedule is switched on.
--
-- Staff read both tables through RLS with finance.report_emails.manage (select only); every write is a server action
-- (service role after can(), audited) or the claim function (service role only). A training workspace never claims.

-- ---------------------------------------------------------------------------
-- 1. Permission for existing system roles (new orgs get it from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.report_emails.manage'),
      ('Finance Manager', 'finance.report_emails.manage')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Schedules
-- ---------------------------------------------------------------------------
create table public.fin_report_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('daily_flash', 'monthly_summary')),
  enabled boolean not null default false,
  -- local time in the organisation's timezone (minutes are kept, seconds are not)
  send_time time not null default '07:00' check (extract(second from send_time) = 0),
  -- the monthly summary goes out on this day of the month (1 to 28, so every month has it); null for the daily flash
  day_of_month smallint check (day_of_month between 1 and 28),
  recipient_ids uuid[] not null default '{}' check (cardinality(recipient_ids) <= 25),
  -- when it was last switched on: the job never sends a period that fell due before this
  enabled_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind),
  check ((kind = 'monthly_summary') = (day_of_month is not null)),
  check (not enabled or enabled_at is not null)
);
create trigger fin_report_schedules_set_updated_at before update on public.fin_report_schedules
  for each row execute function app.set_updated_at();

alter table public.fin_report_schedules enable row level security;
create policy fin_report_schedules_select on public.fin_report_schedules for select to authenticated
  using (app.has_perm(org_id, 'finance.report_emails.manage'));

-- ---------------------------------------------------------------------------
-- 3. Runs (one claim per schedule and period)
-- ---------------------------------------------------------------------------
create table public.fin_report_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  schedule_id uuid not null references public.fin_report_schedules (id) on delete cascade,
  kind text not null check (kind in ('daily_flash', 'monthly_summary')),
  -- yyyy-mm-dd (the flash day) or yyyy-mm (the summary month)
  period_key text not null check (period_key ~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$'),
  status text not null default 'claimed' check (status in ('claimed', 'queued', 'skipped')),
  recipients integer not null default 0 check (recipients >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  reason text check (reason is null or reason in ('no_recipients', 'queue_failed')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (schedule_id, period_key)
);
create index fin_report_schedule_runs_org_idx on public.fin_report_schedule_runs (org_id, claimed_at desc);
create trigger fin_report_schedule_runs_schedule_org_check before insert or update of schedule_id, org_id
  on public.fin_report_schedule_runs
  for each row execute function app.check_parent_org('fin_report_schedules', 'schedule_id');

alter table public.fin_report_schedule_runs enable row level security;
create policy fin_report_schedule_runs_select on public.fin_report_schedule_runs for select to authenticated
  using (app.has_perm(org_id, 'finance.report_emails.manage'));

-- ---------------------------------------------------------------------------
-- 4. The claim: at most once per schedule and period, only while the schedule is on and the workspace is not training
-- ---------------------------------------------------------------------------
create or replace function public.fin_report_schedule_claim(p_schedule_id uuid, p_period_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.fin_report_schedule_runs (org_id, schedule_id, kind, period_key)
  select s.org_id, s.id, s.kind, p_period_key
    from public.fin_report_schedules s
    join public.orgs o on o.id = s.org_id
   where s.id = p_schedule_id
     and s.enabled
     and not o.is_training
     and p_period_key ~ case when s.kind = 'daily_flash'
                             then '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
                             else '^\d{4}-(0[1-9]|1[0-2])$' end
  on conflict (schedule_id, period_key) do nothing
  returning id into v_id;
  return v_id;   -- null: already claimed, switched off, training or the wrong period shape
end;
$$;
revoke all on function public.fin_report_schedule_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.fin_report_schedule_claim(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Every 10 minutes (the job decides what is due in each organisation's timezone)
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:finance_report_emails', '*/10 * * * *', $$select app.ping_jobs('finance_report_emails')$$);
