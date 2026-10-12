-- Phase 18 (6/7): month-end close with a LOCK, and the end-of-day cash-up.
--
--   fin_period_closes   one row per month: the frozen snapshot of the month's figures (and its sha256), the finance
--                       sign-off and the CEO sign-off. The CEO sign-off locks the month.
--   fin_cashups / fin_cashup_lines   the cash-up per branch and day, by payment mode
--
-- WHAT "LOCKED" MEANS (enforced here, not in the application):
--   * the close row, its snapshot and its sign-offs can never change or be deleted again (trigger, no bypass: not even
--     the service role; only removing the whole organisation cascades it away);
--   * the snapshot's hash is re-checked at lock time, so a locked month is exactly what both signers approved;
--   * cash-ups dated inside a locked month cannot be inserted, changed or deleted.
--   What is NOT blocked: the Unite and Diligence mirrors. Unite delivers each record once and may re-send an amended
--   invoice; refusing it would lose data. A late change to a locked month is therefore stored (raw first) but never
--   alters the frozen pack; lib/finance/close-drift.ts shows the difference between the live figures and the snapshot.
--
-- Sign-offs are bound to the hash the signer was looking at, and the CEO cannot be the person who signed for finance.

create table public.fin_period_closes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  status text not null default 'open' check (status in ('open', 'built', 'finance_signed', 'locked')),
  snapshot jsonb check (snapshot is null or jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text,
  built_at timestamptz,
  built_by uuid references public.profiles (id) on delete set null,
  finance_signed_by uuid references public.profiles (id) on delete set null,
  finance_signed_at timestamptz,
  finance_note text check (finance_note is null or char_length(finance_note) <= 500),
  ceo_signed_by uuid references public.profiles (id) on delete set null,
  ceo_signed_at timestamptz,
  ceo_note text check (ceo_note is null or char_length(ceo_note) <= 500),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, month),
  check (status = 'open' or (snapshot is not null and snapshot_hash is not null and built_at is not null)),
  check (status not in ('finance_signed', 'locked') or (finance_signed_at is not null)),
  check (status <> 'locked' or (ceo_signed_at is not null and locked_at is not null)),
  check ((status = 'locked') = (locked_at is not null)),
  check (finance_signed_by is null or ceo_signed_by is null or finance_signed_by <> ceo_signed_by)
);
create index fin_period_closes_org_idx on public.fin_period_closes (org_id, month desc);
create trigger fin_period_closes_set_updated_at before update on public.fin_period_closes
  for each row execute function app.set_updated_at();

-- The immutability rule. Runs for every role, including the service role.
create or replace function app.fin_period_close_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- cascading from a deleted organisation is the only way out
    if old.locked_at is not null and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a locked month cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.locked_at is not null then
      -- the FK action that nulls a deleted user's id is the one permitted change
      if (to_jsonb(new) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'updated_at')
         is not distinct from (to_jsonb(old) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'updated_at')
         and (new.built_by is null or new.built_by = old.built_by)
         and (new.finance_signed_by is null or new.finance_signed_by = old.finance_signed_by)
         and (new.ceo_signed_by is null or new.ceo_signed_by = old.ceo_signed_by) then
        return new;
      end if;
      raise exception 'a locked month is immutable' using errcode = '42501';
    end if;
    if new.org_id <> old.org_id or new.month <> old.month then
      raise exception 'the month of a close cannot change' using errcode = 'check_violation';
    end if;
    if not (
         (old.status = new.status and old.status in ('open', 'built'))
      or (old.status = 'open' and new.status = 'built')
      or (old.status = 'built' and new.status = 'finance_signed')
      or (old.status = 'finance_signed' and new.status = 'built')                       -- sign-off withdrawn
      or (old.status = 'finance_signed' and new.status = 'locked')                      -- CEO sign-off
      or (old.status = 'finance_signed' and new.status = 'finance_signed'               -- noise columns / a deleted user's id only
          and (new.finance_signed_by is null or new.finance_signed_by = old.finance_signed_by))
    ) then
      raise exception 'invalid close transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
    -- the snapshot can change only while the pack is being built; signing, withdrawing and locking never touch it
    if not (old.status in ('open', 'built') and new.status = 'built')
       and (new.snapshot is distinct from old.snapshot or new.snapshot_hash is distinct from old.snapshot_hash) then
      raise exception 'the snapshot cannot change once the pack is signed' using errcode = 'check_violation';
    end if;
    if new.status = 'locked' then
      if new.snapshot_hash is distinct from encode(sha256(convert_to(new.snapshot::text, 'UTF8')), 'hex') then
        raise exception 'the snapshot does not match its hash' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_period_close_guard() from public, anon, authenticated;
