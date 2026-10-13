-- Phase 20D review fixes: payables and vouchers (docs/20_PHASE_20D_NOTES.md, "Changes after review").
--
--   1. A locked month freezes CONTENT, not workflow: supplier invoices and vouchers dated in a locked month keep their
--      amounts, dates, supplier / payee, category, branch, narration and document, but their status (on a voucher, paid,
--      released) and their Tally export link may still change. Before this, one unexported item in a locked month blocked
--      every Tally export, and last month's invoices could never be put on a voucher or paid. A voucher's own steps are
--      still refused while ITS date is in a locked month (fin_voucher_act), and links change only in an open month.
--   2. fin_ref_finance_settings: a write through the member's own client (role authenticated, i.e. PostgREST) may change
--      only the Phase 18 columns the workflow settings page writes that way (app.fin_settings_user_columns()); every
--      other column, including any added later, is refused, and an insert must leave them at their defaults. Phase 20
--      settings are written by server actions with the service role after can(), with their own typed confirmations
--      and audit.
--   3. The maker of a voucher never records its payment (both approval modes); a Tally-route voucher therefore always
--      involves a second person in Pulse.
--   4. Part payments: fin_supplier_invoices.paid_amount and fin_voucher_invoices.paid_amount (the allocation recorded
--      when the voucher is paid). A voucher pays its invoices oldest first; an invoice is paid only when its balance is
--      settled within voucher_mismatch_tolerance, otherwise it returns to open with the balance. A voucher with invoices
--      cannot be submitted for more than their balance plus the tolerance. lib/finance/vouchers.ts
--      allocateVoucherPayment() mirrors the allocation (parity-tested). The Board pack counts the unpaid balance.
--   5. Read scope: a holder of only finance.vouchers.approve_dept reads the Tier 2 vouchers waiting for a department
--      head or that they decided, never a special category, and only the documents attached to those; special-category
--      vouchers (payroll, intercompany, related party) and their documents also need finance.vouchers.check,
--      finance.vouchers.approve_ceo or finance.costs.compensation; a file waiting in the Finance inbox needs
--      finance.inbox.manage or finance.payables.manage. lib/finance/vouchers.ts canReadVoucher() is the server mirror.

-- ---------------------------------------------------------------------------
-- 1. Part-payment columns
-- ---------------------------------------------------------------------------
alter table public.fin_supplier_invoices
  add column paid_amount numeric(14, 2) not null default 0,
  add constraint fin_supplier_invoices_paid_amount_check check (paid_amount >= 0 and paid_amount <= net + vat);
comment on column public.fin_supplier_invoices.paid_amount is
  'Paid so far by vouchers (sum of fin_voucher_invoices.paid_amount of paid vouchers). Balance = total - paid_amount.';

alter table public.fin_voucher_invoices
  add column paid_amount numeric(14, 2),
  add constraint fin_voucher_invoices_paid_amount_check check (paid_amount is null or paid_amount >= 0);
comment on column public.fin_voucher_invoices.paid_amount is
  'How much of the voucher went to this invoice; set once when the voucher is paid (null before).';

