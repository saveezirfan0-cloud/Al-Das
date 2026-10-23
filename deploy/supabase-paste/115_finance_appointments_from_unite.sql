-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 114_finance_followup_submission_basis.sql.
-- Production normally gets this through .github/workflows/db-migrate.yml on merge; this file is the manual route.

-- W2 from the Unite connection (docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md, 23 Oct 2026).
--
-- Finance's appointments vs invoices page (and capacity booked vs available) no longer has to wait for an appointment
-- export file: the read-only Unite appointment sync (lib/unite/sync.ts, getallappointments; never the Finance API)
-- re-reads each finished day once a night and hands every day that ALL active clinics have settled to fin_appt_import,
-- the same import a file uses (lib/finance/appointment-api*.ts). Nothing else changes: the rows are the same sanitised
-- shape (Unite PIN as the only person key), matching stays pure TypeScript, and the newest upload for a day and clinic
-- wins whether it came from a file or from Unite.
--
--   * fin_appt_uploads.source: 'file' (default, every earlier upload) or 'unite_api'. A Unite day has no person behind
--     it (created_by null) and its sha256 is over the day's sanitised rows, so the same day twice changes nothing.
--   * fin_appt_import is redefined from its only definition (20261222000100) with p_meta.source; everything else is as
--     it was. Still service role only.

alter table public.fin_appt_uploads
  add column source text not null default 'file' check (source in ('file', 'unite_api'));

create or replace function public.fin_appt_import(p_org_id uuid, p_user_id uuid, p_meta jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sha text := p_meta ->> 'file_sha256';
  v_from date;
  v_to date;
  v_id uuid;
  v_rows integer;
  v_superseded integer := 0;
  v_source text := coalesce(nullif(p_meta ->> 'source', ''), 'file');
begin
  if p_org_id is null or jsonb_typeof(p_meta) is distinct from 'object' or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 30000
     or v_sha is null or v_sha !~ '^[0-9a-f]{64}$' or v_source not in ('file', 'unite_api') then
    raise exception 'appt_bad_input' using errcode = 'invalid_parameter_value';
  end if;
  v_from := (p_meta ->> 'from_date')::date;
  v_to := (p_meta ->> 'to_date')::date;
  if v_from is null or v_to is null or v_to < v_from then
    raise exception 'appt_bad_input' using errcode = 'invalid_parameter_value';
  end if;

  -- one import at a time per organisation, so two overlapping files cannot both stay current
  perform pg_advisory_xact_lock(hashtextextended('fin_appt_import:' || p_org_id::text, 0));

  select u.id, u.row_count into v_id, v_rows from public.fin_appt_uploads u where u.org_id = p_org_id and u.file_sha256 = v_sha;
  if v_id is not null then
    return jsonb_build_object('upload_id', v_id, 'existing', true, 'rows', v_rows, 'superseded', 0);
  end if;

  if exists (select 1 from jsonb_array_elements(p_rows) r
             where (r ->> 'appt_date')::date is null
                or (r ->> 'appt_date')::date not between v_from and v_to) then
    raise exception 'appt_rows_out_of_range' using errcode = 'check_violation';
  end if;

  insert into public.fin_appt_uploads (org_id, file_sha256, from_date, to_date, row_count, created_by, source)
  values (p_org_id, v_sha, v_from, v_to, jsonb_array_length(p_rows), p_user_id, v_source)
  returning id into v_id;

  insert into public.fin_appt_rows (org_id, upload_id, row_no, appointment_id, appt_date, start_min, duration_min, status,
                                    patient_pin, doctor_name, doctor_key, clinic_name, room)
  select p_org_id, v_id, x.row_no, x.appointment_id, x.appt_date, x.start_min, x.duration_min, x.status,
         nullif(btrim(x.patient_pin), ''), x.doctor_name, x.doctor_key, nullif(btrim(x.clinic_name), ''),
         nullif(btrim(x.room), '')
  from jsonb_to_recordset(p_rows) as x (
    row_no integer, appointment_id text, appt_date date, start_min smallint, duration_min integer, status text,
    patient_pin text, doctor_name text, doctor_key text, clinic_name text, room text);

  -- supersede only the clinics this file covers, so a one-clinic export never hides the other clinics' rows
  update public.fin_appt_rows r
     set is_current = false
   where r.org_id = p_org_id and r.is_current and r.upload_id <> v_id
     and r.appt_date between v_from and v_to
     and coalesce(r.clinic_name, '') in (
       select distinct coalesce(n.clinic_name, '') from public.fin_appt_rows n where n.upload_id = v_id);
  get diagnostics v_superseded = row_count;

  update public.fin_appt_rows r set is_current = true where r.upload_id = v_id;
  return jsonb_build_object('upload_id', v_id, 'existing', false, 'rows', jsonb_array_length(p_rows), 'superseded', v_superseded);
end;
$$;
revoke all on function public.fin_appt_import(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fin_appt_import(uuid, uuid, jsonb, jsonb) to service_role;
