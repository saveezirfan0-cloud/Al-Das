-- Unite clinic name aliases per finance branch (docs/41_REPORT_REVIEW_OCT_2026.md §6, OQ-162).
--
-- Unite is renaming its clinics (Palm Jumeirah -> Shoreline and so on) after 10 November 2026. Every report reads the
-- branch at read time by comparing the Unite clinic name with `fin_ref_branches.unite_clinic_long_name`; with one name
-- per branch, renaming it would turn every earlier month into "unknown branch". A branch now also carries
-- `unite_clinic_aliases`: other names Unite has used for the same branch. Old rows keep the name Unite delivered; the
-- branch is still derived when read.
--
--   * One name, one branch: a name may appear once per organisation across every branch's long name and aliases
--     (trigger, per-organisation advisory lock, 23505 like the existing unique index).
--   * Aliases are trimmed, blanks and duplicates dropped, at most 10, each at most 200 characters.
--   * Each function that compared the long name is redefined from its LAST definition with that one comparison widened
--     to "long name or any alias"; nothing else in them changes.

alter table public.fin_ref_branches add column if not exists unite_clinic_aliases text[] not null default '{}';

create or replace function app.fin_ref_branches_clinic_names_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_names text[];
  v_clash text;
begin
  select coalesce(array_agg(distinct a order by a), '{}')
    into new.unite_clinic_aliases
  from (select btrim(x) as a from unnest(coalesce(new.unite_clinic_aliases, '{}'::text[])) as x) s
  where a <> '' and a is distinct from new.unite_clinic_long_name;

  if cardinality(new.unite_clinic_aliases) > 10 then
    raise exception 'a branch has at most 10 other Unite clinic names' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.unite_clinic_aliases) a where char_length(a) > 200) then
    raise exception 'a Unite clinic name is at most 200 characters' using errcode = 'check_violation';
  end if;

  v_names := new.unite_clinic_aliases || case when new.unite_clinic_long_name is null then '{}'::text[]
                                              else array[new.unite_clinic_long_name] end;
  if cardinality(v_names) = 0 then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('fin_ref_branches_clinic_names:' || new.org_id::text));
  select n into v_clash
  from public.fin_ref_branches b, unnest(b.unite_clinic_aliases || case when b.unite_clinic_long_name is null
                                                                     then '{}'::text[] else array[b.unite_clinic_long_name] end) n
  where b.org_id = new.org_id and b.id <> new.id and n = any (v_names)
  limit 1;
  if v_clash is not null then
    raise exception 'that Unite clinic name already belongs to another branch' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists fin_ref_branches_clinic_names_guard on public.fin_ref_branches;
create trigger fin_ref_branches_clinic_names_guard
  before insert or update of unite_clinic_long_name, unite_clinic_aliases, org_id on public.fin_ref_branches
  for each row execute function app.fin_ref_branches_clinic_names_guard();

-- public.fin_apply_invoices: from 20261009000970_finance_f21.sql (1 comparison widened, nothing else changed)
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
    where b.org_id = p_org_id and b.active and (b.unite_clinic_long_name = x.unite_clinic_long_name or x.unite_clinic_long_name = any (b.unite_clinic_aliases))
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

-- public.fin_rederive_branches: from 20261009000600_finance_capture.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_rederive_branches(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    update public.fin_invoices i
    set branch_code = b.code
    from public.fin_ref_branches b
    where i.org_id = p_org_id and i.branch_code is null and b.org_id = i.org_id and b.active
      and (b.unite_clinic_long_name = i.unite_clinic_long_name or i.unite_clinic_long_name = any (b.unite_clinic_aliases))
    returning i.inv_display_number
  loop
    perform public.fin_auto_close_exceptions(p_org_id, 'E07', r.inv_display_number);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- app.fin_report_upload_json: from 20261126000200_finance_unite_report_functions.sql (1 comparison widened, nothing else changed)
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
                        where b.org_id = u.org_id and b.active and (b.unite_clinic_long_name = v.clinic_name or v.clinic_name = any (b.unite_clinic_aliases))))
  )
  from public.fin_report_uploads u
  where u.id = p_upload_id;
