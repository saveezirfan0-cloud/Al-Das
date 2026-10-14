-- Phase 23A: stage, commit and discard a Unite "Daily Collection Multi-Clinic Report" upload (docs/23_PHASE_23A_NOTES.md).
--
--   * The server parses the file (lib/finance/parse-unite-report.ts), deletes the original and passes only the sanitised
--     rows here. These functions are service role only; the server action checks can('finance.revenue.import') first.
--   * fin_report_stage: one transaction for the upload and all its rows. The same file (org, sha256) twice returns the
--     existing upload unchanged. The 12 reconciled totals are summed again here, so an upload is only "reconciled" when
--     the parser AND the database agree with the report's own Invoice Total row.
--   * fin_report_commit: only a staged, reconciled upload. Resolves branch_code from fin_ref_branches by the Unite clinic
--     name, supersedes the current rows of other uploads whose report date falls in this upload's range (is_current =
--     false; nothing is deleted) and makes this upload's rows current. A second commit is refused.
--   * fin_report_discard: deletes a staged upload (its rows cascade). Committed data is never deleted.
--   * Errors carry a stable keyword as the message (report_not_found, report_not_staged, report_not_reconciled,
--     report_rows_out_of_range, report_bad_input) so the server can show a fixed sentence.

-- ---------------------------------------------------------------------------
-- Summary of one upload for the preview: counts and totals only, never a row.
-- ---------------------------------------------------------------------------
create or replace function app.fin_report_upload_json(p_upload_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'upload_id', u.id,
    'status', u.status,
    'from_date', u.from_date,
    'to_date', u.to_date,
    'row_count', u.row_count,
    'reconciled', u.reconciled,
    'report_totals', u.report_totals,
    'row_totals', u.row_totals,
    'problems', u.problems,
    'created_at', u.created_at,
    'committed_at', u.committed_at,
    'doctors', (select count(distinct v.doctor_key) from public.fin_report_visits v where v.upload_id = u.id),
    'clinics', (select count(distinct v.clinic_name) from public.fin_report_visits v where v.upload_id = u.id),
    'cancelled_rows', (select count(*) from public.fin_report_visits v where v.upload_id = u.id and v.is_cancelled),
    'unknown_branch_rows', (
      select count(*) from public.fin_report_visits v
      where v.upload_id = u.id
        and not exists (select 1 from public.fin_ref_branches b
                        where b.org_id = u.org_id and b.active and b.unite_clinic_long_name = v.clinic_name))
  )
  from public.fin_report_uploads u
  where u.id = p_upload_id;
$$;
revoke all on function app.fin_report_upload_json(uuid) from public, anon, authenticated;

create or replace function public.fin_report_upload_summary(p_org_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.fin_report_uploads u where u.id = p_upload_id and u.org_id = p_org_id) then
    raise exception 'report_not_found' using errcode = 'invalid_parameter_value';
  end if;
  return app.fin_report_upload_json(p_upload_id);