-- ---------------------------------------------------------------------------
-- 2. Guards: a locked month freezes content, not status or the Tally export link
-- ---------------------------------------------------------------------------
create or replace function app.fin_voucher_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content_changed boolean;
  -- what a locked month does not freeze: the workflow (status, approvals, payment) and the Tally export link
  v_free constant text[] := array[
    'status', 'route', 'tier_code', 'needs_dept', 'needs_ceo', 'bulk_allowed', 'content_sha256', 'prepared_by',
    'submitted_by', 'submitted_at', 'checked_by', 'checked_at', 'dept_approved_by', 'dept_approved_at', 'ceo_approved_by',
    'ceo_approved_at', 'approved_at', 'rejected_by', 'rejected_at', 'rejection_remarks', 'paid_by', 'paid_at',
    'payment_date', 'payment_reference', 'cancelled_by', 'cancelled_at', 'tally_export_id', 'tally_exported_at',
    'updated_at'];
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'payment vouchers are cancelled, never deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.org_id is null or new.voucher_date is null then
    return new;
  end if;
  -- the FK action that nulls a deleted user's id is always permitted
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['prepared_by', 'submitted_by', 'checked_by', 'dept_approved_by', 'ceo_approved_by',
                                                   'rejected_by', 'paid_by', 'cancelled_by', 'updated_at'])
                        = (to_jsonb(old) - array['prepared_by', 'submitted_by', 'checked_by', 'dept_approved_by', 'ceo_approved_by',
                                                   'rejected_by', 'paid_by', 'cancelled_by', 'updated_at']) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if app.fin_month_is_locked(new.org_id, new.voucher_date) then
      raise exception 'the month of this voucher is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    return new;
  end if;
  -- a locked month freezes the content (the voucher's own steps are refused by fin_voucher_act, by its date)
  if (app.fin_month_is_locked(new.org_id, new.voucher_date) or app.fin_month_is_locked(old.org_id, old.voucher_date))
     and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'the month of this voucher is locked' using errcode = '42501', hint = 'month_locked';
  end if;
  if new.org_id <> old.org_id or new.voucher_no <> old.voucher_no then
    raise exception 'a voucher keeps its organisation and number' using errcode = 'check_violation';
  end if;
  v_content_changed := (new.voucher_date, new.payee_name, new.supplier_id, new.amount, new.currency, new.category,
                        new.special_category, new.branch_code, new.cost_centre, new.pay_from, new.payment_method, new.narration)
    is distinct from (old.voucher_date, old.payee_name, old.supplier_id, old.amount, old.currency, old.category,
                      old.special_category, old.branch_code, old.cost_centre, old.pay_from, old.payment_method, old.narration);
  if v_content_changed then
    if old.tally_export_id is not null then
      raise exception 'an exported voucher cannot change' using errcode = 'check_violation', hint = 'exported';
    end if;
    if old.status not in ('draft', 'rejected') and new.status <> 'draft' then
      raise exception 'a submitted voucher changes only by returning to draft' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if old.status in ('paid', 'cancelled') then
      raise exception 'a % voucher cannot change', old.status using errcode = 'check_violation', hint = 'wrong_status';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_voucher_guard() from public, anon, authenticated;

-- Links (invoices and attachments) change only while the voucher is a draft (or rejected) and its month is open. The one
-- exception is the payment allocation (fin_voucher_invoices.paid_amount), recorded once when the voucher is paid.
create or replace function app.fin_voucher_link_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voucher uuid;
  v public.fin_payment_vouchers;
begin
  if tg_op = 'DELETE' then
    v_voucher := old.voucher_id;
  else
    v_voucher := new.voucher_id;
  end if;
  if v_voucher is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['added_by', 'paid_amount']) = (to_jsonb(old) - array['added_by', 'paid_amount']) then
    if (to_jsonb(new) -> 'paid_amount') is not distinct from (to_jsonb(old) -> 'paid_amount') then
      return new;   -- a deleted user's id nulled by the FK action
    end if;
    if (to_jsonb(old) -> 'paid_amount') = 'null'::jsonb
       and exists (select 1 from public.fin_payment_vouchers x where x.id = v_voucher and x.status = 'paid') then
      return new;   -- the payment allocation, written by fin_voucher_act when the voucher is paid
    end if;
    raise exception 'the payment allocation is recorded once, when the voucher is paid' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  select * into v from public.fin_payment_vouchers where id = v_voucher;
  if found and exists (select 1 from public.orgs o where o.id = v.org_id) then
    if app.fin_month_is_locked(v.org_id, v.voucher_date) then
      raise exception 'the month of this voucher is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    if v.status not in ('draft', 'rejected') then
      raise exception 'attachments and invoices change only while the voucher is a draft' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.fin_voucher_link_guard() from public, anon, authenticated;

-- Supplier invoices: a locked month freezes the content (and voiding, which removes the invoice from the month); the
-- status (on a voucher, paid, open again), the amount paid and the Tally export link may still change. An invoice on a
-- voucher beyond draft, paid or exported keeps its content; only open or void invoices never paid, never exported and on no
-- live voucher may be deleted; a part-paid invoice cannot be voided.
create or replace function app.fin_supplier_invoice_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_busy boolean;
  -- what a locked month does not freeze (total is generated from net and vat)
  v_free constant text[] := array['status', 'paid_amount', 'tally_export_id', 'tally_exported_at', 'updated_at', 'created_by', 'total'];
