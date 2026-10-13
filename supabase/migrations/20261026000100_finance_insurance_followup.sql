-- Phase 20I: insurance follow-up at 60 / 90 / 120 days, configurable ageing buckets, the submission sequence of a claim
-- and receivables by payer and age (the candidate "ARP report", OQ-95). docs/20_FINANCE_CONTROL_PLAN.md, slice 20I.
--
--   * finance.followup.manage (Finance, Insurance): record follow-up outcomes on unpaid claims. Reading the worklist and
--     the receivables report needs finance.claims.view (Finance, Insurance, CEO).
--   * fin_ref_finance_settings: ageing_bucket_days (default 30, 60, 90, 120 -> 0-30 / 31-60 / 61-90 / 91-120 / 120+),
--     followup_stage_days (default 60, 90, 120), followup_start_date (null = no follow-up tasks; a stage crossed before
--     this date never raises one, so go-live does not flood historic claims), followup_task_enabled,
--     followup_task_role (the role whose members get the tasks), followup_task_due_days.
--   * ins_claim_followups: what a person did about an unpaid claim (outcome, a short note without patient names, the next
--     action date). Append-only; written by a server action after can(), audited.
--   * ins_claim_followup_stages: one row per claim and stage the daily job has raised (the atomic claim: a retry or a
--     second run never raises the same stage twice), with the task it created.
--   * fin_followup_open_claims / fin_followup_worklist / fin_receivables_by_payer_age / fin_followup_create_tasks:
--     SECURITY DEFINER, search_path = '', service role only, jsonb; the pages and the job call them after can().
--
-- "Open" uses fin_insurance_overview's rules: outstanding = net - remitted - an APPROVED write-off, above zero; "evidenced"
-- = a remitted amount or a status in accepted_claim_statuses. The existing 0-30 / 31-60 / 61-90 / 90+ ageing of the
-- overview, the monthly summary and the frozen close packs is NOT changed. Identifiers and amounts only: no patient data.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.followup.manage'),
      ('Insurance', 'finance.followup.manage')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Day-step helpers (pure; the same rules as lib/finance/followup.ts)
-- ---------------------------------------------------------------------------
-- strictly increasing whole days between 1 and 3650, between 1 and p_max of them
create or replace function app.fin_valid_day_steps(p_days integer[], p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_days is not null
     and cardinality(p_days) between 1 and p_max
     and array_ndims(p_days) = 1
     and not exists (
       select 1 from unnest(p_days) with ordinality as u(v, i)
       where u.v is null or u.v < 1 or u.v > 3650 or (u.i > 1 and u.v <= p_days[(u.i - 1)::integer]));
$$;

-- bucket index: how many bounds the age is above (0 = the first bucket); null age = null (the "No date" column)
create or replace function app.fin_bucket_index(p_age integer, p_days integer[])
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_age is null then null
              else (select count(*)::integer from unnest(p_days) as d where p_age > d) end;
$$;

-- the highest stage the age has reached, or null before the first
create or replace function app.fin_stage_reached(p_age integer, p_stages integer[])
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_age is null then null
              else (select max(s) from unnest(p_stages) as s where p_age >= s) end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column ageing_bucket_days integer[] not null default '{30,60,90,120}'
    check (app.fin_valid_day_steps(ageing_bucket_days, 8)),
  add column followup_stage_days integer[] not null default '{60,90,120}'
    check (app.fin_valid_day_steps(followup_stage_days, 6)),
  -- null = the daily job raises no follow-up tasks; stages crossed before this date never raise one
  add column followup_start_date date,
  add column followup_task_enabled boolean not null default true,
  -- name of the role whose active members are given the tasks (no member in it = the task is unassigned)
  add column followup_task_role text not null default 'Insurance'
    check (char_length(btrim(followup_task_role)) between 1 and 60),
  add column followup_task_due_days integer not null default 3 check (followup_task_due_days between 0 and 60);

-- ---------------------------------------------------------------------------
-- 4. Follow-up records and raised stages
-- ---------------------------------------------------------------------------
create table public.ins_claim_followups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_id uuid not null references public.ins_claim_activities (id) on delete cascade,
  stage integer check (stage is null or stage between 1 and 3650),   -- the stage the claim had reached when recorded
  outcome text not null
    check (outcome in ('contacted', 'promised', 'resubmitted', 'disputed', 'write_off_proposed', 'paid_elsewhere', 'other')),
  note text check (note is null or (btrim(note) <> '' and char_length(note) <= 1000)),   -- redacted; no patient names
  next_action_date date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ins_claim_followups_claim_idx on public.ins_claim_followups (claim_activity_id, created_at desc);
create index ins_claim_followups_next_idx on public.ins_claim_followups (org_id, next_action_date) where next_action_date is not null;
create trigger ins_claim_followups_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_claim_followups
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');

create table public.ins_claim_followup_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_id uuid not null references public.ins_claim_activities (id) on delete cascade,
  stage integer not null check (stage between 1 and 3650),
  crossed_on date not null,
  task_id uuid references public.tasks (id) on delete set null,
  assignee_id uuid references public.profiles (id) on delete set null,
  -- a later stage was raised in the same run (the job was off, or the claim arrived late): no task for this one
  superseded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, claim_activity_id, stage)
);
create index ins_claim_followup_stages_task_idx on public.ins_claim_followup_stages (task_id) where task_id is not null;
create trigger ins_claim_followup_stages_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_claim_followup_stages
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger ins_claim_followup_stages_task_org_check before insert or update of task_id, org_id on public.ins_claim_followup_stages
  for each row execute function app.check_parent_org('tasks', 'task_id');