create trigger fin_period_closes_guard before update or delete on public.fin_period_closes
  for each row execute function app.fin_period_close_guard();

alter table public.fin_period_closes enable row level security;
create policy fin_period_closes_select on public.fin_period_closes for select to authenticated
  using (app.has_perm(org_id, 'finance.close.view') or app.has_perm(org_id, 'finance.close.manage')
      or app.has_perm(org_id, 'finance.close.signoff.finance') or app.has_perm(org_id, 'finance.close.signoff.ceo'));

-- Is a month locked? (cash-ups consult this)
create or replace function app.fin_month_is_locked(p_org_id uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fin_period_closes c
    where c.org_id = p_org_id and c.month = date_trunc('month', p_date)::date and c.locked_at is not null
  );
$$;
revoke all on function app.fin_month_is_locked(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cash-up
-- ---------------------------------------------------------------------------
create table public.fin_cashups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  branch_code text not null check (char_length(branch_code) between 1 and 20),
  business_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  note text check (note is null or char_length(note) <= 500),
  prepared_by uuid references public.profiles (id) on delete set null,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, branch_code, business_date),
  check ((status = 'submitted') = (submitted_at is not null))
);
create index fin_cashups_org_date_idx on public.fin_cashups (org_id, business_date desc);

create table public.fin_cashup_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  cashup_id uuid not null references public.fin_cashups (id) on delete cascade,
  payment_mode text not null check (char_length(payment_mode) between 1 and 60),
  expected_amount numeric(14, 2) not null default 0,   -- what the system recorded, refreshed while the cash-up is a draft
  counted_amount numeric(14, 2) check (counted_amount is null or counted_amount >= 0),
  variance numeric(14, 2) generated always as (counted_amount - expected_amount) stored,
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cashup_id, payment_mode)
);
create index fin_cashup_lines_cashup_idx on public.fin_cashup_lines (cashup_id);

create trigger fin_cashups_set_updated_at before update on public.fin_cashups for each row execute function app.set_updated_at();
create trigger fin_cashup_lines_set_updated_at before update on public.fin_cashup_lines for each row execute function app.set_updated_at();
create trigger fin_cashup_lines_cashup_org_check before insert or update of cashup_id, org_id on public.fin_cashup_lines
  for each row execute function app.check_parent_org('fin_cashups', 'cashup_id');

-- Locked month => no change. A submitted cash-up's lines are frozen until it is reopened (status back to draft).
-- A row with no date or no parent (the cross-org probe in the security tests) passes through untouched so RLS answers.
create or replace function app.fin_cashup_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_org uuid;
  v_status text;
  v_cashup_id uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.org_id;
  else
    v_org := new.org_id;
  end if;

  if tg_table_name = 'fin_cashups' then
    if tg_op = 'DELETE' then
      v_date := old.business_date;
    else
      v_date := new.business_date;
    end if;
    if tg_op <> 'INSERT' then
      v_status := old.status;
    end if;
  else
    if tg_op = 'DELETE' then
      v_cashup_id := old.cashup_id;
    else
      v_cashup_id := new.cashup_id;
    end if;
    select c.business_date, c.status into v_date, v_status from public.fin_cashups c where c.id = v_cashup_id;
  end if;

  if v_org is not null and v_date is not null then
    if app.fin_month_is_locked(v_org, v_date) and exists (select 1 from public.orgs o where o.id = v_org) then
      raise exception 'the month of this cash-up is locked' using errcode = '42501';
    end if;
    if tg_table_name = 'fin_cashup_lines' and v_status = 'submitted' then
      raise exception 'a submitted cash-up is frozen; reopen it first' using errcode = 'check_violation';
    end if;
    if tg_table_name = 'fin_cashups' then
      if tg_op = 'UPDATE' then
        if old.status = 'submitted' and new.status = 'submitted'
           and (new.branch_code, new.business_date, new.note) is distinct from (old.branch_code, old.business_date, old.note) then
          raise exception 'a submitted cash-up is frozen; reopen it first' using errcode = 'check_violation';
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_cashup_guard() from public, anon, authenticated;
create trigger fin_cashups_guard before insert or update or delete on public.fin_cashups
  for each row execute function app.fin_cashup_guard();
