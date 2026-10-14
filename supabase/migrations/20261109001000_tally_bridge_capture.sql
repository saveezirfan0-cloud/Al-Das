-- Phase 22J follow-up: the Tally bridge after the 22K integration pass (docs/22_PHASE_22J_NOTES.md). Needs
-- 20261109000900_accounting_integration (paste 51) applied first.
--
--   * 22K makes the final, literal definition of acc_post_from_source (22A's contract, 22D's ledger start, 22F's four
--     kinds). This is that body verbatim plus the one block 22J needs: with app.acc_capture on (set only by
--     acc_tally_bridge_capture, inside a sub-transaction it always rolls back) the function raises the journal it was
--     given back as the error's DETAIL instead of posting it. The block sits before the per-item lock, so a capture
--     neither posts nor locks anything. A later migration that redefines acc_post_from_source must keep it (the 22J
--     database tests fail without it).
--   * 22K's "one journal per economic event": a received cheque named by an active receipt is posted by that receipt
--     (dated the cheque), never by the register. The bridge's candidates and capture follow the same rule, so Tally
--     gets the receipt only, never the cheque as well. (A voucher paid by cheque already gives 'nothing' in 22D's builder,
--     so the bridge pushes its cheque only.)
--   * Nothing else of 22J was overwritten by 22K (acc_tally_reconcile, app.acc_tally_import_for_update, the source-kind
--     CHECK, can_view_record_history and the access-log entities are untouched by 22J or unchanged by 22K).

-- ---------------------------------------------------------------------------
-- 1. acc_post_from_source: 22K's final body plus the Tally bridge's capture block
-- ---------------------------------------------------------------------------
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

  -- Phase 22J: the Tally bridge reads the journal without posting it (always inside a rolled-back sub-transaction,
  -- app.acc_tally_bridge_capture); nothing is posted and nothing is locked
  if coalesce(current_setting('app.acc_capture', true), '') = 'on' then
    raise exception 'Captured for the Tally bridge.' using errcode = 'check_violation', hint = 'acc_capture',
      detail = jsonb_build_object('entity_id', v_entity, 'source_kind', p_source_kind, 'source_id', p_source_id,
        'version', p_source_version, 'date', p_date, 'voucher_type', p_voucher_type, 'narration', v_narration,
        'lines', p_lines)::text;
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