-- RLS: staff with claim access or the follow-up permission read; nobody writes from the browser (server actions and the
-- daily job use the service role after can()).
alter table public.ins_claim_followups enable row level security;
alter table public.ins_claim_followup_stages enable row level security;
create policy ins_claim_followups_select on public.ins_claim_followups for select to authenticated
  using (app.has_perm(org_id, 'finance.claims.view') or app.has_perm(org_id, 'finance.followup.manage'));
create policy ins_claim_followup_stages_select on public.ins_claim_followup_stages for select to authenticated
  using (app.has_perm(org_id, 'finance.claims.view') or app.has_perm(org_id, 'finance.followup.manage'));

-- ---------------------------------------------------------------------------
-- 5. The open claims (one definition for the worklist, the report and the job)
-- ---------------------------------------------------------------------------
create or replace function public.fin_followup_open_claims(p_org_id uuid, p_today date)
returns table (
  id uuid, claim_activity_number text, invoice_no text, payer_id text, branch_code text, transaction_date date,
  age_days integer, net numeric, remitted numeric, rejected numeric, outstanding numeric, evidenced boolean,
  claim_status text, resubmission_count integer, last_resubmission_date date
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.claim_activity_number, c.invoice_no, c.payer_id, i.branch_code, c.transaction_date,
         (p_today - c.transaction_date)::integer as age_days,
         round(coalesce(c.net, 0), 2), round(coalesce(c.remitted, 0), 2), round(coalesce(c.rejected, 0), 2),
         round(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
               - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0), 2),
         ( coalesce(c.remitted, 0) > 0
           or exists (select 1 from public.fin_ref_finance_settings s, unnest(s.accepted_claim_statuses) as x
                      where s.org_id = c.org_id and lower(btrim(x)) = lower(btrim(coalesce(c.claim_status, ''))))),
         c.claim_status, coalesce(c.resubmission_count, 0), c.last_resubmission_date
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.org_id = p_org_id
    and greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
          - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) > 0;