create trigger fin_cashup_lines_guard before insert or update or delete on public.fin_cashup_lines
  for each row execute function app.fin_cashup_guard();

alter table public.fin_cashups enable row level security;
alter table public.fin_cashup_lines enable row level security;
create policy fin_cashups_select on public.fin_cashups for select to authenticated
  using (app.has_perm(org_id, 'finance.cashup.manage'));
create policy fin_cashup_lines_select on public.fin_cashup_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.cashup.manage'));

-- ---------------------------------------------------------------------------
-- Month figures for the close pack (SQL so the definitions match the live reports); lib/finance/close-pack.ts adds the
-- revenue breakdowns, scorecard rows and denial reasons and freezes the lot.
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_month_figures(p_org_id uuid, p_month date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  generated as (
    select coalesce(i.branch_code, '(none)') as branch, sum(i.net) as generated, count(*) as invoices
    from public.fin_invoices i cross join m
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date >= m.s and i.transaction_date < m.e group by 1
  ), claimed as (
    select coalesce(i.branch_code, '(none)') as branch, sum(c.net) as claimed, sum(c.remitted) as remitted, sum(c.rejected) as rejected,
           sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
               - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)) as outstanding,
           count(*) as claims
    from public.ins_claim_activities c cross join m
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    where c.org_id = p_org_id and c.transaction_date >= m.s and c.transaction_date < m.e group by 1
  ), selfpay as (
    select coalesce(i.branch_code, '(none)') as branch, sum(p.paid) as self_pay_collected
    from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id cross join m
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date >= m.s and p.paid_date < m.e
      and upper(coalesce(i.inv_type, '')) like 'SELF%' group by 1
  ), branches as (
    select branch from generated union select branch from claimed union select branch from selfpay
  ), by_branch as (
    select b.branch, round(coalesce(g.generated, 0), 2) as generated, coalesce(g.invoices, 0) as invoices,
           round(coalesce(c.claimed, 0), 2) as claimed, round(coalesce(c.remitted, 0), 2) as remitted,
           round(coalesce(c.rejected, 0), 2) as rejected, round(coalesce(c.outstanding, 0), 2) as outstanding,
           coalesce(c.claims, 0) as claims, round(coalesce(s.self_pay_collected, 0), 2) as self_pay_collected
    from branches b
    left join generated g on g.branch = b.branch left join claimed c on c.branch = b.branch left join selfpay s on s.branch = b.branch
  ), collections as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.paid, 0)), 2) as paid, round(sum(coalesce(p.refund, 0)), 2) as refunds
    from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id cross join m
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date >= m.s and p.paid_date < m.e group by 1
  ), adjustments as (
    select round(coalesce(sum(i.write_off), 0), 2) as write_off, round(coalesce(sum(i.credit_note), 0), 2) as credit_note
    from public.fin_invoices i cross join m
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date >= m.s and i.transaction_date < m.e
  ), ageing as (
    select bucket, count(*) as claims, round(sum(amount), 2) as outstanding from (
      select greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
               - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as amount,
             case when (current_date - c.transaction_date) <= 30 then '0-30' when (current_date - c.transaction_date) <= 60 then '31-60'
                  when (current_date - c.transaction_date) <= 90 then '61-90' else '90+' end as bucket
      from public.ins_claim_activities c where c.org_id = p_org_id and c.transaction_date is not null
    ) a where amount > 0 group by bucket
  ), denials as (
    select count(*) filter (where d.denied_on >= m.s and d.denied_on < m.e) as opened_in_month,
           count(*) filter (where d.status in ('open', 'in_progress', 'appealed', 'resubmitted')) as active_now,
           round(coalesce(sum(d.rejected_amount) filter (where d.status in ('open', 'in_progress', 'appealed', 'resubmitted')), 0), 2) as active_amount,
           count(*) filter (where d.status in ('open', 'in_progress') and d.deadline_on < current_date) as past_deadline
    from public.ins_denial_cases d cross join m where d.org_id = p_org_id
  ), remit as (
    select count(distinct b.id) as batches, count(l.id) as lines, count(l.id) filter (where 'short_paid' = any (l.flags)) as short_lines,
           round(coalesce(sum(l.short_amount), 0), 2) as short_amount, round(coalesce(sum(l.paid_amount), 0), 2) as paid
    from public.ins_remittance_batches b cross join m
    left join public.ins_remittance_lines l on l.batch_id = b.id
    where b.org_id = p_org_id and b.created_at >= m.s and b.created_at < m.e
  ), cash as (
    select coalesce(c.branch_code, '(none)') as branch, count(distinct c.id) as days,
           round(coalesce(sum(l.expected_amount), 0), 2) as expected, round(coalesce(sum(l.counted_amount), 0), 2) as counted,
           round(coalesce(sum(l.variance), 0), 2) as variance
    from public.fin_cashups c cross join m
    left join public.fin_cashup_lines l on l.cashup_id = c.id
    where c.org_id = p_org_id and c.status = 'submitted' and c.business_date >= m.s and c.business_date < m.e group by 1
  )
  select jsonb_build_object(
    'by_branch', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.branch) from by_branch x), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.mode) from collections x), '[]'::jsonb),
    'adjustments', (select row_to_json(x)::jsonb from adjustments x),
    'ageing', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.bucket) from ageing x), '[]'::jsonb),
    'denials', (select row_to_json(x)::jsonb from denials x),
    'remittance', (select row_to_json(x)::jsonb from remit x),
    'cashups', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.branch) from cash x), '[]'::jsonb),
    'open_exceptions', (select count(*) from public.ops_exceptions e where e.org_id = p_org_id and e.status in ('open', 'in_progress')),
    'freshness', jsonb_build_object(
      'last_capture_at', (select max(b.processed_at) from public.fin_raw_unite_batches b where b.org_id = p_org_id and b.process_status = 'processed'),
      'last_import_at', (select max(f.committed_at) from public.fin_raw_diligence_files f where f.org_id = p_org_id and f.status = 'committed'))
  );
