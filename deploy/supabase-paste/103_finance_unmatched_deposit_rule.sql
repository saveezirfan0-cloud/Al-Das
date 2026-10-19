-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 102_finance_deposit_groups.sql.

-- W3 follow-up 4, unmatched deposits (docs/47_W3_W5_INSURANCE_NOTES.md, docs/48_FOLLOWUPS_DEPOSITS_NOTES.md).
--
-- A bank credit on the account that receives insurers' payments that is still unmatched and unexplained after the
-- threshold opens an exception (rule E15, owner Finance, threshold in fin_ref_exception_rules, default 10 days).
--   1. ops_exceptions.entity_type allows 'deposit' (the existing list is read from the constraint and kept)
--   2. the E15 row for every org, and seed_finance_reference (from its last definition, 20261024000100) seeds it
--   3. fin_run_exception_rules from its last definition (20261021000100) with every earlier rule unchanged plus E15
-- Idempotent like every rule (app.fin_reconcile opens what should be open, auto-closes what cleared).

-- ---------------------------------------------------------------------------
-- 1. entity_type 'deposit' (keeps whatever the constraint already allows)
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.ops_exceptions'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%entity_type%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.ops_exceptions drop constraint %I', c.conname);
  end loop;
  v_list := coalesce(v_list, array['invoice', 'claim', 'batch', 'file', 'visit']);
  if not ('deposit' = any (v_list)) then
    v_list := array_append(v_list, 'deposit');
  end if;
  execute format('alter table public.ops_exceptions add constraint ops_exceptions_entity_type_check check (entity_type in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 2. The rule row (existing orgs now, new orgs through seed_finance_reference)
-- ---------------------------------------------------------------------------
insert into public.fin_ref_exception_rules (org_id, rule_code, description, owner_role, threshold_days)
select o.id, 'E15', 'Insurer-account bank credit still unmatched and unexplained after N days', 'finance', 10
from public.orgs o
on conflict (org_id, rule_code) do nothing;

create or replace function public.seed_finance_reference(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.fin_ref_branches (org_id, code, name) values
    (p_org_id, 'P', 'Palm Jumeirah'),
    (p_org_id, 'M', 'Meadows'),
    (p_org_id, 'G', 'Golden Mile')
  on conflict (org_id, code) do nothing;

  insert into public.fin_ref_exception_rules (org_id, rule_code, description, owner_role, threshold_days) values
    (p_org_id, 'E01', 'Insurance invoice with no claim activity after N days',                         'insurance', 30),
    (p_org_id, 'E02', 'Claim activity with no matching Unite invoice',                                 'insurance', null),
    (p_org_id, 'E03', 'Claimed amount differs from invoiced line amount, or ambiguous line match',     'billing',   null),
    (p_org_id, 'E04', 'Rejected or partially rejected claim not resubmitted after N days',             'insurance', 14),
    (p_org_id, 'E05', 'Outstanding insurance balance older than N days',                               'insurance', 60),
    (p_org_id, 'E06', 'Claim activity in the previous Diligence file but missing from the latest',     'insurance', null),
    (p_org_id, 'E07', 'Unknown clinic / branch on an invoice',                                         'admin',     null),
    (p_org_id, 'E08', 'AppointmentId not found in appointments',                                       'admin',     null),
    (p_org_id, 'E09', 'Capture failure, count mismatch, or gap in the invoice number sequence',        'admin',     null),
    (p_org_id, 'E10', 'Diligence file failed validation',                                              'insurance', null),
    (p_org_id, 'E11', 'Billed service with no visit record for the patient and date (review signal)',   'insurance', null),
    (p_org_id, 'E12', 'Recorded visit with no invoice for the patient and date (review signal)',        'billing',   null),
    (p_org_id, 'E13', 'The same service billed more than once on one invoice',                          'billing',   null),
    (p_org_id, 'E14', 'Claim matched an invoice but no invoice line for the claimed service',           'billing',   null),
    (p_org_id, 'E15', 'Insurer-account bank credit still unmatched and unexplained after N days',       'finance',   10)
  on conflict (org_id, rule_code) do nothing;

  insert into public.fin_capture_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  -- Phase 18
  insert into public.fin_ref_finance_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  -- Starter denial-code families. PLACEHOLDERS: replace with the payers' real code lists (Finance, Reference data).
  insert into public.fin_ref_denial_codes (org_id, code, is_family, description, category, default_owner_role, resubmit_days, appealable, is_placeholder) values
    (p_org_id, 'AUTH', true, 'Prior authorisation missing or not valid for the service', 'authorization',     'insurance', 30, true,  true),
    (p_org_id, 'ELIG', true, 'Member not eligible or cover not active on the service date', 'eligibility',     'billing',   30, true,  true),
    (p_org_id, 'MNEC', true, 'Service not considered medically necessary',                'medical_necessity', 'insurance', 30, true,  true),
    (p_org_id, 'CODE', true, 'Coding or billing error (code, modifier, quantity)',         'coding',            'billing',   30, true,  true),
    (p_org_id, 'CLAI', true, 'Claim documentation missing or incomplete',                  'documentation',     'insurance', 30, true,  true),
    (p_org_id, 'DUPL', true, 'Duplicate of a claim already submitted or paid',             'duplicate',         'billing',   15, false, true),
    (p_org_id, 'TIME', true, 'Submitted after the payer''s filing limit',                  'timely_filing',     'finance',   15, false, true),
    (p_org_id, 'PRCE', true, 'Price differs from the agreed payer price list',             'pricing',           'finance',   30, true,  true)
  on conflict (org_id, code) do nothing;

  -- Phase 20D: delegation of authority
  perform app.fin_seed_payables(p_org_id);
end;
$$;
revoke all on function public.seed_finance_reference(uuid) from public, anon, authenticated;
grant execute on function public.seed_finance_reference(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The engine (every earlier rule unchanged; E15 added)
-- ---------------------------------------------------------------------------
create or replace function public.fin_run_exception_rules(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ctx record;
  rule record;
  v_result jsonb := '{}'::jsonb;
  v_desired jsonb;
  v_window date;
  v_set record;
  v_visits_from date;
  v_bank_window integer;
  v_first_remit date;
begin
  select * into ctx from public.fin_rules_context(p_org_id);
  select window_from into v_window from public.fin_capture_settings where org_id = p_org_id;
  select evidence_start_date, evidence_grace_days into v_set from public.fin_ref_finance_settings where org_id = p_org_id;
  select min(v.visit_date) into v_visits_from from public.visits v where v.org_id = p_org_id and not v.is_test_record;
  select bank_date_window_days into v_bank_window from public.fin_ref_finance_settings where org_id = p_org_id;
  select min(coalesce(b.paid_on, b.created_at::date)) into v_first_remit
    from public.ins_remittance_batches b where b.org_id = p_org_id;

  for rule in
    select rule_code, threshold_days from public.fin_ref_exception_rules
    where org_id = p_org_id and active and rule_code in ('E01', 'E02', 'E03', 'E04', 'E05', 'E07', 'E08', 'E09', 'E11', 'E12', 'E13', 'E14', 'E15')
    order by rule_code
  loop
    v_desired := null;

    if rule.rule_code = 'E01' then
      if ctx.claims_fresh and rule.threshold_days is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'invoice', 'entity_key', i.inv_display_number, 'branch_code', i.branch_code,
                 'detail', jsonb_build_object('days', current_date - i.transaction_date, 'net', i.net, 'inv_type', i.inv_type))), '[]'::jsonb)
        into v_desired
        from public.fin_invoices i
        where i.org_id = p_org_id and not i.is_deleted and public.fin_is_insurance_type(i.inv_type)
          and coalesce(i.net, 0) > 0 and i.transaction_date <= current_date - rule.threshold_days
          and not exists (
            select 1 from public.ins_claim_activities c
            where c.org_id = i.org_id
              and (c.matched_invoice_id = i.id
                   or upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = i.inv_key));
      end if;

    elsif rule.rule_code = 'E02' then
      if ctx.capture_drained then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'claim', 'entity_key', c.claim_activity_number, 'branch_code', null,
                 'detail', jsonb_build_object('invoice_no', c.invoice_no, 'reason', c.match_reason, 'net', c.net))), '[]'::jsonb)
        into v_desired
        from public.ins_claim_activities c
        where c.org_id = p_org_id and c.match_reason in ('no_invoice', 'invoice_deleted');
      end if;

    elsif rule.rule_code = 'E03' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity_type', 'claim', 'entity_key', c.claim_activity_number, 'branch_code', i.branch_code,
               'detail', jsonb_build_object('invoice_no', c.invoice_no, 'reason', c.match_reason, 'claimed', c.initial_net))), '[]'::jsonb)
      into v_desired
      from public.ins_claim_activities c
      left join public.fin_invoices i on i.id = c.matched_invoice_id
      where c.org_id = p_org_id and c.match_reason in ('amount_mismatch', 'ambiguous');

    elsif rule.rule_code = 'E04' then
      if rule.threshold_days is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'claim', 'entity_key', c.claim_activity_number, 'branch_code', i.branch_code,
                 'detail', jsonb_build_object('invoice_no', c.invoice_no, 'rejected', c.rejected, 'denial_type', c.denial_type,
                          'days', current_date - coalesce(c.last_remittance_date, c.transaction_date)))), '[]'::jsonb)
        into v_desired
        from public.ins_claim_activities c
        left join public.fin_invoices i on i.id = c.matched_invoice_id
        where c.org_id = p_org_id and coalesce(c.rejected, 0) > 0 and coalesce(c.resubmission_count, 0) = 0
          and not coalesce(c.settled, false) and lower(coalesce(c.write_off_status, '')) <> 'approved'
          and coalesce(c.last_remittance_date, c.transaction_date) <= current_date - rule.threshold_days;
      end if;

    elsif rule.rule_code = 'E05' then
      if rule.threshold_days is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'invoice', 'entity_key', g.entity_key, 'branch_code', g.branch_code,
                 'detail', jsonb_build_object('outstanding', g.outstanding, 'days', current_date - g.oldest))), '[]'::jsonb)
        into v_desired
        from (
          select coalesce(max(i.inv_display_number), max(c.invoice_no)) as entity_key,
                 max(i.branch_code) as branch_code,
                 sum(o.outstanding) as outstanding,
                 min(c.transaction_date) filter (where o.outstanding > 0) as oldest
          from public.ins_claim_activities c
          left join public.fin_invoices i on i.id = c.matched_invoice_id
          cross join lateral (
            select greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                            - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as outstanding
          ) o
          where c.org_id = p_org_id and c.transaction_date is not null
          group by upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g'))
        ) g
        where g.outstanding > 0.01 and g.oldest <= current_date - rule.threshold_days;
      end if;

    elsif rule.rule_code = 'E07' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity_type', 'invoice', 'entity_key', i.inv_display_number, 'branch_code', null,
               'detail', jsonb_build_object('unite_clinic_long_name', i.unite_clinic_long_name))), '[]'::jsonb)
      into v_desired
      from public.fin_invoices i
      where i.org_id = p_org_id and i.branch_code is null and not i.is_deleted;

    elsif rule.rule_code = 'E08' then
      if ctx.appointments_from is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'invoice', 'entity_key', i.inv_display_number, 'branch_code', i.branch_code,
                 'detail', jsonb_build_object('appointment_id', i.appointment_id))), '[]'::jsonb)
        into v_desired
        from public.fin_invoices i
        where i.org_id = p_org_id and not i.is_deleted and btrim(coalesce(i.appointment_id, '')) <> ''
          and i.transaction_date > ctx.appointments_from
          and not exists (
            select 1 from public.appointments a
            where a.org_id = i.org_id and a.source = 'unite' and a.external_id = btrim(i.appointment_id));
      end if;

    elsif rule.rule_code = 'E09' then
      if ctx.capture_drained and v_window is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'batch', 'entity_key', 'gap:' || g.series || ':' || g.missing_from || '-' || g.missing_to,
                 'branch_code', null,
                 'detail', jsonb_build_object('series', g.series, 'from', g.missing_from, 'to', g.missing_to, 'missing', g.missing_count))), '[]'::jsonb)
        into v_desired
        from (select * from public.fin_invoice_number_gaps(p_org_id, v_window) limit 200) g;
      end if;

    -- E11: billed, but no visit record for that patient around that date. A REVIEW SIGNAL, never proof that care
    -- was or was not given (blueprint p3). Off until evidence_start_date is set; silent without a visit feed.
    elsif rule.rule_code = 'E11' then
      if v_set.evidence_start_date is not null and v_visits_from is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'invoice', 'entity_key', i.inv_display_number, 'branch_code', i.branch_code,
                 'detail', jsonb_build_object('date', i.transaction_date, 'net', i.net, 'inv_type', i.inv_type))), '[]'::jsonb)
        into v_desired
        from public.fin_invoices i
        where i.org_id = p_org_id and not i.is_deleted and coalesce(i.net, 0) > 0
          and btrim(coalesce(i.patient_pin, '')) <> ''
          and i.transaction_date >= greatest(v_set.evidence_start_date, v_visits_from)
          and i.transaction_date <= current_date - v_set.evidence_grace_days
          and not exists (
            select 1 from public.visits v
            join public.contacts c on c.id = v.contact_id and c.org_id = v.org_id
            where v.org_id = i.org_id and not v.is_test_record and c.external_id = i.patient_pin
              and v.visit_date between i.transaction_date - v_set.evidence_grace_days
                                   and i.transaction_date + v_set.evidence_grace_days);
      end if;

    -- E12: a recorded visit with no invoice for that patient around that date (possible missed billing).
    elsif rule.rule_code = 'E12' then
      if v_set.evidence_start_date is not null and ctx.capture_drained then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'visit', 'entity_key', v.external_id, 'branch_code', null,
                 'detail', jsonb_build_object('date', v.visit_date, 'department', v.department_mapped))), '[]'::jsonb)
        into v_desired
        from public.visits v
        join public.contacts c on c.id = v.contact_id and c.org_id = v.org_id
        where v.org_id = p_org_id and not v.is_test_record and btrim(coalesce(c.external_id, '')) <> ''
          and v.visit_date >= v_set.evidence_start_date
          and v.visit_date <= current_date - v_set.evidence_grace_days
          and v.visit_date >= (select min(i2.transaction_date) from public.fin_invoices i2 where i2.org_id = p_org_id)
          and not exists (
            select 1 from public.fin_invoices i
            where i.org_id = v.org_id and not i.is_deleted and i.patient_pin = c.external_id
              and i.transaction_date between v.visit_date - v_set.evidence_grace_days
                                         and v.visit_date + v_set.evidence_grace_days);
      end if;

    -- E13: the same service (item, quantity, amount) billed more than once on one invoice.
    elsif rule.rule_code = 'E13' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity_type', 'invoice', 'entity_key', d.inv_display_number, 'branch_code', d.branch_code,
               'detail', jsonb_build_object('repeated_groups', d.groups, 'extra_lines', d.extra_lines, 'extra_amount', d.extra_amount))), '[]'::jsonb)
      into v_desired
      from (
        select g.inv_display_number, max(g.branch_code) as branch_code, count(*) as groups,
               sum(g.n - 1) as extra_lines, sum((g.n - 1) * coalesce(g.line_net, 0)) as extra_amount
        from (
          select i.inv_display_number, i.branch_code, l.item_code, l.qty, l.line_net, count(*) as n
          from public.fin_invoices i
          join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
          where i.org_id = p_org_id and not i.is_deleted
          group by i.id, i.inv_display_number, i.branch_code, l.item_code, l.qty, l.line_net
          having count(*) > 1
        ) g
        group by g.inv_display_number
      ) d;

    -- E14: the claim found its invoice but no invoice line for the claimed service.
    elsif rule.rule_code = 'E14' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'entity_type', 'claim', 'entity_key', c.claim_activity_number, 'branch_code', i.branch_code,
               'detail', jsonb_build_object('invoice_no', c.invoice_no, 'cpt', c.cpt_code, 'claimed', c.net))), '[]'::jsonb)
      into v_desired
      from public.ins_claim_activities c
      left join public.fin_invoices i on i.id = c.matched_invoice_id
      where c.org_id = p_org_id and c.match_reason = 'no_line';

    -- E15 (docs/48): a credit on the account that receives insurers' payments, still unexplained after the threshold:
    -- not matched by a reconciliation or a bank entry (fin_bank_lines.match_status), no live allocation in the insurer
    -- matching (fin_match_decisions), and no reason given in a reconciliation (fin_bank_rec_notes 'bank|<line id>').
    -- Guards against start-up false alarms: off without a threshold; never before the account's first reconciliation
    -- period or before the first remittance advice was loaded (history imported before either is never flagged); and
    -- never inside the bank date window. Ids, dates and amounts only (never the reference or description).
    elsif rule.rule_code = 'E15' then
      if rule.threshold_days is not null and v_first_remit is not null then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'entity_type', 'deposit', 'entity_key', l.id::text, 'branch_code', null,
                 'detail', jsonb_build_object('account_id', l.account_id, 'value_date', l.value_date, 'amount', l.amount,
                          'days', current_date - l.value_date))), '[]'::jsonb)
        into v_desired
        from public.fin_bank_lines l
        join public.fin_bank_accounts a on a.id = l.account_id and a.org_id = l.org_id and a.receives_insurance
        where l.org_id = p_org_id and l.amount > 0 and l.match_status = 'unmatched'
          and l.value_date <= current_date - greatest(rule.threshold_days, coalesce(v_bank_window, 0))
          and l.value_date >= v_first_remit
          and exists (
            select 1 from public.fin_bank_recs r
            where r.org_id = l.org_id and r.account_id = l.account_id and r.period_start <= l.value_date)
          and not exists (
            select 1 from public.fin_match_decisions d
            where d.org_id = l.org_id and d.bank_line_id = l.id and d.decision = 'accepted' and d.undone_at is null)
          and not exists (
            select 1 from public.fin_bank_rec_notes n
            where n.org_id = l.org_id and n.item_key = 'bank|' || l.id::text);
      end if;
    end if;

    if v_desired is null then
      v_result := v_result || jsonb_build_object(rule.rule_code, jsonb_build_object('skipped', true));
    else
      v_result := v_result || jsonb_build_object(
        rule.rule_code,
        app.fin_reconcile(p_org_id, rule.rule_code, v_desired, case when rule.rule_code = 'E09' then 'gap:' else null end));
    end if;
  end loop;

  perform public.fin_escalate_exceptions(p_org_id);
  return v_result;
end;
$$;
