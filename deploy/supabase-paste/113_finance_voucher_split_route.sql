-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 112_finance_reporting_rules_oct22.sql.
-- Production normally gets this through .github/workflows/db-migrate.yml on merge; this file is the manual route.

-- Finance's answer of 22 Oct 2026 (19 Oct requests Q2, OQ-90 / OQ-196; docs/52): routine payment vouchers up to AED 5,000
-- are approved in Tally (Accountant and Finance Manager); vouchers above it need the CEO and go through Pulse.
--
--   * fin_ref_finance_settings.approval_mode gains 'split': a voucher of no special category whose amount is at or below
--     fin_ref_finance_settings.tally_approval_max (default 5,000.00) goes to Tally ('for_tally'), anything else follows
--     the Pulse delegation-of-authority tiers. Payroll, intercompany and related-party vouchers always stay in Pulse.
--     'pulse' and 'tally' behave exactly as before. The mode is switched by the Finance Manager under Voucher settings
--     (typed confirmation, audited); this migration does not switch it.
--   * fin_voucher_act is redefined from its last definition (20261107000100); only the submit branch's route changes.
--     The pure twin is voucherRoute() in lib/finance/vouchers.ts (shared scenarios in phase20d-vouchers.synthetic.json).

alter table public.fin_ref_finance_settings drop constraint fin_ref_finance_settings_approval_mode_check;
alter table public.fin_ref_finance_settings
  add constraint fin_ref_finance_settings_approval_mode_check check (approval_mode in ('pulse', 'tally', 'split')),
  add column tally_approval_max numeric(14, 2) not null default 5000.00
    check (tally_approval_max > 0 and tally_approval_max <= 10000000);

comment on column public.fin_ref_finance_settings.tally_approval_max is
  'Approval mode split: vouchers of no special category up to this amount are approved in Tally, above it in Pulse.';

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
  v_tally_max numeric;
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
  select s.approval_mode, s.voucher_mismatch_tolerance, s.tally_approval_max into v_mode, v_tol, v_tally_max
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
    -- Q2 (22 Oct 2026): in split mode a routine voucher up to the threshold is approved in Tally
    if coalesce(v_mode, 'pulse') = 'tally'
       or (v_mode = 'split' and v.special_category = 'none' and v.amount <= coalesce(v_tally_max, 5000.00)) then
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

