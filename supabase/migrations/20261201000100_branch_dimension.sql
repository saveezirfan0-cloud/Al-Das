-- Phase B (docs/34_CLINIC_OS_PLAN.md), second slice: branches as a dimension across the app.
--
--   channels.location_id         the branch a WhatsApp number belongs to
--   channels.default_team_id     the team a new conversation on that number is routed to (before the org default team)
--   teams.location_id            the branch a team works for (informational; routing uses the channel's team)
--   contacts.location_id         the patient's home branch (patients still cross branches: contacts RLS is unchanged)
--   tasks.location_id            the branch a task belongs to; RLS hides other branches' tasks from members limited to
--                                some branches (app.location_visible_to, rows with no branch stay visible)
--   conversations.location_id    copied from the channel when the conversation is created (trigger below); conversations
--                                RLS is unchanged (a patient may write to any branch's number)
--
-- Every new location_id is nullable, `on delete set null`, and checked against the row's org (app.check_parent_org).
-- route_conversation (from its last definition, 20261110000200_routing_presence.sql) now prefers the channel's default
-- team over the team the caller passes (the org default); everything else is unchanged.
-- The ledger reports gain an optional branch filter (acc_journal_lines.branch_code = fin_ref_branches.code, which
-- locations.branch_code points at): acc_trial_balance, acc_ledger, acc_balance_sheet and acc_cash_flow, each from its
-- last definition with one extra trailing parameter p_branch_code (default null = every branch, exactly as before).

-- ---------------------------------------------------------------------------
-- 1. Columns, org checks and indexes
-- ---------------------------------------------------------------------------
alter table public.channels
  add column location_id uuid references public.locations (id) on delete set null,
  add column default_team_id uuid references public.teams (id) on delete set null;
alter table public.teams add column location_id uuid references public.locations (id) on delete set null;
alter table public.contacts add column location_id uuid references public.locations (id) on delete set null;
alter table public.tasks add column location_id uuid references public.locations (id) on delete set null;
alter table public.conversations add column location_id uuid references public.locations (id) on delete set null;

create trigger channels_location_org_check before insert or update of location_id on public.channels
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger channels_default_team_org_check before insert or update of default_team_id on public.channels
  for each row execute function app.check_parent_org('teams', 'default_team_id');
create trigger teams_location_org_check before insert or update of location_id on public.teams
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger contacts_location_org_check before insert or update of location_id on public.contacts
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger tasks_location_org_check before insert or update of location_id on public.tasks
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger conversations_location_org_check before insert or update of location_id on public.conversations
  for each row execute function app.check_parent_org('locations', 'location_id');

create index channels_location_idx on public.channels (location_id) where location_id is not null;
create index channels_default_team_idx on public.channels (default_team_id) where default_team_id is not null;
create index teams_location_idx on public.teams (location_id) where location_id is not null;
create index contacts_org_location_idx on public.contacts (org_id, location_id) where location_id is not null;
create index tasks_org_location_idx on public.tasks (org_id, location_id) where location_id is not null;
create index conversations_org_location_idx on public.conversations (org_id, location_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- 2. Defaults on insert
-- ---------------------------------------------------------------------------
-- A new conversation takes its channel's branch (every insert path: inbound, outbound, campaigns, web chat, social).
-- Fires before conversations_location_org_check (triggers run in name order); the channel is in the same org anyway.
create or replace function app.conversation_branch_from_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.location_id is null and new.channel_id is not null then
    select ch.location_id into new.location_id
    from public.channels ch
    where ch.id = new.channel_id and ch.org_id = new.org_id;
  end if;
  return new;
end;
$$;
revoke all on function app.conversation_branch_from_channel() from public, anon, authenticated;
create trigger conversations_branch_from_channel before insert on public.conversations
  for each row execute function app.conversation_branch_from_channel();

-- A new task with no branch takes its appointment's branch, else its enquiry's (front desk call tasks, enquiry
-- follow-ups). A task created on the Tasks page carries the branch chosen there.
create or replace function app.task_branch_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.location_id is null and new.appointment_id is not null then
    select a.location_id into new.location_id
    from public.appointments a
    where a.id = new.appointment_id and a.org_id = new.org_id;
  end if;
  if new.location_id is null and new.enquiry_id is not null then
    select e.location_id into new.location_id
    from public.enquiries e
    where e.id = new.enquiry_id and e.org_id = new.org_id;
  end if;
  return new;
end;
$$;
revoke all on function app.task_branch_default() from public, anon, authenticated;
create trigger tasks_branch_default before insert on public.tasks
  for each row execute function app.task_branch_default();

-- ---------------------------------------------------------------------------
-- 3. Tasks RLS: the branch rule on top of the last definitions (20261124000100_soft_delete_restore.sql for select and
--    update, 20261010000300_enquiries.sql for insert). There is no browser DELETE policy on tasks since the soft delete
--    slice (deletes go through soft_delete_records), so none is added here.
-- ---------------------------------------------------------------------------
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (app.has_perm(org_id, 'tasks.view') and deleted_at is null
         and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (app.has_perm(org_id, 'tasks.manage') and deleted_at is null
         and app.location_visible_to(org_id, auth.uid(), location_id))
  with check (app.has_perm(org_id, 'tasks.manage') and deleted_at is null
              and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.has_perm(org_id, 'tasks.manage') and app.location_visible_to(org_id, auth.uid(), location_id));

-- ---------------------------------------------------------------------------
-- 4. Routing: the channel's default team first (from 20261110000200_routing_presence.sql; only the team choice changed)
-- ---------------------------------------------------------------------------
create or replace function public.route_conversation(p_org_id uuid, p_conversation_id uuid, p_team_id uuid, p_round_robin boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv record;
  v_team record;
  v_fb record;
  v_idle integer;
  v_user uuid;
  v_final uuid;
  v_team_id uuid := p_team_id;
  v_channel_team uuid;
  v_fallback boolean := false;
  v_tried_rr boolean := false;
  v_out record;
begin
  select c.id, c.assignee_user_id, c.assignee_team_id, c.channel_id into v_conv
  from public.conversations c
  where c.id = p_conversation_id and c.org_id = p_org_id
  for update;
  if not found then
    return null;
  end if;
  if v_conv.assignee_user_id is not null then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', v_conv.assignee_user_id,
                              'fallback', false, 'team_online', true, 'auto_reply_text', null, 'office_hours', null);
  end if;
  -- Phase B: the number's own team (a branch's desk) before the workspace default.
  select t.id into v_channel_team
  from public.channels ch
  join public.teams t on t.id = ch.default_team_id and t.org_id = p_org_id
  where ch.id = v_conv.channel_id and ch.org_id = p_org_id;
  if v_channel_team is not null then
    v_team_id := v_channel_team;
  end if;
  select t.id, t.round_robin, t.fallback_team_id into v_team
  from public.teams t where t.id = v_team_id and t.org_id = p_org_id;
  if not found then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', null,
                              'fallback', false, 'team_online', false, 'auto_reply_text', null, 'office_hours', null);
  end if;

  perform set_config('pulse.assign_source', 'routing', true);
  select app.auto_away_minutes(o.settings) into v_idle from public.orgs o where o.id = p_org_id;

  v_final := v_team.id;
  if p_round_robin and v_team.round_robin then
    v_tried_rr := true;
    v_user := app.pick_team_assignee(p_org_id, v_team.id, true);
  end if;
  if v_user is null and v_team.fallback_team_id is not null
     and (v_tried_rr or not app.team_has_online_member(p_org_id, v_team.id, v_idle)) then
    select t.id, t.round_robin into v_fb
    from public.teams t where t.id = v_team.fallback_team_id and t.org_id = p_org_id;
    if found then
      if p_round_robin and v_fb.round_robin then
        v_user := app.pick_team_assignee(p_org_id, v_fb.id, true);
      end if;
      if v_user is not null or app.team_has_online_member(p_org_id, v_fb.id, v_idle) then
        v_final := v_fb.id;
        v_fallback := true;
      end if;
    end if;
  end if;

  update public.conversations
  set assignee_team_id = v_final, assignee_user_id = v_user
  where id = p_conversation_id;

  select t.auto_reply_text, t.office_hours into v_out from public.teams t where t.id = v_final;
  return jsonb_build_object(
    'team_id', v_final,
    'user_id', v_user,
    'fallback', v_fallback,
    'team_online', v_user is not null or app.team_has_online_member(p_org_id, v_final, v_idle),
    'auto_reply_text', v_out.auto_reply_text,
    'office_hours', v_out.office_hours
  );
end;
$$;
revoke all on function public.route_conversation(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.route_conversation(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Ledger reports by branch. Each is its last definition plus `p_branch_code` (null or blank = every line, exactly as
--    before). A branch view keeps only lines that name the branch; control accounts (bank, VAT, receivables) often name
--    none, so a branch balance sheet or trial balance need not balance. The old signatures are dropped so a call with
--    the old arguments resolves to the new function (no ambiguous overloads).
-- ---------------------------------------------------------------------------

-- Trial balance (from 20261108000100_accounting_core.sql)
drop function public.acc_trial_balance(uuid, uuid, date, date);
create function public.acc_trial_balance(p_org_id uuid, p_entity_id uuid, p_from date, p_to date,
                                         p_branch_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_branch text := nullif(btrim(coalesce(p_branch_code, '')), '');
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_entity_id is not null and not exists (select 1 from public.acc_entities e where e.id = p_entity_id and e.org_id = p_org_id) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  with ln as (
    select l.account_id, j.journal_date, l.debit, l.credit, a.nature,
           app.acc_fy_start(e.fiscal_year_start_month, p_from) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (v_branch is null or l.branch_code = v_branch)
  ), per as (
    select account_id,
           sum(case when journal_date < p_from and (nature in ('asset', 'liability', 'equity') or journal_date >= fy_start)
                    then debit - credit else 0 end) as opening,
           sum(case when journal_date >= p_from then debit else 0 end) as debit,
           sum(case when journal_date >= p_from then credit else 0 end) as credit
    from ln group by account_id
  ), earlier as (
    select coalesce(sum(debit - credit), 0) as pl from ln where nature in ('income', 'expense') and journal_date < fy_start
  ), tot as (
    select coalesce(sum(opening), 0) as opening, coalesce(sum(debit), 0) as debit, coalesce(sum(credit), 0) as credit from per
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id, 'branch_code', v_branch,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature, 'parent_id', a.parent_id,
               'opening', p.opening, 'debit', p.debit, 'credit', p.credit, 'closing', p.opening + p.debit - p.credit)
             order by a.code)
      from per p join public.acc_accounts a on a.id = p.account_id
      where p.opening <> 0 or p.debit <> 0 or p.credit <> 0), '[]'::jsonb),
    'earlier_years_pl', (select pl from earlier),
    'totals', (select jsonb_build_object(
                 'opening', t.opening + (select pl from earlier), 'debit', t.debit, 'credit', t.credit,
                 'closing', t.opening + (select pl from earlier) + t.debit - t.credit) from tot t))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_trial_balance(uuid, uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.acc_trial_balance(uuid, uuid, date, date, text) to service_role;

-- General ledger (from 20261108000100_accounting_core.sql)
drop function public.acc_ledger(uuid, uuid, date, date, integer, integer);
create function public.acc_ledger(p_org_id uuid, p_account_id uuid, p_from date, p_to date, p_limit integer, p_offset integer,
                                  p_branch_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.acc_accounts;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_branch text := nullif(btrim(coalesce(p_branch_code, '')), '');
  v jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  select * into a from public.acc_accounts where id = p_account_id and org_id = p_org_id;
  if not found then
    raise exception 'Account not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  with recursive tree as (
    select x.id from public.acc_accounts x where x.id = a.id
    union all
    select c.id from public.acc_accounts c join tree t on c.parent_id = t.id
  ), ln as (
    select l.id, l.journal_id, l.line_no, l.debit, l.credit, l.description, l.branch_code, ac.code as account_code,
           ac.name as account_name, ac.nature, j.number, j.journal_date, j.voucher_type, j.narration, j.posted_at,
           j.status, j.source_kind, app.acc_fy_start(e.fiscal_year_start_month, p_from) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts ac on ac.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where l.account_id in (select id from tree) and j.org_id = p_org_id and j.status in ('posted', 'reversed')
      and j.journal_date <= p_to
      and (v_branch is null or l.branch_code = v_branch)
  ), op as (
    select coalesce(sum(debit - credit), 0) as opening from ln
    where journal_date < p_from and (nature in ('asset', 'liability', 'equity') or journal_date >= fy_start)
  ), rng as (
    select ln.*, (select opening from op) + sum(debit - credit) over (
             order by journal_date, posted_at, number, line_no, id rows between unbounded preceding and current row) as balance,
           row_number() over (order by journal_date, posted_at, number, line_no, id) as rn
    from ln where journal_date >= p_from
  )
  select jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature, 'is_group', a.is_group),
    'from', p_from, 'to', p_to, 'branch_code', v_branch,
    'opening', (select opening from op),
    'period_debit', (select coalesce(sum(debit), 0) from rng),
    'period_credit', (select coalesce(sum(credit), 0) from rng),
    'closing', (select opening from op) + (select coalesce(sum(debit - credit), 0) from rng),
    'total_lines', (select count(*) from rng),
    'limit', v_limit, 'offset', v_offset,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', r.id, 'journal_id', r.journal_id, 'number', r.number, 'date', r.journal_date,
               'voucher_type', r.voucher_type, 'narration', r.narration, 'description', r.description,
               'account_code', r.account_code, 'account_name', r.account_name, 'branch_code', r.branch_code,
               'status', r.status, 'source_kind', r.source_kind,
               'debit', r.debit, 'credit', r.credit, 'balance', r.balance) order by r.rn)
      from rng r where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_ledger(uuid, uuid, date, date, integer, integer, text) from public, anon, authenticated;
