-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 98_tally_company_per_entity.sql. It redefines fin_close_controls,
-- fin_close_sign_finance and app.fin_period_close_guard: run it AFTER any other file of its batch that redefines them.

-- Insurance receivable control (docs/48, asked for by Saeed; docs/47 W3 item (e) and follow-up 4).
--
-- Each month-end close pack now holds the Diligence insurance receivable at the month end (claimed minus remitted minus
-- approved write-offs, per payer) beside TALLY's insurer receivable at the same month end as Pulse mirrors it, the
-- difference, the tolerance and a status: agrees / differs / no_tally_data / no_diligence_data. It is part of the control
-- summary (fin_close_controls -> 'ins_receivable'), so it is frozen in the snapshot and bound into its sha256.
--
-- Owner decision (19 Oct 2026): Al Das stays on Tally. Tally is the book of record and Pulse's own ledger is on hold
-- (acc_entities.ledger_start_date is not set). The Tally side is read from the Tally MIRROR in acc_journals: journals
-- the 22I import or the 22J connector pulled (source 'tally_import', the Tally 'opening'), and their reversals when a
-- later Tally version replaced them. It is only as fresh as the last Tally pull; the block carries when that was.
--
-- A month that DIFFERS needs a written explanation before the finance sign-off: the preparer (finance.close.manage)
-- writes it, the person who signs for Finance reviews it as part of the existing sign-off and must be someone else, the
-- CEO signs as today. Enforced here (fin_close_sign_finance, which fin_close_sign_signed calls), not only in the UI.
--
--   * fin_ref_finance_settings.ins_receivable_tolerance: "agrees" = within this many dirhams (data, default 1.00).
--   * fin_period_closes.ins_control_note / _hash / _by / _at: the explanation, bound to the snapshot hash it explains.
--     Changeable only while the pack waits for the finance sign-off; frozen with the month by the lock guard.
--   * app.fin_ins_receivable_compare: the comparison rule (pure; twin of lib/finance/insurance-receivable-control.ts,
--     parity-tested with tests/unit/finance/fixtures/ins-receivable-control.synthetic.json).
--   * app.fin_ins_receivable_block: the figures for one org and month end (sums per payer id only; no patient data).
--   * The insurer receivable ledger(s) are read from data: the active receivable posting rules for 'insurance'
--     (acc_posting_rules; 22J maps them to ledgers imported from Tally; seeded as 1200 Insurance receivable), never a
--     code written here. A ledger that only one payer's rule points at is that payer's (Tally keeps a ledger per insurer
--     under Sundry Debtors); any other mapped ledger has no payer, which makes the comparison a total one.
--   * app.fin_period_close_guard is redefined from 20261016000600 (its only definition): unchanged except that a deleted
--     explainer's id may be nulled on a locked row, like the other people columns.
--   * fin_close_controls is redefined from its last definition (20261107000100) with every earlier block kept.
--   * fin_close_sign_finance is redefined from 20261016000600 (its only definition) with the explanation check added.

-- 1. Tolerance ----------------------------------------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column ins_receivable_tolerance numeric(12, 2) not null default 1.00
    check (ins_receivable_tolerance >= 0 and ins_receivable_tolerance <= 100000);

-- 2. The explanation on the close ---------------------------------------------------------------------------------------
alter table public.fin_period_closes
  add column ins_control_note text check (ins_control_note is null or char_length(ins_control_note) between 10 and 1000),
  add column ins_control_note_hash text check (ins_control_note_hash is null or ins_control_note_hash ~ '^[0-9a-f]{64}$'),
  add column ins_control_note_by uuid references public.profiles (id) on delete set null,
  add column ins_control_note_at timestamptz,
  add constraint fin_period_closes_ins_note_complete check (
    (ins_control_note is null) = (ins_control_note_hash is null) and (ins_control_note is null) = (ins_control_note_at is null));