begin
  if tg_op = 'INSERT' then
    if new.org_id is not null and new.invoice_date is not null and app.fin_month_is_locked(new.org_id, new.invoice_date) then
      raise exception 'the month of this invoice is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    return new;
  end if;
  if not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['created_by', 'updated_at']) = (to_jsonb(old) - array['created_by', 'updated_at']) then
    return new;   -- a deleted user's id nulled by the FK action
  end if;
  v_busy := old.tally_export_id is not null or exists (
    select 1 from public.fin_voucher_invoices l join public.fin_payment_vouchers v on v.id = l.voucher_id
    where l.supplier_invoice_id = old.id and v.status not in ('draft', 'rejected', 'cancelled'));
  if tg_op = 'DELETE' then
    if app.fin_month_is_locked(old.org_id, old.invoice_date) then
      raise exception 'the month of this invoice is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    if v_busy or old.status not in ('open', 'void') or old.paid_amount > 0 or exists (
      select 1 from public.fin_voucher_invoices l join public.fin_payment_vouchers v on v.id = l.voucher_id
      where l.supplier_invoice_id = old.id and v.status <> 'cancelled') then
      raise exception 'this invoice is on a voucher or was exported; void it instead' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    return old;
  end if;
  if (app.fin_month_is_locked(old.org_id, old.invoice_date) or app.fin_month_is_locked(new.org_id, new.invoice_date))
     and ((to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free)
          or (new.status = 'void') is distinct from (old.status = 'void')) then
    raise exception 'the month of this invoice is locked' using errcode = '42501', hint = 'month_locked';
  end if;
  if new.status = 'void' and old.status <> 'void' and old.paid_amount > 0 then
    raise exception 'a part-paid invoice cannot be voided' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if v_busy and (new.supplier_id, new.invoice_number, new.invoice_date, new.category, new.net, new.vat, new.currency,
                 new.branch_code, new.cost_centre, new.doctor_dha_id, new.document_id)
     is distinct from (old.supplier_id, old.invoice_number, old.invoice_date, old.category, old.net, old.vat, old.currency,
                       old.branch_code, old.cost_centre, old.doctor_dha_id, old.document_id) then
    raise exception 'this invoice is on a voucher being approved, paid or exported; it cannot change' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_supplier_invoice_guard() from public, anon, authenticated;

-- Invoices paid before part payments existed were paid in full (the old rule marked every linked invoice paid).
update public.fin_supplier_invoices set paid_amount = total where status = 'paid' and paid_amount = 0;
update public.fin_voucher_invoices l set paid_amount = si.total
  from public.fin_supplier_invoices si, public.fin_payment_vouchers v
 where si.id = l.supplier_invoice_id and v.id = l.voucher_id and v.status = 'paid' and l.paid_amount is null;

-- ---------------------------------------------------------------------------
-- 3. fin_ref_finance_settings: what a browser (user-client) write may change
-- ---------------------------------------------------------------------------
-- Exactly the columns app/(app)/finance/workflow-settings/actions.ts writes with createClient() (saveThresholds,
-- saveBlueprintSettings; a database test keeps the two lists equal), plus updated_at (set by its trigger). Everything
-- else, including any column added later, is written only by server actions with the service role after can().
create or replace function app.fin_settings_user_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'preauth_expiry_lead_days', 'preauth_task_enabled', 'ready_start_date', 'ready_grace_days',
    'denial_cases_start_date', 'denial_default_resubmit_days', 'denial_warn_days', 'denial_task_enabled',
    'short_pay_tolerance_amount', 'short_pay_tolerance_pct', 'scorecard_min_claims', 'scorecard_denial_rate_warn',
    'scorecard_denial_rate_alert', 'scorecard_days_to_pay_warn', 'scorecard_days_to_pay_alert',
    'forecast_horizon_weeks', 'forecast_default_lag_days', 'forecast_default_collection_rate', 'forecast_min_history',
    'forecast_tail_weeks', 'cashup_variance_tolerance',
    'doctor_basis', 'accepted_claim_statuses', 'evidence_start_date', 'evidence_grace_days', 'escalation_days',
    'escalation_role',
    'updated_at'
  ]::text[];