$$;

-- public.fin_report_commit: from 20261126000200_finance_unite_report_functions.sql (1 comparison widened, nothing else changed)
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
                        where b.org_id = p_org_id and b.active and (b.unite_clinic_long_name = v.clinic_name or v.clinic_name = any (b.unite_clinic_aliases)))
   where v.upload_id = u.id;

  -- supersede only the clinics this upload covers, so a one-clinic export never hides the other clinics' rows
  update public.fin_report_visits v
     set is_current = false
   where v.org_id = p_org_id and v.is_current and v.upload_id <> u.id
     and v.report_date between u.from_date and u.to_date
     and coalesce(v.clinic_name, '') in (
       select distinct coalesce(n.clinic_name, '') from public.fin_report_visits n where n.upload_id = u.id);
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

-- public.fin_report_latest_month: from 20261126000300_finance_doctor_performance.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_report_latest_month(p_org_id uuid, p_branches text[] default null)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select date_trunc('month', max(r.report_date))::date
  from public.fin_report_visits r
  left join public.fin_ref_branches b
    on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
  where r.org_id = p_org_id and r.is_current
    and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches));
$$;

-- public.fin_doctor_performance_inputs: from 20261126000300_finance_doctor_performance.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_doctor_performance_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_prev date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_settings jsonb;
  v_scopes jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_prev := (v_month - interval '1 month')::date;
  v_next := (v_month + interval '1 month')::date;

  select jsonb_build_object(
           'target', coalesce(s.perf_arpp_target, 750),
           'near', coalesce(s.perf_band_near, 700),
           'moderate', coalesce(s.perf_band_moderate, 650))
    into v_settings
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select case when r.report_date >= v_month then 'current' else 'previous' end as period,
           nullif(btrim(r.department), '') as department,
           r.doctor_key,
           r.doctor_name,
           coalesce(r.patient_ref, r.patient_pin, r.id::text) as pid,
           r.net,
           r.visit_status,
           r.is_cancelled
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_prev and r.report_date < v_next
      and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches))
      and (v_branch is null or coalesce(b.code, r.branch_code) = v_branch)
  ),
  -- Display name: the most frequent spelling for the doctor key over both months, ties alphabetical.
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (select doctor_key, doctor_name, count(*) as n from v group by doctor_key, doctor_name) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  -- g: 0 = doctor within department, 1 = department, 3 = total (grouping(department, doctor_key)).
  agg as (
    select period, department, doctor_key, grouping(department, doctor_key) as g,
           sum(net) as revenue,
           count(*) as visits,
           count(distinct pid) as patients,
           count(*) filter (where visit_status = 'new') as new_visits,
           count(*) filter (where is_cancelled) as cancelled_visits,
           count(distinct doctor_key) as doctors
    from v
    group by grouping sets ((period, department, doctor_key), (period, department), (period))
  ),
  per_patient as (
    select period, department, doctor_key, grouping(department, doctor_key) as g, pid, sum(net) as net
    from v
    group by grouping sets ((period, department, doctor_key, pid), (period, department, pid), (period, pid))
  ),
  unbilled as (
    select period, department, doctor_key, g, count(*) filter (where net <= 0) as n
    from per_patient
    group by period, department, doctor_key, g
  ),
  res as (
    select a.*, coalesce(u.n, 0) as unbilled_patients
    from agg a
    left join unbilled u
      on u.period = a.period and u.g = a.g
     and u.department is not distinct from a.department and u.doctor_key is not distinct from a.doctor_key
  )
  select jsonb_object_agg(p.period, jsonb_build_object(
           'doctors', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'department', x.department, 'doctor_key', x.doctor_key, 'doctor_name', n.doctor_name,
                      'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits)
                    order by x.department collate "C" nulls last, x.doctor_key collate "C")
             from res x join names n on n.doctor_key = x.doctor_key
             where x.period = p.period and x.g = 0), '[]'::jsonb),
           'departments', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'department', x.department, 'doctors', x.doctors,
                      'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits)
                    order by x.department collate "C" nulls last)
             from res x
             where x.period = p.period and x.g = 1), '[]'::jsonb),
           'total', coalesce((
             select jsonb_build_object(
                      'doctors', x.doctors, 'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits,
                      'cancelled_visits', x.cancelled_visits)
             from res x
             where x.period = p.period and x.g = 3),
             jsonb_build_object('doctors', 0, 'revenue', 0, 'visits', 0, 'patients', 0, 'unbilled_patients', 0,
                                'new_visits', 0, 'cancelled_visits', 0))))
    into v_scopes
  from (values ('current'), ('previous')) as p (period);

  return jsonb_build_object(
    'month', v_month,
    'previous_month', v_prev,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'previous_coverage', app.fin_report_coverage(p_org_id, v_prev, (v_month - 1)),
    'settings', v_settings,
    'current', v_scopes -> 'current',
    'previous', v_scopes -> 'previous'
  );