grant execute on function public.acc_ledger(uuid, uuid, date, date, integer, integer, text) to service_role;

-- Balance sheet (from 20261109000400_accounting_statements.sql)
drop function public.acc_balance_sheet(uuid, uuid, date, boolean);
create function public.acc_balance_sheet(p_org_id uuid, p_entity_id uuid, p_as_at date, p_include_adjustment boolean,
                                         p_branch_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fy date;
  v_branch text := nullif(btrim(coalesce(p_branch_code, '')), '');
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_as_at, p_as_at);
  select app.acc_fy_start(e.fiscal_year_start_month, p_as_at) into v_fy
  from public.acc_entities e
  where e.org_id = p_org_id and (e.id = p_entity_id or (p_entity_id is null and e.is_default));
  v_fy := coalesce(v_fy, app.acc_fy_start(7, p_as_at));
  with ln as (
    select l.account_id, a.nature, j.journal_date, l.debit - l.credit as dc,
           app.acc_fy_start(e.fiscal_year_start_month, p_as_at) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_as_at
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
      and (v_branch is null or l.branch_code = v_branch)
  ), bs as (
    select account_id, nature, sum(case when nature = 'asset' then dc else -dc end) as bal
    from ln where nature in ('asset', 'liability', 'equity') group by account_id, nature
  ), pl as (
    select coalesce(sum(case when journal_date >= fy_start then -dc else 0 end), 0) as cur,
           coalesce(sum(case when journal_date < fy_start then -dc else 0 end), 0) as earlier
    from ln where nature in ('income', 'expense')
  ), tot as (
    select coalesce(sum(case when nature = 'asset' then bal else 0 end), 0) as assets,
           coalesce(sum(case when nature = 'liability' then bal else 0 end), 0) as liabilities,
           coalesce(sum(case when nature = 'equity' then bal else 0 end), 0) as equity
    from bs
  )
  select jsonb_build_object(
    'as_at', p_as_at, 'entity_id', p_entity_id, 'fy_start', v_fy, 'branch_code', v_branch,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, v_fy, p_as_at),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', b.account_id, 'nature', b.nature, 'balance', b.bal)
                       order by b.account_id)
      from bs b where b.bal <> 0), '[]'::jsonb),
    'current_year_pl', (select cur from pl),
    'earlier_years_pl', (select earlier from pl),
    'totals', (select jsonb_build_object(
                 'assets', t.assets, 'liabilities', t.liabilities, 'equity', t.equity,
                 'difference', t.assets - t.liabilities - t.equity - (select cur from pl) - (select earlier from pl))
               from tot t))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_balance_sheet(uuid, uuid, date, boolean, text) from public, anon, authenticated;
