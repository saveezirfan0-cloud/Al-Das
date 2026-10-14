-- Paste into Supabase > SQL Editor > New query, then Run. Needs 35_finance_labs.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20G part 2: the Board pack control summary (docs/20_PHASE_20G_NOTES.md, "Part 2: Board pack controls").
--
--   * fin_close_controls(org, month, today): one control summary for the month-end pack, frozen into the close snapshot
--     (and so covered by its sha256) when the pack is built. Counts, amounts, statuses and dates only: no patient, payee,
--     supplier or doctor detail. SECURITY DEFINER, search_path = '', service role only; the server checks the close
--     permission first.
--   * Each block is null ("not set up") when its feature holds no data, never a misleading zero.
--   * Three thresholds on fin_ref_finance_settings for the "matters needing attention" list (the list itself is derived
--     in lib/finance/close-controls.ts from this summary and frozen with it). The bank and exception age limit reuses
--     close_item_max_age_days (20G).

alter table public.fin_ref_finance_settings
  add column close_revshare_wd smallint not null default 7 check (close_revshare_wd between 1 and 23),
  add column close_voucher_unpaid_days integer not null default 14 check (close_voucher_unpaid_days between 1 and 365),
  add column close_receivables_over90_pct numeric(5, 2) not null default 25
    check (close_receivables_over90_pct between 0 and 100);

-- As of what:
--   * payables (supplier invoices) are as at the month end: dated on or before it, not paid by a voucher whose payment
--     date is on or before it;
--   * bank: this month's reconciliation per account; bank credits dated on or before the month end that are still
--     unmatched and carry no reason in any reconciliation; their age is at the build date;
--   * everything else (vouchers, revenue-share runs and liability, receivables, the timetable, exceptions) is the state
--     at the build date (p_today, default today in the clinic's time zone), like the pack's receivables ageing.
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
    with inv as (
      select i.total, v_end - i.invoice_date as age
      from public.fin_supplier_invoices i
      where i.org_id = p_org_id and i.status <> 'void' and i.invoice_date <= v_end
        and not exists (select 1 from public.fin_voucher_invoices vi
                        join public.fin_payment_vouchers v on v.id = vi.voucher_id
                        where vi.supplier_invoice_id = i.id and v.status = 'paid' and v.payment_date <= v_end)
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
    'exceptions', v_exceptions);
end;
$$;
revoke all on function public.fin_close_controls(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_close_controls(uuid, date, date) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261106000100', 'finance_close_controls') on conflict (version) do nothing;