-- 3. The comparison rule (pure). Inputs: the tolerance, the Tally state and two arrays of {payer_id, amount}.
--    Twin of compareInsuranceReceivable() in lib/finance/insurance-receivable-control.ts; change both together.
create or replace function app.fin_ins_receivable_compare(
  p_tolerance numeric, p_tally_state text, p_diligence jsonb, p_tally jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tol bigint := case when p_tolerance is not null and p_tolerance >= 0 then round(p_tolerance * 100)::bigint else 0 end;
  v_dil jsonb := case when p_diligence is null or jsonb_typeof(p_diligence) = 'null' then null else p_diligence end;
  v_tal jsonb := case when p_tally is null or jsonb_typeof(p_tally) = 'null' then '[]'::jsonb else p_tally end;
  v_unreadable jsonb := jsonb_build_object(
    'status', 'differs', 'basis', 'none', 'diligence_total', null, 'tally_total', null, 'difference', null,
    'unassigned_diligence', null, 'unassigned_tally', null, 'payers', '[]'::jsonb);
  v_d_total bigint;
  v_t_total bigint;
  v_d_un bigint;
  v_t_un bigint;
  v_named integer;
  v_per_payer boolean;
  v_payers jsonb;
  v_all_payers_agree boolean;
begin
  if p_tally_state is null or p_tally_state not in ('mirrored', 'no_account', 'no_data') then
    return v_unreadable;
  end if;
  if v_dil is not null and (jsonb_typeof(v_dil) <> 'array' or exists (
       select 1 from jsonb_array_elements(v_dil) e
       where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'amount') is distinct from 'number')) then
    return v_unreadable;
  end if;
  if v_dil is not null then
    select coalesce(sum(round((e ->> 'amount')::numeric * 100)), 0)::bigint into v_d_total from jsonb_array_elements(v_dil) e;
  end if;

  if p_tally_state <> 'mirrored' then
    return jsonb_build_object(
      'status', 'no_tally_data', 'basis', 'none',
      'diligence_total', case when v_dil is null then null else v_d_total::numeric / 100 end,
      'tally_total', null, 'difference', null, 'unassigned_diligence', null, 'unassigned_tally', null,
      'payers', '[]'::jsonb);
  end if;

  if jsonb_typeof(v_tal) <> 'array' or exists (
       select 1 from jsonb_array_elements(v_tal) e
       where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'amount') is distinct from 'number') then
    return v_unreadable;
  end if;
  select coalesce(sum(round((e ->> 'amount')::numeric * 100)), 0)::bigint into v_t_total from jsonb_array_elements(v_tal) e;

  if v_dil is null then
    return jsonb_build_object(
      'status', 'no_diligence_data', 'basis', 'none', 'diligence_total', null,
      'tally_total', v_t_total::numeric / 100, 'difference', null, 'unassigned_diligence', null,
      'unassigned_tally', null, 'payers', '[]'::jsonb);
  end if;

  with d as (
    select nullif(btrim(e ->> 'payer_id'), '') as k, round((e ->> 'amount')::numeric * 100)::bigint as c
    from jsonb_array_elements(v_dil) e
  ), t as (
    select nullif(btrim(e ->> 'payer_id'), '') as k, round((e ->> 'amount')::numeric * 100)::bigint as c
    from jsonb_array_elements(v_tal) e
  )
  select coalesce((select sum(c) from d where k is null), 0)::bigint,
         coalesce((select sum(c) from t where k is null), 0)::bigint,
         (select count(*) from (select k from d where k is not null union select k from t where k is not null) n)::integer
    into v_d_un, v_t_un, v_named;
  v_per_payer := v_d_un = 0 and v_t_un = 0 and v_named > 0;

  if v_per_payer then
    with d as (
      select nullif(btrim(e ->> 'payer_id'), '') as k, sum(round((e ->> 'amount')::numeric * 100))::bigint as c
      from jsonb_array_elements(v_dil) e group by 1
    ), t as (
      select nullif(btrim(e ->> 'payer_id'), '') as k, sum(round((e ->> 'amount')::numeric * 100))::bigint as c
      from jsonb_array_elements(v_tal) e group by 1
    ), p as (
      select coalesce(d.k, t.k) as k, coalesce(d.c, 0) as dc, coalesce(t.c, 0) as tc
      from d full join t on t.k = d.k
    )
    select jsonb_agg(jsonb_build_object(
             'payer_id', p.k, 'diligence', p.dc::numeric / 100, 'tally', p.tc::numeric / 100,
             'difference', (p.tc - p.dc)::numeric / 100, 'agrees', abs(p.tc - p.dc) <= v_tol)
           order by p.k collate "C"),
           bool_and(abs(p.tc - p.dc) <= v_tol)
      into v_payers, v_all_payers_agree
    from p;
  else
    v_payers := '[]'::jsonb;
    v_all_payers_agree := true;
  end if;

  return jsonb_build_object(
    'status', case when abs(v_t_total - v_d_total) <= v_tol and v_all_payers_agree then 'agrees' else 'differs' end,
    'basis', case when v_per_payer then 'per_payer' else 'total' end,
    'diligence_total', v_d_total::numeric / 100,
    'tally_total', v_t_total::numeric / 100,
    'difference', (v_t_total - v_d_total)::numeric / 100,
    'unassigned_diligence', v_d_un::numeric / 100,
    'unassigned_tally', v_t_un::numeric / 100,
    'payers', v_payers);
