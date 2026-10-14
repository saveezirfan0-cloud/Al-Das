-- Paste into Supabase > SQL Editor > New query, then Run. Needs 49_accounting_tally_import.sql and 50 (the Tally bridge,
-- migration 20261109000700) applied first; this file does not depend on 50. The migration-history line is at the bottom.

-- Phase 22K: the accounting integration pass (docs/22_PHASE_22K_NOTES.md).
--
-- Slices 22D to 22I were built in parallel on 22A and merged; this migration makes them agree. It never edits an
-- earlier migration: it redefines what two slices disagreed on and repairs workspaces that were already seeded.
--
--   1. Ledger codes: each meaning has exactly one code. 22E's customer receivable control moves from 1220 (22D's
--      corporate receivable, seeded first) to 1230; 22H's disposal gain / loss ledger moves from 4910 (22E's rental
--      income, seeded first) to 4920. Seed functions redefined; existing workspaces repaired (an account that already
--      has journal lines is never renamed: a NOTICE says what to reclassify by hand).
--   2. The ledger start (22D) exempts the year-end closing journal (22I) and its reversal, like Tally imports and
--      openings: closing a year that Tally kept is a reclassification inside the mirror, not an economic event.
--   3. One journal per economic event:
--      * a 20D voucher paid by cheque: the cheque register (22F) owns the bank posting; the posting engine (22D) posts
--        nothing while a live cheque is registered for it and otherwise waits with 'cheque_not_registered' (a trigger
--        on acc_journals refuses a voucher journal for a cheque voucher, every role);
--      * a customer receipt (22E) by cheque names the received cheque in the register and owns its posting, dated the
--        cheque's date; the register never posts that cheque itself (a posting it already made is reversed when the
--        receipt takes over); bouncing, cancelling or a stale cheque voids the receipt;
--      * a 20C statement line explained by a settlement match (posted by 22D) cannot also get a bank entry (22F), and a
--        line with a live bank entry cannot be matched (triggers, every role).
--   4. Shared definitions, final and complete: app.can_view_record_history (every HISTORY_TABLES table), the journal
--      source kinds (CHECK and the list inside acc_post_from_source), the record_access_log entities.
--   5. Statements (22G) leave the year-end closing journal (22I) out of profit and loss, cash flow, the corporate tax
--      bridge and budget against actual; each fixed-asset class's accumulated depreciation (22H) is non-cash.

