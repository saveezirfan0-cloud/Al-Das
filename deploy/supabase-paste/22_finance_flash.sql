-- Paste into Supabase > SQL Editor > New query, then Run. Needs 21_finance_insurance_overview.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20A: revenue targets, reporting lines and the daily flash report (docs/20_FINANCE_CONTROL_PLAN.md, OQ-93).
--
--   * finance.flash.view (Finance, CEO, Medical Director) and finance.targets.manage (Finance)
--   * fin_ref_report_lines: how invoices are grouped on the flash report (a branch, or a department such as Chiro that
--     is reported on its own line whichever branch it was seen in); in_core = counted in "Total (excl. Chiro)"
--   * fin_ref_revenue_targets: daily revenue / patient / ARPP targets per month and line (line_code null = the total)
--   * fin_ref_finance_settings: flash_share_basis (doctor % of section total or of the grand total), flash_top_doctors
--   * fin_flash_inputs(): per day, branch, department and doctor: net revenue, patient visits, invoices. Counts and
--     amounts only, no patient identifier. SECURITY DEFINER, service role only; the page checks finance.flash.view.
--   * fin_flash_set_targets(): replaces one month's targets in one transaction (service role only, after can()).

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.flash.view'),
      ('Finance', 'finance.targets.manage'),
      ('CEO', 'finance.flash.view'),
      ('Medical Director', 'finance.flash.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reporting lines
-- ---------------------------------------------------------------------------
create table public.fin_ref_report_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{1,12}$' and code not in ('CORE', 'UNASSIGNED')),
  label text not null check (char_length(btrim(label)) between 1 and 60),
  match_kind text not null check (match_kind in ('branch', 'department')),
  match_values text[] not null check (cardinality(match_values) between 1 and 20),
  in_core boolean not null default true,
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
create trigger fin_ref_report_lines_set_updated_at before update on public.fin_ref_report_lines
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Targets (daily rates; the report multiplies by the days in the period)
-- ---------------------------------------------------------------------------
create table public.fin_ref_revenue_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  line_code text check (line_code is null or line_code ~ '^[A-Z0-9_]{1,12}$'),  -- null = the total
  daily_revenue numeric(14, 2) check (daily_revenue is null or daily_revenue > 0),
  daily_patients numeric(10, 2) check (daily_patients is null or daily_patients > 0),
  arpp numeric(14, 2) check (arpp is null or arpp > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (daily_revenue is not null or daily_patients is not null or arpp is not null)
);
create unique index fin_ref_revenue_targets_uidx on public.fin_ref_revenue_targets (org_id, month, coalesce(line_code, ''));

-- ---------------------------------------------------------------------------
-- 4. RLS: staff read with a flash or target permission; every write is a server action (service role after can())
-- ---------------------------------------------------------------------------
alter table public.fin_ref_report_lines enable row level security;
alter table public.fin_ref_revenue_targets enable row level security;

create policy fin_ref_report_lines_select on public.fin_ref_report_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.flash.view') or app.has_perm(org_id, 'finance.targets.manage'));
create policy fin_ref_revenue_targets_select on public.fin_ref_revenue_targets for select to authenticated
  using (app.has_perm(org_id, 'finance.flash.view') or app.has_perm(org_id, 'finance.targets.manage'));

-- ---------------------------------------------------------------------------
-- 5. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column flash_share_basis text not null default 'section' check (flash_share_basis in ('section', 'all')),
  add column flash_top_doctors integer not null default 5 check (flash_top_doctors between 1 and 50);

-- ---------------------------------------------------------------------------
-- 6. Report input: one row per day, branch, department and doctor (on the configured doctor basis)
-- ---------------------------------------------------------------------------
-- Patient visits = distinct patients within the row (day, branch, department, doctor); the report sums rows, so a
-- patient seen by two doctors on one day counts twice, as on the clinic's sheets (OQ-93). Deleted invoices excluded.
create or replace function public.fin_flash_inputs(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with basis as (select doctor_basis from public.fin_ref_finance_settings where org_id = p_org_id),
  inv as (
    select i.id, i.transaction_date, i.branch_code,
           coalesce(nullif(btrim(i.department), ''), d0.department) as department,
           case (select doctor_basis from basis)
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end as doctor_id,
           i.doctor_name,
           coalesce(i.patient_ref, i.patient_pin, i.id::text) as pid,
           coalesce(i.net, 0) as net
    from public.fin_invoices i
    left join public.fin_ref_doctors d0 on d0.org_id = i.org_id and d0.dha_id = i.doctor_dha_id
    where i.org_id = p_org_id and not i.is_deleted
      and i.transaction_date between p_from and p_to
  ), grouped as (
    select v.transaction_date, v.branch_code, v.department, v.doctor_id,
           coalesce((select d.name from public.fin_ref_doctors d where d.org_id = p_org_id and d.dha_id = v.doctor_id),
                    max(v.doctor_name)) as doctor_name,
           round(sum(v.net), 2) as net,
           count(distinct v.pid) as patients,
           count(*) as invoices
    from inv v
    group by v.transaction_date, v.branch_code, v.department, v.doctor_id
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', g.transaction_date, 'branch', g.branch_code, 'department', g.department,
        'doctor_id', g.doctor_id, 'doctor_name', g.doctor_name,
        'net', g.net, 'patients', g.patients, 'invoices', g.invoices)
        order by g.transaction_date, g.branch_code, g.department, g.doctor_id)
      from grouped g), '[]'::jsonb),
    'last_received_at', (select max(i.last_received_at) from public.fin_invoices i where i.org_id = p_org_id)
  );
$$;
revoke all on function public.fin_flash_inputs(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_flash_inputs(uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Replace one month's targets atomically
-- ---------------------------------------------------------------------------
-- p_rows: [{ "line_code": "PALM" | null, "daily_revenue": n|null, "daily_patients": n|null, "arpp": n|null }]
create or replace function public.fin_flash_set_targets(p_org_id uuid, p_month date, p_rows jsonb, p_user uuid)
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
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'targets must be a list of at most 100 rows' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.fin_ref_revenue_targets where org_id = p_org_id and month = p_month;
  insert into public.fin_ref_revenue_targets (org_id, month, line_code, daily_revenue, daily_patients, arpp, created_by)
  select p_org_id, p_month, nullif(btrim(r->>'line_code'), ''),
         (r->>'daily_revenue')::numeric, (r->>'daily_patients')::numeric, (r->>'arpp')::numeric, p_user
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'daily_revenue', r->>'daily_patients', r->>'arpp') is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fin_flash_set_targets(uuid, date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_flash_set_targets(uuid, date, jsonb, uuid) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261023000100', 'finance_flash') on conflict (version) do nothing;
