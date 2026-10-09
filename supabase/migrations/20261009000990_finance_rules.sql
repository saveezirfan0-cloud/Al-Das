-- Finance F5: exception rules engine, due dates, invoice list view, appointment-link metric.
--
-- Rules already raised elsewhere stay there: E06 (Diligence import), E07/E09 (batch processing and
-- capture failures), E10 (invalid file). The engine adds E01-E05, E08, a safety net for E07 and the
-- invoice-number gap check for E09. It is idempotent and set-based; running it often is harmless.

alter table public.fin_ref_exception_rules
  add column due_days integer not null default 7 check (due_days between 0 and 365);

alter table public.fin_capture_settings
  add column digest_enabled boolean not null default false;

-- ONE definition of "insurance invoice". Unite's InvType values are still unconfirmed
-- (docs/finance/open-items.md); change it here only.
create or replace function public.fin_is_insurance_type(p_inv_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select upper(coalesce(p_inv_type, '')) like '%INSUR%';
$$;

-- Every exception gets a due date from its rule unless the caller set one.
create or replace function app.ops_exception_set_due()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.due_date is null then
    select (current_date + r.due_days) into new.due_date
    from public.fin_ref_exception_rules r
    where r.org_id = new.org_id and r.rule_code = new.rule_code;
  end if;
  return new;
end;
$$;
create trigger ops_exceptions_set_due before insert on public.ops_exceptions
  for each row execute function app.ops_exception_set_due();

update public.ops_exceptions e
set due_date = (e.opened_at::date + r.due_days)
from public.fin_ref_exception_rules r
where e.due_date is null and r.org_id = e.org_id and r.rule_code = e.rule_code and e.status in ('open', 'in_progress');

-- ---------------------------------------------------------------------------
-- Context the guards need.
-- ---------------------------------------------------------------------------
create or replace function public.fin_rules_context(p_org_id uuid)
returns table (claims_fresh boolean, capture_drained boolean, appointments_from date)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.fin_raw_diligence_files f
      where f.org_id = p_org_id and f.status = 'committed' and f.committed_at > now() - interval '14 days'
    ),
    coalesce((
      select b.balance_in_range is not null and b.balance_in_range <= 0 and b.process_status = 'processed'
      from public.fin_raw_unite_batches b
      where b.org_id = p_org_id
      order by b.requested_at desc
      limit 1
    ), false),
    (select min(a.starts_at)::date from public.appointments a where a.org_id = p_org_id and a.source = 'unite');
$$;

-- ---------------------------------------------------------------------------
-- Reconcile one rule: open what should be open, close what no longer applies.
--   p_desired    : [{entity_type, entity_key, branch_code, detail}]
--   p_key_prefix : when set, only exceptions whose key starts with it are auto-closed
--                  (E09 also holds capture exceptions that must not be touched here)
--   p_cap        : at most this many NEW exceptions per run (the rest follow next run)
-- ---------------------------------------------------------------------------
create or replace function app.fin_reconcile(
  p_org_id uuid,
  p_rule text,
  p_desired jsonb,
  p_key_prefix text default null,
  p_cap integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opened integer;
  v_closed integer;
begin
  with want as (
    select d.entity_type, d.entity_key, d.branch_code, d.detail
    from jsonb_to_recordset(coalesce(p_desired, '[]'::jsonb)) as d(entity_type text, entity_key text, branch_code text, detail jsonb)
  ), fresh as (
    select w.*, r.owner_role
    from want w
    join public.fin_ref_exception_rules r on r.org_id = p_org_id and r.rule_code = p_rule
    where not exists (
      select 1 from public.ops_exceptions e
      where e.org_id = p_org_id and e.rule_code = p_rule and e.entity_key = w.entity_key
        and e.status in ('open', 'in_progress')
    )
    order by w.entity_key
    limit p_cap
  ), ins as (
    insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, branch_code, owner_role, detail)
    select p_org_id, p_rule, f.entity_type, f.entity_key, f.branch_code, f.owner_role, coalesce(f.detail, '{}'::jsonb)
    from fresh f
    on conflict (org_id, rule_code, entity_key) where status in ('open', 'in_progress') do nothing
    returning 1
  )
  select count(*) into v_opened from ins;

  update public.ops_exceptions e
  set status = 'auto_closed', closed_at = now(), closure_note = 'condition cleared'
  where e.org_id = p_org_id and e.rule_code = p_rule and e.status in ('open', 'in_progress')
    and (p_key_prefix is null or e.entity_key like p_key_prefix || '%')
    and not exists (
      select 1 from jsonb_to_recordset(coalesce(p_desired, '[]'::jsonb)) as d(entity_key text)
      where d.entity_key = e.entity_key
    );
  get diagnostics v_closed = row_count;

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end;
$$;

