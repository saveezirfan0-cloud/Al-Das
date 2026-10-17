-- W2: Unite appointments <-> invoices (docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md).
--
--   * The Unite appointment export (.xlsx / .csv) is parsed on the server (lib/finance/parse-appointments.ts), the original
--     is deleted at once and only sanitised rows land here. NEVER stored: patient name, date of birth, Emirates ID,
--     phone, insurance member id, or any column the mapping file does not name. The Unite PIN is the only person key.
--   * fin_appt_uploads: one row per file (sha256 only, never the file). fin_appt_rows: one row per appointment.
--     Importing makes its rows current and supersedes the current rows of earlier uploads for the same clinics and
--     dates (is_current = false; nothing is deleted), the way the Unite collection report (23A) does.
--   * Both tables have RLS and no policies: service role only. The page reads them after can('finance.revenue.view');
--     the import runs after can('finance.revenue.import'). No new permission.
--   * The matching to Unite invoices (fin_invoices) is pure TypeScript (lib/finance/appointment-billing.ts); nothing here
--     writes to fin_invoices or Unite.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.fin_appt_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  from_date date not null,
  to_date date not null,
  row_count integer not null check (row_count > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (to_date >= from_date),
  unique (org_id, file_sha256)
);
create index fin_appt_uploads_org_created_idx on public.fin_appt_uploads (org_id, created_at desc);

create table public.fin_appt_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  upload_id uuid not null references public.fin_appt_uploads (id) on delete cascade,
  row_no integer not null check (row_no > 0),           -- position in the data rows, for problem reports
  appointment_id text not null check (appointment_id <> ''),
  appt_date date not null,
  start_min smallint check (start_min between 0 and 1439),     -- minutes after midnight (clinic wall clock)
  duration_min integer check (duration_min between 1 and 1440), -- null = the file did not say
  status text not null check (status in ('awaiting', 'confirmed', 'honoured', 'cancelled')),
  patient_pin text,
  doctor_name text not null,
  doctor_key text not null,                              -- normalised name (lib/finance/unite-report-mapping.ts)
  clinic_name text,                                      -- branch is worked out when read (current branch mapping)
  room text,                                             -- the room's name as Unite prints it, if the file has one
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  unique (upload_id, row_no)
);
create index fin_appt_rows_current_idx on public.fin_appt_rows (org_id, appt_date) where is_current;
create index fin_appt_rows_appt_idx on public.fin_appt_rows (org_id, appointment_id) where is_current;
create index fin_appt_rows_upload_idx on public.fin_appt_rows (upload_id);

alter table public.fin_appt_uploads enable row level security;
alter table public.fin_appt_rows enable row level security;
revoke all on public.fin_appt_uploads from anon, authenticated;
revoke all on public.fin_appt_rows from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Import (one transaction: the upload, its rows, and the supersede)
-- ---------------------------------------------------------------------------
-- p_meta: file_sha256, from_date, to_date. p_rows: the sanitised rows. The same file (org, sha256) twice returns the
-- existing upload unchanged. Errors carry a stable keyword (appt_bad_input, appt_rows_out_of_range).
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
begin
  if p_org_id is null or jsonb_typeof(p_meta) is distinct from 'object' or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 30000
     or v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
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

  insert into public.fin_appt_uploads (org_id, file_sha256, from_date, to_date, row_count, created_by)
  values (p_org_id, v_sha, v_from, v_to, jsonb_array_length(p_rows), p_user_id)
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