-- ---------------------------------------------------------------------------
-- 1. Ledger codes
-- ---------------------------------------------------------------------------
create or replace function public.acc_seed_receivables(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v integer := 0;
begin
  if not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'Organisation not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v := v + app.acc_seed_account(p_org_id, '1230', 'Customer receivables', 'G-DEBT', false, 'asset', 'receivable', null, false, 100);
  v := v + app.acc_seed_account(p_org_id, '4910', 'Rental income', 'G-IINC', false, 'income', null, null, false, 100);
  insert into public.acc_ar_settings (org_id) values (p_org_id) on conflict do nothing;
  return v;
end;
$$;
revoke all on function public.acc_seed_receivables(uuid) from public, anon, authenticated;
grant execute on function public.acc_seed_receivables(uuid) to service_role;


create or replace function app.acc_ar_receivable_account(p_org_id uuid, p_customer_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v uuid;
begin
  select c.receivable_account_id into v from public.acc_customers c where c.id = p_customer_id and c.org_id = p_org_id;
  if v is null then
    -- 22K: 1230 (1220 is 22D's corporate receivable); the name as a fallback where 1230 could not be seeded
    select a.id into v from public.acc_accounts a
     where a.org_id = p_org_id and a.code = '1230' and not a.is_group and a.is_active and a.control = 'receivable';
    if v is null then
      select a.id into v from public.acc_accounts a
       where a.org_id = p_org_id and lower(a.name) = 'customer receivables' and not a.is_group and a.is_active
         and a.control = 'receivable';
    end if;
  end if;
  if v is null then
    raise exception 'The receivable account must be an active receivables ledger.' using errcode = 'check_violation', hint = 'receivable_account';
  end if;
  return v;
end;
$$;
revoke all on function app.acc_ar_receivable_account(uuid, uuid) from public, anon, authenticated;


create or replace function app.acc_receipt_post(p_receipt_id uuid, p_today date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  c public.acc_customers;
  ch public.acc_cheques;
  v_date date;
  v_res jsonb;
  v_hint text;
begin
  select * into r from public.acc_receipts where id = p_receipt_id for update;
  if r.status <> 'active' or r.posting_status = 'posted' then
    return r.posting_status;
  end if;
  v_date := r.receipt_date;
  if r.cheque_id is not null then
    -- 22K: paid by a registered cheque: the receipt owns the bank posting, dated the cheque's date, once that date has
    -- come and while the cheque is live (the register's sweep calls this again on the date)
    select * into ch from public.acc_cheques where id = r.cheque_id for update;
    if ch.status not in ('received', 'presented', 'cleared') or ch.cheque_date > coalesce(p_today, current_date) then
      return r.posting_status;
    end if;
    v_date := ch.cheque_date;
  end if;
  select * into c from public.acc_customers where id = r.customer_id;
  begin
    v_res := public.acc_post_from_source(
      r.org_id, r.entity_id, 'receipt', r.id::text, 1, v_date, 'receipt', 'Receipt ' || r.number,
      jsonb_build_array(
        jsonb_build_object('account_id', r.account_id, 'debit', r.amount, 'description', r.number,
                           'party_kind', 'customer', 'party_id', c.id::text),
        jsonb_strip_nulls(jsonb_build_object('account_id', r.receivable_account_id, 'credit', r.amount,
                           'description', r.number, 'payer_id', c.payer_id,
                           'party_kind', 'customer', 'party_id', c.id::text))));
    update public.acc_receipts set journal_id = (v_res ->> 'id')::uuid, posting_status = 'posted' where id = r.id;
    if ch.id is not null then
      update public.acc_cheques set posting = 'posted', journal_id = (v_res ->> 'id')::uuid where id = ch.id;
    end if;
    return 'posted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      update public.acc_receipts set posting_status = 'waiting_ledger_start' where id = r.id;
      if ch.id is not null then
        update public.acc_cheques set posting = 'waiting_ledger_start', journal_id = null where id = ch.id;
      end if;
      return 'waiting_ledger_start';
    end if;
    raise;
  end;
end;
$$;
revoke all on function app.acc_receipt_post(uuid, date) from public, anon, authenticated;


create or replace function public.acc_receipt_save(p_org_id uuid, p_user_id uuid, p_receipt jsonb, p_allocations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer uuid;
  v_entity uuid;
  v_account uuid;
  v_date date;
  v_amount numeric;
  v_mode text := coalesce(p_receipt ->> 'mode', '');
  v_id uuid;
  v_number text;
  v_posting text;
  v_alloc numeric;
  v_cheque_id uuid;
  v_cheque public.acc_cheques;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.receipts.manage') then
    raise exception 'You cannot record receipts.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  begin
    v_customer := nullif(p_receipt ->> 'customer_id', '')::uuid;
    v_entity := nullif(p_receipt ->> 'entity_id', '')::uuid;
    v_account := nullif(p_receipt ->> 'account_id', '')::uuid;
    v_date := nullif(p_receipt ->> 'receipt_date', '')::date;
    v_amount := nullif(p_receipt ->> 'amount', '')::numeric;
    v_cheque_id := nullif(p_receipt ->> 'cheque_id', '')::uuid;
  exception when others then
    raise exception 'Check the date and amount.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_date is null or v_date < date '2000-01-01' or v_date > date '2999-12-01'
     or v_mode not in ('bank_transfer', 'cheque', 'card', 'cash', 'other') then
    raise exception 'Enter a valid date and mode.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) or v_amount >= 1e12 then
    raise exception 'Amounts are positive with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
  end if;
  if not exists (select 1 from public.acc_customers c where c.id = v_customer and c.org_id = p_org_id and c.active) then
    raise exception 'Choose an active customer.' using errcode = 'check_violation', hint = 'customer_unknown';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if not exists (select 1 from public.acc_accounts a
                 where a.id = v_account and a.org_id = p_org_id and not a.is_group and a.is_active
                   and a.control in ('bank', 'cash', 'clearing') and (a.entity_id is null or a.entity_id = v_entity)) then
    raise exception 'Choose a bank, cash or clearing ledger.' using errcode = 'check_violation', hint = 'receipt_account';
  end if;
  -- 22K: one journal per economic event. A receipt by cheque names the received cheque in the register; the receipt
  -- then owns the bank posting (dated the cheque's date) and the register does not post that cheque itself.
  if v_mode = 'cheque' then
    if v_cheque_id is null then
      raise exception 'Register the cheque in the cheque register first, then choose it here.'
        using errcode = 'check_violation', hint = 'cheque_not_registered';
    end if;
    select * into v_cheque from public.acc_cheques ch where ch.id = v_cheque_id and ch.org_id = p_org_id for update;
    if not found or v_cheque.direction <> 'received' or v_cheque.status not in ('received', 'presented', 'cleared')
       or v_cheque.amount <> v_amount or v_cheque.party_kind = 'patient'
       or (v_cheque.party_kind = 'customer' and v_cheque.party_ref is not null and v_cheque.party_ref <> v_customer::text)
       or (select b.gl_account_id from public.fin_bank_accounts b where b.id = v_cheque.bank_account_id) is distinct from v_account
       or exists (select 1 from public.acc_receipts x where x.cheque_id = v_cheque.id and x.status = 'active') then
      raise exception 'Choose a live received cheque of this amount, deposited to the ledger chosen, not yet on another receipt.'
        using errcode = 'check_violation', hint = 'cheque_mismatch';
    end if;
  elsif v_cheque_id is not null then
    raise exception 'Only a receipt by cheque names a cheque.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_number := app.acc_ar_next_number(p_org_id, v_entity, 'receipt', v_date);
  insert into public.acc_receipts (org_id, entity_id, customer_id, number, receipt_date, account_id, receivable_account_id,
                                   amount, mode, reference, notes, prepared_by, cheque_id)
  values (p_org_id, v_entity, v_customer, v_number, v_date, v_account, app.acc_ar_receivable_account(p_org_id, v_customer),
          v_amount, v_mode, nullif(left(btrim(coalesce(p_receipt ->> 'reference', '')), 60), ''),
          nullif(left(btrim(coalesce(p_receipt ->> 'notes', '')), 300), ''), p_user_id, v_cheque.id)
  returning id into v_id;
  if v_cheque.id is not null then
    -- the register may already have posted the cheque (dated on or before today): hand the posting to the receipt
    if v_cheque.posting = 'posted' then
      perform app.acc_reverse_internal(p_org_id, v_cheque.journal_id, p_user_id,
                                       (select j.journal_date from public.acc_journals j where j.id = v_cheque.journal_id),
                                       'cheque ' || v_cheque.cheque_no || ' posted by receipt ' || v_number);
    end if;
    update public.acc_cheques set posting = 'not_due', journal_id = null, updated_by = p_user_id where id = v_cheque.id;
  end if;
  v_posting := app.acc_receipt_post(v_id, current_date);
  v_alloc := app.acc_receipt_allocate_internal(v_id, p_user_id, p_allocations);
  return jsonb_build_object('id', v_id, 'number', v_number, 'posting_status', v_posting, 'allocated', v_alloc,
                            'unallocated', v_amount - v_alloc);
end;
$$;
revoke all on function public.acc_receipt_save(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_receipt_save(uuid, uuid, jsonb, jsonb) to service_role;


create or replace function public.acc_receipt_void(p_org_id uuid, p_receipt_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_touched uuid[];
  v_inv uuid;
  v_rev jsonb;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.receipts.manage') then
    raise exception 'You cannot void receipts.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into r from public.acc_receipts where id = p_receipt_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Receipt not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if r.status <> 'active' then
    raise exception 'This receipt is already void.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Say why the receipt is voided.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  -- 22K: a receipt paid by a live registered cheque is voided through the cheque (bounce or cancel it)
  if r.cheque_id is not null and exists (select 1 from public.acc_cheques c where c.id = r.cheque_id
                                          and c.status in ('received', 'presented', 'cleared')) then
    raise exception 'This receipt was paid by a cheque in the register: bounce or cancel the cheque there; the receipt is voided with it.'
      using errcode = 'check_violation', hint = 'receipt_has_cheque';
  end if;
  return app.acc_receipt_void_internal(r.id, p_user_id, p_date, v_reason);
end;
$$;
revoke all on function public.acc_receipt_void(uuid, uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.acc_receipt_void(uuid, uuid, uuid, date, text) to service_role;

create or replace function public.acc_assets_seed(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts integer := 0;
  v_classes integer := 0;
  v_n integer;
  g record;
begin
  if not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'Organisation not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  for g in
    select * from (values
      ('1520', 'IT equipment',                                     'G-FA',   'asset'),
      ('1530', 'Leasehold improvements',                           'G-FA',   'asset'),
      ('1540', 'Motor vehicles',                                   'G-FA',   'asset'),
      ('1591', 'Accumulated depreciation - medical equipment',     'G-FA',   'asset'),
      ('1592', 'Accumulated depreciation - IT equipment',          'G-FA',   'asset'),
      ('1593', 'Accumulated depreciation - furniture and fittings', 'G-FA',  'asset'),
      ('1594', 'Accumulated depreciation - leasehold improvements', 'G-FA',  'asset'),
      ('1595', 'Accumulated depreciation - motor vehicles',        'G-FA',   'asset'),
      ('2310', 'Deferred revenue',                                 'G-CL',   'liability'),
      ('4920', 'Gain or loss on disposal of fixed assets',         'G-IINC', 'income')
    ) as t (code, name, parent, nature)
  loop
    v_accounts := v_accounts + app.acc_seed_account(p_org_id, g.code, g.name, g.parent, false, g.nature, null, null, false, 100);
  end loop;

  -- straight line, no residual by default; leasehold improvements: 60 months or the lease term, whichever is shorter
  insert into public.acc_asset_classes (org_id, code, name, cost_account_id, accum_account_id, expense_account_id,
                                        disposal_account_id, method, life_months, residual_pct)
  select p_org_id, t.code, t.name, c.id, a.id, e.id, d.id, 'straight_line', t.life, 0
  from (values
    ('MED',  'Medical equipment',      '1500', '1591', 60),
    ('IT',   'IT equipment',           '1520', '1592', 36),
    ('FURN', 'Furniture and fittings', '1510', '1593', 60),
    ('LHI',  'Leasehold improvements', '1530', '1594', 60),
    ('VEH',  'Motor vehicles',         '1540', '1595', 60)
  ) as t (code, name, cost_code, accum_code, life)
  join public.acc_accounts c on c.org_id = p_org_id and c.code = t.cost_code and not c.is_group and c.nature = 'asset'
  join public.acc_accounts a on a.org_id = p_org_id and a.code = t.accum_code and not a.is_group and a.nature = 'asset'
  join public.acc_accounts e on e.org_id = p_org_id and e.code = '6400' and not e.is_group and e.nature = 'expense'
  join public.acc_accounts d on d.org_id = p_org_id and d.code = '4920' and not d.is_group and d.nature in ('income', 'expense')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_classes := v_n;
  -- 22K: each class's accumulated depreciation is a non-cash item in the cash flow (22G does the same for 1590; its
  -- trigger runs before this seed for a new org, so the classes' ledgers are marked here)
  update public.acc_accounts a set cash_flow_class = 'operating_noncash'
   where a.org_id = p_org_id and a.cash_flow_class is null and not a.is_group
     and a.id in (select k.accum_account_id from public.acc_asset_classes k where k.org_id = p_org_id);
  return jsonb_build_object('accounts_added', v_accounts, 'classes_added', v_classes);
end;
$$;
revoke all on function public.acc_assets_seed(uuid) from public, anon, authenticated;
grant execute on function public.acc_assets_seed(uuid) to service_role;

-- Repairs one workspace that was seeded before this migration. Idempotent; returns what it did (codes only).
create or replace function app.acc_integration_repair_codes(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a1220 public.acc_accounts;
  a4910 public.acc_accounts;
  v1230 uuid;
  v4920 uuid;
  v_done text[] := '{}';
  v_lines boolean;
begin
  if not exists (select 1 from public.acc_entities e where e.org_id = p_org_id and e.is_default) then
    return jsonb_build_object('org_id', p_org_id, 'done', '[]'::jsonb);   -- no chart yet
  end if;
  perform set_config('app.acc_seeding', 'on', true);

  -- 1220: 22D's corporate receivable. If 22E's paste ran first, 1220 is "Customer receivables": give it back when unused.
  select * into a1220 from public.acc_accounts where org_id = p_org_id and code = '1220';
  if found and lower(a1220.name) = 'customer receivables' then
    v_lines := exists (select 1 from public.acc_journal_lines l where l.account_id = a1220.id);
    if not v_lines and not exists (select 1 from public.acc_accounts x where x.org_id = p_org_id
                                    and lower(x.name) = 'corporate receivable') then
      update public.acc_accounts set name = 'Corporate receivable' where id = a1220.id;
      v_done := array_append(v_done, '1220 renamed Corporate receivable');
    else
      raise notice 'org %: account 1220 "Customer receivables" has journal lines; it keeps its name. Rename it or reclassify by journal.', p_org_id;
      v_done := array_append(v_done, '1220 left (has lines)');
    end if;
  elsif found then
    if exists (select 1 from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id
               where l.account_id = a1220.id and j.source_kind in ('sales_invoice', 'receipt')) then
      raise notice 'org %: account 1220 % holds lines of Pulse sales documents (22E); new documents use 1230. Reclassify by journal if wanted.', p_org_id, a1220.name;
      v_done := array_append(v_done, '1220 holds 22E lines');
    end if;
  end if;

  -- 4910: 22E's rental income. If 22H's paste ran first, 4910 is the disposal gain / loss ledger: give it back when unused.
  select * into a4910 from public.acc_accounts where org_id = p_org_id and code = '4910';
  if found and lower(a4910.name) = 'gain or loss on disposal of fixed assets' then
    v_lines := exists (select 1 from public.acc_journal_lines l where l.account_id = a4910.id);
    if not v_lines and not exists (select 1 from public.acc_accounts x where x.org_id = p_org_id and lower(x.name) = 'rental income') then
      update public.acc_accounts set name = 'Rental income' where id = a4910.id;
      v_done := array_append(v_done, '4910 renamed Rental income');
    else
      raise notice 'org %: account 4910 is the disposal gain / loss ledger and has journal lines; rental income was not created at 4910.', p_org_id;
      v_done := array_append(v_done, '4910 left (has lines)');
    end if;
  elsif found and exists (select 1 from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id
                          where l.account_id = a4910.id and j.source_kind = 'fixed_asset') then
    raise notice 'org %: account 4910 % holds disposal gains or losses (22H); new disposals use 4920. Reclassify by journal if wanted.', p_org_id, a4910.name;
    v_done := array_append(v_done, '4910 holds 22H lines');
  end if;

  -- the ledgers under their own codes (skipped where they exist)
  perform public.acc_seed_receivables(p_org_id);
  perform public.acc_assets_seed(p_org_id);
  perform set_config('app.acc_seeding', 'on', true);
  select a.id into v1230 from public.acc_accounts a where a.org_id = p_org_id and a.code = '1230' and not a.is_group;
  select a.id into v4920 from public.acc_accounts a where a.org_id = p_org_id and a.code = '4920' and not a.is_group;

  -- references: customers that named 22E's old ledger explicitly, and the asset classes' disposal ledger
  if v1230 is not null and a1220.id is not null and lower(a1220.name) = 'customer receivables' then
    update public.acc_customers set receivable_account_id = v1230
     where org_id = p_org_id and receivable_account_id = a1220.id;
  end if;
  if v4920 is not null then
    update public.acc_asset_classes k set disposal_account_id = v4920
     where k.org_id = p_org_id and k.disposal_account_id = (
       select a.id from public.acc_accounts a where a.org_id = p_org_id and a.code = '4910' and lower(a.name) = 'rental income');
    if found then
      v_done := array_append(v_done, 'asset classes now use 4920');
    end if;
  end if;
  perform set_config('app.acc_seeding', '', true);
  return jsonb_build_object('org_id', p_org_id, 'done', to_jsonb(v_done));
end;
$$;
revoke all on function app.acc_integration_repair_codes(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The ledger start exempts the year-end close (and its reversal) like Tally imports and openings
-- ---------------------------------------------------------------------------
create or replace function app.acc_ledger_start_ok(p_entity_id uuid, p_date date, p_source_kind text, p_reversal_of uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
begin
  if p_source_kind in ('tally_import', 'opening', 'year_end') then
    return true;
  end if;
  if p_source_kind = 'reversal' and exists (
    select 1 from public.acc_journals o where o.id = p_reversal_of and o.source_kind in ('tally_import', 'opening', 'year_end')) then
    return true;
  end if;
  select e.ledger_start_date into v_start from public.acc_entities e where e.id = p_entity_id;
  return v_start is not null and p_date >= v_start;
end;
$$;
revoke all on function app.acc_ledger_start_ok(uuid, date, text, uuid) from public, anon, authenticated;

create or replace function app.acc_first_pulse_journal(p_entity_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select min(j.journal_date)
  from public.acc_journals j
  left join public.acc_journals o on o.id = j.reversal_of
  where j.entity_id = p_entity_id and j.status in ('posted', 'reversed')
    and coalesce(j.source_kind, '') not in ('tally_import', 'opening', 'year_end')
    and not (j.source_kind = 'reversal' and o.source_kind in ('tally_import', 'opening', 'year_end'));
$$;
revoke all on function app.acc_first_pulse_journal(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. One journal per economic event
-- ---------------------------------------------------------------------------
-- 3a. A voucher's cheque: one live cheque per voucher (a bounced, cancelled or stale one may be replaced)
alter table public.acc_cheques drop constraint if exists acc_cheques_voucher_id_key;
create unique index if not exists acc_cheques_voucher_live_uidx on public.acc_cheques (voucher_id)
  where voucher_id is not null and status in ('issued', 'presented', 'cleared');

-- 3b. A receipt by cheque names the received cheque (one active receipt per cheque); fixed once saved
alter table public.acc_receipts add column cheque_id uuid references public.acc_cheques (id);
alter table public.acc_receipts add constraint acc_receipts_cheque_mode check (cheque_id is null or mode = 'cheque');
create unique index acc_receipts_cheque_live_uidx on public.acc_receipts (cheque_id) where cheque_id is not null and status = 'active';
create trigger acc_receipts_cheque_org_check before insert or update on public.acc_receipts
  for each row execute function app.check_parent_org('acc_cheques', 'cheque_id');

-- 3c. Every role: a voucher paid by cheque is never posted by the engine, and a cheque named by a receipt never by the
--     register (their owners post them).
create or replace function app.acc_journal_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_kind = 'voucher' and exists (
    select 1 from public.fin_payment_vouchers v
    where v.org_id = new.org_id and v.id::text = new.source_id and v.payment_method = 'cheque') then
    raise exception 'A voucher paid by cheque is posted by the cheque register.'
      using errcode = 'check_violation', hint = 'cheque_not_registered';
  end if;
  if new.source_kind = 'cheque' and exists (
    select 1 from public.acc_receipts r
    where r.org_id = new.org_id and r.cheque_id::text = new.source_id and r.status = 'active') then
    raise exception 'This cheque is posted by its receipt.' using errcode = 'check_violation', hint = 'cheque_by_receipt';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_journal_owner_guard() from public, anon, authenticated;
create trigger acc_journals_owner_guard before insert on public.acc_journals
  for each row execute function app.acc_journal_owner_guard();

-- 3d. Receipts: posted dated the cheque (two-argument form), the void split into a guarded public part and an internal
--     part the cheque register uses
create or replace function app.acc_receipt_void_internal(p_receipt_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  v_touched uuid[];
  v_inv uuid;
  v_rev jsonb;
  j public.acc_journals;
begin
  select * into r from public.acc_receipts where id = p_receipt_id for update;
  if r.status <> 'active' then
    return jsonb_build_object('id', r.id, 'status', r.status);
  end if;
  select coalesce(array_agg(a.invoice_id), '{}') into v_touched from public.acc_allocations a where a.receipt_id = r.id;
  delete from public.acc_allocations where receipt_id = r.id;
  if r.journal_id is not null then
    select * into j from public.acc_journals where id = r.journal_id;
    if j.status = 'posted' then   -- a bounced cheque has already reversed it
      v_rev := app.acc_reverse_internal(r.org_id, j.id, p_user_id,
                                        greatest(coalesce(p_date, r.receipt_date), r.receipt_date, j.journal_date),
                                        left('receipt ' || r.number || ' void: ' || p_reason, 300));
    end if;
  end if;
  update public.acc_receipts set status = 'void', amount_allocated = 0, voided_by = p_user_id, voided_at = now(),
    void_reason = left(p_reason, 200)
  where id = r.id;
  foreach v_inv in array v_touched loop
    perform app.acc_ar_refresh_invoice(v_inv);
  end loop;
  return jsonb_build_object('id', r.id, 'status', 'void', 'reversal_id', v_rev ->> 'id', 'reversal_number', v_rev ->> 'number');
end;
$$;
revoke all on function app.acc_receipt_void_internal(uuid, uuid, date, text) from public, anon, authenticated;

create or replace function app.acc_receipt_post(p_receipt_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.acc_receipt_post(p_receipt_id, current_date);
end;
$$;
revoke all on function app.acc_receipt_post(uuid) from public, anon, authenticated;

create or replace function app.acc_cheque_post_due(p_cheque_id uuid, p_today date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ch public.acc_cheques;
  v_res jsonb;
  v_receipt uuid;
begin
  select * into ch from public.acc_cheques where id = p_cheque_id for update;
  if ch.posting not in ('not_due', 'waiting_ledger_start') or ch.cheque_date > p_today
     or ch.status not in ('issued', 'received', 'presented', 'cleared') then
    return ch.posting;
  end if;
  -- 22K: a received cheque named by a receipt is posted by that receipt (dated the cheque), never twice
  select r.id into v_receipt from public.acc_receipts r where r.cheque_id = ch.id and r.status = 'active';
  if v_receipt is not null then
    perform app.acc_receipt_post(v_receipt, p_today);
    return (select c.posting from public.acc_cheques c where c.id = ch.id);
  end if;
  v_res := app.acc_banking_post_item('cheque', ch.id);
  update public.acc_cheques set posting = case when v_res ->> 'status' = 'posted' then 'posted' else 'waiting_ledger_start' end,
                                journal_id = (v_res ->> 'journal_id')::uuid
   where id = ch.id;
  return case when v_res ->> 'status' = 'posted' then 'posted' else 'waiting_ledger_start' end;
end;
$$;
revoke all on function app.acc_cheque_post_due(uuid, date) from public, anon, authenticated;

-- A cheque that bounces, is cancelled or goes stale takes its receipt with it (the receipt's journal, which the
-- register reversed as the cheque's posting, stays reversed; allocations go; the invoices open again).
create or replace function app.acc_cheque_receipt_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.status in ('bounced', 'cancelled', 'stale') and old.status not in ('bounced', 'cancelled', 'stale') then
    for r in select x.id from public.acc_receipts x where x.cheque_id = new.id and x.status = 'active' loop
      perform app.acc_receipt_void_internal(r.id, new.updated_by, coalesce(new.bounced_on, new.cancelled_on, new.stale_on),
                                            new.status || ' cheque ' || new.cheque_no);
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function app.acc_cheque_receipt_follow() from public, anon, authenticated;
create trigger acc_cheques_receipt_follow after update of status on public.acc_cheques
  for each row execute function app.acc_cheque_receipt_follow();

-- 3e. A statement line is explained once: by a reconciliation match (22D posts settlements from it) or by a bank entry
--     (22F), never both. acc_bank_entry_insert already refuses a matched line; these repeat it for every role and add
--     the other direction.
create or replace function app.fin_bank_match_entry_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'matched' and exists (
    select 1 from public.acc_bank_entries e where e.bank_line_id = new.bank_line_id and e.status <> 'cancelled') then
    raise exception 'A bank entry already explains this statement line; cancel it before matching the line.'
      using errcode = 'check_violation', hint = 'line_has_bank_entry';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_bank_match_entry_guard() from public, anon, authenticated;
create trigger fin_bank_matches_entry_guard before insert or update of status, bank_line_id on public.fin_bank_matches
  for each row execute function app.fin_bank_match_entry_guard();

create or replace function app.acc_bank_entry_line_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bank_line_id is not null and new.status <> 'cancelled' and exists (
    select 1 from public.fin_bank_matches m where m.bank_line_id = new.bank_line_id and m.status = 'matched') then
    raise exception 'That statement line is already matched.' using errcode = 'check_violation', hint = 'line_matched';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_bank_entry_line_guard() from public, anon, authenticated;
create trigger acc_bank_entries_line_guard before insert on public.acc_bank_entries
  for each row execute function app.acc_bank_entry_line_guard();

-- 3f. The posting engine reads the voucher's cheque (candidates and the sanitised record)
create or replace function public.acc_posting_candidates(
  p_org_id uuid, p_kind text, p_after timestamptz, p_after_id text, p_limit integer, p_settle_seconds integer default 120
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_after timestamptz := coalesce(p_after, '-infinity'::timestamptz);
  v_id text := coalesce(p_after_id, '');
  v_until timestamptz := now() - make_interval(secs => greatest(coalesce(p_settle_seconds, 120), 0));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_out jsonb;
begin
  with c(id, s) as (
    select i.inv_display_number, i.updated_at from public.fin_invoices i
     where p_kind = 'unite_invoice' and i.org_id = p_org_id and i.updated_at >= v_after
    union all
    select i.inv_display_number, l.updated_at from public.fin_invoice_lines l join public.fin_invoices i on i.id = l.invoice_id
     where p_kind = 'unite_invoice' and l.org_id = p_org_id and l.updated_at >= v_after
    union all
    select i.inv_display_number, a.updated_at from public.ins_claim_activities a join public.fin_invoices i on i.id = a.matched_invoice_id
     where p_kind = 'unite_invoice' and a.org_id = p_org_id and a.updated_at >= v_after
    union all
    select p.id::text, greatest(p.updated_at, i.updated_at) from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
     where p_kind = 'unite_payment' and p.org_id = p_org_id and greatest(p.updated_at, i.updated_at) >= v_after
    union all
    select 'refund:' || p.id::text, greatest(p.updated_at, i.updated_at) from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
     where p_kind = 'unite_payment' and p.org_id = p_org_id and greatest(p.updated_at, i.updated_at) >= v_after
       and (coalesce(p.refund, 0) <> 0 or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'unite_payment' and st.source_id = 'refund:' || p.id::text))
    union all
    select s.id::text, s.updated_at from public.fin_supplier_invoices s
     where p_kind = 'supplier_invoice' and s.org_id = p_org_id and s.updated_at >= v_after
    union all
    select v.id::text, v.updated_at from public.fin_payment_vouchers v
     where p_kind = 'voucher' and v.org_id = p_org_id and v.updated_at >= v_after
       and (v.status = 'paid' or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'voucher' and st.source_id = v.id::text))
    union all
    -- 22K: a cheque registered, bounced or cancelled for a paid voucher makes the voucher look again
    select v.id::text, c.updated_at from public.acc_cheques c join public.fin_payment_vouchers v on v.id = c.voucher_id
     where p_kind = 'voucher' and c.org_id = p_org_id and c.updated_at >= v_after
       and (v.status = 'paid' or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'voucher' and st.source_id = v.id::text))
    union all
    select b.id::text, b.created_at from public.ins_remittance_batches b
     where p_kind = 'remittance' and b.org_id = p_org_id and b.created_at >= v_after
    union all
    select d.id::text, d.updated_at from public.ins_denial_cases d
     where p_kind = 'denial' and d.org_id = p_org_id and d.updated_at >= v_after
       and (d.status in ('lost', 'written_off') or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'denial' and st.source_id = d.id::text))
    union all
    select r.id::text, r.updated_at from public.fin_revshare_runs r
     where p_kind = 'revshare_run' and r.org_id = p_org_id and r.updated_at >= v_after
    union all
    select 'payout:' || l.id::text, greatest(l.created_at, coalesce(l.paid_recorded_at, l.created_at), r.updated_at)
      from public.fin_revshare_lines l join public.fin_revshare_runs r on r.id = l.run_id
     where p_kind = 'revshare_run' and l.org_id = p_org_id
       and greatest(l.created_at, coalesce(l.paid_recorded_at, l.created_at), r.updated_at) >= v_after
       and (l.paid_on is not null or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'revshare_run' and st.source_id = 'payout:' || l.id::text))
    union all
    select s.id::text, s.updated_at from public.fin_provider_statements s
     where p_kind = 'lab_charge' and s.org_id = p_org_id and s.updated_at >= v_after
       and (s.status = 'posted' or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'lab_charge' and st.source_id = s.id::text))
    union all
    select c.id::text, greatest(c.updated_at, coalesce((select max(l.updated_at) from public.fin_cashup_lines l where l.cashup_id = c.id), c.updated_at))
      from public.fin_cashups c
     where p_kind = 'cashup' and c.org_id = p_org_id
       and greatest(c.updated_at, coalesce((select max(l.updated_at) from public.fin_cashup_lines l where l.cashup_id = c.id), c.updated_at)) >= v_after
    union all
    select m.id::text, greatest(m.decided_at, r.updated_at) from public.fin_bank_matches m join public.fin_bank_recs r on r.id = m.rec_id
     where p_kind = 'settlement' and m.org_id = p_org_id and m.expected_kind in ('collection', 'payout')
       and greatest(m.decided_at, r.updated_at) >= v_after
    union all
    -- a source row that vanished (an undone bank match, a removed remittance) while its journal or preview is live
    select st.source_id, st.updated_at from public.acc_posting_status st
     where st.org_id = p_org_id and st.source_kind = p_kind and p_kind in ('settlement', 'remittance')
       and st.state in ('posted', 'preview') and st.updated_at >= v_after
       and not exists (select 1 from public.fin_bank_matches m where p_kind = 'settlement' and m.id::text = st.source_id)
       and not exists (select 1 from public.ins_remittance_batches b where p_kind = 'remittance' and b.id::text = st.source_id)
  ), g as (
    select c.id, max(c.s) as s from c group by c.id
  ), picked as (
    select g.id, g.s from g
    where g.s < v_until and (g.s > v_after or (g.s = v_after and g.id > v_id))
    order by g.s, g.id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', picked.id, 'stamp', picked.s) order by picked.s, picked.id), '[]'::jsonb)
    into v_out from picked;
  return v_out;
end;
$$;
revoke all on function public.acc_posting_candidates(uuid, text, timestamptz, text, integer, integer) from public, anon, authenticated;
grant execute on function public.acc_posting_candidates(uuid, text, timestamptz, text, integer, integer) to service_role;


create or replace function public.acc_posting_load(p_org_id uuid, p_kind text, p_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_out jsonb;
begin
  select coalesce(o.timezone, 'Asia/Dubai') into v_tz from public.orgs o where o.id = p_org_id;
  v_tz := coalesce(v_tz, 'Asia/Dubai');
  if p_kind = 'unite_invoice' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.inv_display_number, 'date', i.transaction_date, 'branch', i.branch_code, 'department', i.department,
      'doctor', i.doctor_dha_id, 'inv_type', i.inv_type, 'is_package', i.is_package, 'is_deleted', i.is_deleted,
      'total', i.total, 'write_off', i.write_off, 'credit_note', i.credit_note, 'version', i.version,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('category', coalesce(s.service_category, 'Unmapped'),
                                            'discount', l.line_discount, 'net', l.line_net, 'vat', l.vat)
                         order by l.position, l.line_key)
        from public.fin_invoice_lines l
        left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
        where l.invoice_id = i.id and l.is_current), '[]'::jsonb),
      'claims', coalesce((
        select jsonb_agg(jsonb_build_object('payer_id', x.payer_id, 'amount', x.amount) order by x.payer_id)
        from (select a.payer_id, round(sum(coalesce(a.initial_net, a.net, 0)), 2) as amount
              from public.ins_claim_activities a
              where a.matched_invoice_id = i.id and a.match_status = 'matched'
              group by a.payer_id) x), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_invoices i where i.org_id = p_org_id and i.inv_display_number = any (p_ids);
  elsif p_kind = 'unite_payment' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.sid, 'part', case when x.sid like 'refund:%' then 'refund' else 'payment' end,
      'invoice', i.inv_display_number, 'inv_type', i.inv_type, 'branch', i.branch_code,
      'is_current', p.is_current, 'invoice_deleted', i.is_deleted,
      'mode', upper(coalesce(nullif(btrim(p.payment_mode), ''), '(UNKNOWN)')),
      'paid', p.paid, 'advance', p.advance_added, 'refund', p.refund,
      'date', case when x.sid like 'refund:%' then coalesce(p.refund_date, p.paid_date) else p.paid_date end
    )), '[]'::jsonb) into v_out
    from unnest(p_ids) as x(sid)
    join public.fin_payments p on p.org_id = p_org_id and p.id::text = regexp_replace(x.sid, '^refund:', '')
    join public.fin_invoices i on i.id = p.invoice_id;
  elsif p_kind = 'supplier_invoice' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'number', s.invoice_number, 'supplier_id', s.supplier_id, 'date', s.invoice_date, 'category', s.category,
      'net', s.net, 'vat', s.vat, 'currency', s.currency, 'branch', s.branch_code, 'doctor', s.doctor_dha_id, 'status', s.status
    )), '[]'::jsonb) into v_out
    from public.fin_supplier_invoices s where s.org_id = p_org_id and s.id::text = any (p_ids);
  elsif p_kind = 'voucher' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'voucher_no', v.voucher_no, 'status', v.status, 'date', v.payment_date, 'amount', v.amount,
      'currency', v.currency, 'supplier_id', v.supplier_id, 'category', v.category, 'branch', v.branch_code,
      'pay_from', v.pay_from, 'method', v.payment_method,
      -- 22K: a voucher paid by cheque is posted by the cheque register while a live cheque is registered for it
      'cheque_live', exists (select 1 from public.acc_cheques c where c.voucher_id = v.id
                             and c.status in ('issued', 'presented', 'cleared'))
    )), '[]'::jsonb) into v_out
    from public.fin_payment_vouchers v where v.org_id = p_org_id and v.id::text = any (p_ids);
  elsif p_kind = 'remittance' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'payer_id', b.payer_id, 'date', b.paid_on,
      'bank_account_id', (select a.id from public.fin_bank_accounts a where a.org_id = p_org_id and a.receives_insurance limit 1),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('payer_id', y.payer_id, 'paid', y.paid) order by y.payer_id nulls first)
        from (select coalesce(nullif(btrim(l.payer_id), ''), b.payer_id) as payer_id, round(sum(l.paid_amount), 2) as paid
              from public.ins_remittance_lines l where l.batch_id = b.id group by 1) y), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.ins_remittance_batches b where b.org_id = p_org_id and b.id::text = any (p_ids);
  elsif p_kind = 'denial' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'status', d.status, 'payer_id', d.payer_id, 'amount', d.rejected_amount,
      'date', (d.resolved_at at time zone v_tz)::date
    )), '[]'::jsonb) into v_out
    from public.ins_denial_cases d where d.org_id = p_org_id and d.id::text = any (p_ids);
  elsif p_kind = 'revshare_run' then
    select coalesce(jsonb_agg(z.o), '[]'::jsonb) into v_out from (
      select jsonb_build_object('id', r.id, 'part', 'run', 'month', r.month, 'status', r.status,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('doctor', l.doctor_dha_id, 'payout', l.payout)
                                            order by l.doctor_dha_id)
                           from public.fin_revshare_lines l where l.run_id = r.id), '[]'::jsonb)) as o
      from public.fin_revshare_runs r where r.org_id = p_org_id and r.id::text = any (p_ids)
      union all
      select jsonb_build_object('id', 'payout:' || l.id, 'part', 'payout', 'month', r.month, 'status', r.status,
        'doctor', l.doctor_dha_id, 'payout', l.payout, 'paid_on', l.paid_on)
      from public.fin_revshare_lines l join public.fin_revshare_runs r on r.id = l.run_id
      where l.org_id = p_org_id and ('payout:' || l.id::text) = any (p_ids)
    ) z;
  elsif p_kind = 'lab_charge' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'month', s.month, 'status', s.status, 'provider_kind', p.kind,
      'allocation', coalesce((
        select jsonb_agg(jsonb_build_object('doctor', a ->> 'doctor', 'branch', a ->> 'branch', 'cost', (a ->> 'cost')::numeric))
        from jsonb_array_elements(coalesce(s.figures -> 'allocation', '[]'::jsonb)) a), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_provider_statements s join public.fin_providers p on p.id = s.provider_id
    where s.org_id = p_org_id and s.id::text = any (p_ids);
  elsif p_kind = 'cashup' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'branch', c.branch_code, 'date', c.business_date, 'status', c.status,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('mode', upper(btrim(l.payment_mode)), 'variance', l.variance)
                                          order by l.payment_mode)
                         from public.fin_cashup_lines l where l.cashup_id = c.id), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_cashups c where c.org_id = p_org_id and c.id::text = any (p_ids);
  elsif p_kind = 'settlement' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'matched', m.status = 'matched' and r.status = 'signed', 'kind', m.expected_kind,
      'mode', upper(btrim(split_part(m.expected_key, '|', 2))), 'date', bl.value_date, 'bank_account_id', bl.account_id,
      'bank_amount', m.bank_amount,
      'gross', case
        when m.expected_kind = 'collection' then (
          select round(coalesce(sum(p.paid) filter (where p.paid_date = split_part(m.expected_key, '|', 3)::date), 0)
                       - coalesce(sum(p.refund) filter (where coalesce(p.refund_date, p.paid_date) = split_part(m.expected_key, '|', 3)::date), 0), 2)
          from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
          where p.org_id = p_org_id and p.is_current and not i.is_deleted
            and lower(btrim(p.payment_mode)) = lower(btrim(split_part(m.expected_key, '|', 2)))
            and split_part(m.expected_key, '|', 3) ~ '^\d{4}-\d{2}-\d{2}$')
        else (
          select round(sum(sl.gross), 2) from public.fin_settlement_lines sl
          where sl.org_id = p_org_id
            and lower(btrim(sl.payment_mode)) = lower(btrim(split_part(m.expected_key, '|', 2)))
            and split_part(m.expected_key, '|', 3) ~ '^\d{4}-\d{2}-\d{2}'
            and sl.settlement_date = left(split_part(m.expected_key, '|', 3), 10)::date
            and coalesce(sl.reference, '') = substr(split_part(m.expected_key, '|', 3), 12))
        end
    )), '[]'::jsonb) into v_out
    from public.fin_bank_matches m
    join public.fin_bank_recs r on r.id = m.rec_id
    join public.fin_bank_lines bl on bl.id = m.bank_line_id
    where m.org_id = p_org_id and m.id::text = any (p_ids);
  else
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  return v_out;
end;
$$;
revoke all on function public.acc_posting_load(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.acc_posting_load(uuid, text, text[]) to service_role;

-- vouchers are looked at again once (a voucher posted before this migration and paid by a registered cheque is withdrawn)
delete from public.acc_posting_cursors where source_kind = 'voucher';

-- ---------------------------------------------------------------------------
-- 4. Shared definitions, final and complete
-- ---------------------------------------------------------------------------
-- 4a. Journal source kinds: the CHECK is the union of what is there and every slice's kinds
do $$
declare
  c record;
  v_list text[] := array['unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial',
    'revshare_run', 'lab_charge', 'cashup', 'settlement', 'bank_line', 'opening', 'tally_import', 'fixed_asset',
    'depreciation', 'sales_invoice', 'receipt', 'payroll', 'reversal',          -- 22A
    'bank_transfer', 'bank_entry', 'petty_cash', 'cheque',                       -- 22F
    'year_end'];                                                                 -- 22I
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.acc_journals'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_kind%' and pg_get_constraintdef(con.oid) like '%tally_import%'
  loop
    v_list := v_list || array(select m[1] from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m);
    execute format('alter table public.acc_journals drop constraint %I', c.conname);
  end loop;
  v_list := array(select distinct x from unnest(v_list) as x order by x);
  execute format('alter table public.acc_journals add constraint acc_journals_source_kind_check check (source_kind is null or source_kind in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- 4b. acc_post_from_source: 22A's contract with 22D's ledger-start check and 22F's four kinds. Every kind of the CHECK
--     except 'reversal' (acc_reverse_journal) and 'year_end' (acc_year_end_close only) posts through it.
create or replace function public.acc_post_from_source(p_org_id uuid, p_entity_id uuid, p_source_kind text, p_source_id text, p_source_version integer, p_date date, p_voucher_type text, p_narration text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_entity uuid := p_entity_id;
  v_existing public.acc_journals;
  v_old public.acc_journals;
  v_new uuid;
  v_res jsonb;
  v_narration text := btrim(coalesce(p_narration, ''));
begin
  if p_source_kind is null or p_source_kind = 'reversal' or p_source_kind not in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'bank_line', 'opening', 'tally_import', 'fixed_asset', 'depreciation', 'sales_invoice',
    'receipt', 'payroll', 'bank_transfer', 'bank_entry', 'petty_cash', 'cheque') then
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  if nullif(btrim(coalesce(p_source_id, '')), '') is null or char_length(p_source_id) > 200
     or p_source_version is null or p_source_version < 1 or p_date is null
     or p_voucher_type is null or p_voucher_type not in (
       'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note', 'opening')
     or v_narration = '' or char_length(v_narration) > 300 then
    raise exception 'The source, version, date, voucher type and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;

  -- one caller at a time per source item
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || '|' || p_source_kind || '|' || p_source_id, 22));

  select * into v_existing from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and source_version = p_source_version;
  if found then
    return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'status', v_existing.status,
                              'created', false, 'replaced', null);
  end if;
  if not app.acc_ledger_start_ok(v_entity, p_date, p_source_kind, null) then
    raise exception 'This item is dated before the ledger start; until then Tally is the book of record.'
      using errcode = 'check_violation', hint = 'before_ledger_start';
  end if;
  if exists (select 1 from public.acc_journals
             where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id
               and source_version > p_source_version) then
    raise exception 'A newer version of this item is already posted.' using errcode = 'check_violation', hint = 'stale_version';
  end if;
  select * into v_old from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and status = 'posted';
  if found then
    perform app.acc_reverse_internal(p_org_id, v_old.id, null, greatest(p_date, v_old.journal_date),
                                     'replaced by version ' || p_source_version::text);
  end if;

  insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, source_kind, source_id,
                                   source_version, tally_guid)
  values (p_org_id, v_entity, p_voucher_type, p_date, v_narration, p_source_kind, p_source_id, p_source_version,
          case when p_source_kind = 'tally_import' then p_source_id end)
  returning id into v_new;
  perform app.acc_write_lines(p_org_id, v_new, p_lines);
  v_res := app.acc_post_internal(v_new, null);
  return v_res || jsonb_build_object('created', true, 'replaced', v_old.id);
