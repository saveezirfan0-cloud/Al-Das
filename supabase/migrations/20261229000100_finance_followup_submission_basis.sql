-- Insurance follow-up as the Insurance team runs it (Sharaf, call of 23 Oct 2026, 19 Oct requests Q33; docs/52 §7):
-- follow-up counts from the SUBMISSION date, not the visit date, and a claim is a red flag at 120 days. Most remittance
-- advices arrive about 90 days after submission, so earlier stages only produce noise.
--
--   * fin_ref_finance_settings.followup_age_basis: 'submission' (new default) or 'visit' (the behaviour before). Diligence
--     has no first-submission date: "submission" is the last resubmission date when the claim was resubmitted (the insurer's
--     clock restarts), else the visit date (a first submission goes out about 15 days after the visit, docs/41), so a
--     claim is never flagged later than it should be. app.fin_followup_from is the one rule; followupFrom() in
--     lib/finance/followup.ts is its twin.
--   * followup_stage_days default {120}; an organisation still on the old default {60,90,120} moves to {120}, a list
--     Finance chose is kept.
--   * fin_followup_worklist and fin_followup_create_tasks are redefined from their only definition (20261026000100): the
--     stage and the day a stage is crossed come from the follow-up date; ageing buckets (the receivables report) still
--     count from the visit date. The worklist adds followup_from, followup_age_days and age_basis. Nothing else changes.

alter table public.fin_ref_finance_settings
  add column followup_age_basis text not null default 'submission'
    check (followup_age_basis in ('submission', 'visit'));
alter table public.fin_ref_finance_settings alter column followup_stage_days set default '{120}';
update public.fin_ref_finance_settings set followup_stage_days = '{120}' where followup_stage_days = '{60,90,120}';

comment on column public.fin_ref_finance_settings.followup_age_basis is
  'Insurance follow-up counts from: submission (last resubmission date, else the visit date) or visit.';

create or replace function app.fin_followup_from(p_basis text, p_transaction_date date, p_last_resubmission_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case when p_basis = 'visit' then p_transaction_date
              else coalesce(p_last_resubmission_date, p_transaction_date) end;
$$;

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
           coalesce((select followup_stage_days from public.fin_ref_finance_settings where org_id = p_org_id), '{120}') as stages,
           coalesce((select followup_age_basis from public.fin_ref_finance_settings where org_id = p_org_id), 'submission') as basis,
           (select followup_start_date from public.fin_ref_finance_settings where org_id = p_org_id) as start_date,
           coalesce((select followup_task_enabled from public.fin_ref_finance_settings where org_id = p_org_id), false) as task_enabled
  ), b as materialized (
    select c.*, app.fin_followup_from((select basis from s), c.transaction_date, c.last_resubmission_date) as followup_from
    from public.fin_followup_open_claims(p_org_id, p_today) c
  ), o as materialized (
    select b.*, (p_today - b.followup_from)::integer as followup_age_days,
           app.fin_bucket_index(b.age_days, (select buckets from s)) as bucket,
           app.fin_stage_reached((p_today - b.followup_from)::integer, (select stages from s)) as stage
    from b
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
    'age_basis', (select basis from s),
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
               'followup_from', k.followup_from, 'followup_age_days', k.followup_age_days,
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
  select followup_start_date, followup_stage_days, followup_task_enabled, followup_task_role, followup_task_due_days,
         followup_age_basis
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
    select c.id as claim_id, st.stage, (c.followup_from + st.stage) as crossed_on
    from (select oc.id, app.fin_followup_from(s.followup_age_basis, oc.transaction_date, oc.last_resubmission_date) as followup_from
          from public.fin_followup_open_claims(p_org_id, p_today) oc) c
    cross join unnest(s.followup_stage_days) as st(stage)
    where c.followup_from is not null
      and c.followup_from + st.stage <= p_today
      and c.followup_from + st.stage >= s.followup_start_date
      and not exists (select 1 from public.ins_claim_followup_stages x
                      where x.org_id = p_org_id and x.claim_activity_id = c.id and x.stage = st.stage)
    order by c.followup_from + st.stage, c.id, st.stage
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
            'Insurance claim follow-up: ' || r.stage
              || case when s.followup_age_basis = 'visit' then ' days unpaid' else ' days since submission' end,
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