end;
$$;

-- public.fin_collections_inputs: from 20261208000100_finance_collections.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_collections_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_late integer;
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  select coalesce(s.dq_late_invoice_days, 3)
    into v_late
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select r.report_date,
           coalesce(b.code, r.branch_code) as branch_code,
           nullif(btrim(r.clinic_name), '') as clinic_name,
           r.doctor_key,
           r.doctor_name,
           nullif(upper(regexp_replace(btrim(coalesce(r.invoice_type, '')), '\s+', ' ', 'g')), '') as invoice_type,
           r.invoice_date,
           (r.visit_at at time zone 'Asia/Dubai')::date as visit_date,
           nullif(btrim(r.selfpay_invoice_no), '') is null
             and nullif(btrim(r.insurance_invoice_no), '') is null as no_invoice_no,
           r.visit_status,
           r.categories,
           r.is_cancelled,
           r.cash, r.card, r.bank_transfer, r.payment_gateway, r.other_payment, r.patient_share, r.insurance_claim,
           r.net, r.advance_consumed, r.credit_note_consumed, r.outstanding_credit, r.write_off, r.refund
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_month and r.report_date < v_next
      and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches))
      and (v_branch is null or coalesce(b.code, r.branch_code) = v_branch)
  ),
  -- g (grouping of report_date, branch_code, doctor_key, invoice_type): 7 day, 11 branch, 13 doctor, 14 type, 15 total.
  agg as (
    select grouping(report_date, branch_code, doctor_key, invoice_type) as g,
           report_date, branch_code, doctor_key, invoice_type,
           jsonb_build_object(
             'rows', count(*),
             'cash', coalesce(sum(cash), 0),
             'card', coalesce(sum(card), 0),
             'bank_transfer', coalesce(sum(bank_transfer), 0),
             'payment_gateway', coalesce(sum(payment_gateway), 0),
             'other_payment', coalesce(sum(other_payment), 0),
             'patient_share', coalesce(sum(patient_share), 0),
             'insurance_claim', coalesce(sum(insurance_claim), 0),
             'net', coalesce(sum(net), 0),
             'advance_consumed', coalesce(sum(advance_consumed), 0),
             'credit_note_consumed', coalesce(sum(credit_note_consumed), 0),
             'outstanding_credit', coalesce(sum(outstanding_credit), 0),
             'write_off', coalesce(sum(write_off), 0),
             'refund', coalesce(sum(refund), 0)) as sums
    from v
    group by grouping sets ((report_date), (branch_code), (doctor_key), (invoice_type), ())
  ),
  -- Display name: the most frequent spelling for the doctor key in the month, ties alphabetical (as in 23B).
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (select doctor_key, doctor_name, count(*) as n from v group by doctor_key, doctor_name) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  flags as (
    select v.*,
           v.no_invoice_no and v.net = 0 as f_no_invoice,
           v.invoice_date is not null and v.visit_date is not null
             and v.invoice_date - v.visit_date > v_late as f_late_invoice,
           v.invoice_date is not null and v.visit_date is not null
             and v.visit_date < date_trunc('month', v.invoice_date)::date as f_earlier_month,
           v.branch_code is null as f_unknown_branch,
           v.categories ? 'NO' as f_category_no,
           v.visit_status is null as f_blank_visit_status,
           v.invoice_type is null and v.net > 0 as f_blank_invoice_type,
           v.is_cancelled as f_cancelled
    from v
  ),
  quality as (
    select jsonb_build_object(
             'no_invoice', jsonb_build_object('rows', count(*) filter (where f_no_invoice),
                                              'net', coalesce(sum(net) filter (where f_no_invoice), 0)),
             'late_invoice', jsonb_build_object('rows', count(*) filter (where f_late_invoice),
                                                'net', coalesce(sum(net) filter (where f_late_invoice), 0)),
             'earlier_month', jsonb_build_object('rows', count(*) filter (where f_earlier_month),
                                                 'net', coalesce(sum(net) filter (where f_earlier_month), 0)),
             'unknown_branch', jsonb_build_object('rows', count(*) filter (where f_unknown_branch),
                                                  'net', coalesce(sum(net) filter (where f_unknown_branch), 0)),
             'category_no', jsonb_build_object('rows', count(*) filter (where f_category_no),
                                               'net', coalesce(sum(net) filter (where f_category_no), 0)),
             'blank_visit_status', jsonb_build_object('rows', count(*) filter (where f_blank_visit_status),
                                                      'net', coalesce(sum(net) filter (where f_blank_visit_status), 0)),
             'blank_invoice_type', jsonb_build_object('rows', count(*) filter (where f_blank_invoice_type),
                                                      'net', coalesce(sum(net) filter (where f_blank_invoice_type), 0)),
             'cancelled', jsonb_build_object('rows', count(*) filter (where f_cancelled),
                                             'net', coalesce(sum(net) filter (where f_cancelled), 0))) as j
    from flags
  ),
  clinics as (
    select coalesce(jsonb_agg(jsonb_build_object('clinic', c.clinic_name, 'rows', c.n, 'net', c.net)
                              order by c.clinic_name collate "C" nulls last), '[]'::jsonb) as j
    from (select clinic_name, count(*) as n, sum(net) as net from v where branch_code is null group by clinic_name) c
  )
  select jsonb_build_object(
           'days', coalesce((select jsonb_agg(jsonb_build_object('date', a.report_date) || a.sums
                                              order by a.report_date)
                             from agg a where a.g = 7), '[]'::jsonb),
           'branches', coalesce((select jsonb_agg(jsonb_build_object('branch_code', a.branch_code) || a.sums
                                                  order by a.branch_code collate "C" nulls last)
                                 from agg a where a.g = 11), '[]'::jsonb),
           'doctors', coalesce((select jsonb_agg(jsonb_build_object('doctor_key', a.doctor_key,
                                                                    'doctor_name', n.doctor_name) || a.sums
                                                 order by a.doctor_key collate "C")
                                from agg a join names n on n.doctor_key = a.doctor_key where a.g = 13), '[]'::jsonb),
           'invoice_types', coalesce((select jsonb_agg(jsonb_build_object('invoice_type', a.invoice_type) || a.sums
                                                       order by a.invoice_type collate "C" nulls last)
                                      from agg a where a.g = 14), '[]'::jsonb),
           'total', (select a.sums from agg a where a.g = 15),
           'quality', (select q.j from quality q) || jsonb_build_object('unknown_clinics', (select c.j from clinics c)))
    into v_out;

  return jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'settings', jsonb_build_object('late_invoice_days', v_late)
  ) || v_out;
