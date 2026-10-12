-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. Safe to stop between files.

-- ======================================================================
-- 20261009000970_finance_f21.sql
-- ======================================================================
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

-- ======================================================================
-- 20261009000980_finance_diligence.sql
-- ======================================================================
-- Finance F4: Diligence claim import (staging, atomic commit, matching writes) and the finance-files bucket.
--
-- The uploaded .xlsx holds patient names and Emirates IDs. It is parsed server-side, the SANITISED rows
-- are staged here for the preview/confirm step, and the original file is deleted straight away. Only its
-- sha256 is kept (to block duplicate uploads).

alter table public.ins_claim_activities
  add column match_reason text check (match_reason is null or match_reason in
    ('ok', 'no_invoice', 'invoice_deleted', 'no_line', 'amount_mismatch', 'ambiguous', 'quantity_mismatch')),
  add column clinician_mismatch boolean not null default false,
  add column matched_at timestamptz;

alter table public.fin_raw_diligence_files
  add column committed_by uuid references public.profiles (id) on delete set null,
  add column commit_summary jsonb not null default '{}'::jsonb;

create table public.ins_staged_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_id uuid not null references public.fin_raw_diligence_files (id) on delete cascade,
  row_no integer not null,
  claim_activity_number text not null,
  data jsonb not null,                                -- sanitised ClaimRow
  created_at timestamptz not null default now(),
  unique (file_id, claim_activity_number)
);
create index ins_staged_activities_file_idx on public.ins_staged_activities (file_id, row_no);
alter table public.ins_staged_activities enable row level security;   -- service role only

create trigger ins_staged_file_org_check before insert or update of file_id, org_id on public.ins_staged_activities
  for each row execute function app.check_parent_org('fin_raw_diligence_files', 'file_id');

