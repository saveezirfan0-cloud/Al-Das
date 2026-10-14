-- Phase M2A: contribution by doctor, department and clinic (docs/40_MANAGEMENT_PLATFORM_PLAN.md §2, levels L3, L5 and L6;
-- docs/23_PHASE_M2A_NOTES.md).
--
--   * fin_report_doctor_map: links the Unite report's doctor (doctor_key, the normalised name) to the DHA licence id the
--     cost tables use (fin_ref_doctors.dha_id). Service role only (RLS on, no policies): the page reads it through
--     fin_contribution_inputs() and writes it through a server action after can('finance.costs.manage'), audited.
--   * fin_contribution_inputs(): for one calendar month, revenue per (branch, department, doctor) from the current Unite
--     collection report rows (fin_report_visits, as 23B reads them), plus the ACTUAL costs Finance has loaded for the
--     doctors and branches in view: doctor compensation (fin_cost_doctor_comp), doctor charges (fin_doctor_charges),
--     branch overheads and shared overhead pools (fin_cost_overheads), and whether Finance approved the month
--     (fin_cost_periods). Pay is never calculated here or anywhere in M2A. A cost of 0 means unavailable and is left out
--     (the doctor then shows "pay not loaded", never zero pay).
--     Weights for apportioning: a doctor's pay and charges are split over ALL that doctor's rows in the month (every
--     branch) and shared pools over every branch, so a member limited to one branch sees that branch's share, never the
--     whole amount. Only the weights leave the scope; the rows, comp and charges returned are for the doctors in view.
--     Branch scoping exactly as 23B: the branch is worked out when read from the Unite clinic and the CURRENT
--     fin_ref_branches mapping; p_branches = the member's allowed finance codes (null = unrestricted); a row whose branch
--     is unknown is visible only to an unrestricted member; p_branch = the page's own filter.
--     Counts, amounts, doctor names and DHA ids only: no PIN, no patient ref. SECURITY DEFINER, search_path '', service
--     role only; the server checks finance.profit.view first (and hides individual pay without
--     finance.costs.compensation, lib/finance/contribution.ts).

-- ---------------------------------------------------------------------------
-- 1. Doctor mapping (report doctor_key -> DHA id)
-- ---------------------------------------------------------------------------
create table public.fin_report_doctor_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  doctor_key text not null check (btrim(doctor_key) <> '' and char_length(doctor_key) <= 200),
  dha_id text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, doctor_key),
  -- the DHA id must be one of the org's own reference doctors; removing that doctor removes the link (fails closed)
  foreign key (org_id, dha_id) references public.fin_ref_doctors (org_id, dha_id) on delete cascade
);
create index fin_report_doctor_map_dha_idx on public.fin_report_doctor_map (org_id, dha_id);
create trigger fin_report_doctor_map_set_updated_at before update on public.fin_report_doctor_map
  for each row execute function app.set_updated_at();

alter table public.fin_report_doctor_map enable row level security;
-- No policies: service role only (server code after can()).

