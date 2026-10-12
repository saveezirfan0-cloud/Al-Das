-- Phase 18 (4/7): remittance reconciliation.
--
-- A payer's payment advice (.xlsx or .csv) is parsed on the server. The advice can hold patient names and member IDs,
-- so, exactly like the Diligence flow, only SANITISED rows are staged for the preview and the uploaded file is deleted
-- at once; only its sha256 is kept (to block a second upload of the same bytes).
--
--   fin_raw_remittance_files       upload log + sha256 + validation result       (service role only: RLS, no policy)
--   fin_staged_remittance_lines    sanitised rows waiting for confirmation       (service role only: RLS, no policy)
--   ins_remittance_batches         one reconciled advice                          (finance.remittance.manage)
--   ins_remittance_lines           every line with its claim match, the expected amount and the flags
--   ins_commit_remittance()        atomic commit of a validated file
--
-- Matching and the short-payment rule are pure TypeScript (lib/finance/match-remittance.ts); this function only stores
-- what the server computed. Claims themselves are never changed here: Diligence stays the source of truth.

create table public.fin_raw_remittance_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_sha256 text not null,                         -- blocks duplicate uploads
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  row_count integer,
  sum_paid numeric(16, 2),
  header_check jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  status text not null default 'validated' check (status in ('validated', 'committed', 'rejected')),
  committed_at timestamptz,
  committed_by uuid references public.profiles (id) on delete set null,
  unique (org_id, file_sha256)
);
create index fin_raw_remittance_files_org_idx on public.fin_raw_remittance_files (org_id, uploaded_at desc);
alter table public.fin_raw_remittance_files enable row level security;      -- service role only

create table public.fin_staged_remittance_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_id uuid not null references public.fin_raw_remittance_files (id) on delete cascade,
  row_no integer not null,
  data jsonb not null,                               -- sanitised line
  created_at timestamptz not null default now(),
  unique (file_id, row_no)
);
create index fin_staged_remittance_lines_file_idx on public.fin_staged_remittance_lines (file_id, row_no);
alter table public.fin_staged_remittance_lines enable row level security;  -- service role only
create trigger fin_staged_remittance_file_org_check before insert or update of file_id, org_id on public.fin_staged_remittance_lines
  for each row execute function app.check_parent_org('fin_raw_remittance_files', 'file_id');

create table public.ins_remittance_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_id uuid references public.fin_raw_remittance_files (id) on delete set null,
  remittance_ref text check (remittance_ref is null or char_length(remittance_ref) <= 80),
  payer_id text,
  paid_on date,
  line_count integer not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  short_count integer not null default 0,
  sum_paid numeric(16, 2) not null default 0,
  sum_expected numeric(16, 2) not null default 0,
  sum_short numeric(16, 2) not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ins_remittance_batches_org_idx on public.ins_remittance_batches (org_id, created_at desc);

create table public.ins_remittance_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  batch_id uuid not null references public.ins_remittance_batches (id) on delete cascade,
  row_no integer not null,
  line_key text not null,                            -- idempotence: the same advice line is never stored twice
  remittance_ref text,
  claim_activity_number text,
  invoice_no text,
  cpt_code text,
  payer_id text,
  quantity numeric(12, 3),
  claimed_amount numeric(14, 2),
  paid_amount numeric(14, 2) not null default 0,
  denied_amount numeric(14, 2) not null default 0,
  denial_code text,
  paid_on date,
  claim_activity_id uuid references public.ins_claim_activities (id) on delete set null,
  match_status text not null check (match_status in ('matched', 'unmatched', 'ambiguous')),
  match_reason text,
  expected_amount numeric(14, 2),
  expected_basis text not null default 'none' check (expected_basis in ('price_list', 'claim_net', 'file', 'none')),
  short_amount numeric(14, 2) not null default 0,
  flags text[] not null default '{}',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  unique (org_id, line_key)
);
create index ins_remittance_lines_batch_idx on public.ins_remittance_lines (batch_id, row_no);
create index ins_remittance_lines_flags_idx on public.ins_remittance_lines (org_id, reviewed_at) where cardinality(flags) > 0;
create index ins_remittance_lines_claim_idx on public.ins_remittance_lines (claim_activity_id) where claim_activity_id is not null;

create trigger ins_remittance_batches_file_org_check before insert or update of file_id, org_id on public.ins_remittance_batches
  for each row execute function app.check_parent_org('fin_raw_remittance_files', 'file_id');
create trigger ins_remittance_lines_batch_org_check before insert or update of batch_id, org_id on public.ins_remittance_lines
  for each row execute function app.check_parent_org('ins_remittance_batches', 'batch_id');
create trigger ins_remittance_lines_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_remittance_lines
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');