-- ---------------------------------------------------------------------------
-- Commit one validated file. Everything happens in one transaction under an org lock.
--   p_rows    : full rows to upsert (new + changed)
--   p_seen    : every claim number in the file (last_seen_file_id is moved to this file)
--   p_events  : [{claim_activity_number, changed_fields}]
--   p_missing : claim numbers present in the previous file but absent now
-- ---------------------------------------------------------------------------
create or replace function public.ins_commit_import(
  p_org_id uuid,
  p_file_id uuid,
  p_user_id uuid,
  p_rows jsonb,
  p_events jsonb,
  p_seen text[],
  p_missing text[],
  p_raise_missing boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.fin_raw_diligence_files;
  v_upserted integer;
  v_events integer := 0;
  v_missing integer := 0;
  v_reopened integer := 0;
  n text;
begin
  perform pg_advisory_xact_lock(hashtext('ins_commit:' || p_org_id::text));

  select * into v_file from public.fin_raw_diligence_files where id = p_file_id and org_id = p_org_id for update;
  if not found then
    raise exception 'file % not found in org %', p_file_id, p_org_id using errcode = 'no_data_found';
  end if;
  if v_file.status <> 'validated' then
    raise exception 'file is % and cannot be committed', v_file.status using errcode = 'check_violation';
  end if;

  insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, activity_start_date, encounter_type, cpt_code, cpt_category, cpt_type, quantity, ordering_clinician_id, clinician_id, receiver_id, payer_id, prior_auth_id, payment_reference, initial_net, net, remitted, last_remitted, initial_rejected, rejected, unprocessed, write_off, write_off_status, settled, principal_diagnosis, diagnosis_text, last_denial_code, denial_category, denial_type, denial_comment, initial_denial_code, initial_denial_type, resubmission_count, remittance_count, first_remittance_date, last_remittance_date, last_resubmission_date, claim_status, payment_status, receipt_status, claim_year, claim_month, first_seen_file_id, last_seen_file_id)
  select p_org_id, r.claim_activity_number, r.invoice_no, r.transaction_date, r.activity_start_date, r.encounter_type, r.cpt_code, r.cpt_category, r.cpt_type, r.quantity, r.ordering_clinician_id, r.clinician_id, r.receiver_id, r.payer_id, r.prior_auth_id, r.payment_reference, r.initial_net, r.net, r.remitted, r.last_remitted, r.initial_rejected, r.rejected, r.unprocessed, r.write_off, r.write_off_status, r.settled, r.principal_diagnosis, r.diagnosis_text, r.last_denial_code, r.denial_category, r.denial_type, r.denial_comment, r.initial_denial_code, r.initial_denial_type, r.resubmission_count, r.remittance_count, r.first_remittance_date, r.last_remittance_date, r.last_resubmission_date, r.claim_status, r.payment_status, r.receipt_status, r.claim_year, r.claim_month, p_file_id, p_file_id
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
      claim_activity_number text,
      invoice_no text,
      transaction_date date,
      activity_start_date date,
      encounter_type text,
      cpt_code text,
      cpt_category text,
      cpt_type text,
      quantity numeric,
      ordering_clinician_id text,
      clinician_id text,
      receiver_id text,
      payer_id text,
      prior_auth_id text,
      payment_reference text,
      initial_net numeric,
      net numeric,
      remitted numeric,
      last_remitted numeric,
      initial_rejected numeric,
      rejected numeric,
      unprocessed numeric,
      write_off numeric,
      write_off_status text,
      settled boolean,
      principal_diagnosis text,
      diagnosis_text text,
      last_denial_code text,
      denial_category text,
      denial_type text,
      denial_comment text,
      initial_denial_code text,
      initial_denial_type text,
      resubmission_count integer,
      remittance_count integer,
      first_remittance_date date,
      last_remittance_date date,
      last_resubmission_date date,
      claim_status text,
      payment_status text,
      receipt_status text,
      claim_year integer,
      claim_month integer
  )
  on conflict (org_id, claim_activity_number) do update set
        invoice_no = excluded.invoice_no,
        transaction_date = excluded.transaction_date,
        activity_start_date = excluded.activity_start_date,
        encounter_type = excluded.encounter_type,
        cpt_code = excluded.cpt_code,
        cpt_category = excluded.cpt_category,
        cpt_type = excluded.cpt_type,
        quantity = excluded.quantity,
        ordering_clinician_id = excluded.ordering_clinician_id,
        clinician_id = excluded.clinician_id,
        receiver_id = excluded.receiver_id,
        payer_id = excluded.payer_id,
        prior_auth_id = excluded.prior_auth_id,
        payment_reference = excluded.payment_reference,
        initial_net = excluded.initial_net,
        net = excluded.net,
        remitted = excluded.remitted,
        last_remitted = excluded.last_remitted,
        initial_rejected = excluded.initial_rejected,
        rejected = excluded.rejected,
        unprocessed = excluded.unprocessed,
        write_off = excluded.write_off,
        write_off_status = excluded.write_off_status,
        settled = excluded.settled,
        principal_diagnosis = excluded.principal_diagnosis,
        diagnosis_text = excluded.diagnosis_text,
        last_denial_code = excluded.last_denial_code,
        denial_category = excluded.denial_category,
        denial_type = excluded.denial_type,
        denial_comment = excluded.denial_comment,
        initial_denial_code = excluded.initial_denial_code,
        initial_denial_type = excluded.initial_denial_type,
        resubmission_count = excluded.resubmission_count,
        remittance_count = excluded.remittance_count,
        first_remittance_date = excluded.first_remittance_date,
        last_remittance_date = excluded.last_remittance_date,
        last_resubmission_date = excluded.last_resubmission_date,
        claim_status = excluded.claim_status,
        payment_status = excluded.payment_status,
        receipt_status = excluded.receipt_status,
        claim_year = excluded.claim_year,
        claim_month = excluded.claim_month,
        last_seen_file_id = p_file_id,
        first_seen_file_id = coalesce(public.ins_claim_activities.first_seen_file_id, p_file_id);
  get diagnostics v_upserted = row_count;

  -- claims that did not change but are in this file
  update public.ins_claim_activities
  set last_seen_file_id = p_file_id
  where org_id = p_org_id and claim_activity_number = any (coalesce(p_seen, '{}'::text[]))
    and last_seen_file_id is distinct from p_file_id;

  insert into public.ins_claim_activity_events (org_id, claim_activity_id, file_id, observed_at, changed_fields)
  select p_org_id, c.id, p_file_id, now(), e.changed_fields
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb)) as e(claim_activity_number text, changed_fields jsonb)
  join public.ins_claim_activities c on c.org_id = p_org_id and c.claim_activity_number = e.claim_activity_number;
  get diagnostics v_events = row_count;

  insert into public.fin_ref_payers (org_id, payer_id, receiver_id)
  select distinct on (r.payer_id) p_org_id, r.payer_id, r.receiver_id
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(payer_id text, receiver_id text)
  where r.payer_id is not null and btrim(r.payer_id) <> ''
  on conflict (org_id, payer_id) do update set
    receiver_id = coalesce(public.fin_ref_payers.receiver_id, excluded.receiver_id);

  -- a claim that reappears closes its E06
  update public.ops_exceptions
  set status = 'auto_closed', closed_at = now(), closure_note = 'claim present in a later file'
  where org_id = p_org_id and rule_code = 'E06' and status in ('open', 'in_progress')
    and entity_key = any (coalesce(p_seen, '{}'::text[]));
  get diagnostics v_reopened = row_count;

  if p_raise_missing then
    foreach n in array coalesce(p_missing, '{}'::text[]) loop
      perform public.fin_open_exception(p_org_id, 'E06', 'claim', n, null, jsonb_build_object('file_id', p_file_id));
      v_missing := v_missing + 1;
    end loop;
  end if;

  delete from public.ins_staged_activities where file_id = p_file_id;

  update public.fin_raw_diligence_files
  set status = 'committed', committed_at = now(), committed_by = p_user_id,
      commit_summary = jsonb_build_object(
        'upserted', v_upserted, 'events', v_events, 'seen', coalesce(array_length(p_seen, 1), 0),
        'missing', coalesce(array_length(p_missing, 1), 0), 'missing_raised', v_missing, 'e06_closed', v_reopened)
  where id = p_file_id;

  return jsonb_build_object('upserted', v_upserted, 'events', v_events, 'missing_raised', v_missing, 'e06_closed', v_reopened);
