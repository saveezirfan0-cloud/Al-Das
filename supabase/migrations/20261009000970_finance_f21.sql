-- Finance F2.1: gap fixes from the F2 review.
--   * fin_apply_invoices v2: tolerates duplicate invoices inside one batch (the caller keeps the last
--     occurrence and reports how many it dropped), and a replay never blanks txn_ref_name
--   * first live runs are one batch: max_batches_per_run defaults to 1
--   * daily maintenance tick (PII strip of old raw payloads, claim re-matching, staging purge)

drop function if exists public.fin_apply_invoices(uuid, uuid, jsonb);

create or replace function public.fin_apply_invoices(p_org_id uuid, p_batch_id uuid, p_invoices jsonb, p_duplicates integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.fin_raw_unite_batches;
  x record;
  e public.fin_invoices;
  v_id uuid;
  v_branch text;
  v_version integer;
  v_stale boolean;
  v_expected integer;
  c_invoices integer := 0;
  c_created integer := 0;
  c_updated integer := 0;
  c_unchanged integer := 0;
  c_stale integer := 0;
  c_lines integer := 0;
  c_payments integer := 0;
  c_versions integer := 0;
  v_rows integer;
begin
  select * into v_batch from public.fin_raw_unite_batches where id = p_batch_id and org_id = p_org_id for update;
  if not found then
    raise exception 'batch % not found in org %', p_batch_id, p_org_id using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(p_invoices) <> 'array' then
    raise exception 'p_invoices must be a json array' using errcode = 'check_violation';
  end if;
  v_expected := coalesce(v_batch.record_count, jsonb_array_length(p_invoices) + coalesce(p_duplicates, 0)) - coalesce(p_duplicates, 0);
  if jsonb_array_length(p_invoices) <> v_expected then
    raise exception 'count mismatch: batch has % records, % were mapped', v_expected, jsonb_array_length(p_invoices)
      using errcode = 'check_violation';
  end if;

  for x in
    select * from jsonb_to_recordset(p_invoices) as t(
      inv_display_number text, ref_type text, transaction_date date, patient_pin text, appointment_id text,
      unite_clinic_long_name text, unite_bu_short_name text, doctor_dha_id text, doctor_name text,
      department text, specialty text, inv_type text, is_package boolean, is_deleted boolean,
      gross numeric, discount numeric, net numeric, vat_applicable boolean, vat numeric, total numeric,
      write_off numeric, credit_note numeric, referral_doctor text, referral_doctor_id text,
      referral_clinic text, referral_clinic_id text, created_by text, modified_by text,
      record_hash text, record jsonb, lines jsonb, payments jsonb
    )
  loop
    c_invoices := c_invoices + 1;

    select b.code into v_branch
    from public.fin_ref_branches b
    where b.org_id = p_org_id and b.active and b.unite_clinic_long_name = x.unite_clinic_long_name
    limit 1;

    select * into e from public.fin_invoices
    where org_id = p_org_id and inv_display_number = x.inv_display_number for update;

    v_stale := false;
    if not found then
      insert into public.fin_invoices (
        org_id, inv_display_number, ref_type, transaction_date, patient_pin, appointment_id, branch_code,
        unite_clinic_long_name, unite_bu_short_name, doctor_dha_id, doctor_name, department, specialty,
        inv_type, is_package, is_deleted, gross, discount, net, vat_applicable, vat, total, write_off,
        credit_note, referral_doctor, referral_doctor_id, referral_clinic, referral_clinic_id,
        created_by, modified_by, version, record_hash, first_received_at, last_received_at, last_batch_id
      ) values (
        p_org_id, x.inv_display_number, x.ref_type, x.transaction_date, x.patient_pin, x.appointment_id, v_branch,
        x.unite_clinic_long_name, x.unite_bu_short_name, x.doctor_dha_id, x.doctor_name, x.department, x.specialty,
        x.inv_type, coalesce(x.is_package, false), coalesce(x.is_deleted, false), x.gross, x.discount, x.net,
        x.vat_applicable, x.vat, x.total, x.write_off, x.credit_note, x.referral_doctor, x.referral_doctor_id,
        x.referral_clinic, x.referral_clinic_id, x.created_by, x.modified_by, 1, x.record_hash,
        v_batch.requested_at, v_batch.requested_at, p_batch_id
      ) returning id into v_id;
      v_version := 1;
      c_created := c_created + 1;
    else
      v_id := e.id;
      v_stale := e.last_received_at > v_batch.requested_at;
      v_version := e.version;
      if v_stale then
        c_stale := c_stale + 1;
      else
        if e.record_hash is distinct from x.record_hash then
          v_version := e.version + 1;
          c_updated := c_updated + 1;
          update public.fin_invoices set
            ref_type = x.ref_type, transaction_date = x.transaction_date, patient_pin = x.patient_pin,
            appointment_id = x.appointment_id, branch_code = v_branch,
            unite_clinic_long_name = x.unite_clinic_long_name, unite_bu_short_name = x.unite_bu_short_name,
            doctor_dha_id = x.doctor_dha_id, doctor_name = x.doctor_name, department = x.department,
            specialty = x.specialty, inv_type = x.inv_type, is_package = coalesce(x.is_package, false),
            is_deleted = coalesce(x.is_deleted, false), gross = x.gross, discount = x.discount, net = x.net,
            vat_applicable = x.vat_applicable, vat = x.vat, total = x.total, write_off = x.write_off,
            credit_note = x.credit_note, referral_doctor = x.referral_doctor, referral_doctor_id = x.referral_doctor_id,
            referral_clinic = x.referral_clinic, referral_clinic_id = x.referral_clinic_id,
            created_by = x.created_by, modified_by = x.modified_by, version = v_version,
            record_hash = x.record_hash, last_received_at = v_batch.requested_at, last_batch_id = p_batch_id
          where id = v_id;
        else
          c_unchanged := c_unchanged + 1;
          -- same content: touch only bookkeeping, and only when it actually differs (replays change nothing)
          update public.fin_invoices
          set branch_code = v_branch, last_received_at = v_batch.requested_at, last_batch_id = p_batch_id
          where id = v_id
            and (branch_code, last_received_at, last_batch_id) is distinct from (v_branch, v_batch.requested_at, p_batch_id);
        end if;
      end if;
    end if;

    -- one history row per delivery (idempotent on replay)
    insert into public.fin_invoice_versions (org_id, invoice_id, version, batch_id, received_at, record)
    values (p_org_id, v_id, v_version, p_batch_id, v_batch.requested_at, coalesce(x.record, '{}'::jsonb))
    on conflict (invoice_id, batch_id) do nothing;
    get diagnostics v_rows = row_count;
    c_versions := c_versions + v_rows;

    if not v_stale then
      -- lines: upsert by key; keys absent from this delivery become not current (never deleted)
      insert into public.fin_invoice_lines (
        org_id, invoice_id, line_key, position, item_code, cpt_code, item_short_desc, item_type, qty,
        line_price, line_gross, line_discount, line_net, vat_applicable, vat, total, line_remarks,
        is_package_item, actual_cost_price, is_current
      )
      select p_org_id, v_id, l.line_key, l.position, l.item_code, l.cpt_code, l.item_short_desc, l.item_type,
             l.qty, l.line_price, l.line_gross, l.line_discount, l.line_net, l.vat_applicable, l.vat, l.total,
             l.line_remarks, coalesce(l.is_package_item, false), l.actual_cost_price, true
      from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(
        line_key text, position integer, item_code text, cpt_code text, item_short_desc text, item_type text,
        qty numeric, line_price numeric, line_gross numeric, line_discount numeric, line_net numeric,
        vat_applicable boolean, vat numeric, total numeric, line_remarks text, is_package_item boolean,
        actual_cost_price numeric
      )
      on conflict (org_id, line_key) do update set
        invoice_id = excluded.invoice_id, position = excluded.position, item_code = excluded.item_code,
        cpt_code = excluded.cpt_code, item_short_desc = excluded.item_short_desc, item_type = excluded.item_type,
        qty = excluded.qty, line_price = excluded.line_price, line_gross = excluded.line_gross,
        line_discount = excluded.line_discount, line_net = excluded.line_net,
        vat_applicable = excluded.vat_applicable, vat = excluded.vat, total = excluded.total,
        line_remarks = excluded.line_remarks, is_package_item = excluded.is_package_item,
        actual_cost_price = excluded.actual_cost_price, is_current = true;
      get diagnostics v_rows = row_count;
      c_lines := c_lines + v_rows;

      update public.fin_invoice_lines
      set is_current = false
      where invoice_id = v_id and is_current
        and line_key <> all (coalesce(
          (select array_agg(l.line_key) from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(line_key text)),
          '{}'::text[]));

      insert into public.fin_payments (
        org_id, invoice_id, payment_key, instalment, payment_mode, collected, paid, paid_date, returned,
        receipt_number, advance_added, refund, refund_date, txn_ref_no, txn_ref_name, card_type, surcharge,
        remarks, is_current
      )
      select p_org_id, v_id, p.payment_key, p.instalment, p.payment_mode, p.collected, p.paid, p.paid_date,
             p.returned, p.receipt_number, p.advance_added, p.refund, p.refund_date, p.txn_ref_no,
             p.txn_ref_name, p.card_type, p.surcharge, p.remarks, true
      from jsonb_to_recordset(coalesce(x.payments, '[]'::jsonb)) as p(
        payment_key text, instalment text, payment_mode text, collected numeric, paid numeric, paid_date date,
        returned numeric, receipt_number text, advance_added numeric, refund numeric, refund_date date,
        txn_ref_no text, txn_ref_name text, card_type text, surcharge numeric, remarks text
      )
      on conflict (org_id, payment_key) do update set
        invoice_id = excluded.invoice_id, instalment = excluded.instalment, payment_mode = excluded.payment_mode,
        collected = excluded.collected, paid = excluded.paid, paid_date = excluded.paid_date,
        returned = excluded.returned, receipt_number = excluded.receipt_number,
        advance_added = excluded.advance_added, refund = excluded.refund, refund_date = excluded.refund_date,
        txn_ref_no = excluded.txn_ref_no, txn_ref_name = coalesce(excluded.txn_ref_name, public.fin_payments.txn_ref_name), card_type = excluded.card_type,
        surcharge = excluded.surcharge, remarks = excluded.remarks, is_current = true;
      get diagnostics v_rows = row_count;
      c_payments := c_payments + v_rows;

      update public.fin_payments
      set is_current = false
      where invoice_id = v_id and is_current
        and payment_key <> all (coalesce(
          (select array_agg(p.payment_key) from jsonb_to_recordset(coalesce(x.payments, '[]'::jsonb)) as p(payment_key text)),
          '{}'::text[]));

      -- reference data: fill blanks only; admins own the rest
      if x.doctor_dha_id is not null and btrim(x.doctor_dha_id) <> '' then
        insert into public.fin_ref_doctors (org_id, dha_id, name, department, specialty)
        values (p_org_id, x.doctor_dha_id, x.doctor_name, x.department, x.specialty)
        on conflict (org_id, dha_id) do update set
          name = coalesce(public.fin_ref_doctors.name, excluded.name),
          department = coalesce(public.fin_ref_doctors.department, excluded.department),
          specialty = coalesce(public.fin_ref_doctors.specialty, excluded.specialty);
      end if;
      insert into public.fin_ref_services (org_id, item_code, cpt_code, description, item_type)
      select distinct on (l.item_code) p_org_id, l.item_code, l.cpt_code, l.item_short_desc, l.item_type
      from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(item_code text, cpt_code text, item_short_desc text, item_type text)
      where l.item_code is not null and btrim(l.item_code) <> ''
      on conflict (org_id, item_code) do update set
        cpt_code = coalesce(public.fin_ref_services.cpt_code, excluded.cpt_code),
        description = coalesce(public.fin_ref_services.description, excluded.description),
        item_type = coalesce(public.fin_ref_services.item_type, excluded.item_type);

      -- E07: unknown clinic. Opens while unmapped, auto-closes once mapped.
      if v_branch is null then
        perform public.fin_open_exception(
          p_org_id, 'E07', 'invoice', x.inv_display_number, null,
          jsonb_build_object('unite_clinic_long_name', x.unite_clinic_long_name));
      else
        perform public.fin_auto_close_exceptions(p_org_id, 'E07', x.inv_display_number);
      end if;
    end if;
  end loop;

  update public.fin_raw_unite_batches
  set process_status = 'processed', processed_at = now(), error = null,
      process_counts = jsonb_build_object(
        'invoices', c_invoices, 'created', c_created, 'updated', c_updated, 'unchanged', c_unchanged,
        'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions,
        'duplicates', coalesce(p_duplicates, 0))
  where id = p_batch_id;

  perform public.fin_auto_close_exceptions(p_org_id, 'E09', p_batch_id::text);

  return jsonb_build_object(
    'invoices', c_invoices, 'created', c_created, 'updated', c_updated, 'unchanged', c_unchanged,
    'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions,
    'duplicates', coalesce(p_duplicates, 0));
end;
$$;

revoke all on function public.fin_apply_invoices(uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.fin_apply_invoices(uuid, uuid, jsonb, integer) to service_role;

-- A first live run should be one watched batch.
alter table public.fin_capture_settings alter column max_batches_per_run set default 1;
update public.fin_capture_settings set max_batches_per_run = 1 where not enabled;

-- One maintenance message per org per day (independent of whether capture is enabled).
create or replace function public.fin_maintenance_enqueue()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_n integer := 0;
begin
  for s in select org_id from public.fin_capture_settings loop
    if not exists (
      select 1 from pgmq.q_finance_capture
      where message ->> 'kind' = 'maintenance' and message ->> 'org_id' = s.org_id::text
    ) then
      perform pgmq.send('finance_capture', jsonb_build_object('kind', 'maintenance', 'org_id', s.org_id));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.fin_maintenance_enqueue() from public, anon, authenticated;
grant execute on function public.fin_maintenance_enqueue() to service_role;

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname = 'pulse:finance_maintenance' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;
select cron.schedule('pulse:finance_maintenance', '30 2 * * *', $$select public.fin_maintenance_enqueue()$$);