grant execute on function public.acc_balance_sheet(uuid, uuid, date, boolean, text) to service_role;

-- Cash flow (from 20261109000900_accounting_integration.sql: closing journals left out)
drop function public.acc_cash_flow(uuid, uuid, date, date, boolean);
create function public.acc_cash_flow(p_org_id uuid, p_entity_id uuid, p_from date, p_to date, p_include_adjustment boolean,
                                     p_branch_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch text := nullif(btrim(coalesce(p_branch_code, '')), '');
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  with cls as (
    select * from app.acc_cash_flow_classes(p_org_id)
  ), ln as (
    select l.account_id, a.nature, c.cls, j.journal_date, l.debit, l.credit
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    left join cls c on c.account_id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
      and not app.acc_is_closing_journal(j.source_kind, j.reversal_of)
      and (v_branch is null or l.branch_code = v_branch)
  ), mv as (
    select account_id, coalesce(cls, 'working_capital') as cls,
           sum(case when journal_date >= p_from then credit - debit else 0 end) as effect,
           sum(case when journal_date < p_from then debit - credit else 0 end) as opening,
           sum(debit - credit) as closing
    from ln where nature in ('asset', 'liability', 'equity') group by account_id, coalesce(cls, 'working_capital')
  ), np as (
    select coalesce(sum(credit - debit), 0) as np from ln where nature in ('income', 'expense') and journal_date >= p_from
  ), tot as (
    select coalesce(sum(case when cls = 'operating_noncash' then effect else 0 end), 0) as noncash,
           coalesce(sum(case when cls = 'working_capital' then effect else 0 end), 0) as wc,
           coalesce(sum(case when cls = 'investing' then effect else 0 end), 0) as inv,
           coalesce(sum(case when cls = 'financing' then effect else 0 end), 0) as fin,
           coalesce(sum(case when cls = 'cash' then opening else 0 end), 0) as cash_open,
           coalesce(sum(case when cls = 'cash' then closing else 0 end), 0) as cash_close
    from mv
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id, 'branch_code', v_branch,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'net_profit', (select np from np),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', m.account_id, 'class', m.cls, 'amount', m.effect)
                       order by m.cls, m.account_id)
      from mv m where m.cls <> 'cash' and m.effect <> 0), '[]'::jsonb),
    'cash_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', m.account_id, 'opening', m.opening, 'closing', m.closing)
                       order by m.account_id)
      from mv m where m.cls = 'cash' and (m.opening <> 0 or m.closing <> 0)), '[]'::jsonb),
    'totals', (select jsonb_build_object(
                 'net_profit', (select np from np),
                 'operating_noncash', t.noncash, 'working_capital', t.wc,
                 'operating', (select np from np) + t.noncash + t.wc,
                 'investing', t.inv, 'financing', t.fin,
                 'net_change', (select np from np) + t.noncash + t.wc + t.inv + t.fin,
                 'opening_cash', t.cash_open, 'closing_cash', t.cash_close,
                 'cash_movement', t.cash_close - t.cash_open,
                 'difference', (select np from np) + t.noncash + t.wc + t.inv + t.fin - (t.cash_close - t.cash_open))
               from tot t),
    'classes', coalesce((select jsonb_object_agg(c.account_id::text, c.cls) from cls c where c.cls is not null), '{}'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_cash_flow(uuid, uuid, date, date, boolean, text) from public, anon, authenticated;
grant execute on function public.acc_cash_flow(uuid, uuid, date, date, boolean, text) to service_role;