end;
$$;

-- Matching results computed by lib/finance/match-claims.ts.
create or replace function public.ins_apply_matches(p_org_id uuid, p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.ins_claim_activities c
  set matched_invoice_id = m.invoice_id, matched_line_id = m.line_id, match_status = m.status,
      match_reason = m.reason, clinician_mismatch = coalesce(m.clinician_mismatch, false), matched_at = now()
  from jsonb_to_recordset(coalesce(p_matches, '[]'::jsonb)) as m(
    claim_id uuid, invoice_id uuid, line_id uuid, status text, reason text, clinician_mismatch boolean)
  where c.id = m.claim_id and c.org_id = p_org_id
    and (c.matched_invoice_id, c.matched_line_id, c.match_status, c.match_reason, c.clinician_mismatch)
        is distinct from (m.invoice_id, m.line_id, m.status, m.reason, coalesce(m.clinician_mismatch, false));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.ins_discard_import(p_org_id uuid, p_file_id uuid, p_reason text default 'discarded')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ins_staged_activities where file_id = p_file_id and org_id = p_org_id;
  update public.fin_raw_diligence_files
  set status = 'rejected', errors = jsonb_build_array(jsonb_build_object('row', null, 'code', p_reason))
  where id = p_file_id and org_id = p_org_id and status = 'validated';
end;
$$;

-- Staged rows nobody confirmed within 7 days are removed and their file marked expired.
create or replace function public.ins_purge_stale_staging()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with stale as (
    select id from public.fin_raw_diligence_files
    where status = 'validated' and uploaded_at < now() - interval '7 days'
  ), gone as (
    delete from public.ins_staged_activities s using stale where s.file_id = stale.id returning s.id
  ), mark as (
    update public.fin_raw_diligence_files f
    set status = 'rejected', errors = jsonb_build_array(jsonb_build_object('row', null, 'code', 'expired'))
    from stale where f.id = stale.id returning f.id
  )
  select count(*) into v_n from gone;
  return coalesce(v_n, 0);
end;
$$;

revoke all on function public.ins_commit_import(uuid, uuid, uuid, jsonb, jsonb, text[], text[], boolean) from public, anon, authenticated;
revoke all on function public.ins_apply_matches(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ins_discard_import(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ins_purge_stale_staging() from public, anon, authenticated;
grant execute on function public.ins_commit_import(uuid, uuid, uuid, jsonb, jsonb, text[], text[], boolean) to service_role;
grant execute on function public.ins_apply_matches(uuid, jsonb) to service_role;
grant execute on function public.ins_discard_import(uuid, uuid, text) to service_role;
grant execute on function public.ins_purge_stale_staging() to service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for the short-lived upload (deleted right after parsing).
-- No member policies: only the service role touches it. Guarded for plain Postgres.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('finance-files', 'finance-files', false, 26214400)
    on conflict (id) do nothing;
  end if;
end $$;

-- ======================================================================
-- 20261009000990_finance_rules.sql
-- ======================================================================
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

-- ======================================================================
-- 20261009000991_finance_alerts.sql
-- ======================================================================
-- Finance F6: monitoring alerts. An hourly job evaluates capture health, Diligence freshness and
-- overdue exceptions and notifies the people who hold finance.capture.manage, once per problem
-- (not once per hour). This table remembers what has already been announced.

create table public.fin_alert_state (
  org_id uuid not null references public.orgs (id) on delete cascade,
  alert_key text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  first_seen_at timestamptz not null default now(),
  last_notified_at timestamptz,
  cleared_at timestamptz,
  primary key (org_id, alert_key)
);
alter table public.fin_alert_state enable row level security;   -- service role only

-- One alerts message per org per hour, whether or not Unite capture is enabled
-- ("no Diligence upload" and "overdue exceptions" do not depend on it).
create or replace function public.fin_alerts_enqueue()
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
      where message ->> 'kind' = 'alerts' and message ->> 'org_id' = s.org_id::text
    ) then
      perform pgmq.send('finance_capture', jsonb_build_object('kind', 'alerts', 'org_id', s.org_id));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.fin_alerts_enqueue() from public, anon, authenticated;
grant execute on function public.fin_alerts_enqueue() to service_role;

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname = 'pulse:finance_alerts' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;
select cron.schedule('pulse:finance_alerts', '35 * * * *', $$select public.fin_alerts_enqueue()$$);

-- ======================================================================
-- 20261009001000_finance_ui_views.sql
-- ======================================================================
-- Finance F7: one read-only view that tells a finance user how fresh and how
-- complete the data behind the portal is ("data as of", setup checklist).
--
-- It runs with the owner's rights because the raw tables and credentials are
-- service-only, and exposes nothing but dates, counts and yes/no flags. It is
-- filtered by app.has_perm(org_id, 'finance.view'), so a member only ever sees
-- their own org and only with the Finance permission.

create view public.v_fin_data_freshness with (security_invoker = false) as
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
         where e.org_id = s.org_id and e.status in ('open', 'in_progress'))        as open_exceptions
from public.fin_capture_settings s
where app.has_perm(s.org_id, 'finance.view');

revoke all on public.v_fin_data_freshness from anon;
grant select on public.v_fin_data_freshness to authenticated, service_role;