$$;
revoke all on function public.fin_followup_open_claims(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_followup_open_claims(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The worklist: open claims with age, bucket, stage reached, last follow-up and the raised task
--    p_stage: null = every open claim, 0 = not yet at the first stage, n = exactly at stage n
-- ---------------------------------------------------------------------------
create or replace function public.fin_followup_worklist(
  p_org_id uuid, p_today date, p_stage integer default null, p_payer text default null, p_branch text default null,
  p_limit integer default 500)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select coalesce((select ageing_bucket_days from public.fin_ref_finance_settings where org_id = p_org_id), '{30,60,90,120}') as buckets,
           coalesce((select followup_stage_days from public.fin_ref_finance_settings where org_id = p_org_id), '{60,90,120}') as stages,
           (select followup_start_date from public.fin_ref_finance_settings where org_id = p_org_id) as start_date,
           coalesce((select followup_task_enabled from public.fin_ref_finance_settings where org_id = p_org_id), false) as task_enabled
  ), o as materialized (
    select c.*, app.fin_bucket_index(c.age_days, (select buckets from s)) as bucket,
           app.fin_stage_reached(c.age_days, (select stages from s)) as stage
    from public.fin_followup_open_claims(p_org_id, p_today) c
  ), f as (
    select o.* from o
    where (p_payer is null or coalesce(o.payer_id, '(no payer)') = p_payer)
      and (p_branch is null or o.branch_code = p_branch)
  ), picked as (
    select f.* from f
    where p_stage is null or (p_stage = 0 and f.stage is null) or f.stage = p_stage
    order by f.age_days desc nulls last, f.claim_activity_number
    limit greatest(least(coalesce(p_limit, 500), 2000), 1)
  )
  select jsonb_build_object(
    'today', p_today,
    'bucket_days', to_jsonb((select buckets from s)),
    'stage_days', to_jsonb((select stages from s)),
    'tasks_from', (select start_date from s),
    'tasks_enabled', (select task_enabled from s) and (select start_date from s) is not null,
    'total', (select count(*) from f where p_stage is null or (p_stage = 0 and f.stage is null) or f.stage = p_stage),
    'total_outstanding', coalesce((select sum(outstanding) from f where p_stage is null or (p_stage = 0 and f.stage is null) or f.stage = p_stage), 0),
    'by_stage', coalesce((
      select jsonb_agg(jsonb_build_object('stage', g.stage, 'claims', g.n, 'outstanding', g.amt) order by g.stage nulls first)
      from (select f.stage, count(*) as n, sum(f.outstanding) as amt from f group by f.stage) g), '[]'::jsonb),
    'payers', coalesce((
      select jsonb_agg(jsonb_build_object('payer_id', p.payer_id, 'payer_name', p.payer_name) order by p.payer_id)
      from (select distinct coalesce(o.payer_id, '(no payer)') as payer_id,
                   (select pr.payer_name from public.fin_ref_payers pr where pr.org_id = p_org_id and pr.payer_id = o.payer_id) as payer_name
            from o) p), '[]'::jsonb),
    'branches', coalesce((select jsonb_agg(distinct o.branch_code) from o where o.branch_code is not null), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'claim_activity_number', k.claim_activity_number, 'invoice_no', k.invoice_no,
               'payer_id', k.payer_id,
               'payer_name', (select pr.payer_name from public.fin_ref_payers pr where pr.org_id = p_org_id and pr.payer_id = k.payer_id),
               'branch_code', k.branch_code, 'transaction_date', k.transaction_date, 'age_days', k.age_days,
               'bucket', k.bucket, 'stage', k.stage, 'net', k.net, 'remitted', k.remitted, 'outstanding', k.outstanding,
               'rejected', k.rejected, 'evidenced', k.evidenced, 'claim_status', k.claim_status,
               'resubmission_count', k.resubmission_count, 'last_resubmission_date', k.last_resubmission_date,
               'last_followup', (
                 select jsonb_build_object('stage', fu.stage, 'outcome', fu.outcome, 'note', fu.note,
                                           'next_action_date', fu.next_action_date, 'created_at', fu.created_at)
                 from public.ins_claim_followups fu
                 where fu.org_id = p_org_id and fu.claim_activity_id = k.id
                 order by fu.created_at desc, fu.id desc limit 1),
               'task', (
                 select jsonb_build_object('stage', st.stage, 'task_id', st.task_id, 'assignee_id', st.assignee_id,
                                           'done', coalesce(t.done, false))
                 from public.ins_claim_followup_stages st
                 left join public.tasks t on t.id = st.task_id
                 where st.org_id = p_org_id and st.claim_activity_id = k.id and not st.superseded
                 order by st.stage desc limit 1))
             order by k.age_days desc nulls last, k.claim_activity_number)
      from picked k), '[]'::jsonb)
  );
