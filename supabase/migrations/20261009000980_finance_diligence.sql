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