end;
$$;
revoke all on function public.fin_report_upload_summary(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_report_upload_summary(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Stage
-- ---------------------------------------------------------------------------
-- p_meta: from_date, to_date, file_sha256, report_totals (the 12 keys below, AED), problems (array of fixed sentences),
-- reconciled (the parser's verdict). p_rows: the sanitised rows (UniteReportRow).
create or replace function public.fin_report_stage(p_org_id uuid, p_user_id uuid, p_meta jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys constant text[] := array['gross', 'discount', 'vat', 'net', 'total', 'cash', 'card', 'bank_transfer',
                                  'payment_gateway', 'other_payment', 'patient_share', 'insurance_claim'];
  v_from date;
  v_to date;
  v_sha text := p_meta ->> 'file_sha256';
  v_id uuid;
  v_report jsonb := coalesce(p_meta -> 'report_totals', '{}'::jsonb);
  v_rows jsonb := '{}'::jsonb;
  v_ok boolean := true;
  k text;
  v_sum numeric;
begin
  if p_org_id is null or jsonb_typeof(p_meta) is distinct from 'object' or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 30000
     or v_sha is null or v_sha !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(v_report) <> 'object'
     or jsonb_typeof(coalesce(p_meta -> 'problems', '[]'::jsonb)) <> 'array' then
    raise exception 'report_bad_input' using errcode = 'invalid_parameter_value';
  end if;
  v_from := (p_meta ->> 'from_date')::date;
  v_to := (p_meta ->> 'to_date')::date;
  if v_from is null or v_to is null or v_to < v_from then
    raise exception 'report_bad_input' using errcode = 'invalid_parameter_value';
  end if;

  -- the same file again: return what is there, unchanged
  select u.id into v_id from public.fin_report_uploads u where u.org_id = p_org_id and u.file_sha256 = v_sha;
  if v_id is not null then
    return app.fin_report_upload_json(v_id) || jsonb_build_object('existing', true);
  end if;

  if exists (select 1 from jsonb_array_elements(p_rows) r
             where (r ->> 'report_date')::date is null
                or (r ->> 'report_date')::date not between v_from and v_to
                or jsonb_typeof(coalesce(r -> 'categories', '{}'::jsonb)) <> 'object') then
    raise exception 'report_rows_out_of_range' using errcode = 'check_violation';
  end if;

  insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, row_count, report_totals,
                                         problems, created_by)
  values (p_org_id, v_from, v_to, v_sha, 'staged', jsonb_array_length(p_rows), v_report,
          coalesce(p_meta -> 'problems', '[]'::jsonb), p_user_id)
  on conflict (org_id, file_sha256) do nothing
  returning id into v_id;
  if v_id is null then
    -- a concurrent upload of the same file won the race
    select u.id into v_id from public.fin_report_uploads u where u.org_id = p_org_id and u.file_sha256 = v_sha;
    return app.fin_report_upload_json(v_id) || jsonb_build_object('existing', true);
  end if;

  insert into public.fin_report_visits (
    org_id, upload_id, row_no, visit_at, invoice_date, report_date, department, doctor_name, doctor_key, clinic_name,
    patient_pin, visit_status, invoice_type, selfpay_invoice_no, insurance_invoice_no, categories,
    gross, discount, vat, net, total, cash, card, bank_transfer, payment_gateway, other_payment, patient_share,
    insurance_claim, advance_consumed, credit_note_consumed, outstanding_credit, write_off, refund, is_cancelled)
  select p_org_id, v_id, x.row_no, x.visit_at, x.invoice_date, x.report_date, x.department, x.doctor_name, x.doctor_key,
         x.clinic_name, nullif(btrim(x.patient_pin), ''), x.visit_status, x.invoice_type, x.selfpay_invoice_no,
         x.insurance_invoice_no, coalesce(x.categories, '{}'::jsonb),
         coalesce(x.gross, 0), coalesce(x.discount, 0), coalesce(x.vat, 0), coalesce(x.net, 0), coalesce(x.total, 0),
         coalesce(x.cash, 0), coalesce(x.card, 0), coalesce(x.bank_transfer, 0), coalesce(x.payment_gateway, 0),
         coalesce(x.other_payment, 0), coalesce(x.patient_share, 0), coalesce(x.insurance_claim, 0),
         coalesce(x.advance_consumed, 0), coalesce(x.credit_note_consumed, 0), coalesce(x.outstanding_credit, 0),
         coalesce(x.write_off, 0), coalesce(x.refund, 0), coalesce(x.is_cancelled, false)
  from jsonb_to_recordset(p_rows) as x (
    row_no integer, visit_at timestamptz, invoice_date date, report_date date, department text, doctor_name text,
    doctor_key text, clinic_name text, patient_pin text, visit_status text, invoice_type text, selfpay_invoice_no text,
    insurance_invoice_no text, categories jsonb, gross numeric, discount numeric, vat numeric, net numeric,
    total numeric, cash numeric, card numeric, bank_transfer numeric, payment_gateway numeric, other_payment numeric,
    patient_share numeric, insurance_claim numeric, advance_consumed numeric, credit_note_consumed numeric,
    outstanding_credit numeric, write_off numeric, refund numeric, is_cancelled boolean);

  -- the database's own sums of the 12 reconciled columns (stored values, so to the fils)
  foreach k in array v_keys loop
    execute format('select coalesce(sum(%I), 0) from public.fin_report_visits where upload_id = $1', k)
      into v_sum using v_id;
    v_rows := v_rows || jsonb_build_object(k, v_sum);
    if (v_report ->> k) is null or (v_report ->> k)::numeric is distinct from v_sum then
      v_ok := false;
    end if;
  end loop;

  update public.fin_report_uploads
     set row_totals = v_rows,
         reconciled = v_ok and coalesce((p_meta ->> 'reconciled')::boolean, false)
   where id = v_id;
  return app.fin_report_upload_json(v_id) || jsonb_build_object('existing', false);
end;
$$;
revoke all on function public.fin_report_stage(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fin_report_stage(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------
create or replace function public.fin_report_commit(p_org_id uuid, p_upload_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  u record;
  v_rows integer;
  v_superseded integer;
  v_unknown integer;
begin
  -- one commit at a time per organisation, so two overlapping uploads cannot both stay current
  perform pg_advisory_xact_lock(hashtextextended('fin_report_commit:' || p_org_id::text, 0));
  select * into u from public.fin_report_uploads x where x.id = p_upload_id and x.org_id = p_org_id for update;
  if not found then
    raise exception 'report_not_found' using errcode = 'invalid_parameter_value';
  end if;
  if u.status <> 'staged' then
    raise exception 'report_not_staged' using errcode = 'check_violation';
  end if;
  if not u.reconciled then
    raise exception 'report_not_reconciled' using errcode = 'check_violation';
  end if;

  update public.fin_report_visits v
     set branch_code = (select b.code from public.fin_ref_branches b
                        where b.org_id = p_org_id and b.active and b.unite_clinic_long_name = v.clinic_name)
   where v.upload_id = u.id;

  update public.fin_report_visits v
     set is_current = false
   where v.org_id = p_org_id and v.is_current and v.upload_id <> u.id
     and v.report_date between u.from_date and u.to_date;
  get diagnostics v_superseded = row_count;

  update public.fin_report_visits v set is_current = true where v.upload_id = u.id;
  get diagnostics v_rows = row_count;

  select count(*) into v_unknown from public.fin_report_visits v where v.upload_id = u.id and v.branch_code is null;

  update public.fin_report_uploads
     set status = 'committed', committed_by = p_user_id, committed_at = now()
   where id = u.id;
  return jsonb_build_object('rows', v_rows, 'superseded', v_superseded, 'unknown_branch_rows', v_unknown);
end;
$$;
revoke all on function public.fin_report_commit(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_report_commit(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Discard (staged only)
-- ---------------------------------------------------------------------------
create or replace function public.fin_report_discard(p_org_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_rows integer;
begin
  select x.status, x.row_count into v_status, v_rows
  from public.fin_report_uploads x where x.id = p_upload_id and x.org_id = p_org_id for update;
  if v_status is null then
    raise exception 'report_not_found' using errcode = 'invalid_parameter_value';
  end if;
  if v_status <> 'staged' then
    raise exception 'report_not_staged' using errcode = 'check_violation';
  end if;
  delete from public.fin_report_uploads where id = p_upload_id;
  return jsonb_build_object('upload_id', p_upload_id, 'rows', v_rows);
end;
$$;
revoke all on function public.fin_report_discard(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_report_discard(uuid, uuid) to service_role;