$$;
revoke all on function app.fin_settings_user_columns() from public, anon;
grant execute on function app.fin_settings_user_columns() to authenticated, service_role;

-- SECURITY INVOKER on purpose: current_user is the role that wrote the row.
create or replace function app.fin_settings_user_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_new jsonb;
  v_old jsonb;
  v_col text;
  v_expr text;
  v_type text;
  v_def jsonb;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  v_allowed := app.fin_settings_user_columns();
  v_new := to_jsonb(new);
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    for v_col in select jsonb_object_keys(v_new) loop
      if not (v_col = any (v_allowed)) and (v_new -> v_col) is distinct from (v_old -> v_col) then
        raise exception 'This setting is changed only on its own settings page.' using errcode = '42501', hint = 'not_permitted';
      end if;
    end loop;
  else
    for v_col, v_expr, v_type in
      select a.attname::text, pg_catalog.pg_get_expr(d.adbin, d.adrelid), pg_catalog.format_type(a.atttypid, a.atttypmod)
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped
    loop
      continue when v_col = 'org_id' or v_col = any (v_allowed);
      v_def := null;
      if v_expr is not null then
        execute format('select to_jsonb((%s)::%s)', v_expr, v_type) into v_def;
      end if;
      if coalesce(v_new -> v_col, 'null'::jsonb) is distinct from coalesce(v_def, 'null'::jsonb) then
        raise exception 'This setting is changed only on its own settings page.' using errcode = '42501', hint = 'not_permitted';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_settings_user_write_guard() from public, anon, authenticated;
-- named to fire after fin_ref_finance_settings_set_updated_at (BEFORE triggers run in name order)
create trigger fin_ref_finance_settings_user_write_guard before insert or update on public.fin_ref_finance_settings
  for each row execute function app.fin_settings_user_write_guard();