end;
$$;
revoke all on function app.fin_ins_receivable_compare(numeric, text, jsonb, jsonb) from public, anon, authenticated;

-- The status a stored snapshot's control would have, recomputed from its own inputs (never from its stored result).
-- Null when the snapshot holds no insurance receivable control (packs built before it); 'differs' when unreadable.
create or replace function app.fin_close_ins_status(p_snapshot jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_b jsonb := p_snapshot -> 'controls' -> 'ins_receivable';
begin
  if v_b is null or jsonb_typeof(v_b) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_b) <> 'object' then
    return 'differs';
  end if;
  return app.fin_ins_receivable_compare(
    case when jsonb_typeof(v_b -> 'tolerance') = 'number' then (v_b ->> 'tolerance')::numeric else 0 end,
    v_b ->> 'tally_state', v_b -> 'diligence', v_b -> 'tally') ->> 'status';
end;
$$;
revoke all on function app.fin_close_ins_status(jsonb) from public, anon, authenticated;

-- 4. The figures for one org at one month end. Sums and counts per payer id only (no patient data).
--    Diligence: claims dated on or before the month end; outstanding = net - remitted - approved write-off (not below 0),
--    the close pack's definition, except that a claim whose FIRST remittance is dated after the month end has its
--    remitted amount added back (it was still owed at the month end). Diligence keeps one remitted total per claim, so a
--    claim remitted both before and after the month end has all of it deducted; those are counted ('remitted_straddling').
--    Write-offs carry no date in Diligence: an approved one counts whenever it was approved.
--    Tally: debit minus credit on the insurer receivable ledger(s), over the Tally mirror only (journals with source
--    'tally_import' or 'opening', and the reversals of those), posted or reversed, dated on or before the month end, all
--    entities (one Tally company each, W7).
create or replace function app.fin_ins_receivable_block(p_org_id uuid, p_month_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tol numeric;
  v_key text;
  v_map jsonb;          -- [{account_id, payer_id}] for the mapped ledgers
  v_state text;
  v_dil jsonb;
  v_tal jsonb;
  v_lines integer;
  v_after jsonb;
  v_straddling integer;
  v_names jsonb;
  v_acc jsonb;
  v_last_at timestamptz;
  v_last_date date;
begin
  select coalesce((select f.ins_receivable_tolerance from public.fin_ref_finance_settings f where f.org_id = p_org_id), 1.00)
    into v_tol;

  -- The insurer receivable ledger(s): what the posting engine would use for insurance (the 'insurance' rules, else the
  -- catch-all receivable rule, as findRule in lib/accounting/posting/rules.ts falls back).
  v_key := case
    when exists (select 1 from public.acc_posting_rules r where r.org_id = p_org_id and r.kind = 'receivable'
                   and r.key = 'insurance' and r.active and r.account_id is not null) then 'insurance'
    when exists (select 1 from public.acc_posting_rules r where r.org_id = p_org_id and r.kind = 'receivable'
                   and r.key = '*' and r.active and r.account_id is not null) then '*' end;

  -- a ledger is one payer's only when every rule pointing at it names that same payer
  select jsonb_agg(jsonb_build_object('account_id', m.account_id, 'payer_id', m.payer_id)) into v_map
  from (
    select r.account_id,
           case when count(distinct r.qualifier) = 1 and min(r.qualifier) <> '*' then min(r.qualifier) end as payer_id
    from public.acc_posting_rules r
    where v_key is not null and r.org_id = p_org_id and r.kind = 'receivable' and r.key = v_key and r.active
      and r.account_id is not null
    group by r.account_id
  ) m;

  select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', coalesce(a.tally_name, a.name),
                                               'payer_id', m ->> 'payer_id') order by a.code), '[]'::jsonb)
    into v_acc
  from jsonb_array_elements(coalesce(v_map, '[]'::jsonb)) m
  join public.acc_accounts a on a.id = (m ->> 'account_id')::uuid and a.org_id = p_org_id;

  -- Freshness of the mirror (any ledger): when Pulse last posted a Tally voucher, and the latest voucher date.
  select max(j.posted_at), max(j.journal_date) into v_last_at, v_last_date
  from public.acc_journals j
  where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.source_kind in ('tally_import', 'opening');

  with acc as (
    select (m ->> 'account_id')::uuid as account_id, m ->> 'payer_id' as payer_id
    from jsonb_array_elements(coalesce(v_map, '[]'::jsonb)) m
  ), tl as (
    select acc.payer_id, l.debit - l.credit as amount
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join acc on acc.account_id = l.account_id
    left join public.acc_journals o on o.id = j.reversal_of
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_month_end
      and (j.source_kind in ('tally_import', 'opening')
           or (j.source_kind = 'reversal' and o.source_kind in ('tally_import', 'opening')))
  )
  select (select count(*) from tl)::integer,
         (select coalesce(jsonb_agg(jsonb_build_object('payer_id', g.payer_id, 'amount', g.amount)
                                    order by g.payer_id collate "C" nulls first), '[]'::jsonb)
          from (select tl.payer_id, round(sum(tl.amount), 2) as amount from tl group by tl.payer_id) g)
    into v_lines, v_tal;

  v_state := case
    when v_map is null then 'no_account'
    when v_lines = 0 then 'no_data'
    else 'mirrored' end;
  if v_state <> 'mirrored' then
    v_tal := null;
  end if;

  with cl as (
    select nullif(btrim(c.payer_id), '') as payer_id,
           greatest(coalesce(c.net, 0)
                    - case when c.first_remittance_date > p_month_end then 0 else coalesce(c.remitted, 0) end
                    - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end,
                    0) as amount,
           coalesce(c.first_remittance_date > p_month_end and coalesce(c.remitted, 0) <> 0, false) as added_back,
           case when c.first_remittance_date > p_month_end then coalesce(c.remitted, 0) else 0 end as added_amount,
           coalesce(c.first_remittance_date <= p_month_end and c.last_remittance_date > p_month_end, false) as straddling
    from public.ins_claim_activities c
    where c.org_id = p_org_id and c.transaction_date <= p_month_end
  )
  select (select jsonb_agg(jsonb_build_object('payer_id', g.payer_id, 'amount', g.amount, 'claims', g.claims)
                           order by g.payer_id collate "C" nulls first)
          from (select cl.payer_id, round(sum(cl.amount), 2) as amount, count(*) filter (where cl.amount > 0) as claims
                from cl group by cl.payer_id) g),
         (select jsonb_build_object('claims', count(*) filter (where cl.added_back),
                                    'amount', round(coalesce(sum(cl.added_amount), 0), 2)) from cl),
         (select count(*) filter (where cl.straddling) from cl)::integer
    into v_dil, v_after, v_straddling;

  select coalesce(jsonb_object_agg(p.payer_id, p.payer_name), '{}'::jsonb) into v_names
  from public.fin_ref_payers p
  where p.org_id = p_org_id and nullif(btrim(coalesce(p.payer_name, '')), '') is not null
    and (p.payer_id in (select e ->> 'payer_id' from jsonb_array_elements(coalesce(v_dil, '[]'::jsonb)) e)
         or p.payer_id in (select e ->> 'payer_id' from jsonb_array_elements(coalesce(v_tal, '[]'::jsonb)) e));

  return jsonb_build_object(
    'version', 1,
    'month_end', p_month_end,
    'tolerance', v_tol,
    'tally_state', v_state,
    'accounts', v_acc,
    'diligence', v_dil,
    'tally', v_tal,
    'tally_last_mirrored_at', v_last_at,
    'tally_last_voucher_date', v_last_date,
    'remitted_after', v_after,
    'remitted_straddling', v_straddling,
    'payer_names', v_names,
    'result', app.fin_ins_receivable_compare(v_tol, v_state, v_dil, v_tal));