-- ---------------------------------------------------------------------------
-- 2. The bridge's sources and capture follow 22K's cheque-by-receipt rule (otherwise as 20261109000700)
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_candidates(p_org_id uuid, p_after timestamptz, p_after_key text, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select coalesce((select x.push_sources from public.acc_tally_bridge_settings x where x.org_id = p_org_id), array[]::text[]) as kinds),
  c as (
    select st.source_kind as kind, st.source_id as id,
           case when st.state = 'preview' then 'ready' when st.state in ('withdrawn', 'nothing') then 'gone' end as state,
           st.source_date as d, st.updated_at as stamp
      from public.acc_posting_status st where st.org_id = p_org_id
    union all
    select 'sales_invoice', i.id::text,
           case when i.posting_status = 'waiting_ledger_start' and i.status <> 'draft' then 'ready' end, i.invoice_date, i.updated_at
      from public.acc_sales_invoices i where i.org_id = p_org_id
    union all
    select 'receipt', r.id::text,
           case when r.status <> 'active' then 'gone' when r.posting_status = 'waiting_ledger_start' then 'ready' end,
           r.receipt_date, r.updated_at
      from public.acc_receipts r where r.org_id = p_org_id
    union all
    select 'bank_transfer', t.id::text,
           case when t.status = 'cancelled' then 'gone' when t.status = 'waiting_ledger_start' then 'ready' end,
           t.transfer_date, t.updated_at
      from public.acc_bank_transfers t where t.org_id = p_org_id
    union all
    select 'bank_entry', e.id::text,
           case when e.status = 'cancelled' then 'gone' when e.status = 'waiting_ledger_start' then 'ready' end,
           e.entry_date, e.updated_at
      from public.acc_bank_entries e where e.org_id = p_org_id
    union all
    select 'petty_cash', x.id::text,
           case when x.status = 'cancelled' then 'gone' when x.status = 'waiting_ledger_start' then 'ready' end,
           x.expense_date, x.updated_at
      from public.acc_petty_cash_expenses x where x.org_id = p_org_id
    union all
    select 'cheque', ch.id::text,
           case when ch.posting = 'waiting_ledger_start' and ch.status in ('issued', 'received', 'presented', 'cleared')
                     -- 22K: a received cheque named by a receipt is posted (and pushed) by that receipt
                     and not exists (select 1 from public.acc_receipts rr where rr.cheque_id = ch.id and rr.status = 'active')
                  then 'ready'
                when ch.status in ('bounced', 'cancelled', 'stale') or ch.posting in ('reversed', 'not_posted')
                     or exists (select 1 from public.acc_receipts rr where rr.cheque_id = ch.id and rr.status = 'active')
                  then 'gone' end,
           ch.cheque_date, ch.updated_at
      from public.acc_cheques ch where ch.org_id = p_org_id
    union all
    select 'fixed_asset', r.id::text, case when r.status = 'waiting_ledger_start' then 'ready' end,
           (r.period_month + interval '1 month' - interval '1 day')::date, r.updated_at
      from public.acc_depreciation_runs r where r.org_id = p_org_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'id', x.id, 'state', x.state, 'date', x.d,
                                               'stamp', x.stamp, 'key', x.k) order by x.stamp, x.k), '[]'::jsonb)
  from (
    select c.kind, c.id, c.state, c.d, c.stamp, c.kind || '|' || c.id as k
    from c, s
    where c.state is not null
      and c.kind = any (s.kinds)
      and c.stamp < now() - interval '2 minutes'
      and (p_after is null or (c.stamp, c.kind || '|' || c.id) > (p_after, coalesce(p_after_key, '')))
    order by c.stamp, c.kind || '|' || c.id
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) x;
$$;
revoke all on function public.acc_tally_bridge_candidates(uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_candidates(uuid, timestamptz, text, integer) to service_role;

create or replace function public.acc_tally_bridge_capture(p_org_id uuid, p_kind text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid uuid;
  v_hint text;
  v_detail text;
  r public.acc_depreciation_runs;
  v_lines jsonb;
  v_desc text;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_uuid := p_id::uuid;
  if p_kind = 'fixed_asset' then
    select * into r from public.acc_depreciation_runs where id = v_uuid and org_id = p_org_id;
    if not found or r.status <> 'waiting_ledger_start' then
      return null;
    end if;
    v_desc := case r.kind when 'depreciation' then 'Depreciation ' when 'schedules' then 'Schedule releases '
                          else 'Reversing accruals ' end || to_char(r.period_month, 'YYYY-MM');
    select coalesce(jsonb_agg(x.line order by x.k, x.side), '[]'::jsonb) into v_lines
    from (
      select g.k, s.side, case s.side
               when 1 then jsonb_build_object('account_id', g.debit_account_id, 'debit', g.amt, 'credit', 0,
                                              'branch_code', g.branch_code, 'department', g.department, 'description', v_desc)
               else jsonb_build_object('account_id', g.credit_account_id, 'debit', 0, 'credit', g.amt,
                                       'branch_code', g.branch_code, 'department', g.department, 'description', v_desc) end as line
      from (
        select l.debit_account_id, l.credit_account_id, l.branch_code, l.department, sum(l.amount) as amt,
               l.debit_account_id::text || '|' || l.credit_account_id::text || '|' || coalesce(l.branch_code, '') || '|' ||
               coalesce(l.department, '') as k
        from public.acc_asset_run_lines l where l.run_id = r.id and l.version = r.version
        group by l.debit_account_id, l.credit_account_id, l.branch_code, l.department
      ) g cross join (values (1), (2)) as s (side)
    ) x;
    return jsonb_build_object('entity_id', r.entity_id, 'source_kind', 'fixed_asset', 'source_id', r.id, 'version', r.version,
      'date', (r.period_month + interval '1 month' - interval '1 day')::date, 'voucher_type', 'journal',
      'narration', case r.kind when 'depreciation' then 'Depreciation for ' when 'schedules' then 'Schedule releases for '
                               else 'Reversing accruals for ' end || to_char(r.period_month, 'YYYY-MM'),
      'run_kind', r.kind, 'reverse_on', case when r.kind = 'reversing_accruals'
                                              then (r.period_month + interval '1 month')::date end,
      'lines', v_lines);
  end if;
  if not (
    (p_kind = 'sales_invoice' and exists (select 1 from public.acc_sales_invoices x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.posting_status = 'waiting_ledger_start'))
    or (p_kind = 'receipt' and exists (select 1 from public.acc_receipts x where x.id = v_uuid and x.org_id = p_org_id
                                       and x.status = 'active' and x.posting_status = 'waiting_ledger_start'))
    or (p_kind = 'bank_transfer' and exists (select 1 from public.acc_bank_transfers x where x.id = v_uuid and x.org_id = p_org_id
                                             and x.status = 'waiting_ledger_start'))
    or (p_kind = 'bank_entry' and exists (select 1 from public.acc_bank_entries x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.status = 'waiting_ledger_start'))
    or (p_kind = 'petty_cash' and exists (select 1 from public.acc_petty_cash_expenses x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.status = 'waiting_ledger_start'))
    or (p_kind = 'cheque' and exists (select 1 from public.acc_cheques x where x.id = v_uuid and x.org_id = p_org_id
                                      and x.posting = 'waiting_ledger_start'
                                      and x.status in ('issued', 'received', 'presented', 'cleared'))
        -- 22K: a cheque named by an active receipt is that receipt's journal, never a second one
        and not exists (select 1 from public.acc_receipts rc where rc.cheque_id = v_uuid and rc.status = 'active'))) then
    return null;
  end if;
  begin
    perform set_config('app.acc_capture', 'on', true);
    case p_kind
      when 'sales_invoice' then perform app.acc_sales_doc_post(v_uuid);
      when 'receipt' then perform app.acc_receipt_post(v_uuid);
      when 'bank_transfer' then perform app.acc_banking_post_item('transfer', v_uuid);
      when 'bank_entry' then perform app.acc_banking_post_item('entry', v_uuid);
      when 'petty_cash' then perform app.acc_banking_post_item('expense', v_uuid);
      when 'cheque' then perform app.acc_banking_post_item('cheque', v_uuid);
    end case;
    raise exception 'Nothing to capture.' using errcode = 'check_violation', hint = 'acc_capture_none';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    if v_hint = 'acc_capture' then
      return v_detail::jsonb;
    elsif v_hint = 'acc_capture_none' then
      return null;
    end if;
    return jsonb_build_object('error', coalesce(nullif(v_hint, ''), 'error'));
  end;
end;
$$;
revoke all on function public.acc_tally_bridge_capture(uuid, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_capture(uuid, text, text) to service_role;