end;
$$;
revoke all on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb) to service_role;

-- 4c. Who reads a table's history: every table of HISTORY_TABLES (lib/security/history.ts). 22E and 22F added their
--     tables, 22H then replaced the function with 22A's list plus its own; this is the union.
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
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

-- 4d. record_access_log entities: the union of what is there and every slice's (lib/security/access-log.ts)
do $$
declare
  c record;
  v_list text[] := array['contact', 'conversation', 'finance_claim', 'finance_invoice', 'document', 'finance_document',
                         'accounting_journal', 'accounting_receivable', 'enquiry', 'appointment', 'portal_record', 'export',
                         'activity_log'];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.record_access_log'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%entity%' and pg_get_constraintdef(con.oid) not like '%action%'
  loop
    v_list := v_list || array(select m[1] from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m);
    execute format('alter table public.record_access_log drop constraint %I', c.conname);
  end loop;
  v_list := array(select distinct x from unnest(v_list) as x order by x);
  execute format('alter table public.record_access_log add constraint record_access_log_entity_check check (entity in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Statements leave the year-end closing journal (and its reversal) out
-- ---------------------------------------------------------------------------
create or replace function app.acc_is_closing_journal(p_source_kind text, p_reversal_of uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_source_kind, '') = 'year_end'
      or (p_source_kind = 'reversal' and exists (
            select 1 from public.acc_journals o where o.id = p_reversal_of and o.source_kind = 'year_end'));
$$;
revoke all on function app.acc_is_closing_journal(text, uuid) from public, anon, authenticated;

create or replace function public.acc_profit_and_loss(p_org_id uuid, p_entity_id uuid, p_from date, p_to date,
                                                      p_dimension text, p_include_adjustment boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dim text := coalesce(nullif(p_dimension, ''), 'none');
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  if v_dim not in ('none', 'month', 'branch', 'department', 'doctor') then
    raise exception 'Choose how to split the columns.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  with ln as (
    select l.account_id, a.nature, a.affects_gross_profit as gp,
           case v_dim when 'none' then 'total'
                      when 'month' then to_char(j.journal_date, 'YYYY-MM')
                      when 'branch' then coalesce(l.branch_code, '')
                      when 'department' then coalesce(l.department, '')
                      else coalesce(l.doctor_id, '') end as col,
           case when a.nature = 'income' then l.credit - l.debit else l.debit - l.credit end as amt
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between p_from and p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
      and a.nature in ('income', 'expense')
      and not app.acc_is_closing_journal(j.source_kind, j.reversal_of)
  ), per as (
    select account_id, col, sum(amt) as amt from ln group by account_id, col
  ), tot as (
    select col,
           sum(case when nature = 'income' and gp then amt else 0 end) as direct_income,
           sum(case when nature = 'expense' and gp then amt else 0 end) as direct_expense,
           sum(case when nature = 'income' and not gp then amt else 0 end) as indirect_income,
           sum(case when nature = 'expense' and not gp then amt else 0 end) as indirect_expense
    from ln group by col
  ), cols as (
    select distinct col from ln
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id, 'dimension', v_dim,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'columns', coalesce((select jsonb_agg(c.col order by c.col) from cols c), '[]'::jsonb),
    'labels', coalesce((
      select jsonb_object_agg(c.col, case
               when c.col = '' then 'Not set'
               when v_dim = 'branch' then coalesce((select b.name from public.fin_ref_branches b
                                                     where b.org_id = p_org_id and b.code = c.col), c.col)
               when v_dim = 'doctor' then coalesce((select d.name from public.fin_ref_doctors d
                                                     where d.org_id = p_org_id and d.dha_id = c.col), c.col)
               when v_dim = 'none' then 'Amount'
               else c.col end)
      from cols c), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'col', p.col, 'amount', p.amt)
                       order by p.account_id, p.col)
      from per p where p.amt <> 0), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'col', t.col, 'direct_income', t.direct_income, 'direct_expense', t.direct_expense,
               'gross_profit', t.direct_income - t.direct_expense,
               'indirect_income', t.indirect_income, 'indirect_expense', t.indirect_expense,
               'net_profit', t.direct_income - t.direct_expense + t.indirect_income - t.indirect_expense)
             order by t.col)
      from tot t), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_profit_and_loss(uuid, uuid, date, date, text, boolean) from public, anon, authenticated;