$$;
revoke all on function public.fin_followup_worklist(uuid, date, integer, text, text, integer) from public, anon, authenticated;
grant execute on function public.fin_followup_worklist(uuid, date, integer, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Receivables by payer and age (counts and amounts per payer and bucket; bucket null = no transaction date)
-- ---------------------------------------------------------------------------
create or replace function public.fin_receivables_by_payer_age(p_org_id uuid, p_today date, p_branch text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select coalesce((select ageing_bucket_days from public.fin_ref_finance_settings where org_id = p_org_id), '{30,60,90,120}') as buckets
  ), o as (
    select coalesce(c.payer_id, '(no payer)') as payer_id, c.payer_id as raw_payer,
           app.fin_bucket_index(c.age_days, (select buckets from s)) as bucket, c.outstanding
    from public.fin_followup_open_claims(p_org_id, p_today) c
    where p_branch is null or c.branch_code = p_branch
  )
  select jsonb_build_object(
    'today', p_today,
    'bucket_days', to_jsonb((select buckets from s)),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('payer_id', g.payer_id, 'payer_name', g.payer_name, 'bucket', g.bucket,
                                          'claims', g.n, 'outstanding', g.amt)
                       order by g.payer_id, g.bucket nulls last)
      from (
        select o.payer_id, o.bucket, count(*) as n, round(sum(o.outstanding), 2) as amt,
               (select pr.payer_name from public.fin_ref_payers pr where pr.org_id = p_org_id and pr.payer_id = max(o.raw_payer)) as payer_name
        from o group by o.payer_id, o.bucket
      ) g), '[]'::jsonb)
  );
