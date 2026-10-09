-- Finance F2: capture pipeline support.
--   * integration_accounts (encrypted credentials + token cache) and unite_api_calls (call log)
--   * fin_apply_invoices: atomic, idempotent upsert of one batch of already-normalised invoices
--   * exception helpers (reused by the F5 rules), branch re-derivation, invoice-number gap report
--   * hourly tick enqueuer + 30 s pings for the finance_capture queue
--
-- The Unite Finance API is deliver-once. Mapping Unite's JSON to the normalised
-- shape happens in TypeScript (lib/finance/unite-mapping.ts); this file only
-- writes rows, in ONE transaction per batch, so a failed batch changes nothing
-- and can be replayed from fin_raw_unite_batches.

-- ---------------------------------------------------------------------------
-- Infrastructure tables (service role only: RLS on, no policies)
-- ---------------------------------------------------------------------------

create table public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null,                                 -- 'unite', 'google_calendar', ...
  config_enc text not null,                           -- AES-256-GCM (lib/crypto.ts); never selected by the UI
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  token_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind)
);
create trigger integration_accounts_set_updated_at before update on public.integration_accounts
  for each row execute function app.set_updated_at();

create table public.unite_api_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  endpoint text not null,                             -- 'authorize' | 'refreshtoken' | 'GetFinanceDetails' | ...
  http_status integer,
  unite_status text,                                  -- body Status / Message (never record data)
  duration_ms integer,
  batch_id uuid references public.fin_raw_unite_batches (id) on delete set null,
  at timestamptz not null default now()
);
create index unite_api_calls_org_at_idx on public.unite_api_calls (org_id, at desc);

alter table public.integration_accounts enable row level security;
alter table public.unite_api_calls enable row level security;

-- ---------------------------------------------------------------------------
-- Exception helpers
-- ---------------------------------------------------------------------------