-- ---------------------------------------------------------------------------
-- 2. Report input
-- ---------------------------------------------------------------------------
create or replace function public.fin_contribution_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  with v as (
    select coalesce(b.code, r.branch_code) as branch_code,
           nullif(btrim(r.department), '') as department,
           r.doctor_key,
           r.doctor_name,
           upper(btrim(m.dha_id)) as dha_id,
           r.net
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and b.unite_clinic_long_name = r.clinic_name
    left join public.fin_report_doctor_map m
      on m.org_id = r.org_id and m.doctor_key = r.doctor_key
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_month and r.report_date < v_next
  ),
  -- every (branch, department, doctor) of the month, all branches: the weights
  grp as (
    select branch_code, department, doctor_key, dha_id, sum(net) as revenue, count(*) as visits
    from v
    group by branch_code, department, doctor_key, dha_id
  ),
  scoped as (
    select g.*
    from grp g
    where (p_branches is null or g.branch_code = any (p_branches))
      and (v_branch is null or g.branch_code = v_branch)
  ),
  -- display name: the most frequent spelling in view, ties alphabetical (as 23B)
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (
      select v.doctor_key, v.doctor_name, count(*) as n
      from v
      where (p_branches is null or v.branch_code = any (p_branches))
        and (v_branch is null or v.branch_code = v_branch)
      group by v.doctor_key, v.doctor_name
    ) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  dhas as (
    select distinct dha_id from scoped where dha_id is not null
  )
  select jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'period_approved', exists (
      select 1 from public.fin_cost_periods p
      where p.org_id = p_org_id and p.month = v_month and p.status = 'approved'),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branch_code', s.branch_code, 'department', s.department, 'doctor_key', s.doctor_key,
               'doctor_name', n.doctor_name, 'dha_id', s.dha_id, 'revenue', s.revenue, 'visits', s.visits)
             order by s.branch_code collate "C" nulls last, s.department collate "C" nulls last,
                      s.doctor_key collate "C")
      from scoped s join names n on n.doctor_key = s.doctor_key), '[]'::jsonb),
    'doctor_weights', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', w.dha_id, 'revenue', w.revenue, 'groups', w.groups)
             order by w.dha_id collate "C")
      from (
        select g.dha_id, sum(greatest(g.revenue, 0)) as revenue, count(*) as groups
        from grp g join dhas d on d.dha_id = g.dha_id
        group by g.dha_id
      ) w), '[]'::jsonb),
    'comp', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', c.dha_id, 'amount', c.amount) order by c.dha_id collate "C")
      from (
        select upper(btrim(x.doctor_dha_id)) as dha_id, sum(x.amount) as amount
        from public.fin_cost_doctor_comp x
        join dhas d on d.dha_id = upper(btrim(x.doctor_dha_id))
        where x.org_id = p_org_id and x.month = v_month and x.amount > 0   -- 0 = unavailable, never zero pay
        group by 1
      ) c), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', c.dha_id, 'amount', c.amount) order by c.dha_id collate "C")
      from (
        select x.doctor_dha_id as dha_id, sum(x.amount) as amount
        from public.fin_doctor_charges x
        join dhas d on d.dha_id = x.doctor_dha_id
        where x.org_id = p_org_id and x.month = v_month
        group by 1
      ) c), '[]'::jsonb),
    'branch_overheads', coalesce((
      select jsonb_agg(jsonb_build_object('branch_code', o.branch_code, 'amount', o.amount)
             order by o.branch_code collate "C")
      from (
        select x.branch_code, sum(x.amount) as amount
        from public.fin_cost_overheads x
        where x.org_id = p_org_id and x.month = v_month and x.branch_code is not null and x.amount > 0
          and (p_branches is null or x.branch_code = any (p_branches))
          and (v_branch is null or x.branch_code = v_branch)
        group by 1
      ) o), '[]'::jsonb),
    'shared_overheads', coalesce((
      select jsonb_agg(jsonb_build_object('pool', x.pool, 'amount', x.amount, 'basis', x.basis)
             order by lower(x.pool) collate "C")
      from public.fin_cost_overheads x
      where x.org_id = p_org_id and x.month = v_month and x.branch_code is null and x.amount > 0), '[]'::jsonb),
    'branch_weights', coalesce((
      select jsonb_agg(jsonb_build_object('branch_code', w.branch_code, 'revenue', w.revenue, 'visits', w.visits)
             order by w.branch_code collate "C" nulls last)
      from (
        select g.branch_code, sum(g.revenue) as revenue, sum(g.visits) as visits from grp g group by g.branch_code
      ) w), '[]'::jsonb)
  )
  into v_out;

  return v_out;
end;
$$;
revoke all on function public.fin_contribution_inputs(uuid, date, text, text[]) from public, anon, authenticated;
grant execute on function public.fin_contribution_inputs(uuid, date, text, text[]) to service_role;