end;
$$;

-- public.fin_insurance_billing_recon_inputs: from 20261208000200_finance_insurance_billing_recon.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_insurance_billing_recon_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_unrestricted boolean := p_branches is null and nullif(btrim(p_branch), '') is null;
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  with r as (
    -- this month's current report rows of EVERY branch (ambiguity is judged over all of them); visible = in scope
    select app.fin_invoice_key(v.insurance_invoice_no) as key,
           nullif(btrim(v.insurance_invoice_no), '') as invoice_no,
           x.branch,
           v.doctor_key,
           v.doctor_name,
           v.report_date,
           v.insurance_claim as claim,
           v.is_cancelled,
           coalesce((p_branches is null or x.branch = any (p_branches))
                    and (v_branch is null or x.branch = v_branch), false) as visible
    from public.fin_report_visits v
    left join public.fin_ref_branches b
      on b.org_id = v.org_id and b.active and (b.unite_clinic_long_name = v.clinic_name or v.clinic_name = any (b.unite_clinic_aliases))
    cross join lateral (select coalesce(b.code, v.branch_code) as branch) x
    where v.org_id = p_org_id
      and v.is_current
      and v.report_date >= v_month and v.report_date < v_next
  ),
  -- one entry per invoice number with at least one visible, not cancelled row this month
  inv as (
    select r.key,
           min(r.invoice_no collate "C") filter (where r.visible) as invoice_no,
           count(distinct coalesce(r.branch, '') || '|' || r.doctor_key) as pairs,
           sum(r.claim) filter (where r.visible) as billed,
           count(*) filter (where r.visible) as rows,
           min(r.report_date) filter (where r.visible) as first_date,
           max(r.report_date) filter (where r.visible) as last_date
    from r
    where r.key <> '' and not r.is_cancelled
    group by r.key
    having bool_or(r.visible)
  ),
  vis_pairs as (
    select p.key,
           jsonb_agg(jsonb_build_object('branch', p.branch, 'doctor', p.doctor_name)
                     order by p.branch collate "C" nulls last, p.doctor_name collate "C") as list
    from (
      select distinct on (r.key, r.branch, r.doctor_key) r.key, r.branch, r.doctor_key, r.doctor_name
      from r
      where r.key <> '' and not r.is_cancelled and r.visible
      order by r.key, r.branch, r.doctor_key, r.doctor_name collate "C"
    ) p
    group by p.key
  ),
  sub as (
    select app.fin_invoice_key(c.invoice_no) as key,
           sum(coalesce(c.net, c.initial_net, 0)) as submitted,
           count(*) as activities,
           jsonb_agg(distinct c.payer_id) filter (where nullif(btrim(c.payer_id), '') is not null) as payers
    from public.ins_claim_activities c
    where c.org_id = p_org_id
      and app.fin_invoice_key(c.invoice_no) in (select i.key from inv i)
    group by 1
  ),
  -- Diligence activities dated this month (service date, else transaction date); only without a branch restriction
  -- or filter, since activities carry no branch
  acts as (
    select app.fin_invoice_key(c.invoice_no) as key,
           btrim(c.invoice_no) as invoice_no,
           coalesce(c.net, c.initial_net, 0) as submitted,
           coalesce(c.activity_start_date, c.transaction_date) as activity_date,
           nullif(btrim(c.payer_id), '') as payer_id
    from public.ins_claim_activities c
    where v_unrestricted
      and c.org_id = p_org_id
      and coalesce(c.activity_start_date, c.transaction_date) >= v_month
      and coalesce(c.activity_start_date, c.transaction_date) < v_next
  ),
  -- ... whose invoice number is on no current, not cancelled report row of this month
  un as (
    select a.key,
           min(a.invoice_no collate "C") as invoice_no,
           sum(a.submitted) as submitted,
           count(*) as activities,
           min(a.activity_date) as first_date,
           jsonb_agg(distinct a.payer_id) filter (where a.payer_id is not null) as payers
    from acts a
    where a.key <> ''
      and not exists (select 1 from r where r.key = a.key and not r.is_cancelled)
    group by a.key
  ),
  -- where else the report has them: the latest month with a not cancelled row, and whether a cancelled row has it
  elsewhere as (
    select app.fin_invoice_key(v.insurance_invoice_no) as key,
           max(date_trunc('month', v.report_date)::date) filter (where not v.is_cancelled) as report_month,
           bool_or(v.is_cancelled) as cancelled
    from public.fin_report_visits v
    where v.org_id = p_org_id and v.is_current
      and app.fin_invoice_key(v.insurance_invoice_no) in (select u.key from un u)
    group by 1
  )
  select jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'unreported_shown', v_unrestricted,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'settings', (
      select jsonb_build_object(
               'tolerance', coalesce(s.ins_recon_tolerance, 1.00),
               'grace_days', coalesce(s.ins_recon_grace_days, 7))
      from (select 1) one
      left join public.fin_ref_finance_settings s on s.org_id = p_org_id),
    'summary', (
      select jsonb_build_object(
               'billed', coalesce(sum(r.claim) filter (where not r.is_cancelled), 0),
               'billed_rows', count(*) filter (where not r.is_cancelled and r.claim <> 0),
               'no_invoice_no_rows', count(*) filter (where not r.is_cancelled and r.key = '' and r.claim <> 0),
               'no_invoice_no_amount', coalesce(sum(r.claim) filter (where not r.is_cancelled and r.key = ''), 0),
               'cancelled_rows', count(*) filter (where r.is_cancelled and r.claim <> 0),
               'cancelled_amount', coalesce(sum(r.claim) filter (where r.is_cancelled), 0))
      from r
      where r.visible)
      || (
      select jsonb_build_object(
               'submitted_no_invoice_no_activities', count(*),
               'submitted_no_invoice_no_amount', coalesce(sum(a.submitted), 0))
      from acts a
      where a.key = ''),
    'invoices', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', i.key,
               'invoice_no', i.invoice_no,
               'billed', i.billed,
               'rows', i.rows,
               'first_date', i.first_date,
               'last_date', i.last_date,
               'pairs', i.pairs,
               'visible_pairs', coalesce(vp.list, '[]'::jsonb),
               'submitted', s.submitted,
               'activities', coalesce(s.activities, 0),
               'payers', coalesce(s.payers, '[]'::jsonb))
             order by i.key collate "C"), '[]'::jsonb)
      from inv i
      left join vis_pairs vp on vp.key = i.key
      left join sub s on s.key = i.key),
    'unreported', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', u.key,
               'invoice_no', u.invoice_no,
               'submitted', u.submitted,
               'activities', u.activities,
               'first_date', u.first_date,
               'payers', coalesce(u.payers, '[]'::jsonb),
               'report_month', e.report_month,
               'cancelled_in_report', coalesce(e.cancelled, false))
             order by u.key collate "C"), '[]'::jsonb)
      from un u
      left join elsewhere e on e.key = u.key))
    into v_out;

  return v_out;
