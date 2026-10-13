-- Finance F8 (Integration Blueprint v2): the parts of the blueprint Phase 18 did not cover.
--
--   1. permissions + a "Cost / Payroll" role (cost and payroll data is separate from revenue and P&L, p4)
--   2. settings: doctor basis (ordering / performing), evidenced claim statuses, completion-evidence window,
--      escalation window and role
--   3. cost inputs (service cost, doctor compensation, overhead pools) + approval of a month; the CALCULATION is
--      in lib/finance/profitability.ts and every result is labelled provisional until a month is approved
--   4. pseudonymous reporting patient ID (keyed hash of the PIN; the key lives in Vault, never in the repo)
--   5. ordering / performing doctor stored separately from the invoice's single doctor
--   6. exception rules E11 (billed, no visit record), E12 (visit, not billed), E13 (duplicate billed lines),
--      E14 (claim without an invoice line) and escalation of overdue exceptions
--   7. v_fin_monthly_measures (accepted only when evidenced, paid from remittance allocations) and the
--      data-freshness view with coverage dates
--   8. service-role-only report inputs: fin_profit_inputs, fin_doctor_measures
--
-- Cost tables hold amounts and codes only: no patient data. Browsers can read (by permission) but never write;
-- every write is a server action or job using the service role after can() (CLAUDE.md rules 1 and 2).