grant execute on function public.acc_profit_and_loss(uuid, uuid, date, date, text, boolean) to service_role;


create or replace function public.acc_cash_flow(p_org_id uuid, p_entity_id uuid, p_from date, p_to date, p_include_adjustment boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
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
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
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
revoke all on function public.acc_cash_flow(uuid, uuid, date, date, boolean) from public, anon, authenticated;
grant execute on function public.acc_cash_flow(uuid, uuid, date, date, boolean) to service_role;


create or replace function public.acc_ct_bridge(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  with ln as (
    select a.id as account_id, a.code, a.name, a.nature, a.ct_treatment, l.debit, l.credit
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between p_from and p_to
      and (p_entity_id is null or j.entity_id = p_entity_id) and a.nature in ('income', 'expense')
      and not app.acc_is_closing_journal(j.source_kind, j.reversal_of)
  ), tagged as (
    select account_id, code, name, ct_treatment, sum(debit - credit) as amount
    from ln where ct_treatment is not null and nature = 'expense'
    group by account_id, code, name, ct_treatment
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'settings', app.acc_report_settings(p_org_id),
    'accounting_profit', (select coalesce(sum(credit - debit), 0) from ln),
    'revenue', (select coalesce(sum(credit - debit), 0) from ln where nature = 'income'),
    'by_treatment', coalesce((select jsonb_object_agg(t.ct_treatment, t.amount)
                              from (select ct_treatment, sum(amount) as amount from tagged group by ct_treatment) t), '{}'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_id', t.account_id, 'code', t.code, 'name', t.name, 'treatment', t.ct_treatment, 'amount', t.amount)
                  order by t.ct_treatment, t.code) from tagged t), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_ct_bridge(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_ct_bridge(uuid, uuid, date, date) to service_role;


create or replace function public.acc_budget_vs_actual(p_org_id uuid, p_budget_id uuid, p_from date, p_to date,
                                                       p_branch text, p_department text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.acc_budgets;
  v_from date;
  v_to date;
  v_fy_end date;
  v_branch text := nullif(btrim(coalesce(p_branch, '')), '');
  v_dept text := nullif(btrim(coalesce(p_department, '')), '');
  v jsonb;
begin
  select * into b from public.acc_budgets where id = p_budget_id and org_id = p_org_id;
  if not found then
    raise exception 'Budget not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v_fy_end := (b.fy_start + interval '1 year' - interval '1 day')::date;
  v_from := greatest(coalesce(p_from, b.fy_start), b.fy_start);
  v_to := least(coalesce(p_to, v_fy_end), v_fy_end);
  if v_from > v_to then   -- a range outside the budget's year: the whole year
    v_from := b.fy_start;
    v_to := v_fy_end;
  end if;
  with bud as (
    select l.account_id, to_char(l.month, 'YYYY-MM') as m, sum(l.amount) as amount
    from public.acc_budget_lines l
    where l.budget_id = b.id and l.month between date_trunc('month', v_from)::date and v_to
      and (v_branch is null or l.branch_code = v_branch) and (v_dept is null or l.department = v_dept)
    group by l.account_id, to_char(l.month, 'YYYY-MM')
  ), act as (
    select l.account_id, to_char(j.journal_date, 'YYYY-MM') as m,
           sum(case when a.nature = 'income' then l.credit - l.debit else l.debit - l.credit end) as amount
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.entity_id = b.entity_id and j.status in ('posted', 'reversed')
      and j.journal_date between v_from and v_to and a.nature in ('income', 'expense')
      and not app.acc_is_closing_journal(j.source_kind, j.reversal_of)
      and (v_branch is null or l.branch_code = v_branch) and (v_dept is null or l.department = v_dept)
    group by l.account_id, to_char(j.journal_date, 'YYYY-MM')
  ), both_ as (
    select coalesce(bu.account_id, ac.account_id) as account_id, coalesce(bu.m, ac.m) as m,
           coalesce(bu.amount, 0) as budget, coalesce(ac.amount, 0) as actual
    from bud bu full join act ac on ac.account_id = bu.account_id and ac.m = bu.m
  )
  select jsonb_build_object(
    'budget_id', b.id, 'name', b.name, 'status', b.status, 'fy_start', b.fy_start, 'entity_id', b.entity_id,
    'from', v_from, 'to', v_to, 'branch', v_branch, 'department', v_dept,
    'threshold_pct', (app.acc_report_settings(p_org_id) ->> 'budget_variance_pct')::numeric,
    'provisional', not app.acc_range_final(p_org_id, b.entity_id, v_from, v_to),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', x.account_id, 'month', x.m, 'budget', x.budget, 'actual', x.actual)
                       order by x.account_id, x.m)
      from both_ x where x.budget <> 0 or x.actual <> 0), '[]'::jsonb),
    'totals', (select jsonb_build_object(
                 'budget_income', coalesce(sum(case when a.nature = 'income' then x.budget end), 0),
                 'actual_income', coalesce(sum(case when a.nature = 'income' then x.actual end), 0),
                 'budget_expense', coalesce(sum(case when a.nature = 'expense' then x.budget end), 0),
                 'actual_expense', coalesce(sum(case when a.nature = 'expense' then x.actual end), 0))
               from both_ x join public.acc_accounts a on a.id = x.account_id))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_budget_vs_actual(uuid, uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.acc_budget_vs_actual(uuid, uuid, date, date, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Every existing workspace: codes repaired, cash flow classes set
-- ---------------------------------------------------------------------------
select app.acc_integration_repair_codes(id) from public.orgs;

insert into supabase_migrations.schema_migrations (version, name) values ('20261109000900', 'accounting_integration') on conflict (version) do nothing;