end;
$$;

-- public.fin_mgmt_alert_inputs: from 20261208000300_finance_management_alerts.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_mgmt_alert_inputs(p_org_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  return jsonb_build_object(
    'month', v_month,
    'last_covered', (
      select max(u.to_date) from public.fin_report_uploads u
      where u.org_id = p_org_id and u.status = 'committed'),
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.report_date, 'branch', d.branch, 'department', d.department,
                                          'net', d.net)
                       order by d.report_date, d.branch collate "C" nulls last, d.department collate "C" nulls last)
      from (
        select r.report_date,
               coalesce(b.code, r.branch_code) as branch,
               nullif(btrim(r.department), '') as department,
               sum(r.net) as net
        from public.fin_report_visits r
        left join public.fin_ref_branches b
          on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
        where r.org_id = p_org_id
          and r.is_current
          and r.report_date >= v_month and r.report_date < v_next
        group by 1, 2, 3
      ) d), '[]'::jsonb)
  );
end;
$$;

-- public.fin_contribution_inputs: from 20261208000400_finance_contribution.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_contribution_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  with v as (
    select coalesce(b.code, r.branch_code) as branch_code,
           nullif(btrim(r.department), '') as department,
           r.doctor_key,
           r.doctor_name,
           upper(btrim(sp.dha_id)) as dha_id,
           r.net
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
    left join public.specialists sp
      on sp.org_id = r.org_id and sp.report_doctor_key = r.doctor_key
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_month and r.report_date < v_next
  ),
  -- every (branch, department, doctor) of the month, all branches: the weights
  grp as (
    select branch_code, department, doctor_key, dha_id, sum(net) as revenue, count(*) as visits
    from v
    group by branch_code, department, doctor_key, dha_id
  ),
  scoped as (
    select g.*
    from grp g
    where (p_branches is null or g.branch_code = any (p_branches))
      and (v_branch is null or g.branch_code = v_branch)
  ),
  -- display name: the most frequent spelling in view, ties alphabetical (as 23B)
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (
      select v.doctor_key, v.doctor_name, count(*) as n
      from v
      where (p_branches is null or v.branch_code = any (p_branches))
        and (v_branch is null or v.branch_code = v_branch)
      group by v.doctor_key, v.doctor_name
    ) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  dhas as (
    select distinct dha_id from scoped where dha_id is not null
  )
  select jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'period_approved', exists (
      select 1 from public.fin_cost_periods p
      where p.org_id = p_org_id and p.month = v_month and p.status = 'approved'),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branch_code', s.branch_code, 'department', s.department, 'doctor_key', s.doctor_key,
               'doctor_name', n.doctor_name, 'dha_id', s.dha_id, 'revenue', s.revenue, 'visits', s.visits)
             order by s.branch_code collate "C" nulls last, s.department collate "C" nulls last,
                      s.doctor_key collate "C")
      from scoped s join names n on n.doctor_key = s.doctor_key), '[]'::jsonb),
    'doctor_weights', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', w.dha_id, 'revenue', w.revenue, 'groups', w.groups)
             order by w.dha_id collate "C")
      from (
        select g.dha_id, sum(greatest(g.revenue, 0)) as revenue, count(*) as groups
        from grp g join dhas d on d.dha_id = g.dha_id
        group by g.dha_id
      ) w), '[]'::jsonb),
    'comp', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', c.dha_id, 'amount', c.amount) order by c.dha_id collate "C")
      from (
        select upper(btrim(x.doctor_dha_id)) as dha_id, sum(x.amount) as amount
        from public.fin_cost_doctor_comp x
        join dhas d on d.dha_id = upper(btrim(x.doctor_dha_id))
        where x.org_id = p_org_id and x.month = v_month and x.amount > 0   -- 0 = unavailable, never zero pay
        group by 1
      ) c), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', c.dha_id, 'amount', c.amount) order by c.dha_id collate "C")
      from (
        select x.doctor_dha_id as dha_id, sum(x.amount) as amount
        from public.fin_doctor_charges x
        join dhas d on d.dha_id = x.doctor_dha_id
        where x.org_id = p_org_id and x.month = v_month
        group by 1
      ) c), '[]'::jsonb),
    'branch_overheads', coalesce((
      select jsonb_agg(jsonb_build_object('branch_code', o.branch_code, 'amount', o.amount)
             order by o.branch_code collate "C")
      from (
        select x.branch_code, sum(x.amount) as amount
        from public.fin_cost_overheads x
        where x.org_id = p_org_id and x.month = v_month and x.branch_code is not null and x.amount > 0
          and (p_branches is null or x.branch_code = any (p_branches))
          and (v_branch is null or x.branch_code = v_branch)
        group by 1
      ) o), '[]'::jsonb),
    'shared_overheads', coalesce((
      select jsonb_agg(jsonb_build_object('pool', x.pool, 'amount', x.amount, 'basis', x.basis)
             order by lower(x.pool) collate "C")
      from public.fin_cost_overheads x
      where x.org_id = p_org_id and x.month = v_month and x.branch_code is null and x.amount > 0), '[]'::jsonb),
    'branch_weights', coalesce((
      select jsonb_agg(jsonb_build_object('branch_code', w.branch_code, 'revenue', w.revenue, 'visits', w.visits)
             order by w.branch_code collate "C" nulls last)
      from (
        select g.branch_code, sum(g.revenue) as revenue, sum(g.visits) as visits from grp g group by g.branch_code
      ) w), '[]'::jsonb)
  )
  into v_out;

  return v_out;