$$;
revoke all on function public.fin_receivables_by_payer_age(uuid, date, text) from public, anon, authenticated;
grant execute on function public.fin_receivables_by_payer_age(uuid, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The daily job step: raise each stage once per claim and create its task, in one transaction
--    * off until followup_start_date is set; a stage crossed before that date is never raised
--    * the stage row is the atomic claim (unique per claim and stage, insert ... on conflict do nothing): a retry or a
--      concurrent run never raises it twice, and the task is created in the same transaction (both or neither)
--    * when one run raises several stages of a claim (the job was off, or the claim arrived late) only the highest gets
--      a task; the lower ones are recorded as superseded
--    * assignee: the claim's previous follow-up assignee while they are still an active member of the role, otherwise
--      the role member with the fewest open follow-up tasks (ties: lowest user id); no member = unassigned
--    * open follow-up tasks of claims that are no longer open (paid, written off) are closed
--    Task subject and notes are fixed text plus the stage and the claim activity id: no payer, amount or patient detail.
-- ---------------------------------------------------------------------------
create or replace function public.fin_followup_create_tasks(
  p_org_id uuid, p_today date, p_now timestamptz default now(), p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_pool uuid[] := '{}';
  v_load integer[] := '{}';
  r record;
  v_prev uuid;
  v_assignee uuid;
  v_task uuid;
  v_idx integer;
  i integer;
  v_raised integer := 0;
  v_tasks integer := 0;
  v_superseded integer := 0;
  v_unassigned integer := 0;
  v_closed integer := 0;
  v_first_task uuid;
  v_won jsonb;
begin
  select followup_start_date, followup_stage_days, followup_task_enabled, followup_task_role, followup_task_due_days
    into s from public.fin_ref_finance_settings where org_id = p_org_id;
  if s is null or s.followup_start_date is null then
    return jsonb_build_object('skipped', 'not_enabled', 'raised', 0, 'tasks', 0, 'superseded', 0, 'unassigned', 0, 'closed', 0);
  end if;

  -- close the open follow-up tasks of claims that are no longer open
  with open_ids as materialized (select c.id from public.fin_followup_open_claims(p_org_id, p_today) c)
  update public.tasks t
     set done = true, done_at = p_now
    from public.ins_claim_followup_stages st
   where st.org_id = p_org_id and st.task_id = t.id and not t.done
     and not exists (select 1 from open_ids o where o.id = st.claim_activity_id);
  get diagnostics v_closed = row_count;

  -- the pool, with each member's open follow-up tasks
  select coalesce(array_agg(p.user_id order by p.user_id), '{}'), coalesce(array_agg(p.n order by p.user_id), '{}')
    into v_pool, v_load
    from (
      select m.user_id,
             (select count(*)::integer from public.ins_claim_followup_stages st join public.tasks t on t.id = st.task_id
              where st.org_id = p_org_id and not t.done and t.assignee_id = m.user_id) as n
      from public.memberships m join public.roles ro on ro.id = m.role_id
      where m.org_id = p_org_id and m.status = 'active' and lower(ro.name) = lower(btrim(s.followup_task_role))
    ) p;

  -- claim the crossed stages (the insert is the atomic claim), then walk what this run won
  with cand as (
    select c.id as claim_id, st.stage, (c.transaction_date + st.stage) as crossed_on
    from public.fin_followup_open_claims(p_org_id, p_today) c
    cross join unnest(s.followup_stage_days) as st(stage)
    where c.transaction_date is not null
      and c.transaction_date + st.stage <= p_today
      and c.transaction_date + st.stage >= s.followup_start_date
      and not exists (select 1 from public.ins_claim_followup_stages x
                      where x.org_id = p_org_id and x.claim_activity_id = c.id and x.stage = st.stage)
    order by c.transaction_date + st.stage, c.id, st.stage
    limit greatest(least(coalesce(p_limit, 500), 5000), 1)
  ), ins as (
    insert into public.ins_claim_followup_stages (org_id, claim_activity_id, stage, crossed_on)
    select p_org_id, cand.claim_id, cand.stage, cand.crossed_on from cand
    on conflict (org_id, claim_activity_id, stage) do nothing
    returning id, claim_activity_id, stage
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'claim_activity_id', w.claim_activity_id, 'stage', w.stage, 'top', w.top)
           order by w.claim_activity_id, w.stage), '[]'::jsonb)
    into v_won
    from (select ins.id, ins.claim_activity_id, ins.stage,
                 ins.stage = max(ins.stage) over (partition by ins.claim_activity_id) as top
          from ins) w;

  for r in
    select * from jsonb_to_recordset(v_won) as w(id uuid, claim_activity_id uuid, stage integer, top boolean)
  loop
    v_raised := v_raised + 1;
    if not r.top then
      update public.ins_claim_followup_stages set superseded = true where id = r.id;
      v_superseded := v_superseded + 1;
      continue;
    end if;
    if not s.followup_task_enabled then
      continue;
    end if;

    v_assignee := null;
    select st.assignee_id into v_prev from public.ins_claim_followup_stages st
     where st.org_id = p_org_id and st.claim_activity_id = r.claim_activity_id and st.stage < r.stage
       and st.assignee_id is not null
     order by st.stage desc limit 1;
    if v_prev is not null and v_prev = any (v_pool) then
      v_assignee := v_prev;
    elsif cardinality(v_pool) > 0 then
      v_idx := 1;
      for i in 2 .. cardinality(v_pool) loop
        if v_load[i] < v_load[v_idx] then
          v_idx := i;
        end if;
      end loop;
      v_assignee := v_pool[v_idx];
    end if;
    if v_assignee is not null then
      v_idx := array_position(v_pool, v_assignee);
      v_load[v_idx] := v_load[v_idx] + 1;
    else
      v_unassigned := v_unassigned + 1;
    end if;

    insert into public.tasks (org_id, type, subject, notes, due_at, assignee_id)
    values (p_org_id, 'follow_up',
            'Insurance claim follow-up: ' || r.stage || ' days unpaid',
            'Open Finance, Insurance follow-up. Claim activity id ' || r.claim_activity_id::text || '.',
            p_now + make_interval(days => s.followup_task_due_days), v_assignee)
    returning id into v_task;
    update public.ins_claim_followup_stages set task_id = v_task, assignee_id = v_assignee where id = r.id;
    v_first_task := coalesce(v_first_task, v_task);
    v_tasks := v_tasks + 1;
  end loop;

  return jsonb_build_object('raised', v_raised, 'tasks', v_tasks, 'superseded', v_superseded,
                            'unassigned', v_unassigned, 'closed', v_closed, 'first_task_id', v_first_task);
end;
$$;
revoke all on function public.fin_followup_create_tasks(uuid, date, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.fin_followup_create_tasks(uuid, date, timestamptz, integer) to service_role;
