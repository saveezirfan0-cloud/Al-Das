-- Finance F1 / 1: raw capture tables, capture settings and the single-consumer lease.
--
-- The Unite Finance API is sync-once: every call permanently dequeues records
-- (CLAUDE.md rule 7). Raw payloads are therefore stored BEFORE any parsing and
-- are the only copy of the data until processing succeeds. These tables are
-- infrastructure tables like job_runs: RLS is enabled with NO policies, so only
-- the service role (server code after can() checks) can read or write them.
-- The payload holds full patient PII; it is never selected by the app UI.

create table public.fin_raw_unite_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  requested_at timestamptz not null default now(),
  from_date date not null,
  to_date date not null,
  count_requested integer not null check (count_requested > 0),
  http_status integer,
  message_status text,
  detail_message text,
  balance_in_range integer,                           -- DataBalancetoSync
  balance_overall integer,                            -- OverallDataBalancetoSync
  record_count integer,                               -- number of elements in payload.Data
  payload jsonb,                                      -- full response, PII included; stripped later
  payload_sha256 text,
  payload_stripped_at timestamptz,                    -- set when PII keys were removed (replay still works)
  process_status text not null default 'received'
    check (process_status in ('received', 'processed', 'failed')),
  processed_at timestamptz,
  process_counts jsonb not null default '{}'::jsonb,  -- per-table counts written by fin_process_batch
  error text,
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);
create index fin_raw_unite_batches_org_requested_idx on public.fin_raw_unite_batches (org_id, requested_at desc);
create index fin_raw_unite_batches_pending_idx on public.fin_raw_unite_batches (org_id, process_status)
  where process_status <> 'processed';

create table public.fin_raw_diligence_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  storage_path text not null,                         -- private Storage bucket
  file_name text,
  file_sha256 text not null,                          -- blocks duplicate uploads
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  row_count integer,
  sum_net numeric(16, 2),
  sum_remitted numeric(16, 2),
  sum_rejected numeric(16, 2),
  header_check jsonb not null default '{}'::jsonb,    -- missing / extra headers
  status text not null default 'validated'
    check (status in ('validated', 'committed', 'rejected')),
  errors jsonb not null default '[]'::jsonb,
  committed_at timestamptz,
  unique (org_id, file_sha256)
);
create index fin_raw_diligence_files_org_uploaded_idx on public.fin_raw_diligence_files (org_id, uploaded_at desc);

-- Per-org capture configuration. `enabled` defaults to FALSE: nothing may call
-- the Unite Finance API until an admin switches it on after the Phase F0 checks.
create table public.fin_capture_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  enabled boolean not null default false,
  batch_size integer not null default 50 check (batch_size between 1 and 500),
  window_from date not null default date '2026-01-01',   -- every pull uses window_from -> today
  max_batches_per_run integer not null default 10 check (max_batches_per_run between 1 and 100),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger fin_capture_settings_set_updated_at before update on public.fin_capture_settings
  for each row execute function app.set_updated_at();

-- One consumer only: the capture job claims this lease before calling Unite.
-- (Session-level advisory locks do not survive pooled connections.)
create table public.fin_capture_lease (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  holder text not null,
  leased_until timestamptz not null
);

alter table public.fin_raw_unite_batches enable row level security;
alter table public.fin_raw_diligence_files enable row level security;
alter table public.fin_capture_settings enable row level security;
alter table public.fin_capture_lease enable row level security;
-- No policies on purpose: service role only.

-- Atomically claim the lease. Returns true when this holder now owns it.
create or replace function public.fin_capture_try_lease(p_org_id uuid, p_holder text, p_ttl_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holder text;
begin
  insert into public.fin_capture_lease (org_id, holder, leased_until)
  values (p_org_id, p_holder, now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  on conflict (org_id) do update
    set holder = excluded.holder, leased_until = excluded.leased_until
    where public.fin_capture_lease.leased_until < now()
       or public.fin_capture_lease.holder = excluded.holder
  returning holder into v_holder;
  return v_holder is not null;
end;
$$;

create or replace function public.fin_capture_release_lease(p_org_id uuid, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.fin_capture_lease set leased_until = now() - interval '1 second'
  where org_id = p_org_id and holder = p_holder;
$$;

revoke all on function public.fin_capture_try_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.fin_capture_release_lease(uuid, text) from public, anon, authenticated;
grant execute on function public.fin_capture_try_lease(uuid, text, integer) to service_role;
grant execute on function public.fin_capture_release_lease(uuid, text) to service_role;