end;
$$;

-- public.fin_recruitment_benchmarks: from 20261208000600_finance_recruitment_scenarios.sql (1 comparison widened, nothing else changed)
create or replace function public.fin_recruitment_benchmarks(p_org_id uuid, p_branches text[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb;
  v_months jsonb;
  v_departments jsonb;
  v_clinic jsonb;
begin
  if p_org_id is null then
    raise exception 'org is required' using errcode = 'invalid_parameter_value';
  end if;

  select jsonb_build_object(
           'conservative_pct', coalesce(s.recruit_conservative_pct, 70),
           'consumables_pct', coalesce(s.recruit_consumables_pct, 12),
           'gateway_pct', coalesce(s.recruit_gateway_pct, 1.5),
           'min_peer_months', coalesce(s.recruit_min_peer_months, 6))
    into v_settings
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select nullif(btrim(r.department), '') as department, r.doctor_key,
           date_trunc('month', r.report_date)::date as month, r.net
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and (b.unite_clinic_long_name = r.clinic_name or r.clinic_name = any (b.unite_clinic_aliases))
    where r.org_id = p_org_id
      and r.is_current
      and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches))
  ),
  full_months as (
    select m.month
    from (select distinct month from v) m
    where app.fin_report_coverage(p_org_id, m.month, ((m.month + interval '1 month')::date - 1))
          = jsonb_build_array(jsonb_build_object('from', m.month, 'to', ((m.month + interval '1 month')::date - 1)))
  ),
  dm as (
    select v.department, v.doctor_key, v.month, sum(v.net) as net
    from v join full_months f on f.month = v.month
    group by v.department, v.doctor_key, v.month
  ),
  cm as (
    select doctor_key, month, sum(net) as net from dm group by doctor_key, month
  )
  select
    (select coalesce(jsonb_agg(f.month order by f.month), '[]'::jsonb) from full_months f),
    (select coalesce(jsonb_agg(jsonb_build_object(
               'department', d.department, 'doctor_months', d.n, 'doctors', d.doctors,
               'median', d.median, 'p75', d.p75) order by d.department collate "C" nulls last), '[]'::jsonb)
     from (
       select department, count(*) as n, count(distinct doctor_key) as doctors,
              round((percentile_cont(0.5) within group (order by net))::numeric, 3) as median,
              round((percentile_cont(0.75) within group (order by net))::numeric, 3) as p75
       from dm
       where net > 0
       group by department
     ) d),
    (select jsonb_build_object(
               'department', null, 'doctor_months', count(*), 'doctors', count(distinct doctor_key),
               'median', round((percentile_cont(0.5) within group (order by net))::numeric, 3),
               'p75', round((percentile_cont(0.75) within group (order by net))::numeric, 3))
     from cm where net > 0)
    into v_months, v_departments, v_clinic;

  return jsonb_build_object(
    'settings', v_settings,
    'months', v_months,
    'departments', v_departments,
    'clinic', v_clinic
  );
end;
$$;