-- Opens an exception unless one is already open for the same (rule, entity).
-- Inactive or unknown rules open nothing. `detail` must not contain patient data.
create or replace function public.fin_open_exception(
  p_org_id uuid,
  p_rule_code text,
  p_entity_type text,
  p_entity_key text,
  p_branch_code text default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_id uuid;
begin
  select owner_role into v_owner
  from public.fin_ref_exception_rules
  where org_id = p_org_id and rule_code = p_rule_code and active;
  if v_owner is null then
    return null;
  end if;

  insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, branch_code, owner_role, detail)
  values (p_org_id, p_rule_code, p_entity_type, p_entity_key, p_branch_code, v_owner, coalesce(p_detail, '{}'::jsonb))
  on conflict (org_id, rule_code, entity_key) where status in ('open', 'in_progress') do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.fin_auto_close_exceptions(
  p_org_id uuid,
  p_rule_code text,
  p_entity_key text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.ops_exceptions
  set status = 'auto_closed', closed_at = now(), closure_note = 'condition cleared'
  where org_id = p_org_id and rule_code = p_rule_code and entity_key = p_entity_key
    and status in ('open', 'in_progress');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- A failed batch keeps its raw payload; the exception tells an admin to fix the
-- mapping and replay (or ask Unite to re-queue when the raw insert itself failed).
create or replace function public.fin_batch_mark_failed(p_batch_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  update public.fin_raw_unite_batches
  set process_status = 'failed', error = left(coalesce(p_error, 'unknown error'), 1000)
  where id = p_batch_id
  returning org_id into v_org;
  if v_org is not null then
    perform public.fin_open_exception(
      v_org, 'E09', 'batch', p_batch_id::text, null,
      jsonb_build_object('reason', 'batch_failed', 'error', left(coalesce(p_error, ''), 300))
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- fin_apply_invoices
--   p_invoices: [{ inv_display_number, ..., record_hash, record, lines: [...], payments: [...] }]
--   Idempotent: applying the same batch twice changes nothing. A replay of an
--   OLDER batch never overwrites newer current state (it only records history).
-- ---------------------------------------------------------------------------

create or replace function public.fin_apply_invoices(p_org_id uuid, p_batch_id uuid, p_invoices jsonb)
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
  v_expected := coalesce(v_batch.record_count, jsonb_array_length(p_invoices));
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
        txn_ref_no = excluded.txn_ref_no, txn_ref_name = excluded.txn_ref_name, card_type = excluded.card_type,
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
        'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions)
  where id = p_batch_id;

  perform public.fin_auto_close_exceptions(p_org_id, 'E09', p_batch_id::text);

  return jsonb_build_object(
    'invoices', c_invoices, 'created', c_created, 'updated', c_updated, 'unchanged', c_unchanged,
    'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions);
end;
$$;

-- After an admin maps a clinic name, re-derive branches for invoices that had none
-- (and close their E07 exceptions) without waiting for a replay.
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
      and b.unite_clinic_long_name = i.unite_clinic_long_name
    returning i.inv_display_number
  loop
    perform public.fin_auto_close_exceptions(p_org_id, 'E07', r.inv_display_number);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Missing numbers inside each invoice-number series (e.g. 'ADMC/C/'), for the
-- data-health gap report. Gaps mean records Unite has not delivered yet.
create or replace function public.fin_invoice_number_gaps(p_org_id uuid, p_from date default date '2026-01-01')
returns table (series text, missing_from bigint, missing_to bigint, missing_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with parsed as (
    select (m)[1] as series, (m)[2]::bigint as n
    from (
      select regexp_match(inv_display_number, '^(.*?)([0-9]{1,15})$') as m
      from public.fin_invoices
      where org_id = p_org_id and transaction_date >= p_from
    ) s
    where m is not null
  ), uniq as (
    select distinct series, n from parsed
  ), stepped as (
    select series, n, lag(n) over (partition by series order by n) as prev from uniq
  )
  select series, prev + 1, n - 1, n - prev - 1
  from stepped
  where prev is not null and n - prev > 1
  order by series, prev;
$$;

-- ---------------------------------------------------------------------------
-- Scheduling: one tick per enabled org per hour; the queue is pinged every 30 s.
-- ---------------------------------------------------------------------------

create or replace function public.fin_capture_enqueue_ticks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_n integer := 0;
begin
  for s in select org_id from public.fin_capture_settings where enabled loop
    if not exists (
      select 1 from pgmq.q_finance_capture
      where message ->> 'kind' = 'tick' and message ->> 'org_id' = s.org_id::text
    ) then
      perform pgmq.send('finance_capture', jsonb_build_object('kind', 'tick', 'org_id', s.org_id));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname in ('pulse:finance_capture', 'pulse:finance_capture_tick') loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:finance_capture_tick', '5 * * * *', $$select public.fin_capture_enqueue_ticks()$$);
select cron.schedule('pulse:finance_capture', '30 seconds', $$select app.ping_jobs('finance_capture')$$);

-- ---------------------------------------------------------------------------
-- Privileges: service role only
-- ---------------------------------------------------------------------------

revoke all on function public.fin_open_exception(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fin_auto_close_exceptions(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fin_batch_mark_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.fin_apply_invoices(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fin_rederive_branches(uuid) from public, anon, authenticated;
revoke all on function public.fin_invoice_number_gaps(uuid, date) from public, anon, authenticated;
revoke all on function public.fin_capture_enqueue_ticks() from public, anon, authenticated;
grant execute on function public.fin_open_exception(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.fin_auto_close_exceptions(uuid, text, text) to service_role;
grant execute on function public.fin_batch_mark_failed(uuid, text) to service_role;
grant execute on function public.fin_apply_invoices(uuid, uuid, jsonb) to service_role;
grant execute on function public.fin_rederive_branches(uuid) to service_role;
grant execute on function public.fin_invoice_number_gaps(uuid, date) to service_role;
grant execute on function public.fin_capture_enqueue_ticks() to service_role;