-- ---------------------------------------------------------------------------
-- 4. The state machine: submit checks the invoices' balance, pay refuses the maker and allocates the payment.
--    Body as in 20261024000100 except where marked "20D review".
-- ---------------------------------------------------------------------------
create or replace function public.fin_voucher_act(
  p_org_id uuid, p_voucher_id uuid, p_user_id uuid, p_action text, p_hash text, p_remarks text, p_payment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_payment_vouchers;
  r public.fin_ref_approval_tiers;
  v_mode text;
  v_hash text;
  v_to text;
  v_event text;
  v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_docs integer;
  v_blocked integer;
  v_pay_date date;
  v_pay_ref text;
  v_perm text;
  v_tol numeric;
  v_inv integer;
  v_outstanding numeric;
  v_left numeric;
  v_alloc numeric;
  inv record;
begin
  select * into v from public.fin_payment_vouchers where id = p_voucher_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if app.fin_month_is_locked(p_org_id, v.voucher_date) then
    raise exception 'The month of this voucher is locked.' using errcode = 'check_violation', hint = 'month_locked';
  end if;
  v_hash := public.fin_voucher_compute_hash(v.id);
  select s.approval_mode, s.voucher_mismatch_tolerance into v_mode, v_tol
    from public.fin_ref_finance_settings s where s.org_id = p_org_id;
  v_tol := coalesce(v_tol, 1.00);

  if p_action = 'submit' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot submit payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('draft', 'rejected') then
      raise exception 'Only a draft can be submitted.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    select count(*), count(*) filter (where d.scan_status = 'infected' or d.status <> 'ready') into v_docs, v_blocked from (
      select vd.document_id as id from public.fin_voucher_documents vd where vd.voucher_id = v.id
      union
      select si.document_id from public.fin_voucher_invoices l join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
      where l.voucher_id = v.id and si.document_id is not null
    ) x join public.fin_documents d on d.id = x.id;
    if v_docs = 0 then
      raise exception 'Attach the supporting document first (zero paper: the backup travels with the voucher).'
        using errcode = 'check_violation', hint = 'no_attachment';
    end if;
    if v_blocked > 0 then
      raise exception 'An attachment was blocked by the malware scan.' using errcode = 'check_violation', hint = 'attachment_blocked';
    end if;
    -- 20D review: never more than the linked invoices still owe (their balance plus the tolerance)
    select count(*), coalesce(sum(si.total - si.paid_amount), 0) into v_inv, v_outstanding
      from public.fin_voucher_invoices l join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
     where l.voucher_id = v.id;
    if v_inv > 0 and v.amount > v_outstanding + v_tol then
      raise exception 'The voucher is for more than its supplier invoices still owe.'
        using errcode = 'check_violation', hint = 'amount_exceeds_invoices';
    end if;
    if coalesce(v_mode, 'pulse') = 'tally' then
      v_to := 'for_tally';
      v_event := 'sent_to_tally';
      update public.fin_payment_vouchers set
        status = v_to, route = 'tally', tier_code = null, needs_dept = false, needs_ceo = false, bulk_allowed = false,
        content_sha256 = v_hash, submitted_by = p_user_id, submitted_at = now(),
        rejected_by = null, rejected_at = null, rejection_remarks = null
      where id = v.id;
    else
      r := app.fin_voucher_rule(p_org_id, v.amount, v.special_category);
      if r.id is null then
        raise exception 'No approval rule covers this amount or category. Fix the delegation-of-authority settings.'
          using errcode = 'check_violation', hint = 'no_rule';
      end if;
      v_to := 'submitted';
      v_event := 'submitted';
      update public.fin_payment_vouchers set
        status = v_to, route = 'pulse', tier_code = r.code, needs_dept = r.needs_dept_head, needs_ceo = r.needs_ceo,
        bulk_allowed = r.bulk_allowed, content_sha256 = v_hash, submitted_by = p_user_id, submitted_at = now(),
        rejected_by = null, rejected_at = null, rejection_remarks = null
      where id = v.id;
    end if;

  elsif p_action = 'check' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.check') then
      raise exception 'Only the Finance Manager verifies vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'submitted' then
      raise exception 'This voucher is not waiting for verification.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) then
      raise exception 'The checker must be a different person from the maker.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := case when coalesce(v.needs_dept, false) or coalesce(v.needs_ceo, false) then 'checked' else 'approved' end;
    v_event := 'checked';
    update public.fin_payment_vouchers set status = v_to, checked_by = p_user_id, checked_at = now(),
      approved_at = case when v_to = 'approved' then now() else null end
    where id = v.id;

  elsif p_action = 'approve_dept' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.approve_dept') then
      raise exception 'Only a department head approves this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'checked' or not coalesce(v.needs_dept, false) then
      raise exception 'This voucher is not waiting for a department head.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) or p_user_id = v.checked_by then
      raise exception 'Each step must be a different person.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := case when coalesce(v.needs_ceo, false) then 'dept_approved' else 'approved' end;
    v_event := 'dept_approved';
    update public.fin_payment_vouchers set status = v_to, dept_approved_by = p_user_id, dept_approved_at = now(),
      approved_at = case when v_to = 'approved' then now() else null end
    where id = v.id;

  elsif p_action = 'approve_ceo' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.approve_ceo') then
      raise exception 'Only the CEO authorises this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if not coalesce(v.needs_ceo, false)
       or v.status <> (case when coalesce(v.needs_dept, false) then 'dept_approved' else 'checked' end) then
      raise exception 'This voucher is not waiting for the CEO.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) or p_user_id = v.checked_by or p_user_id = v.dept_approved_by then
      raise exception 'Each step must be a different person.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := 'approved';
    v_event := 'ceo_approved';
    update public.fin_payment_vouchers set status = v_to, ceo_approved_by = p_user_id, ceo_approved_at = now(), approved_at = now()
    where id = v.id;

  elsif p_action = 'reject' then
    if v.status not in ('submitted', 'checked', 'dept_approved') then
      raise exception 'Only a voucher waiting for a decision can be rejected.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_perm := case
      when v.status = 'submitted' then 'finance.vouchers.check'
      when v.status = 'checked' and coalesce(v.needs_dept, false) then 'finance.vouchers.approve_dept'
      else 'finance.vouchers.approve_ceo' end;
    if not app.user_has_perm(p_org_id, p_user_id, v_perm) then
      raise exception 'You cannot decide this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v_remarks is null or char_length(v_remarks) < 3 then
      raise exception 'Say why the voucher is rejected (remarks are required).' using errcode = 'check_violation', hint = 'remarks_required';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) then
      raise exception 'The maker cannot reject their own voucher; edit it instead.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    v_to := 'rejected';
    v_event := 'rejected';
    update public.fin_payment_vouchers set status = v_to, rejected_by = p_user_id, rejected_at = now(),
      rejection_remarks = left(v_remarks, 1000),
      checked_by = null, checked_at = null, dept_approved_by = null, dept_approved_at = null,
      ceo_approved_by = null, ceo_approved_at = null, approved_at = null
    where id = v.id;

  elsif p_action = 'reopen' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot prepare payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'rejected' then
      raise exception 'Only a rejected voucher can be reopened.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_to := 'draft';
    v_event := 'reopened';
    update public.fin_payment_vouchers set status = v_to, route = null, tier_code = null, needs_dept = null, needs_ceo = null,
      bulk_allowed = null, content_sha256 = null, submitted_by = null, submitted_at = null
    where id = v.id;

  elsif p_action = 'cancel' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot prepare payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('draft', 'rejected', 'for_tally') or v.tally_export_id is not null then
      raise exception 'Only a draft, a rejected voucher or one not yet exported to Tally can be cancelled.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if v_remarks is null or char_length(v_remarks) < 3 then
      raise exception 'Say why the voucher is cancelled (remarks are required).' using errcode = 'check_violation', hint = 'remarks_required';
    end if;
    v_to := 'cancelled';
    v_event := 'cancelled';
    update public.fin_payment_vouchers set status = v_to, cancelled_by = p_user_id, cancelled_at = now() where id = v.id;
    update public.fin_supplier_invoices si set status = 'open'
     where si.status = 'on_voucher' and si.id in (select l.supplier_invoice_id from public.fin_voucher_invoices l where l.voucher_id = v.id);

  elsif p_action = 'pay' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.pay') then
      raise exception 'You cannot record payments.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('approved', 'for_tally') then
      raise exception 'Only an approved voucher can be paid.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    -- 20D review: a second person records the payment, whatever the approval route
    if app.fin_voucher_is_maker(v.id, p_user_id) then
      raise exception 'The maker of a voucher does not record its payment; another person does.'
        using errcode = 'check_violation', hint = 'same_person';
    end if;
    v_pay_date := nullif(p_payment ->> 'date', '')::date;
    v_pay_ref := nullif(btrim(coalesce(p_payment ->> 'reference', '')), '');
    if v_pay_date is null or v_pay_ref is null or char_length(v_pay_ref) > 60 then
      raise exception 'Enter the payment date and the bank reference.' using errcode = 'check_violation', hint = 'payment_details_required';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    if app.fin_month_is_locked(p_org_id, v_pay_date) then
      raise exception 'The month of the payment date is locked.' using errcode = 'check_violation', hint = 'month_locked';
    end if;
    v_to := 'paid';
    v_event := 'paid';
    update public.fin_payment_vouchers set status = v_to, paid_by = p_user_id, paid_at = now(),
      payment_date = v_pay_date, payment_reference = v_pay_ref
    where id = v.id;
    -- 20D review: the amount goes to the linked invoices oldest first (date, then number, then id; mirrored by
    -- allocateVoucherPayment in lib/finance/vouchers.ts); an invoice is paid once its balance is settled within the
    -- tolerance, otherwise it is open again with its balance.
    v_left := v.amount;
    for inv in
      select si.id, si.total, si.paid_amount
      from public.fin_voucher_invoices l join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
      where l.voucher_id = v.id
      order by si.invoice_date, si.invoice_number collate "C", si.id::text collate "C"
    loop
      v_alloc := least(v_left, greatest(inv.total - inv.paid_amount, 0));
      v_left := v_left - v_alloc;
      update public.fin_voucher_invoices set paid_amount = v_alloc where voucher_id = v.id and supplier_invoice_id = inv.id;
      update public.fin_supplier_invoices set paid_amount = inv.paid_amount + v_alloc,
        status = case when inv.paid_amount + v_alloc >= inv.total - v_tol then 'paid' else 'open' end
      where id = inv.id;
    end loop;
    v_remarks := coalesce(v_remarks, 'Payment reference ' || v_pay_ref);

  else
    raise exception 'Unknown action.' using errcode = 'check_violation', hint = 'unknown_action';
  end if;

  insert into public.fin_voucher_events (org_id, voucher_id, action, actor_id, from_status, to_status, remarks, content_sha256)
  values (p_org_id, v.id, v_event, p_user_id, v.status, v_to, left(v_remarks, 1000),
          case when v_event in ('reopened') then null else v_hash end);

  return (select jsonb_build_object('id', x.id, 'voucher_no', x.voucher_no, 'from', v.status, 'to', x.status, 'hash', v_hash,
                                    'needs_dept', coalesce(x.needs_dept, false), 'needs_ceo', coalesce(x.needs_ceo, false),
                                    'prepared_by', x.prepared_by, 'submitted_by', x.submitted_by)
          from public.fin_payment_vouchers x where x.id = v.id);