alter table public.ins_remittance_batches enable row level security;
alter table public.ins_remittance_lines enable row level security;
create policy ins_remittance_batches_select on public.ins_remittance_batches for select to authenticated
  using (app.has_perm(org_id, 'finance.remittance.manage'));
create policy ins_remittance_lines_select on public.ins_remittance_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.remittance.manage'));

-- ---------------------------------------------------------------------------
-- ins_commit_remittance: store one reconciled advice atomically.
--   p_batch : {remittance_ref, payer_id, paid_on}
--   p_lines : [{row_no, line_key, remittance_ref, claim_activity_number, invoice_no, cpt_code, payer_id, quantity,
--               claimed_amount, paid_amount, denied_amount, denial_code, paid_on, claim_activity_id, match_status,
--               match_reason, expected_amount, expected_basis, short_amount, flags}]
-- Lines whose line_key already exists (a re-keyed upload of the same advice) are skipped and counted.
-- ---------------------------------------------------------------------------
create or replace function public.ins_commit_remittance(
  p_org_id uuid,
  p_file_id uuid,
  p_user_id uuid,
  p_batch jsonb,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.fin_raw_remittance_files;
  v_batch uuid;
  v_inserted integer;
  v_total integer;
begin
  perform pg_advisory_xact_lock(hashtext('ins_remit:' || p_org_id::text));

  select * into v_file from public.fin_raw_remittance_files where id = p_file_id and org_id = p_org_id for update;
  if not found then
    raise exception 'file % not found in org %', p_file_id, p_org_id using errcode = 'no_data_found';
  end if;
  if v_file.status <> 'validated' then
    raise exception 'file is % and cannot be committed', v_file.status using errcode = 'check_violation';
  end if;

  insert into public.ins_remittance_batches (org_id, file_id, remittance_ref, payer_id, paid_on, created_by)
  values (p_org_id, p_file_id, nullif(p_batch ->> 'remittance_ref', ''), nullif(p_batch ->> 'payer_id', ''),
          nullif(p_batch ->> 'paid_on', '')::date, p_user_id)
  returning id into v_batch;

  select count(*) into v_total from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb));

  insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, remittance_ref, claim_activity_number, invoice_no,
    cpt_code, payer_id, quantity, claimed_amount, paid_amount, denied_amount, denial_code, paid_on, claim_activity_id,
    match_status, match_reason, expected_amount, expected_basis, short_amount, flags)
  select p_org_id, v_batch, r.row_no, r.line_key, r.remittance_ref, r.claim_activity_number, r.invoice_no,
         r.cpt_code, r.payer_id, r.quantity, r.claimed_amount, coalesce(r.paid_amount, 0), coalesce(r.denied_amount, 0),
         r.denial_code, r.paid_on, r.claim_activity_id, r.match_status, r.match_reason, r.expected_amount,
         coalesce(r.expected_basis, 'none'), coalesce(r.short_amount, 0), coalesce(r.flags, '{}')
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as r(
    row_no integer, line_key text, remittance_ref text, claim_activity_number text, invoice_no text, cpt_code text,
    payer_id text, quantity numeric, claimed_amount numeric, paid_amount numeric, denied_amount numeric, denial_code text,
    paid_on date, claim_activity_id uuid, match_status text, match_reason text, expected_amount numeric,
    expected_basis text, short_amount numeric, flags text[]
  )
  on conflict (org_id, line_key) do nothing;
  get diagnostics v_inserted = row_count;

  update public.ins_remittance_batches b
     set line_count = s.n, matched_count = s.matched, unmatched_count = s.unmatched, short_count = s.short,
         sum_paid = s.paid, sum_expected = s.expected, sum_short = s.short_amount
    from (
      select count(*) as n,
             count(*) filter (where match_status = 'matched') as matched,
             count(*) filter (where match_status <> 'matched') as unmatched,
             count(*) filter (where 'short_paid' = any (flags)) as short,
             coalesce(sum(paid_amount), 0) as paid,
             coalesce(sum(expected_amount), 0) as expected,
             coalesce(sum(short_amount), 0) as short_amount
      from public.ins_remittance_lines where batch_id = v_batch
    ) s
   where b.id = v_batch;

  update public.fin_raw_remittance_files
     set status = 'committed', committed_at = now(), committed_by = p_user_id
   where id = p_file_id;
  delete from public.fin_staged_remittance_lines where file_id = p_file_id;

  return jsonb_build_object('batch_id', v_batch, 'lines', v_inserted, 'duplicates_skipped', v_total - v_inserted);
end;
$$;
revoke all on function public.ins_commit_remittance(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ins_commit_remittance(uuid, uuid, uuid, jsonb, jsonb) to service_role;