end;
$$;
revoke all on function app.fin_ins_receivable_block(uuid, date) from public, anon, authenticated;

-- 5. The lock guard (from 20261016000600): a locked row may also have a deleted explainer's id nulled.
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
      if (to_jsonb(new) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'ins_control_note_by' - 'updated_at')
         is not distinct from (to_jsonb(old) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'ins_control_note_by' - 'updated_at')
         and (new.built_by is null or new.built_by = old.built_by)
         and (new.finance_signed_by is null or new.finance_signed_by = old.finance_signed_by)
         and (new.ceo_signed_by is null or new.ceo_signed_by = old.ceo_signed_by)
         and (new.ins_control_note_by is null or new.ins_control_note_by = old.ins_control_note_by) then
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

-- The explanation changes only while the pack waits for the finance sign-off (built -> built), for every role. A deleted
-- explainer's id may be nulled at any time (the FK action).
create or replace function app.fin_period_close_ins_note_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.ins_control_note, new.ins_control_note_hash, new.ins_control_note_at)
       is not distinct from (old.ins_control_note, old.ins_control_note_hash, old.ins_control_note_at)
     and (new.ins_control_note_by is null or new.ins_control_note_by is not distinct from old.ins_control_note_by) then
    return new;
  end if;
  if not (old.status = 'built' and new.status = 'built') then
    raise exception 'The insurance receivable explanation can change only while the pack waits for the finance sign-off.'
      using errcode = 'check_violation', hint = 'ins_receivable_note_frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_period_close_ins_note_guard() from public, anon, authenticated;