$$;
revoke all on function public.fin_close_month_figures(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_close_month_figures(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Build / store the snapshot, sign for finance, sign for the CEO (locks), withdraw. Service role only; the server has
-- run can('finance.close.*') first. The database enforces the order, the hash binding and "not the same person".
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_store_snapshot(p_org_id uuid, p_month date, p_user_id uuid, p_snapshot jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_close public.fin_period_closes;
begin
  if v_month >= date_trunc('month', current_date)::date then
    raise exception 'a month can only be closed after it has ended' using errcode = 'check_violation';
  end if;
  insert into public.fin_period_closes (org_id, month) values (p_org_id, v_month) on conflict (org_id, month) do nothing;
  select * into v_close from public.fin_period_closes where org_id = p_org_id and month = v_month for update;
  if v_close.status in ('finance_signed', 'locked') then
    raise exception 'this month is % and cannot be rebuilt', v_close.status using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'built', snapshot = p_snapshot,
         snapshot_hash = encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex'),
         built_at = now(), built_by = p_user_id
   where id = v_close.id;
  return v_close.id;
end;
$$;
revoke all on function public.fin_close_store_snapshot(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fin_close_store_snapshot(uuid, date, uuid, jsonb) to service_role;

create or replace function public.fin_close_sign_finance(p_org_id uuid, p_close_id uuid, p_user_id uuid, p_hash text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'built' then
    raise exception 'the month is % and cannot be signed for finance', v_close.status using errcode = 'check_violation';
  end if;
  if p_hash is distinct from v_close.snapshot_hash then
    raise exception 'the pack changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'finance_signed', finance_signed_by = p_user_id, finance_signed_at = now(),
         finance_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.fin_close_sign_ceo(p_org_id uuid, p_close_id uuid, p_user_id uuid, p_hash text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'finance_signed' then
    raise exception 'the month is % and cannot be signed for the CEO', v_close.status using errcode = 'check_violation';
  end if;
  if v_close.finance_signed_by = p_user_id then
    raise exception 'the finance and CEO sign-offs must be two different people' using errcode = 'check_violation';
  end if;
  if p_hash is distinct from v_close.snapshot_hash then
    raise exception 'the pack changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'locked', ceo_signed_by = p_user_id, ceo_signed_at = now(), locked_at = now(),
         ceo_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_sign_ceo(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_sign_ceo(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.fin_close_withdraw(p_org_id uuid, p_close_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'finance_signed' then
    raise exception 'only a month waiting for the CEO can have its finance sign-off withdrawn' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'built', finance_signed_by = null, finance_signed_at = null, finance_note = null
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_withdraw(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_close_withdraw(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cash-up: refresh the expected amounts of a draft, and submit (freeze) it
-- ---------------------------------------------------------------------------
create or replace function public.fin_cashup_refresh(p_org_id uuid, p_cashup_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cashup public.fin_cashups;
  v_row jsonb;
begin
  select * into v_cashup from public.fin_cashups where id = p_cashup_id and org_id = p_org_id for update;
  if not found then raise exception 'cash-up not found' using errcode = 'no_data_found'; end if;
  if v_cashup.status <> 'draft' then
    raise exception 'a submitted cash-up is frozen' using errcode = 'check_violation';
  end if;
  -- modes the system knows about get a line (expected updated); lines the cashier added for another mode keep expected 0
  for v_row in select * from jsonb_array_elements(public.fin_cashup_expected(p_org_id, v_cashup.branch_code, v_cashup.business_date)) loop
    insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount)
    values (p_org_id, p_cashup_id, v_row ->> 'mode', (v_row ->> 'expected')::numeric)
    on conflict (cashup_id, payment_mode) do update set expected_amount = excluded.expected_amount;
  end loop;
  update public.fin_cashup_lines l set expected_amount = 0
   where l.cashup_id = p_cashup_id
     and not exists (select 1 from jsonb_array_elements(public.fin_cashup_expected(p_org_id, v_cashup.branch_code, v_cashup.business_date)) e
                     where e ->> 'mode' = l.payment_mode)
     and l.expected_amount <> 0;
end;
$$;
revoke all on function public.fin_cashup_refresh(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_cashup_refresh(uuid, uuid) to service_role;

create or replace function public.fin_cashup_submit(p_org_id uuid, p_cashup_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cashup public.fin_cashups;
  v_tolerance numeric;
  v_bad integer;
begin
  perform public.fin_cashup_refresh(p_org_id, p_cashup_id);
  select * into v_cashup from public.fin_cashups where id = p_cashup_id and org_id = p_org_id for update;
  select s.cashup_variance_tolerance into v_tolerance from public.fin_ref_finance_settings s where s.org_id = p_org_id;
  if exists (select 1 from public.fin_cashup_lines l where l.cashup_id = p_cashup_id and l.counted_amount is null) then
    raise exception 'count every payment mode before submitting (enter 0 where nothing was taken)' using errcode = 'check_violation';
  end if;
  select count(*) into v_bad from public.fin_cashup_lines l
   where l.cashup_id = p_cashup_id and abs(l.variance) > coalesce(v_tolerance, 0) and btrim(coalesce(l.reason, '')) = '';
  if v_bad > 0 then
    raise exception 'give a reason for every difference above the tolerance' using errcode = 'check_violation';
  end if;
  update public.fin_cashups set status = 'submitted', submitted_by = p_user_id, submitted_at = now() where id = v_cashup.id;
end;
$$;
revoke all on function public.fin_cashup_submit(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_cashup_submit(uuid, uuid, uuid) to service_role;

select app.enable_record_history('fin_period_closes', 'snapshot,snapshot_hash');