-- ---------------------------------------------------------------------------
-- 1. Permissions and the Cost / Payroll role
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.costs.manage'),
      ('Finance', 'finance.costs.view'),
      ('Finance', 'finance.costs.compensation'),
      ('Finance', 'finance.profit.view'),
      ('Finance', 'finance.profit.approve'),
      ('CEO', 'finance.profit.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Cost / Payroll',
       'Service costs, overheads and (when authorised) doctor compensation. No access to revenue detail or the consolidated P&L.',
       '["finance.costs.manage","finance.costs.view","finance.costs.compensation"]'::jsonb, true
from public.orgs o
on conflict (org_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  -- which doctor governs revenue measures; null = not decided, reports show the invoice doctor and say so
  add column doctor_basis text check (doctor_basis is null or doctor_basis in ('ordering', 'performing')),
  -- claim statuses that evidence acceptance (a remitted amount always does); matched case-insensitively
  add column accepted_claim_statuses text[] not null default '{}',
  -- E11 / E12: records before this date are never flagged; null = the check is switched off
  add column evidence_start_date date,
  add column evidence_grace_days integer not null default 2 check (evidence_grace_days between 0 and 30),
  -- overdue exceptions move to this role after this many days past their due date
  add column escalation_days integer not null default 14 check (escalation_days between 1 and 365),
  add column escalation_role text not null default 'finance' check (escalation_role in ('insurance', 'billing', 'finance', 'admin'));

-- ---------------------------------------------------------------------------
-- 3. Exceptions: new entity type, escalation columns, rules E11-E14
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.ops_exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%entity_type%'
  loop
    execute format('alter table public.ops_exceptions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.ops_exceptions
  add constraint ops_exceptions_entity_type_check check (entity_type in ('invoice', 'claim', 'batch', 'file', 'visit')),
  add column escalated_at timestamptz,
  add column escalated_from_role text check (escalated_from_role is null or escalated_from_role in ('insurance', 'billing', 'finance', 'admin'));

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
    (p_org_id, 'E14', 'Claim matched an invoice but no invoice line for the claimed service',           'billing',   null)
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
end;
$$;

select public.seed_finance_reference(id) from public.orgs;

-- Overdue exceptions move to the escalation role once (the original owner is kept in escalated_from_role).
create or replace function public.fin_escalate_exceptions(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  n integer;
begin
  select escalation_days, escalation_role into s from public.fin_ref_finance_settings where org_id = p_org_id;
  if s is null then
    return 0;
  end if;
  update public.ops_exceptions e
     set escalated_from_role = e.owner_role, owner_role = s.escalation_role, escalated_at = now()
   where e.org_id = p_org_id and e.status in ('open', 'in_progress') and e.escalated_at is null
     and e.due_date is not null and e.due_date + s.escalation_days < current_date;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.fin_escalate_exceptions(uuid) from public, anon, authenticated;
grant execute on function public.fin_escalate_exceptions(uuid) to service_role;

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
begin
  select * into ctx from public.fin_rules_context(p_org_id);
  select window_from into v_window from public.fin_capture_settings where org_id = p_org_id;
  select evidence_start_date, evidence_grace_days into v_set from public.fin_ref_finance_settings where org_id = p_org_id;
  select min(v.visit_date) into v_visits_from from public.visits v where v.org_id = p_org_id and not v.is_test_record;

  for rule in
    select rule_code, threshold_days from public.fin_ref_exception_rules
    where org_id = p_org_id and active and rule_code in ('E01', 'E02', 'E03', 'E04', 'E05', 'E07', 'E08', 'E09', 'E11', 'E12', 'E13', 'E14')
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


-- ---------------------------------------------------------------------------
-- 4. Cost inputs
-- ---------------------------------------------------------------------------
-- Unite's own cost price is 0 today, and 0 means UNAVAILABLE, not free (blueprint p4). These tables hold the
-- Finance-maintained costs instead; a cost of 0 is therefore refused.
create table public.fin_cost_services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  item_code text not null check (btrim(item_code) <> ''),
  effective_from date not null,
  unit_cost numeric(14, 2) not null check (unit_cost > 0),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, item_code, effective_from)
);

create table public.fin_cost_doctor_comp (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  doctor_dha_id text not null check (btrim(doctor_dha_id) <> ''),
  amount numeric(14, 2) not null check (amount >= 0),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, month, doctor_dha_id)
);

create table public.fin_cost_overheads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  branch_code text check (branch_code is null or branch_code ~ '^[A-Z0-9]{1,4}$'),  -- null = shared across branches
  pool text not null check (btrim(pool) <> ''),
  amount numeric(14, 2) not null check (amount >= 0),
  basis text not null default 'revenue' check (basis in ('revenue', 'invoices', 'equal')),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index fin_cost_overheads_uidx on public.fin_cost_overheads (org_id, month, coalesce(branch_code, ''), lower(pool));

-- Finance approves a month once its costs are complete; until then every profit figure is "provisional".
create table public.fin_cost_periods (
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (org_id, month),
  check (status = 'draft' or (approved_by is not null and approved_at is not null))
);
create trigger fin_cost_periods_set_updated_at before update on public.fin_cost_periods
  for each row execute function app.set_updated_at();

-- An approved month's compensation and overheads cannot change (reopen the month first, which is audited).
create or replace function app.fin_cost_month_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_month date;
  v_org uuid;
begin
  v_month := case when tg_op = 'DELETE' then old.month else new.month end;
  v_org := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  if exists (select 1 from public.fin_cost_periods p where p.org_id = v_org and p.month = v_month and p.status = 'approved') then
    raise exception 'the month % is approved; reopen it before changing its costs', v_month using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger fin_cost_doctor_comp_month_guard before insert or update or delete on public.fin_cost_doctor_comp
  for each row execute function app.fin_cost_month_guard();
create trigger fin_cost_overheads_month_guard before insert or update or delete on public.fin_cost_overheads
  for each row execute function app.fin_cost_month_guard();

alter table public.fin_cost_services enable row level security;
alter table public.fin_cost_doctor_comp enable row level security;
alter table public.fin_cost_overheads enable row level security;
alter table public.fin_cost_periods enable row level security;

-- Browsers may READ by permission; there is no insert / update / delete policy (writes are server-side only).
create policy fin_cost_services_select on public.fin_cost_services for select to authenticated
  using (app.has_perm(org_id, 'finance.costs.view') or app.has_perm(org_id, 'finance.costs.manage'));
create policy fin_cost_overheads_select on public.fin_cost_overheads for select to authenticated
  using (app.has_perm(org_id, 'finance.costs.view') or app.has_perm(org_id, 'finance.costs.manage'));
-- doctor compensation is a separate, specifically authorised permission
create policy fin_cost_doctor_comp_select on public.fin_cost_doctor_comp for select to authenticated
  using (app.has_perm(org_id, 'finance.costs.compensation'));
create policy fin_cost_periods_select on public.fin_cost_periods for select to authenticated
  using (app.has_perm(org_id, 'finance.costs.view') or app.has_perm(org_id, 'finance.costs.manage')
         or app.has_perm(org_id, 'finance.profit.view'));

-- ---------------------------------------------------------------------------
-- 5. Pseudonymous reporting patient ID
-- ---------------------------------------------------------------------------
-- A keyed hash of the Unite PIN. The key is the Vault secret 'finance_ref_key' (at least 16 characters). Without it the
-- result is NULL (fail closed). Analytical outputs use this ID, never the PIN; the PIN stays on staff drill-down screens.
create or replace function app.fin_patient_ref(p_pin text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k text;
begin
  if p_pin is null or btrim(p_pin) = '' then
    return null;
  end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'finance_ref_key' limit 1;
  if k is null or char_length(k) < 16 then
    return null;
  end if;
  return 'P-' || substr(encode(sha256(convert_to(k || ':' || btrim(p_pin), 'UTF8')), 'hex'), 1, 16);
end;
$$;
revoke all on function app.fin_patient_ref(text) from public, anon, authenticated;

alter table public.fin_invoices add column patient_ref text;
create index fin_invoices_patient_ref_idx on public.fin_invoices (org_id, patient_ref) where patient_ref is not null;

create or replace function app.fin_invoice_set_patient_ref()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.patient_ref := app.fin_patient_ref(new.patient_pin);
  return new;
end;
$$;
create trigger fin_invoices_patient_ref before insert or update of patient_pin on public.fin_invoices
  for each row execute function app.fin_invoice_set_patient_ref();

-- Fill the reference for existing rows once the key exists (call repeatedly until it returns 0).
create or replace function public.fin_backfill_patient_refs(p_org_id uuid, p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.fin_invoices i
     set patient_ref = app.fin_patient_ref(i.patient_pin)
   where i.id in (
     select x.id from public.fin_invoices x
     where x.org_id = p_org_id and x.patient_ref is null and btrim(coalesce(x.patient_pin, '')) <> ''
     limit greatest(1, least(p_limit, 50000)));
  get diagnostics n = row_count;
  return case when app.fin_patient_ref('probe') is null then 0 else n end;
end;
$$;
revoke all on function public.fin_backfill_patient_refs(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_backfill_patient_refs(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Ordering / performing doctor (kept apart from the invoice's single doctor; never overwritten)
-- ---------------------------------------------------------------------------
alter table public.fin_invoices
  add column ordering_doctor_dha_id text,
  add column ordering_doctor_name text,
  add column performing_doctor_dha_id text,
  add column performing_doctor_name text;

-- p_rows: [{inv, ordering_id, ordering_name, performing_id, performing_name}]; only supplied values are written.
create or replace function public.fin_set_invoice_doctor_roles(p_org_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be an array' using errcode = 'check_violation';
  end if;
  update public.fin_invoices i
     set ordering_doctor_dha_id = coalesce(nullif(btrim(x.ordering_id), ''), i.ordering_doctor_dha_id),
         ordering_doctor_name = coalesce(nullif(btrim(x.ordering_name), ''), i.ordering_doctor_name),
         performing_doctor_dha_id = coalesce(nullif(btrim(x.performing_id), ''), i.performing_doctor_dha_id),
         performing_doctor_name = coalesce(nullif(btrim(x.performing_name), ''), i.performing_doctor_name)
    from jsonb_to_recordset(p_rows) as x (inv text, ordering_id text, ordering_name text, performing_id text, performing_name text)
   where i.org_id = p_org_id and i.inv_key = upper(regexp_replace(x.inv, '\s+', '', 'g'));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.fin_set_invoice_doctor_roles(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fin_set_invoice_doctor_roles(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Measures and freshness
-- ---------------------------------------------------------------------------
-- The five measures are separate, not consecutive stages (blueprint p4):
--   generated = invoice net; claimed = Diligence net; accepted = claimed amount whose claim has EVIDENCE of acceptance
--   (a remitted amount, or a status listed in settings); paid_allocated = payments allocated to claims from reconciled
--   remittance advices (each advice line is stored once); outstanding = as v_fin_monthly_summary.
-- Claims with no status and no payment or rejection are counted in status_unknown_claims instead of being assumed.
create view public.v_fin_monthly_measures with (security_invoker = false) as
with flagged as (
  select c.org_id, date_trunc('month', c.transaction_date)::date as month, i.branch_code, c.net, c.id,
         ( coalesce(c.remitted, 0) > 0
           or exists (select 1 from public.fin_ref_finance_settings s, unnest(s.accepted_claim_statuses) as x
                      where s.org_id = c.org_id and lower(x) = lower(btrim(coalesce(c.claim_status, '')))) ) as evidenced,
         ( nullif(btrim(coalesce(c.claim_status, '')), '') is null and coalesce(c.remitted, 0) = 0 and coalesce(c.rejected, 0) = 0 ) as unknown_status
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.transaction_date is not null
), acc as (
  select org_id, month, branch_code,
         sum(net) filter (where evidenced) as accepted,
         count(*) filter (where unknown_status) as status_unknown_claims
  from flagged group by org_id, month, branch_code
), paid as (
  select f.org_id, f.month, f.branch_code, sum(l.paid_amount) as paid_allocated
  from public.ins_remittance_lines l
  join flagged f on f.id = l.claim_activity_id
  where l.match_status = 'matched'
  group by f.org_id, f.month, f.branch_code
)
select m.org_id, m.month, m.branch_code, m.generated, m.claimed, a.accepted, p.paid_allocated, m.remitted, m.rejected,
       m.outstanding, m.self_pay_collected, a.status_unknown_claims
from public.v_fin_monthly_summary m
left join acc a on a.org_id = m.org_id and a.month = m.month and a.branch_code is not distinct from m.branch_code
left join paid p on p.org_id = m.org_id and p.month = m.month and p.branch_code is not distinct from m.branch_code;

revoke all on public.v_fin_monthly_measures from anon;
grant select on public.v_fin_monthly_measures to authenticated, service_role;

-- Coverage dates and the reporting-ID flag (appended columns; the F7 columns are unchanged).
create or replace view public.v_fin_data_freshness with (security_invoker = false) as
select s.org_id,
       s.enabled                                                                   as capture_enabled,
       exists (select 1 from public.integration_accounts a
               where a.org_id = s.org_id and a.kind = 'unite')                     as credentials_configured,
       (select max(b.processed_at) from public.fin_raw_unite_batches b
         where b.org_id = s.org_id and b.process_status = 'processed')             as last_capture_at,
       (select max(f.committed_at) from public.fin_raw_diligence_files f
         where f.org_id = s.org_id and f.status = 'committed')                     as last_import_at,
       (select count(*) from public.fin_raw_unite_batches b where b.org_id = s.org_id)      as batch_count,
       (select count(*) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as invoice_count,
       (select count(*) from public.ins_claim_activities c where c.org_id = s.org_id)       as claim_count,
       (select count(*) from public.fin_ref_branches r
         where r.org_id = s.org_id and r.active and r.unite_clinic_long_name is not null)   as branches_mapped,
       (select count(*) from public.fin_ref_exception_rules x
         where x.org_id = s.org_id and x.active)                                   as active_rules,
       (select count(*) from public.ops_exceptions e
         where e.org_id = s.org_id and e.status in ('open', 'in_progress'))        as open_exceptions,
       (select min(i.transaction_date) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as first_invoice_date,
       (select max(i.transaction_date) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as last_invoice_date,
       (select min(c.transaction_date) from public.ins_claim_activities c where c.org_id = s.org_id)              as first_claim_date,
       (select max(c.transaction_date) from public.ins_claim_activities c where c.org_id = s.org_id)              as last_claim_date,
       (select max(b.created_at) from public.ins_remittance_batches b where b.org_id = s.org_id)                 as last_remittance_at,
       (select count(*) from public.ops_exceptions e
         where e.org_id = s.org_id and e.status in ('open', 'in_progress') and e.escalated_at is not null)       as escalated_exceptions
from public.fin_capture_settings s
where app.has_perm(s.org_id, 'finance.view');

-- ---------------------------------------------------------------------------
-- 8. Report inputs (service role only: the server runs can() first, then calls with member.orgId)
-- ---------------------------------------------------------------------------
-- Revenue and direct service cost per month, branch, department and doctor. A line with no Finance cost is counted as
-- uncosted (its revenue stays in revenue, but costed_net excludes it), so coverage is always visible.
create or replace function public.fin_profit_inputs(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select doctor_basis from public.fin_ref_finance_settings where org_id = p_org_id),
  l as (
    select date_trunc('month', i.transaction_date)::date as month, i.branch_code, i.department,
           case (select doctor_basis from s)
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end as doctor_dha_id,
           coalesce(ln.line_net, 0) as net, coalesce(ln.qty, 1) as qty, cost.unit_cost
    from public.fin_invoices i
    join public.fin_invoice_lines ln on ln.invoice_id = i.id and ln.is_current
    left join lateral (
      select c.unit_cost from public.fin_cost_services c
      where c.org_id = i.org_id and c.item_code = ln.item_code and c.effective_from <= i.transaction_date
      order by c.effective_from desc limit 1) cost on true
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', g.month, 'branch_code', g.branch_code, 'department', g.department, 'doctor_dha_id', g.doctor_dha_id,
           'revenue_net', g.revenue_net, 'direct_cost', g.direct_cost, 'costed_net', g.costed_net,
           'lines', g.lines, 'uncosted_lines', g.uncosted_lines)), '[]'::jsonb)
  from (
    select month, branch_code, department, doctor_dha_id,
           sum(net) as revenue_net,
           coalesce(sum(qty * unit_cost) filter (where unit_cost is not null), 0) as direct_cost,
           coalesce(sum(net) filter (where unit_cost is not null), 0) as costed_net,
           count(*) as lines, count(*) filter (where unit_cost is null) as uncosted_lines
    from l group by month, branch_code, department, doctor_dha_id
  ) g;
$$;
revoke all on function public.fin_profit_inputs(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_profit_inputs(uuid, date, date) to service_role;

-- Per doctor (on the configured basis): invoices, distinct patients, new / returning patients, revenue and completed
-- appointments. New / returning is only reported when the window starts after the first invoice on record (otherwise
-- every patient would look new). Completed appointments need the doctor's Unite id to equal the DHA id; otherwise null.
-- Counts only: no patient identifier leaves this function.
create or replace function public.fin_doctor_measures(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with basis as (select doctor_basis from public.fin_ref_finance_settings where org_id = p_org_id),
  hist as (select min(transaction_date) as history_from from public.fin_invoices where org_id = p_org_id and not is_deleted),
  inv as (
    select i.id, i.transaction_date, coalesce(i.patient_ref, i.patient_pin) as pid,
           case (select doctor_basis from basis)
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end as doctor_dha_id,
           i.department, i.net,
           (select min(x.transaction_date) from public.fin_invoices x
             where x.org_id = i.org_id and not x.is_deleted
               and coalesce(x.patient_ref, x.patient_pin) = coalesce(i.patient_ref, i.patient_pin)) as first_seen
    from public.fin_invoices i
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
  ), per as (
    select doctor_dha_id, max(department) as department, count(*) as invoices,
           count(distinct pid) as patients,
           count(distinct pid) filter (where first_seen >= p_from) as new_patients,
           count(distinct pid) filter (where first_seen < p_from) as returning_patients,
           coalesce(sum(net), 0) as revenue
    from inv where doctor_dha_id is not null group by doctor_dha_id
  )
  select jsonb_build_object(
    'history_from', (select history_from from hist),
    'doctor_basis', (select doctor_basis from basis),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'doctor_dha_id', p.doctor_dha_id,
        'doctor_name', (select d.name from public.fin_ref_doctors d where d.org_id = p_org_id and d.dha_id = p.doctor_dha_id),
        'department', coalesce((select d.department from public.fin_ref_doctors d where d.org_id = p_org_id and d.dha_id = p.doctor_dha_id), p.department),
        'invoices', p.invoices, 'patients', p.patients,
        'new_patients', case when p_from > (select history_from from hist) then p.new_patients end,
        'returning_patients', case when p_from > (select history_from from hist) then p.returning_patients end,
        'revenue', p.revenue,
        'completed_appointments', (
          select count(*) from public.appointments a
          join public.specialists sp on sp.id = a.specialist_id and sp.org_id = a.org_id
          where a.org_id = p_org_id and a.status = 'completed' and sp.external_id = p.doctor_dha_id
            and a.starts_at::date between p_from and p_to)
          * case when exists (select 1 from public.specialists sp where sp.org_id = p_org_id and sp.external_id = p.doctor_dha_id) then 1 end
      ) order by p.revenue desc)
      from per p), '[]'::jsonb));
$$;
revoke all on function public.fin_doctor_measures(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_doctor_measures(uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Atomic writes for the cost inputs (service role only; the server runs can() first)
-- ---------------------------------------------------------------------------
-- A whole file is saved or none of it: an approved month's compensation or overheads raise 42501 and roll everything back.
create or replace function public.fin_cost_upsert(p_org_id uuid, p_kind text, p_rows jsonb, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be an array' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'too many rows' using errcode = 'check_violation';
  end if;

  if p_kind = 'services' then
    insert into public.fin_cost_services (org_id, item_code, effective_from, unit_cost, note, created_by)
    select p_org_id, upper(btrim(x.item_code)), x.effective_from, x.unit_cost, x.note, p_user
    from jsonb_to_recordset(p_rows) as x (item_code text, effective_from date, unit_cost numeric, note text)
    on conflict (org_id, item_code, effective_from)
    do update set unit_cost = excluded.unit_cost, note = excluded.note, created_by = excluded.created_by;
  elsif p_kind = 'compensation' then
    insert into public.fin_cost_doctor_comp (org_id, month, doctor_dha_id, amount, note, created_by)
    select p_org_id, x.month, upper(btrim(x.doctor_dha_id)), x.amount, x.note, p_user
    from jsonb_to_recordset(p_rows) as x (month date, doctor_dha_id text, amount numeric, note text)
    on conflict (org_id, month, doctor_dha_id)
    do update set amount = excluded.amount, note = excluded.note, created_by = excluded.created_by;
  elsif p_kind = 'overheads' then
    insert into public.fin_cost_overheads (org_id, month, branch_code, pool, amount, basis, note, created_by)
    select p_org_id, x.month, nullif(upper(btrim(coalesce(x.branch_code, ''))), ''), btrim(x.pool), x.amount, coalesce(x.basis, 'revenue'), x.note, p_user
    from jsonb_to_recordset(p_rows) as x (month date, branch_code text, pool text, amount numeric, basis text, note text)
    on conflict (org_id, month, (coalesce(branch_code, '')), (lower(pool)))
    do update set amount = excluded.amount, basis = excluded.basis, note = excluded.note, created_by = excluded.created_by;
  else
    raise exception 'unknown cost kind' using errcode = 'check_violation';
  end if;
  n := jsonb_array_length(p_rows);
  return n;
end;
$$;
revoke all on function public.fin_cost_upsert(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_cost_upsert(uuid, text, jsonb, uuid) to service_role;

-- Approve or reopen a month. Approving needs an approver; reopening clears the approval.
create or replace function public.fin_cost_set_period(p_org_id uuid, p_month date, p_status text, p_user uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('draft', 'approved') then
    raise exception 'bad status' using errcode = 'check_violation';
  end if;
  insert into public.fin_cost_periods (org_id, month, status, approved_by, approved_at, note)
  values (p_org_id, p_month, p_status,
          case when p_status = 'approved' then p_user end,
          case when p_status = 'approved' then now() end, p_note)
  on conflict (org_id, month) do update
    set status = excluded.status, approved_by = excluded.approved_by, approved_at = excluded.approved_at, note = excluded.note;
end;
$$;
revoke all on function public.fin_cost_set_period(uuid, date, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_cost_set_period(uuid, date, text, uuid, text) to service_role;