create trigger fin_period_closes_ins_note_guard before update on public.fin_period_closes
  for each row execute function app.fin_period_close_ins_note_guard();

-- 6. The preparer explains a month that differs (service role, after can('finance.close.manage')).
create or replace function public.fin_close_explain_ins_receivable(
  p_org_id uuid, p_close_id uuid, p_user_id uuid, p_hash text, p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'built' then
    raise exception 'The explanation can be written only while the pack waits for the finance sign-off.'
      using errcode = 'check_violation', hint = 'ins_receivable_note_frozen';
  end if;
  if p_hash is distinct from v_close.snapshot_hash then
    raise exception 'the pack changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  if app.fin_close_ins_status(v_close.snapshot) is distinct from 'differs' then
    raise exception 'The insurance receivable does not differ in this pack; there is nothing to explain.'
      using errcode = 'check_violation', hint = 'ins_receivable_nothing_to_explain';
  end if;
  if v_note is null or char_length(v_note) < 10 or char_length(v_note) > 1000 then
    raise exception 'Write the explanation in 10 to 1000 characters.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  update public.fin_period_closes
     set ins_control_note = v_note, ins_control_note_hash = v_close.snapshot_hash,
         ins_control_note_by = p_user_id, ins_control_note_at = now()
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_explain_ins_receivable(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_explain_ins_receivable(uuid, uuid, uuid, text, text) to service_role;

-- 7. Finance sign-off (from 20261016000600): a month whose insurance receivable differs needs the preparer's explanation
--    of THIS pack, and the person signing for Finance cannot be the one who wrote it.
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
  if app.fin_close_ins_status(v_close.snapshot) = 'differs' then
    if v_close.ins_control_note is null or v_close.ins_control_note_hash is distinct from v_close.snapshot_hash then
      raise exception 'The insurance receivable differs from Tally: the preparer must explain it before Finance signs.'
        using errcode = 'check_violation', hint = 'ins_receivable_unexplained';
    end if;
    if v_close.ins_control_note_by = p_user_id then
      raise exception 'You wrote the insurance receivable explanation, so a different person must sign for Finance.'
        using errcode = 'check_violation', hint = 'ins_receivable_same_person';
    end if;
  end if;
  update public.fin_period_closes
     set status = 'finance_signed', finance_signed_by = p_user_id, finance_signed_at = now(),
         finance_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) to service_role;

-- 8. The control summary (from 20261107000100, every block kept) with the insurance receivable control added.
create or replace function public.fin_close_controls(p_org_id uuid, p_month date, p_today date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date - 1;
  v_tz text;
  v_today date;
  s record;
  v_wd date[];          -- the close month's working days, counted in the month after it (v_wd[5] = WD5)
  v_start date;
  v_min numeric;
  v_bank jsonb;
  v_payables jsonb;
  v_revshare jsonb;
  v_changes jsonb;
  v_receivables jsonb;
  v_timetable jsonb;
  v_exceptions jsonb;
  v_ins jsonb;          -- docs/48: the insurance receivable control (Diligence beside Tally at the month end)
begin
  select coalesce(o.timezone, 'Asia/Dubai') into v_tz from public.orgs o where o.id = p_org_id;
  if v_tz is null then
    raise exception 'organisation not found' using errcode = 'no_data_found';
  end if;
  v_today := coalesce(p_today, (now() at time zone v_tz)::date);

  select coalesce(f.close_item_max_age_days, 60) as item_max_age_days,
         coalesce(f.close_voucher_unpaid_days, 14) as voucher_unpaid_days,
         coalesce(f.close_receivables_over90_pct, 25) as receivables_over90_pct,
         coalesce(f.close_inputs_wd, 5) as inputs_wd,
         coalesce(f.close_revshare_wd, 7) as revshare_wd,
         coalesce(f.close_weekend_days, '{6,7}'::smallint[])::integer[] as weekend,
         f.change_review_start_date as change_start,
         coalesce(f.change_review_min_amount, 0) as change_min
    into s
    from (select 1) one
    left join public.fin_ref_finance_settings f on f.org_id = p_org_id;

  -- Working days as lib/finance/close-timetable.ts counts them: not a weekend day (ISO), not a holiday; at most 23.
  select array_agg(w.d order by w.d) into v_wd
  from (
    select (v_end + 1 + g)::date as d
    from generate_series(0, 399) g
    where extract(isodow from (v_end + 1 + g))::integer <> all (s.weekend)
      and not exists (select 1 from public.fin_ref_holidays h where h.org_id = p_org_id and h.holiday_on = v_end + 1 + g)
    order by g
    limit 23
  ) w;

  -- Bank: every active account (and any account with a reconciliation for the month).
  select jsonb_build_object('accounts', jsonb_agg(x.j order by x.name, x.id))
    into v_bank
  from (
    select a.name, a.id, jsonb_build_object(
      'account_id', a.id,
      'name', a.name,
      'last4', a.last4,
      'status', coalesce(r.status, 'none'),
      'period_end', r.period_end,
      -- expected receipts are worked out by the reconciliation screen; they are known here once it is reviewed
      'expected_unmatched', case when r.figures is not null then (
          select jsonb_build_object('count', coalesce(sum((b.value ->> 'count')::integer), 0),
                                    'amount', round(coalesce(sum((b.value ->> 'amount')::numeric), 0), 2))
          from jsonb_each(case when jsonb_typeof(r.figures -> 'summary' -> 'unmatched') = 'object'
                               then r.figures -> 'summary' -> 'unmatched' else '{}'::jsonb end) b) end,
      'bank_unexplained', (
          select jsonb_build_object('count', count(*), 'amount', round(coalesce(sum(l.amount), 0), 2),
                                    'oldest_days', max(v_today - l.value_date),
                                    'over_limit', count(*) filter (where v_today - l.value_date > s.item_max_age_days))
          from public.fin_bank_lines l
          where l.org_id = p_org_id and l.account_id = a.id and l.amount > 0 and l.match_status = 'unmatched'
            and l.value_date <= v_end
            and not exists (select 1 from public.fin_bank_rec_notes n
                            join public.fin_bank_recs r2 on r2.id = n.rec_id
                            where r2.org_id = p_org_id and r2.account_id = a.id and n.item_key = 'bank|' || l.id::text))
    ) as j
    from public.fin_bank_accounts a
    left join public.fin_bank_recs r on r.org_id = p_org_id and r.account_id = a.id and r.month = v_month
    where a.org_id = p_org_id and (a.active or r.id is not null)
  ) x
  having count(*) > 0;

  -- Payables: supplier invoices unpaid at the month end, by age at the month end; the voucher queue at the build date.
  if exists (select 1 from public.fin_supplier_invoices i where i.org_id = p_org_id)
     or exists (select 1 from public.fin_payment_vouchers v where v.org_id = p_org_id) then
    with paid as (
      select i.id, i.total, i.invoice_date,
             coalesce((select sum(coalesce(vi.paid_amount, i.total)) from public.fin_voucher_invoices vi
                       join public.fin_payment_vouchers v on v.id = vi.voucher_id
                       where vi.supplier_invoice_id = i.id and v.status = 'paid' and v.payment_date <= v_end), 0) as paid
      from public.fin_supplier_invoices i
      where i.org_id = p_org_id and i.status <> 'void' and i.invoice_date <= v_end
    ), inv as (
      -- 20D review: the balance; an invoice paid within the tolerance counts as paid
      select p.total - p.paid as total, v_end - p.invoice_date as age
      from paid p
      where p.total - p.paid > case when p.paid > 0
                                    then coalesce((select f.voucher_mismatch_tolerance from public.fin_ref_finance_settings f
                                                   where f.org_id = p_org_id), 1.00)
                                    else 0 end
    ), appr as (
      select v.amount, v_today - (v.approved_at at time zone v_tz)::date as days
      from public.fin_payment_vouchers v
      where v.org_id = p_org_id and v.status = 'approved'
    )
    select jsonb_build_object(
      'invoices_unpaid', (select jsonb_build_object('count', count(*), 'amount', round(coalesce(sum(inv.total), 0), 2)) from inv),
      'by_age', (
        select jsonb_agg(jsonb_build_object(
                 'bucket', b.label,
                 'count', (select count(*) from inv where inv.age between b.lo and b.hi),
                 'amount', (select round(coalesce(sum(inv.total), 0), 2) from inv where inv.age between b.lo and b.hi))
               order by b.lo)
        from (values ('0-30', 0, 30), ('31-60', 31, 60), ('61-90', 61, 90), ('90+', 91, 2147483647)) b (label, lo, hi)),
      'vouchers_approved_unpaid', (
        select jsonb_build_object(
                 'count', count(*), 'amount', round(coalesce(sum(appr.amount), 0), 2), 'oldest_days', max(appr.days),
                 'over_limit', jsonb_build_object(
                   'count', count(*) filter (where appr.days is null or appr.days > s.voucher_unpaid_days),
                   'amount', round(coalesce(sum(appr.amount) filter (where appr.days is null or appr.days > s.voucher_unpaid_days), 0), 2)))
        from appr),
      'vouchers_waiting', (
        select jsonb_object_agg(st.status, jsonb_build_object(
                 'count', (select count(*) from public.fin_payment_vouchers v where v.org_id = p_org_id and v.status = st.status),
                 'amount', (select round(coalesce(sum(v.amount), 0), 2) from public.fin_payment_vouchers v
                            where v.org_id = p_org_id and v.status = st.status)))
        from (values ('submitted'), ('checked'), ('dept_approved'), ('for_tally')) st (status)))
    into v_payables;
  end if;

  -- Revenue share: the month's run and the liability (approved or posted, not paid) up to this month.
  if exists (select 1 from public.fin_revshare_schemes x where x.org_id = p_org_id)
     or exists (select 1 from public.fin_revshare_runs x where x.org_id = p_org_id) then
    select jsonb_build_object(
      'run_status', coalesce((select r.status from public.fin_revshare_runs r where r.org_id = p_org_id and r.month = v_month), 'none'),
      'approved_on', (select (r.approved_at at time zone v_tz)::date from public.fin_revshare_runs r
                      where r.org_id = p_org_id and r.month = v_month),
      'due_on', v_wd[s.revshare_wd],
      'liability', (
        select jsonb_build_object('total', round(coalesce(sum((x.value ->> 'unpaid')::numeric), 0), 2),
                                  'runs', coalesce(jsonb_agg(x.value order by x.value ->> 'month'), '[]'::jsonb))
        from jsonb_array_elements(public.fin_revshare_liability(p_org_id) -> 'runs') x
        where (x.value ->> 'month')::date <= v_month))
    into v_revshare;
  end if;

  -- Invoice changes (20J): unapproved changes dated in the month, counted from the start date; "not measured" without it.
  v_start := s.change_start;
  v_min := s.change_min;
  if v_start is null or v_start > v_end then
    v_changes := jsonb_build_object('measured', false);
  else
    select jsonb_build_object(
      'measured', true,
      'from', greatest(v_month, v_start),
      'unapproved', jsonb_build_object('count', count(*), 'amount', round(coalesce(sum(u.amount), 0), 2)))
      into v_changes
    from (
      select (e.value ->> 'amount')::numeric as amount
      from jsonb_array_elements(public.fin_invoice_changes(p_org_id, v_month, v_end) -> 'events') e
      where (e.value ->> 'change_date')::date >= v_start
        and (e.value ->> 'amount')::numeric >= v_min
        and coalesce(e.value -> 'review' ->> 'decision', '') not in ('approved', 'explained')
    ) u;
  end if;

  -- Insurance receivables (20I's open-claim definition), aged at the build date.
  if exists (select 1 from public.ins_claim_activities c where c.org_id = p_org_id) then
    select jsonb_build_object(
      'open_claims', count(*),
      'outstanding', round(coalesce(sum(c.outstanding), 0), 2),
      'over_90', jsonb_build_object('count', count(*) filter (where c.age_days > 90),
                                    'amount', round(coalesce(sum(c.outstanding) filter (where c.age_days > 90), 0), 2)),
      'over_90_pct', case when coalesce(sum(c.outstanding), 0) > 0
                          then round(100 * coalesce(sum(c.outstanding) filter (where c.age_days > 90), 0) / sum(c.outstanding), 1) end)
      into v_receivables
    from public.fin_followup_open_claims(p_org_id, v_today) c;
  end if;

  -- Close timetable (20G): the month's steps; inputs due by the inputs working day judged as on the timetable page.
  select jsonb_build_object(
    'tasks', count(*),
    'done', count(*) filter (where t.is_done),
    'blocked', count(*) filter (where t.status = 'blocked'),
    'inputs_wd', s.inputs_wd,
    'inputs_due_on', v_wd[s.inputs_wd],
    'inputs', jsonb_build_object(
      'total', count(*) filter (where t.due_wd <= s.inputs_wd),
      'on_time', count(*) filter (where t.due_wd <= s.inputs_wd and t.due_on is not null and t.is_done and t.done_on <= t.due_on),
      'late', count(*) filter (where t.due_wd <= s.inputs_wd and (t.due_on is null
                                  or (t.is_done and t.done_on > t.due_on) or (not t.is_done and v_today > t.due_on))),
      'pending', count(*) filter (where t.due_wd <= s.inputs_wd and t.due_on is not null and not t.is_done and v_today <= t.due_on)))
    into v_timetable
  from (
    select k.status, k.due_wd, v_wd[k.due_wd] as due_on, (k.done_at at time zone v_tz)::date as done_on,
           (k.status = 'done' and k.done_at is not null) as is_done
    from public.fin_close_tasks k
    where k.org_id = p_org_id and k.month = v_month
  ) t
  having count(*) > 0;

  -- Open finance exceptions at the build date (the same count as the pack's open_exceptions).
  select jsonb_build_object(
    'open', count(*),
    'oldest_days', max(v_today - (e.opened_at at time zone v_tz)::date),
    'over_limit', count(*) filter (where v_today - (e.opened_at at time zone v_tz)::date > s.item_max_age_days))
    into v_exceptions
  from public.ops_exceptions e
  where e.org_id = p_org_id and e.status in ('open', 'in_progress');

  -- Insurance receivable control (docs/48): Diligence at the month end beside the Tally mirror at the month end.
  v_ins := app.fin_ins_receivable_block(p_org_id, v_end);

  return jsonb_build_object(
    'version', 1,
    'month', v_month,
    'month_end', v_end,
    'as_of', v_today,
    'settings', jsonb_build_object(
      'item_max_age_days', s.item_max_age_days,
      'voucher_unpaid_days', s.voucher_unpaid_days,
      'receivables_over90_pct', s.receivables_over90_pct,
      'inputs_wd', s.inputs_wd,
      'revshare_wd', s.revshare_wd),
    'bank', v_bank,
    'payables', v_payables,
    'revenue_share', v_revshare,
    'invoice_changes', v_changes,
    'receivables', v_receivables,
    'timetable', v_timetable,
    'exceptions', v_exceptions,
    'ins_receivable', v_ins);
end;
$$;
revoke all on function public.fin_close_controls(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_close_controls(uuid, date, date) to service_role;