-- ---------------------------------------------------------------------------
-- The engine.
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
begin
  select * into ctx from public.fin_rules_context(p_org_id);
  select window_from into v_window from public.fin_capture_settings where org_id = p_org_id;

  for rule in
    select rule_code, threshold_days from public.fin_ref_exception_rules
    where org_id = p_org_id and active and rule_code in ('E01', 'E02', 'E03', 'E04', 'E05', 'E07', 'E08', 'E09')
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
    end if;

    if v_desired is null then
      v_result := v_result || jsonb_build_object(rule.rule_code, jsonb_build_object('skipped', true));
    else
      v_result := v_result || jsonb_build_object(
        rule.rule_code,
        app.fin_reconcile(p_org_id, rule.rule_code, v_desired, case when rule.rule_code = 'E09' then 'gap:' else null end));
    end if;
  end loop;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoice list: invoice fields plus claim aggregates. Gated by finance.invoices.view and
-- exposes sums only, so Billing sees claim progress without being able to read claim rows.
-- ---------------------------------------------------------------------------
create view public.v_fin_invoice_list with (security_invoker = false) as
select i.org_id, i.id, i.inv_display_number, i.transaction_date, i.branch_code, i.doctor_dha_id, i.doctor_name,
       i.department, i.inv_type, i.is_deleted, i.net, i.total, i.version, i.appointment_id, i.patient_pin,
       coalesce(cl.claim_count, 0) as claim_count,
       cl.claimed, cl.remitted, cl.rejected,
       pay.paid
from public.fin_invoices i
left join lateral (
  select count(*) as claim_count, sum(c.net) as claimed, sum(c.remitted) as remitted, sum(c.rejected) as rejected
  from public.ins_claim_activities c where c.matched_invoice_id = i.id
) cl on true
left join lateral (
  select sum(p.paid) as paid from public.fin_payments p where p.invoice_id = i.id and p.is_current
) pay on true
where app.has_perm(i.org_id, 'finance.invoices.view');

revoke all on public.v_fin_invoice_list from anon;
grant select on public.v_fin_invoice_list to authenticated, service_role;

-- Revenue by month for the summary screen's department / doctor / category breakdown.
-- Same definition as v_fin_revenue_daily (current, non-deleted invoices and lines), grouped by month.
create view public.v_fin_revenue_monthly with (security_invoker = false) as
select i.org_id,
       date_trunc('month', i.transaction_date)::date as month,
       i.branch_code, i.department, i.doctor_dha_id, i.doctor_name,
       coalesce(s.service_category, 'Unmapped') as service_category,
       i.inv_type,
       sum(l.line_gross) as gross, sum(l.line_discount) as discount, sum(l.line_net) as net, sum(l.vat) as vat
from public.fin_invoices i
join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
where not i.is_deleted and i.transaction_date is not null and app.has_perm(i.org_id, 'finance.view')
group by i.org_id, date_trunc('month', i.transaction_date)::date, i.branch_code, i.department, i.doctor_dha_id,
         i.doctor_name, coalesce(s.service_category, 'Unmapped'), i.inv_type;
revoke all on public.v_fin_revenue_monthly from anon;
grant select on public.v_fin_revenue_monthly to authenticated, service_role;

-- Appointment-link health (F3 exit metric): share of invoices with an AppointmentId that resolves.
create or replace function public.fin_appointment_resolution(p_org_id uuid, p_days integer default 60)
returns table (with_id bigint, resolved bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) as with_id,
         count(*) filter (where exists (
           select 1 from public.appointments a
           where a.org_id = i.org_id and a.source = 'unite' and a.external_id = btrim(i.appointment_id))) as resolved
  from public.fin_invoices i
  where i.org_id = p_org_id and not i.is_deleted and btrim(coalesce(i.appointment_id, '')) <> ''
    and i.transaction_date >= current_date - p_days
    and i.transaction_date > coalesce((select min(a.starts_at)::date from public.appointments a where a.org_id = p_org_id and a.source = 'unite'), date '9999-12-31');
$$;

revoke all on function public.fin_is_insurance_type(text) from public, anon, authenticated;
revoke all on function public.fin_rules_context(uuid) from public, anon, authenticated;
revoke all on function app.fin_reconcile(uuid, text, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.fin_run_exception_rules(uuid) from public, anon, authenticated;
revoke all on function public.fin_appointment_resolution(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_is_insurance_type(text) to service_role;
grant execute on function public.fin_rules_context(uuid) to service_role;
grant execute on function public.fin_run_exception_rules(uuid) to service_role;
grant execute on function public.fin_appointment_resolution(uuid, integer) to service_role;