end;
$$;
revoke all on function public.fin_voucher_act(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fin_voucher_act(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Who reads which voucher and document (lib/finance/vouchers.ts canReadVoucher() is the server-side mirror)
-- ---------------------------------------------------------------------------
-- Every voucher that is not a special category, every supplier and supplier invoice, and every document that is not
-- waiting in the inbox. The department head's key is no longer here: see app.fin_can_read_voucher.
create or replace function app.fin_can_read_payables(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_perm(p_org_id, 'finance.payables.view') or app.has_perm(p_org_id, 'finance.payables.manage')
      or app.has_perm(p_org_id, 'finance.vouchers.prepare') or app.has_perm(p_org_id, 'finance.vouchers.check')
      or app.has_perm(p_org_id, 'finance.vouchers.approve_ceo') or app.has_perm(p_org_id, 'finance.vouchers.pay')
      or app.has_perm(p_org_id, 'finance.tally.export');
$$;
revoke all on function app.fin_can_read_payables(uuid) from public, anon;
grant execute on function app.fin_can_read_payables(uuid) to authenticated, service_role;

-- Special categories (payroll, intercompany, related party: compensation and related-party data) also need one of these.
create or replace function app.fin_can_read_special(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_perm(p_org_id, 'finance.vouchers.check') or app.has_perm(p_org_id, 'finance.vouchers.approve_ceo')
      or app.has_perm(p_org_id, 'finance.costs.compensation');
$$;
revoke all on function app.fin_can_read_special(uuid) from public, anon;
grant execute on function app.fin_can_read_special(uuid) to authenticated, service_role;

create or replace function app.fin_can_read_voucher(p_org_id uuid, p_voucher_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fin_payment_vouchers v
    where v.id = p_voucher_id and v.org_id = p_org_id
      and case
        when v.special_category <> 'none' then app.fin_can_read_payables(p_org_id) and app.fin_can_read_special(p_org_id)
        else app.fin_can_read_payables(p_org_id)
          -- a department head: Tier 2 vouchers waiting for a department head, or that they decided
          or (app.has_perm(p_org_id, 'finance.vouchers.approve_dept') and v.route = 'pulse' and coalesce(v.needs_dept, false)
              and (v.status = 'checked'
                   or exists (select 1 from public.fin_voucher_events e
                              where e.voucher_id = v.id and e.actor_id = auth.uid() and e.action in ('dept_approved', 'rejected'))))
      end);
$$;
revoke all on function app.fin_can_read_voucher(uuid, uuid) from public, anon;
grant execute on function app.fin_can_read_voucher(uuid, uuid) to authenticated, service_role;

-- A supplier invoice: payables staff, or a department head for an invoice on a voucher they read.
create or replace function app.fin_can_read_supplier_invoice(p_org_id uuid, p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.fin_can_read_payables(p_org_id)
      or exists (select 1 from public.fin_voucher_invoices l
                 where l.supplier_invoice_id = p_invoice_id and l.org_id = p_org_id
                   and app.fin_can_read_voucher(p_org_id, l.voucher_id));
$$;
revoke all on function app.fin_can_read_supplier_invoice(uuid, uuid) from public, anon;
grant execute on function app.fin_can_read_supplier_invoice(uuid, uuid) to authenticated, service_role;

-- A finance document: a file waiting in the inbox needs a payables manager (inbox managers have their own policy); a
-- file on a special-category voucher (directly or through its supplier invoice) needs the special-category keys;
-- otherwise payables staff, or a department head for a file on a voucher they read.
create or replace function app.fin_can_read_document(p_org_id uuid, p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with doc as (
    select d.inbox_at, d.routed_at from public.fin_documents d where d.id = p_document_id and d.org_id = p_org_id
  ), linked as (
    select vd.voucher_id from public.fin_voucher_documents vd where vd.document_id = p_document_id
    union
    select l.voucher_id from public.fin_supplier_invoices si
    join public.fin_voucher_invoices l on l.supplier_invoice_id = si.id
    where si.document_id = p_document_id
  )
  select coalesce((
    select case
      when doc.inbox_at is not null and doc.routed_at is null then app.has_perm(p_org_id, 'finance.payables.manage')
      when exists (select 1 from linked x join public.fin_payment_vouchers v on v.id = x.voucher_id
                   where v.special_category <> 'none')
        then app.fin_can_read_payables(p_org_id) and app.fin_can_read_special(p_org_id)
      else app.fin_can_read_payables(p_org_id)
        or exists (select 1 from linked x where app.fin_can_read_voucher(p_org_id, x.voucher_id))
    end
    from doc), false);
$$;
revoke all on function app.fin_can_read_document(uuid, uuid) from public, anon;
grant execute on function app.fin_can_read_document(uuid, uuid) to authenticated, service_role;

drop policy fin_documents_select on public.fin_documents;
create policy fin_documents_select on public.fin_documents for select to authenticated
  using (app.fin_can_read_document(org_id, id));
-- inbox managers read the files WAITING in the inbox; once routed, a file follows the rule above
drop policy fin_documents_inbox_select on public.fin_documents;
create policy fin_documents_inbox_select on public.fin_documents for select to authenticated
  using (inbox_at is not null and routed_at is null and app.has_perm(org_id, 'finance.inbox.manage'));

drop policy fin_supplier_invoices_select on public.fin_supplier_invoices;
create policy fin_supplier_invoices_select on public.fin_supplier_invoices for select to authenticated
  using (app.fin_can_read_supplier_invoice(org_id, id));
drop policy fin_ref_approval_tiers_select on public.fin_ref_approval_tiers;
create policy fin_ref_approval_tiers_select on public.fin_ref_approval_tiers for select to authenticated
  using (app.fin_can_read_payables(org_id) or app.has_perm(org_id, 'finance.vouchers.settings')
         or app.has_perm(org_id, 'finance.vouchers.approve_dept'));
drop policy fin_payment_vouchers_select on public.fin_payment_vouchers;
create policy fin_payment_vouchers_select on public.fin_payment_vouchers for select to authenticated
  using (app.fin_can_read_voucher(org_id, id));
drop policy fin_voucher_invoices_select on public.fin_voucher_invoices;
create policy fin_voucher_invoices_select on public.fin_voucher_invoices for select to authenticated
  using (app.fin_can_read_voucher(org_id, voucher_id));
drop policy fin_voucher_documents_select on public.fin_voucher_documents;
create policy fin_voucher_documents_select on public.fin_voucher_documents for select to authenticated
  using (app.fin_can_read_voucher(org_id, voucher_id));
drop policy fin_voucher_events_select on public.fin_voucher_events;
create policy fin_voucher_events_select on public.fin_voucher_events for select to authenticated
  using (app.fin_can_read_voucher(org_id, voucher_id));

-- ---------------------------------------------------------------------------
-- 6. The Board pack counts the unpaid BALANCE of supplier invoices at the month end (part payments).
--    Body as in 20261106000100 except the "inv" block of the payables section.
-- ---------------------------------------------------------------------------
-- As of what:
--   * payables (supplier invoices) are as at the month end: dated on or before it, with the balance not yet paid by
--     vouchers whose payment date is on or before it (an invoice settled within voucher_mismatch_tolerance is paid);
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
