-- Phase 22J: the Tally bridge, which keeps TallyPrime in step with Pulse until the cut-over (docs/22_ACCOUNTING_PLAN.md,
-- principles 6 and 7 and the 22J row; notes in docs/22_PHASE_22J_NOTES.md).
--
--   * Before the ledger start Tally is the book of record. The bridge PUSHES what Pulse originates and Tally must hold
--     (approved bills and vouchers, sales documents and receipts, bank items, depreciation runs, Unite revenue as daily
--     summaries per branch) as Tally vouchers with a deterministic REMOTEID / GUID "pulse-<org>-<kind>-<id>-<version>",
--     and PULLS masters and vouchers changed in Tally since the last AlterID through the 22I import path
--     (acc_post_from_source('tally_import', GUID, ALTERID, ..)), so the Pulse ledger mirrors Tally, including the
--     vouchers the bridge pushed (linked back to their source by REMOTEID, never counted twice). A daily trial-balance
--     comparison (Tally's ledger closing balances against the mirror) shows drift.
--   * From the ledger start pushing stops by itself (Pulse is then the book of record); pulling continues until it is
--     switched off, and never imports a Tally voucher dated on or after the ledger start.
--   * A connector on the Tally PC (connector/tally-bridge) talks to Tally on 127.0.0.1 only and calls Pulse over HTTPS
--     only. It is paired with a one-time code for a device token (256 bits; only the SHA-256 is stored, revocable). It runs
--     only four job types and imports only vouchers whose REMOTEID starts with "pulse-": create, never delete.
--
--   acc_tally_bridge_settings  per org: push / pull switches, push-from date, sources, revenue as daily summaries
--   acc_tally_devices          paired connectors (pairing-code and token hashes): service role only
--   acc_tally_push             one row per Tally voucher Pulse sends (each version, and each reversal of a version)
--   acc_tally_jobs             the outbox the connector polls (queued -> sent -> done | failed | cancelled)
--   acc_tally_sync_log         one row per voucher result, pull, trial-balance check or pairing (Tally's LINEERROR text
--                              redacted); select for accounting.import
--   acc_tally_cursors          the highest Tally AlterID applied (masters, vouchers) and the source scan position
--
-- Every state change is a SECURITY DEFINER function (search_path = '', service role only, jsonb results). The functions
-- a person triggers check accounting.settings.manage again; the connector's functions are reached only after the route
-- has checked the device token and the integration switch. Errors carry a stable code in the HINT.

-- ---------------------------------------------------------------------------
-- 1. Columns on existing tables
-- ---------------------------------------------------------------------------
-- The ledger's name in Tally as the bridge last pulled it (a system account keeps its Pulse name; this is what a pushed
-- voucher must name). Null: the account's own name.
alter table public.acc_accounts add column tally_name text
  check (tally_name is null or char_length(btrim(tally_name)) between 1 and 120);
-- A bridge pull reuses the import tables for the moment it is applied (the row is deleted when it finishes).
alter table public.acc_tally_imports add column source text not null default 'file' check (source in ('file', 'bridge'));
-- A daily trial-balance check by the bridge, or an uploaded Excel trial balance.
alter table public.acc_tally_reconciliations add column source text not null default 'file'
  check (source in ('file', 'bridge'));

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.acc_tally_bridge_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  push_enabled boolean not null default false,
  pull_enabled boolean not null default false,
  -- items dated before this day are never pushed (Tally already holds them); required to push
  push_from date check (push_from is null or push_from between date '2000-01-01' and date '2999-12-01'),
  -- Unite invoices and payments: one voucher per day and branch (OQ-124 default) or one per invoice / payment
  revenue_mode text not null default 'daily' check (revenue_mode in ('daily', 'per_item')),
  push_sources text[] not null default array[
    'supplier_invoice', 'voucher', 'sales_invoice', 'receipt', 'bank_transfer', 'bank_entry', 'cheque', 'fixed_asset',
    'unite_invoice']::text[],
  cost_category text not null default 'Primary Cost Category'
    check (char_length(btrim(cost_category)) between 1 and 80),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check (push_sources <@ array[
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'sales_invoice', 'receipt', 'bank_transfer', 'bank_entry', 'petty_cash', 'cheque',
    'fixed_asset']::text[])
);
create trigger acc_tally_bridge_settings_set_updated_at before update on public.acc_tally_bridge_settings
  for each row execute function app.set_updated_at();

create table public.acc_tally_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  status text not null default 'pairing' check (status in ('pairing', 'active', 'revoked', 'expired')),
  -- one-time pairing code and device token: SHA-256 only, never the value
  pairing_sha256 text unique check (pairing_sha256 is null or pairing_sha256 ~ '^[0-9a-f]{64}$'),
  pairing_expires_at timestamptz,
  token_sha256 text unique check (token_sha256 is null or token_sha256 ~ '^[0-9a-f]{64}$'),
  version text check (version is null or version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  tally_state text check (tally_state is null or tally_state in ('ok', 'unreachable', 'no_company', 'error')),
  last_seen_at timestamptz,
  paired_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id) on delete set null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'pairing') = (pairing_sha256 is not null)),
  check (status <> 'active' or token_sha256 is not null)
);
create index acc_tally_devices_org_idx on public.acc_tally_devices (org_id, created_at desc);
create trigger acc_tally_devices_set_updated_at before update on public.acc_tally_devices
  for each row execute function app.set_updated_at();

create table public.acc_tally_push (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_kind text not null check (source_kind in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'sales_invoice', 'receipt', 'bank_transfer', 'bank_entry', 'petty_cash', 'cheque',
    'fixed_asset', 'unite_invoice_day', 'unite_payment_day')),
  source_id text not null check (char_length(source_id) between 1 and 200),
  version integer not null check (version between 1 and 100000),
  role text not null default 'voucher' check (role in ('voucher', 'reversal')),
  -- REMOTEID and GUID in Tally: "pulse-<org>-<kind>-<id>-<version>" (a reversal adds "-r")
  remote_id text not null check (remote_id ~ '^pulse-[A-Za-z0-9-]{1,110}$'),
  voucher_date date not null,
  voucher_type text not null check (voucher_type in (
    'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note')),
  amount numeric(16, 2) not null default 0 check (amount >= 0),
  -- the Pulse journal it was built from (accounts and amounts): a change means a new version
  journal_sha256 text not null check (journal_sha256 ~ '^[0-9a-f]{64}$'),
  -- the Tally voucher: narration and entries (Tally ledger name, side, amount in fils, cost centre); null while held
  content jsonb,
  status text not null check (status in ('held', 'ready', 'sent', 'done', 'failed', 'unknown', 'cancelled')),
  reason text check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  detail text check (detail is null or char_length(detail) <= 300),
  -- a done voucher whose reversal was raised (a later version is a new voucher)
  reversed boolean not null default false,
  reverses_id uuid references public.acc_tally_push (id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  tally_master_id bigint,
  -- the tally_import journal the pull made of it: the one place it counts in Pulse's ledger
  mirror_journal_id uuid references public.acc_journals (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  unique (org_id, remote_id),
  unique (org_id, source_kind, source_id, version, role),
  check ((role = 'reversal') = (reverses_id is not null)),
  check (status = 'held' or content is not null),
  check ((status = 'held') = (reason is not null) or status in ('failed', 'unknown', 'cancelled'))
);
create index acc_tally_push_status_idx on public.acc_tally_push (org_id, status, updated_at);
create index acc_tally_push_source_idx on public.acc_tally_push (org_id, source_kind, source_id, version desc);
create trigger acc_tally_push_set_updated_at before update on public.acc_tally_push
  for each row execute function app.set_updated_at();

create table public.acc_tally_jobs (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('export_masters_since', 'export_vouchers_since', 'export_trial_balance', 'import_voucher')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'cancelled')),
  push_id uuid references public.acc_tally_push (id) on delete cascade,
  -- numbers and dates only: since_alter_id, from, to, as_at
  params jsonb not null default '{}'::jsonb,
  device_id uuid references public.acc_tally_devices (id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  -- the previous answer never came: look the voucher up by REMOTEID before importing it again
  check_first boolean not null default false,
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  -- counts only
  result jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  done_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((kind = 'import_voucher') = (push_id is not null))
);
create unique index acc_tally_jobs_push_open_uidx on public.acc_tally_jobs (push_id) where status in ('queued', 'sent');
create unique index acc_tally_jobs_export_open_uidx on public.acc_tally_jobs (org_id, kind)
  where status in ('queued', 'sent') and kind <> 'import_voucher';
create index acc_tally_jobs_queue_idx on public.acc_tally_jobs (org_id, status, seq);
create trigger acc_tally_jobs_set_updated_at before update on public.acc_tally_jobs
  for each row execute function app.set_updated_at();

create table public.acc_tally_sync_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  at timestamptz not null default now(),
  direction text not null check (direction in ('push', 'pull', 'tb', 'pair')),
  outcome text not null check (outcome in (
    'created', 'altered', 'exists', 'failed', 'ambiguous', 'unknown', 'retry', 'refused', 'imported', 'unchanged',
    'differences', 'reconciled', 'paired', 'revoked', 'cancelled', 'reversed')),
  job_id uuid,
  push_id uuid references public.acc_tally_push (id) on delete set null,
  remote_id text check (remote_id is null or char_length(remote_id) <= 120),
  tally_guid text check (tally_guid is null or char_length(tally_guid) <= 100),
  voucher_date date,
  voucher_number text check (voucher_number is null or char_length(voucher_number) <= 60),
  code text check (code is null or code ~ '^[a-z_]{1,40}$'),
  -- Tally's LINEERROR text, passed through lib/redact.ts by the server first; never amounts or narrations
  message text check (message is null or char_length(message) <= 300),
  counts jsonb
);
create index acc_tally_sync_log_org_idx on public.acc_tally_sync_log (org_id, at desc);

create table public.acc_tally_cursors (
  org_id uuid not null references public.orgs (id) on delete cascade,
  cursor text not null check (cursor in ('masters', 'vouchers', 'sources')),
  alter_id bigint check (alter_id is null or alter_id >= 0),
  stamp timestamptz,
  stamp_key text check (stamp_key is null or char_length(stamp_key) <= 250),
  updated_at timestamptz not null default now(),
  primary key (org_id, cursor)
);

alter table public.acc_tally_bridge_settings enable row level security;
alter table public.acc_tally_devices enable row level security;           -- service role only: token hashes, no policy
alter table public.acc_tally_push enable row level security;
alter table public.acc_tally_jobs enable row level security;
alter table public.acc_tally_sync_log enable row level security;
alter table public.acc_tally_cursors enable row level security;
create policy acc_tally_bridge_settings_select on public.acc_tally_bridge_settings for select to authenticated
  using (app.has_perm(org_id, 'accounting.import') or app.has_perm(org_id, 'accounting.settings.manage'));
create policy acc_tally_push_select on public.acc_tally_push for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));
create policy acc_tally_jobs_select on public.acc_tally_jobs for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));
create policy acc_tally_sync_log_select on public.acc_tally_sync_log for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));
create policy acc_tally_cursors_select on public.acc_tally_cursors for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));

-- ---------------------------------------------------------------------------
-- 3. The 22I import path, applied by the bridge (no person): an import row with source 'bridge' may be worked without a
--    user; a file import still needs a person holding accounting.import. Otherwise as 22I.
-- ---------------------------------------------------------------------------
create or replace function app.acc_tally_import_for_update(p_org_id uuid, p_import_id uuid, p_user_id uuid, p_statuses text[])
returns public.acc_tally_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
begin
  select * into imp from public.acc_tally_imports where id = p_import_id and org_id = p_org_id for update;
  if not (app.user_has_perm(p_org_id, p_user_id, 'accounting.import')
          or (p_user_id is null and found and imp.source = 'bridge')) then
    raise exception 'You cannot import into Accounting.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if not found then
    raise exception 'Import not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if not (imp.status = any (p_statuses)) then
    raise exception 'That is not possible in the import''s current state.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  -- one Tally commit at a time per organisation
  perform pg_advisory_xact_lock(hashtextextended('acc_tally|' || p_org_id::text, 22));
  return imp;
end;
$$;
revoke all on function app.acc_tally_import_for_update(uuid, uuid, uuid, text[]) from public, anon, authenticated;

-- The trial-balance comparison (22I) run by the bridge: no person, only inside acc_tally_bridge_record_tb (which sets
-- app.acc_tally_bridge for its own transaction). Patched in place so the rest of 22I's function is kept.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.acc_tally_reconcile(uuid, uuid, uuid, uuid, date, text, jsonb)'::regprocedure);
  if position('app.acc_tally_bridge' in v_def) = 0 then
    v_new := replace(v_def,
      $old$  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.import') then$old$,
      $new$  if not (app.user_has_perm(p_org_id, p_user_id, 'accounting.import')
          or (p_user_id is null and coalesce(current_setting('app.acc_tally_bridge', true), '') = 'on')) then$new$);
    if v_new = v_def then
      raise exception 'acc_tally_reconcile: the permission check was not found';
    end if;
    execute v_new;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Reading the journal a slice WOULD post (22E sales documents and receipts, 22F bank items), without posting it.
--    acc_post_from_source raises it back as the error's DETAIL when app.acc_capture is on; acc_tally_bridge_capture sets
--    it inside a sub-transaction that is always rolled back, so nothing a slice does on the way is kept. Patched in place
--    (before the per-item lock) so every rule other slices added to acc_post_from_source stays.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)'::regprocedure);
  if position('acc_capture' in v_def) = 0 then
    v_new := replace(v_def,
      $old$  -- one caller at a time per source item$old$,
      $new$  -- Phase 22J: the Tally bridge reads the journal without posting it (always inside a rolled-back sub-transaction)
  if coalesce(current_setting('app.acc_capture', true), '') = 'on' then
    raise exception 'Captured for the Tally bridge.' using errcode = 'check_violation', hint = 'acc_capture',
      detail = jsonb_build_object('entity_id', v_entity, 'source_kind', p_source_kind, 'source_id', p_source_id,
        'version', p_source_version, 'date', p_date, 'voucher_type', p_voucher_type, 'narration', v_narration,
        'lines', p_lines)::text;
  end if;

  -- one caller at a time per source item$new$);
    if v_new = v_def then
      raise exception 'acc_post_from_source: the per-item lock was not found';
    end if;
    execute v_new;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Helpers
-- ---------------------------------------------------------------------------
create or replace function app.acc_tally_bridge_lock(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('acc_tally_bridge|' || p_org_id::text, 22));
$$;
revoke all on function app.acc_tally_bridge_lock(uuid) from public, anon, authenticated;

-- Why nothing may be pushed now (null: pushing is allowed). The ledger start stops it for good (Pulse is then the book
-- of record); a training workspace never writes into a real Tally.
create or replace function app.acc_tally_push_stop(p_org_id uuid, p_today date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_start date;
begin
  if not exists (select 1 from public.integration_accounts a where a.org_id = p_org_id and a.kind = 'tally_bridge' and a.enabled) then
    return 'switched_off';
  end if;
  select * into s from public.acc_tally_bridge_settings where org_id = p_org_id;
  if not found or not s.push_enabled then
    return 'push_off';
  end if;
  if s.push_from is null then
    return 'push_from_needed';
  end if;
  if exists (select 1 from public.orgs o where o.id = p_org_id and o.is_training) then
    return 'training';
  end if;
  select e.ledger_start_date into v_start from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  if v_start is not null and coalesce(p_today, current_date) >= v_start then
    return 'ledger_started';
  end if;
  return null;
end;
$$;
revoke all on function app.acc_tally_push_stop(uuid, date) from public, anon, authenticated;

-- The voucher type that undoes another.
create or replace function app.acc_tally_reverse_type(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'payment' then 'receipt' when 'receipt' then 'payment'
    when 'sales' then 'credit_note' when 'credit_note' then 'sales'
    when 'purchase' then 'debit_note' when 'debit_note' then 'purchase'
    else p_type end;
$$;
revoke all on function app.acc_tally_reverse_type(text) from public, anon, authenticated;

create or replace function app.acc_tally_log(
  p_org_id uuid, p_direction text, p_outcome text, p_job_id uuid, p_push_id uuid, p_code text, p_message text,
  p_counts jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.acc_tally_push;
begin
  if p_push_id is not null then
    select * into p from public.acc_tally_push where id = p_push_id;
  end if;
  insert into public.acc_tally_sync_log (org_id, direction, outcome, job_id, push_id, remote_id, voucher_date, code, message, counts)
  values (p_org_id, p_direction, p_outcome, p_job_id, p_push_id, p.remote_id, p.voucher_date,
          case when p_code ~ '^[a-z_]{1,40}$' then p_code end, nullif(left(btrim(coalesce(p_message, '')), 300), ''), p_counts);
end;
$$;
revoke all on function app.acc_tally_log(uuid, text, text, uuid, uuid, text, text, jsonb) from public, anon, authenticated;

create or replace function app.acc_tally_enqueue_push(p_push_id uuid, p_check_first boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.acc_tally_jobs (org_id, kind, push_id, check_first)
  select p.org_id, 'import_voucher', p.id, p_check_first from public.acc_tally_push p where p.id = p_push_id
  on conflict (push_id) where status in ('queued', 'sent') do nothing;
$$;
revoke all on function app.acc_tally_enqueue_push(uuid, boolean) from public, anon, authenticated;

create or replace function app.acc_tally_cancel_jobs(p_push_id uuid, p_code text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.acc_tally_jobs set status = 'cancelled', error_code = p_code, done_at = now()
   where push_id = p_push_id and status = 'queued';
$$;
revoke all on function app.acc_tally_cancel_jobs(uuid, text) from public, anon, authenticated;

-- Raises the reversal of a voucher Tally holds: the same entries on the other side, the opposite voucher type, the same
-- date, REMOTEID "<remote>-r". Idempotent.
create or replace function app.acc_tally_raise_reversal(p_push_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.acc_tally_push;
  v_id uuid;
begin
  select * into p from public.acc_tally_push where id = p_push_id and role = 'voucher' and status = 'done' for update;
  if not found or p.reversed then
    return null;
  end if;
  insert into public.acc_tally_push (org_id, source_kind, source_id, version, role, remote_id, voucher_date, voucher_type,
                                     amount, journal_sha256, content, status, reverses_id)
  values (p.org_id, p.source_kind, p.source_id, p.version, 'reversal', p.remote_id || '-r', p.voucher_date,
          app.acc_tally_reverse_type(p.voucher_type), p.amount, p.journal_sha256,
          jsonb_build_object(
            'narration', left('Reversal: ' || coalesce(p.content ->> 'narration', p.remote_id), 300),
            'entries', (select coalesce(jsonb_agg(e || jsonb_build_object('side', case e ->> 'side' when 'debit' then 'credit' else 'debit' end)
                                                  order by o), '[]'::jsonb)
                        from jsonb_array_elements(p.content -> 'entries') with ordinality as x (e, o))),
          'ready', p.id)
  on conflict (org_id, remote_id) do nothing
  returning id into v_id;
  update public.acc_tally_push set reversed = true where id = p.id;
  if v_id is not null then
    perform app.acc_tally_enqueue_push(v_id);
  end if;
  return v_id;
end;
$$;
revoke all on function app.acc_tally_raise_reversal(uuid) from public, anon, authenticated;

create or replace function app.acc_tally_bump(p_counts jsonb, p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_counts || jsonb_build_object(p_key, coalesce((p_counts ->> p_key)::integer, 0) + 1);
$$;
revoke all on function app.acc_tally_bump(jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Settings (a person with accounting.settings.manage)
-- ---------------------------------------------------------------------------
-- p: { push_enabled, pull_enabled, push_from, revenue_mode, push_sources[], cost_category }. A change to what is pushed
-- makes the next run look at every source again. The revenue mode cannot change once Unite revenue was pushed.
create or replace function public.acc_tally_bridge_save_settings(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  old public.acc_tally_bridge_settings;
  r public.acc_tally_bridge_settings;
  v_sources text[];
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.settings.manage') then
    raise exception 'You cannot change the Tally bridge.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  select * into old from public.acc_tally_bridge_settings where org_id = p_org_id;
  if jsonb_typeof(p -> 'push_sources') = 'array' then
    v_sources := coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(p -> 'push_sources') x),
                          array[]::text[]);
  else
    v_sources := coalesce(old.push_sources, array[
      'supplier_invoice', 'voucher', 'sales_invoice', 'receipt', 'bank_transfer', 'bank_entry', 'cheque', 'fixed_asset',
      'unite_invoice']::text[]);
  end if;
  if not v_sources <@ array[
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'sales_invoice', 'receipt', 'bank_transfer', 'bank_entry', 'petty_cash', 'cheque',
    'fixed_asset']::text[] then
    raise exception 'Unknown source.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if coalesce(p ->> 'revenue_mode', 'daily') not in ('daily', 'per_item') then
    raise exception 'Choose how Unite revenue is sent.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if old.org_id is not null and old.revenue_mode <> coalesce(p ->> 'revenue_mode', old.revenue_mode)
     and exists (select 1 from public.acc_tally_push x where x.org_id = p_org_id
                 and x.source_kind in ('unite_invoice', 'unite_payment', 'unite_invoice_day', 'unite_payment_day')
                 and x.status <> 'cancelled') then
    raise exception 'Unite revenue was already sent this way; the mode cannot change now.' using errcode = 'check_violation', hint = 'mode_locked';
  end if;
  if coalesce((p ->> 'push_enabled')::boolean, false) and nullif(p ->> 'push_from', '') is null then
    raise exception 'Choose the first date to push.' using errcode = 'check_violation', hint = 'push_from_needed';
  end if;
  insert into public.acc_tally_bridge_settings (org_id, push_enabled, pull_enabled, push_from, revenue_mode, push_sources,
                                                cost_category, updated_by)
  values (p_org_id, coalesce((p ->> 'push_enabled')::boolean, false), coalesce((p ->> 'pull_enabled')::boolean, false),
          nullif(p ->> 'push_from', '')::date, coalesce(p ->> 'revenue_mode', old.revenue_mode, 'daily'), v_sources,
          coalesce(nullif(btrim(p ->> 'cost_category'), ''), 'Primary Cost Category'), p_user_id)
  on conflict (org_id) do update
    set push_enabled = excluded.push_enabled, pull_enabled = excluded.pull_enabled, push_from = excluded.push_from,
        revenue_mode = excluded.revenue_mode, push_sources = excluded.push_sources, cost_category = excluded.cost_category,
        updated_by = excluded.updated_by
  returning * into r;
  if old.org_id is null or (old.push_enabled, old.push_from, old.revenue_mode, old.push_sources)
       is distinct from (r.push_enabled, r.push_from, r.revenue_mode, r.push_sources) then
    delete from public.acc_tally_cursors where org_id = p_org_id and cursor = 'sources';
  end if;
  return to_jsonb(r) - 'org_id';
end;
$$;
revoke all on function public.acc_tally_bridge_save_settings(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_save_settings(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Pairing and devices
-- ---------------------------------------------------------------------------
-- A one-time pairing code (its SHA-256), valid for 30 minutes. Earlier unused codes stop working.
create or replace function public.acc_tally_bridge_pair_create(p_org_id uuid, p_user_id uuid, p_label text, p_code_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_exp timestamptz := now() + interval '30 minutes';
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.settings.manage') then
    raise exception 'You cannot pair a Tally connector.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' or nullif(btrim(coalesce(p_label, '')), '') is null then
    raise exception 'The pairing code or name is missing.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  update public.acc_tally_devices set status = 'expired', pairing_sha256 = null
   where org_id = p_org_id and status = 'pairing';
  insert into public.acc_tally_devices (org_id, label, status, pairing_sha256, pairing_expires_at, created_by)
  values (p_org_id, left(btrim(p_label), 60), 'pairing', p_code_sha256, v_exp, p_user_id)
  returning id into v_id;
  return jsonb_build_object('device_id', v_id, 'expires_at', v_exp);
end;
$$;
revoke all on function public.acc_tally_bridge_pair_create(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_pair_create(uuid, uuid, text, text) to service_role;

-- The connector trades the code for its device token (SHA-256 only). Single use; the organisation's previous connector
-- is revoked (one connector per organisation).
create or replace function public.acc_tally_bridge_pair_exchange(p_code_sha256 text, p_token_sha256 text, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_tally_devices;
begin
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid pairing request.' using errcode = 'check_violation', hint = 'invalid_code';
  end if;
  select * into d from public.acc_tally_devices
   where pairing_sha256 = p_code_sha256 and status = 'pairing' and pairing_expires_at > now()
   for update;
  if not found then
    raise exception 'Unknown or expired pairing code.' using errcode = 'check_violation', hint = 'invalid_code';
  end if;
  perform app.acc_tally_bridge_lock(d.org_id);
  update public.acc_tally_devices set status = 'revoked', revoked_at = now()
   where org_id = d.org_id and status = 'active';
  update public.acc_tally_devices
     set status = 'active', pairing_sha256 = null, pairing_expires_at = null, token_sha256 = p_token_sha256,
         version = case when p_version ~ '^[0-9A-Za-z.+-]{1,40}$' then p_version end, paired_at = now(), last_seen_at = now()
   where id = d.id;
  -- jobs handed to a replaced connector are asked again (an import only after a look-up)
  update public.acc_tally_jobs set status = 'queued', check_first = check_first or kind = 'import_voucher', device_id = null
   where org_id = d.org_id and status = 'sent';
  perform app.acc_tally_log(d.org_id, 'pair', 'paired', null, null, null, null);
  return jsonb_build_object('device_id', d.id, 'org_id', d.org_id);
end;
$$;
revoke all on function public.acc_tally_bridge_pair_exchange(text, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_pair_exchange(text, text, text) to service_role;

-- The device behind a token (null when unknown or revoked); records that it was seen.
create or replace function public.acc_tally_bridge_device(p_token_sha256 text, p_version text, p_tally_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_tally_devices;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into d from public.acc_tally_devices where token_sha256 = p_token_sha256 and status = 'active';
  if not found then
    return null;
  end if;
  update public.acc_tally_devices
     set last_seen_at = now(),
         version = case when p_version ~ '^[0-9A-Za-z.+-]{1,40}$' then p_version else version end,
         tally_state = case when p_tally_state in ('ok', 'unreachable', 'no_company', 'error') then p_tally_state else tally_state end
   where id = d.id;
  return jsonb_build_object('device_id', d.id, 'org_id', d.org_id);
end;
$$;
revoke all on function public.acc_tally_bridge_device(text, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_device(text, text, text) to service_role;

create or replace function public.acc_tally_bridge_revoke(p_org_id uuid, p_user_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.settings.manage') then
    raise exception 'You cannot revoke a Tally connector.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  update public.acc_tally_devices
     set status = 'revoked', revoked_at = now(), revoked_by = p_user_id, pairing_sha256 = null
   where id = p_device_id and org_id = p_org_id and status in ('pairing', 'active');
  if not found then
    raise exception 'Connector not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  update public.acc_tally_jobs set status = 'queued', check_first = check_first or kind = 'import_voucher', device_id = null
   where org_id = p_org_id and status = 'sent' and device_id = p_device_id;
  perform app.acc_tally_log(p_org_id, 'pair', 'revoked', null, null, null, null);
  return jsonb_build_object('device_id', p_device_id, 'status', 'revoked');
end;
$$;
revoke all on function public.acc_tally_bridge_revoke(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_revoke(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. What changed in the sources since the scan position: 22D posting status (preview = built before the ledger start),
--    22E documents and receipts, 22F bank items and cheques, 22H runs waiting for the ledger start. 'gone' means a
--    pushed voucher must be reversed. Rows touched in the last two minutes wait for the next run (late commits).
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_candidates(p_org_id uuid, p_after timestamptz, p_after_key text, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select coalesce((select x.push_sources from public.acc_tally_bridge_settings x where x.org_id = p_org_id), array[]::text[]) as kinds),
  c as (
    select st.source_kind as kind, st.source_id as id,
           case when st.state = 'preview' then 'ready' when st.state in ('withdrawn', 'nothing') then 'gone' end as state,
           st.source_date as d, st.updated_at as stamp
      from public.acc_posting_status st where st.org_id = p_org_id
    union all
    select 'sales_invoice', i.id::text,
           case when i.posting_status = 'waiting_ledger_start' and i.status <> 'draft' then 'ready' end, i.invoice_date, i.updated_at
      from public.acc_sales_invoices i where i.org_id = p_org_id
    union all
    select 'receipt', r.id::text,
           case when r.status <> 'active' then 'gone' when r.posting_status = 'waiting_ledger_start' then 'ready' end,
           r.receipt_date, r.updated_at
      from public.acc_receipts r where r.org_id = p_org_id
    union all
    select 'bank_transfer', t.id::text,
           case when t.status = 'cancelled' then 'gone' when t.status = 'waiting_ledger_start' then 'ready' end,
           t.transfer_date, t.updated_at
      from public.acc_bank_transfers t where t.org_id = p_org_id
    union all
    select 'bank_entry', e.id::text,
           case when e.status = 'cancelled' then 'gone' when e.status = 'waiting_ledger_start' then 'ready' end,
           e.entry_date, e.updated_at
      from public.acc_bank_entries e where e.org_id = p_org_id
    union all
    select 'petty_cash', x.id::text,
           case when x.status = 'cancelled' then 'gone' when x.status = 'waiting_ledger_start' then 'ready' end,
           x.expense_date, x.updated_at
      from public.acc_petty_cash_expenses x where x.org_id = p_org_id
    union all
    select 'cheque', ch.id::text,
           case when ch.posting = 'waiting_ledger_start' and ch.status in ('issued', 'received', 'presented', 'cleared') then 'ready'
                when ch.status in ('bounced', 'cancelled', 'stale') or ch.posting in ('reversed', 'not_posted') then 'gone' end,
           ch.cheque_date, ch.updated_at
      from public.acc_cheques ch where ch.org_id = p_org_id
    union all
    select 'fixed_asset', r.id::text, case when r.status = 'waiting_ledger_start' then 'ready' end,
           (r.period_month + interval '1 month' - interval '1 day')::date, r.updated_at
      from public.acc_depreciation_runs r where r.org_id = p_org_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'id', x.id, 'state', x.state, 'date', x.d,
                                               'stamp', x.stamp, 'key', x.k) order by x.stamp, x.k), '[]'::jsonb)
  from (
    select c.kind, c.id, c.state, c.d, c.stamp, c.kind || '|' || c.id as k
    from c, s
    where c.state is not null
      and c.kind = any (s.kinds)
      and c.stamp < now() - interval '2 minutes'
      and (p_after is null or (c.stamp, c.kind || '|' || c.id) > (p_after, coalesce(p_after_key, '')))
    order by c.stamp, c.kind || '|' || c.id
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) x;
$$;
revoke all on function public.acc_tally_bridge_candidates(uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_candidates(uuid, timestamptz, text, integer) to service_role;

-- The journal one 22E / 22F / 22H item would post, or null when it would post nothing now. 22E and 22F run the slice's
-- own posting function with app.acc_capture on, inside a sub-transaction that is always rolled back; 22H runs are
-- built from their stored lines here (the run's own post needs a second person), one debit and one credit per account
-- pair and dimension, as acc_asset_run_post does.
create or replace function public.acc_tally_bridge_capture(p_org_id uuid, p_kind text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid uuid;
  v_hint text;
  v_detail text;
  r public.acc_depreciation_runs;
  v_lines jsonb;
  v_desc text;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_uuid := p_id::uuid;
  if p_kind = 'fixed_asset' then
    select * into r from public.acc_depreciation_runs where id = v_uuid and org_id = p_org_id;
    if not found or r.status <> 'waiting_ledger_start' then
      return null;
    end if;
    v_desc := case r.kind when 'depreciation' then 'Depreciation ' when 'schedules' then 'Schedule releases '
                          else 'Reversing accruals ' end || to_char(r.period_month, 'YYYY-MM');
    select coalesce(jsonb_agg(x.line order by x.k, x.side), '[]'::jsonb) into v_lines
    from (
      select g.k, s.side, case s.side
               when 1 then jsonb_build_object('account_id', g.debit_account_id, 'debit', g.amt, 'credit', 0,
                                              'branch_code', g.branch_code, 'department', g.department, 'description', v_desc)
               else jsonb_build_object('account_id', g.credit_account_id, 'debit', 0, 'credit', g.amt,
                                       'branch_code', g.branch_code, 'department', g.department, 'description', v_desc) end as line
      from (
        select l.debit_account_id, l.credit_account_id, l.branch_code, l.department, sum(l.amount) as amt,
               l.debit_account_id::text || '|' || l.credit_account_id::text || '|' || coalesce(l.branch_code, '') || '|' ||
               coalesce(l.department, '') as k
        from public.acc_asset_run_lines l where l.run_id = r.id and l.version = r.version
        group by l.debit_account_id, l.credit_account_id, l.branch_code, l.department
      ) g cross join (values (1), (2)) as s (side)
    ) x;
    return jsonb_build_object('entity_id', r.entity_id, 'source_kind', 'fixed_asset', 'source_id', r.id, 'version', r.version,
      'date', (r.period_month + interval '1 month' - interval '1 day')::date, 'voucher_type', 'journal',
      'narration', case r.kind when 'depreciation' then 'Depreciation for ' when 'schedules' then 'Schedule releases for '
                               else 'Reversing accruals for ' end || to_char(r.period_month, 'YYYY-MM'),
      'run_kind', r.kind, 'reverse_on', case when r.kind = 'reversing_accruals'
                                              then (r.period_month + interval '1 month')::date end,
      'lines', v_lines);
  end if;
  if not (
    (p_kind = 'sales_invoice' and exists (select 1 from public.acc_sales_invoices x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.posting_status = 'waiting_ledger_start'))
    or (p_kind = 'receipt' and exists (select 1 from public.acc_receipts x where x.id = v_uuid and x.org_id = p_org_id
                                       and x.status = 'active' and x.posting_status = 'waiting_ledger_start'))
    or (p_kind = 'bank_transfer' and exists (select 1 from public.acc_bank_transfers x where x.id = v_uuid and x.org_id = p_org_id
                                             and x.status = 'waiting_ledger_start'))
    or (p_kind = 'bank_entry' and exists (select 1 from public.acc_bank_entries x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.status = 'waiting_ledger_start'))
    or (p_kind = 'petty_cash' and exists (select 1 from public.acc_petty_cash_expenses x where x.id = v_uuid and x.org_id = p_org_id
                                          and x.status = 'waiting_ledger_start'))
    or (p_kind = 'cheque' and exists (select 1 from public.acc_cheques x where x.id = v_uuid and x.org_id = p_org_id
                                      and x.posting = 'waiting_ledger_start'
                                      and x.status in ('issued', 'received', 'presented', 'cleared')))) then
    return null;
  end if;
  begin
    perform set_config('app.acc_capture', 'on', true);
    case p_kind
      when 'sales_invoice' then perform app.acc_sales_doc_post(v_uuid);
      when 'receipt' then perform app.acc_receipt_post(v_uuid);
      when 'bank_transfer' then perform app.acc_banking_post_item('transfer', v_uuid);
      when 'bank_entry' then perform app.acc_banking_post_item('entry', v_uuid);
      when 'petty_cash' then perform app.acc_banking_post_item('expense', v_uuid);
      when 'cheque' then perform app.acc_banking_post_item('cheque', v_uuid);
    end case;
    raise exception 'Nothing to capture.' using errcode = 'check_violation', hint = 'acc_capture_none';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    if v_hint = 'acc_capture' then
      return v_detail::jsonb;
    elsif v_hint = 'acc_capture_none' then
      return null;
    end if;
    return jsonb_build_object('error', coalesce(nullif(v_hint, ''), 'error'));
  end;
end;
$$;
revoke all on function public.acc_tally_bridge_capture(uuid, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_capture(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Pushing: what the scheduler built, applied as Tally vouchers to send. Items: [{ kind, id, remote_base, action:
--    push | hold | withdraw, date, voucher_type, amount, journal_sha256, content?, reason?, detail? }].
--      * new item: version 1 (ready, a job is queued; or held with its reason, e.g. a ledger not mapped to Tally)
--      * the same journal: nothing (a held one is released once it can be pushed)
--      * changed, and Tally never received it (held, ready, failed, cancelled): changed in place
--      * changed, and Tally holds it (done): a reversal voucher, then the next version
--      * withdrawn: not sent yet -> cancelled; in Tally -> reversed
--      * on its way (sent) or unknown: left alone until the answer comes
--    Only items dated from push_from and before the ledger start; nothing at all once pushing stopped.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_push_apply(p_org_id uuid, p_items jsonb, p_today date, p_cursor jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_start date;
  v_stop text;
  it jsonb;
  cur public.acc_tally_push;
  v_action text;
  v_kind text;
  v_date date;
  v_base text;
  v_status text;
  v_id uuid;
  v_counts jsonb := '{}'::jsonb;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  v_stop := app.acc_tally_push_stop(p_org_id, p_today);
  if v_stop is not null then
    return jsonb_build_object('stopped', v_stop);
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'Invalid items.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  select * into s from public.acc_tally_bridge_settings where org_id = p_org_id;
  select e.ledger_start_date into v_start from public.acc_entities e where e.org_id = p_org_id and e.is_default;

  for it in select x from jsonb_array_elements(p_items) x loop
    v_action := it ->> 'action';
    v_kind := it ->> 'kind';
    v_base := it ->> 'remote_base';
    if v_action is null or v_action not in ('push', 'hold', 'withdraw') or v_kind is null
       or nullif(it ->> 'id', '') is null or v_base is null or v_base !~ '^pulse-[A-Za-z0-9-]{1,100}$'
       or (v_action <> 'withdraw' and (nullif(it ->> 'date', '') is null or coalesce(it ->> 'journal_sha256', '') !~ '^[0-9a-f]{64}$'
                                       or (v_action = 'push' and jsonb_typeof(it -> 'content' -> 'entries') is distinct from 'array')
                                       or (v_action = 'hold' and coalesce(it ->> 'reason', '') !~ '^[a-z_]{1,40}$'))) then
      v_counts := app.acc_tally_bump(v_counts, 'invalid');
      continue;
    end if;
    cur := null;
    select * into cur from public.acc_tally_push
     where org_id = p_org_id and source_kind = v_kind and source_id = it ->> 'id' and role = 'voucher'
     order by version desc limit 1 for update;
    if v_action <> 'withdraw' then
      -- only what the clinic chose to send, in the chosen form for Unite revenue
      if not ((case v_kind when 'unite_invoice_day' then 'unite_invoice' when 'unite_payment_day' then 'unite_payment'
                           else v_kind end) = any (s.push_sources))
         or (s.revenue_mode = 'daily' and v_kind in ('unite_invoice', 'unite_payment'))
         or (s.revenue_mode = 'per_item' and v_kind in ('unite_invoice_day', 'unite_payment_day')) then
        v_counts := app.acc_tally_bump(v_counts, 'not_selected');
        continue;
      end if;
      v_date := (it ->> 'date')::date;
      if v_date < s.push_from or (v_start is not null and v_date >= v_start) then
        -- outside what the bridge sends (Tally already holds it, or Pulse posts it itself); a voucher sent earlier stays
        v_counts := app.acc_tally_bump(v_counts, 'out_of_range');
        continue;
      end if;
    end if;
    v_status := case v_action when 'push' then 'ready' else 'held' end;

    if cur.id is null then
      if v_action = 'withdraw' then
        v_counts := app.acc_tally_bump(v_counts, 'nothing');
        continue;
      end if;
      insert into public.acc_tally_push (org_id, source_kind, source_id, version, remote_id, voucher_date, voucher_type, amount,
                                         journal_sha256, content, status, reason, detail)
      values (p_org_id, v_kind, it ->> 'id', 1, v_base || '-1', v_date, it ->> 'voucher_type',
              coalesce((it ->> 'amount')::numeric, 0), it ->> 'journal_sha256',
              case when v_action = 'push' then it -> 'content' end, v_status,
              case when v_action = 'hold' then it ->> 'reason' end, left(nullif(it ->> 'detail', ''), 300))
      returning id into v_id;
      if v_action = 'push' then perform app.acc_tally_enqueue_push(v_id); end if;
      v_counts := app.acc_tally_bump(v_counts, case v_action when 'push' then 'queued' else 'held' end);

    elsif v_action = 'withdraw' then
      if cur.status in ('held', 'ready', 'failed') then
        perform app.acc_tally_cancel_jobs(cur.id, 'withdrawn');
        update public.acc_tally_push set status = 'cancelled', reason = 'withdrawn', detail = null where id = cur.id;
        v_counts := app.acc_tally_bump(v_counts, 'cancelled');
      elsif cur.status = 'done' and not cur.reversed then
        perform app.acc_tally_raise_reversal(cur.id);
        v_counts := app.acc_tally_bump(v_counts, 'reversed');
      elsif cur.status in ('sent', 'unknown') then
        v_counts := app.acc_tally_bump(v_counts, 'waiting');
      else
        v_counts := app.acc_tally_bump(v_counts, 'nothing');
      end if;

    elsif cur.journal_sha256 = it ->> 'journal_sha256' and cur.status <> 'cancelled' and not cur.reversed then
      if cur.status = 'held' and v_action = 'push' then
        update public.acc_tally_push set status = 'ready', reason = null, detail = null, content = it -> 'content',
               voucher_type = it ->> 'voucher_type', amount = coalesce((it ->> 'amount')::numeric, 0)
         where id = cur.id;
        perform app.acc_tally_enqueue_push(cur.id);
        v_counts := app.acc_tally_bump(v_counts, 'queued');
      elsif cur.status in ('held', 'ready') and v_action = 'hold' then
        perform app.acc_tally_cancel_jobs(cur.id, 'held');
        update public.acc_tally_push set status = 'held', reason = it ->> 'reason', detail = left(nullif(it ->> 'detail', ''), 300)
         where id = cur.id and (status, reason, detail) is distinct from ('held', it ->> 'reason', left(nullif(it ->> 'detail', ''), 300));
        v_counts := app.acc_tally_bump(v_counts, 'held');
      else
        v_counts := app.acc_tally_bump(v_counts, 'unchanged');
      end if;

    elsif cur.status in ('held', 'ready', 'failed', 'cancelled') and not cur.reversed then
      -- Tally never received it: change it in place
      perform app.acc_tally_cancel_jobs(cur.id, 'changed');
      update public.acc_tally_push
         set voucher_date = v_date, voucher_type = it ->> 'voucher_type', amount = coalesce((it ->> 'amount')::numeric, 0),
             journal_sha256 = it ->> 'journal_sha256', content = case when v_action = 'push' then it -> 'content' end,
             status = v_status, reason = case when v_action = 'hold' then it ->> 'reason' end,
             detail = left(nullif(it ->> 'detail', ''), 300), attempts = 0
       where id = cur.id;
      if v_action = 'push' then perform app.acc_tally_enqueue_push(cur.id); end if;
      v_counts := app.acc_tally_bump(v_counts, case v_action when 'push' then 'queued' else 'held' end);

    elsif cur.status in ('sent', 'unknown') then
      v_counts := app.acc_tally_bump(v_counts, 'waiting');

    else
      -- Tally holds the previous version (or it was reversed): reverse it, then send the next version
      if cur.status = 'done' and not cur.reversed then
        perform app.acc_tally_raise_reversal(cur.id);
      end if;
      insert into public.acc_tally_push (org_id, source_kind, source_id, version, remote_id, voucher_date, voucher_type, amount,
                                         journal_sha256, content, status, reason, detail)
      values (p_org_id, v_kind, it ->> 'id', cur.version + 1, v_base || '-' || (cur.version + 1)::text, v_date,
              it ->> 'voucher_type', coalesce((it ->> 'amount')::numeric, 0), it ->> 'journal_sha256',
              case when v_action = 'push' then it -> 'content' end, v_status,
              case when v_action = 'hold' then it ->> 'reason' end, left(nullif(it ->> 'detail', ''), 300))
      returning id into v_id;
      if v_action = 'push' then perform app.acc_tally_enqueue_push(v_id); end if;
      v_counts := app.acc_tally_bump(v_counts, 'new_version');
    end if;
  end loop;

  if p_cursor is not null and nullif(p_cursor ->> 'stamp', '') is not null then
    insert into public.acc_tally_cursors (org_id, cursor, stamp, stamp_key, updated_at)
    values (p_org_id, 'sources', (p_cursor ->> 'stamp')::timestamptz, left(p_cursor ->> 'key', 250), now())
    on conflict (org_id, cursor) do update set stamp = excluded.stamp, stamp_key = excluded.stamp_key, updated_at = now();
  end if;
  return v_counts;
end;
$$;
revoke all on function public.acc_tally_bridge_push_apply(uuid, jsonb, date, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_push_apply(uuid, jsonb, date, jsonb) to service_role;

-- A person sends a failed voucher again (after fixing it in Tally), or one whose answer never came (looked up first).
create or replace function public.acc_tally_bridge_retry(p_org_id uuid, p_user_id uuid, p_push_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.acc_tally_push;
  v_stop text;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.settings.manage') then
    raise exception 'You cannot change the Tally bridge.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  select * into p from public.acc_tally_push where id = p_push_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if p.status not in ('failed', 'unknown') then
    raise exception 'Only a failed voucher, or one whose answer never came, can be sent again.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  v_stop := app.acc_tally_push_stop(p_org_id, p_today);
  if v_stop is not null then
    raise exception 'Pushing to Tally is stopped.' using errcode = 'check_violation', hint = v_stop;
  end if;
  update public.acc_tally_push set status = 'ready', reason = null, detail = null, attempts = 0 where id = p.id;
  perform app.acc_tally_enqueue_push(p.id, p.status = 'unknown');
  return jsonb_build_object('id', p.id, 'status', 'ready', 'check_first', p.status = 'unknown');
end;
$$;
revoke all on function public.acc_tally_bridge_retry(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_retry(uuid, uuid, uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 10. The scheduler's tick: housekeeping, and the pulls (masters and vouchers since the last AlterID, the trial balance
--     once a day). The first cursor is where the 22I file import got to.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_tick(p_org_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_on boolean;
  v_masters bigint;
  v_vouchers bigint;
  v_from date;
  v_counts jsonb := '{}'::jsonb;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  update public.acc_tally_devices set status = 'expired', pairing_sha256 = null
   where org_id = p_org_id and status = 'pairing' and pairing_expires_at < now();
  delete from public.acc_tally_jobs where org_id = p_org_id and status in ('done', 'failed', 'cancelled')
     and coalesce(done_at, updated_at) < now() - interval '30 days';
  delete from public.acc_tally_sync_log where org_id = p_org_id and at < now() - interval '400 days';

  v_on := exists (select 1 from public.integration_accounts a where a.org_id = p_org_id and a.kind = 'tally_bridge' and a.enabled);
  select * into s from public.acc_tally_bridge_settings where org_id = p_org_id;
  if not v_on or s.org_id is null or not s.pull_enabled then
    update public.acc_tally_jobs set status = 'cancelled', error_code = 'pull_off', done_at = now()
     where org_id = p_org_id and status = 'queued' and kind <> 'import_voucher';
    return v_counts || jsonb_build_object('pull', false);
  end if;

  v_masters := coalesce((select c.alter_id from public.acc_tally_cursors c where c.org_id = p_org_id and c.cursor = 'masters'),
                        (select max(a.tally_alter_id) from public.acc_accounts a where a.org_id = p_org_id), 0);
  v_vouchers := coalesce((select c.alter_id from public.acc_tally_cursors c where c.org_id = p_org_id and c.cursor = 'vouchers'),
                         (select max(j.source_version) from public.acc_journals j where j.org_id = p_org_id and j.source_kind = 'tally_import'), 0);
  v_from := coalesce((select min(j.journal_date) from public.acc_journals j where j.org_id = p_org_id and j.source_kind = 'tally_import'),
                     p_today - 730);
  if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.kind = 'export_masters_since'
                 and j.status in ('queued', 'sent')) then
    insert into public.acc_tally_jobs (org_id, kind, params)
    values (p_org_id, 'export_masters_since', jsonb_build_object('since_alter_id', v_masters));
    v_counts := app.acc_tally_bump(v_counts, 'masters');
  end if;
  if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.kind = 'export_vouchers_since'
                 and j.status in ('queued', 'sent'))
     and not exists (select 1 from public.acc_tally_imports i where i.org_id = p_org_id and i.source = 'bridge'
                     and i.status in ('staged', 'committing')) then
    insert into public.acc_tally_jobs (org_id, kind, params)
    values (p_org_id, 'export_vouchers_since', jsonb_build_object('since_alter_id', v_vouchers, 'from', v_from, 'to', p_today + 366));
    v_counts := app.acc_tally_bump(v_counts, 'vouchers');
  end if;
  if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.kind = 'export_trial_balance'
                 and j.params ->> 'as_at' = (p_today - 1)::text and j.status in ('queued', 'sent', 'done')) then
    insert into public.acc_tally_jobs (org_id, kind, params)
    values (p_org_id, 'export_trial_balance', jsonb_build_object('as_at', p_today - 1))
    on conflict do nothing;
    v_counts := app.acc_tally_bump(v_counts, 'trial_balance');
  end if;
  return v_counts || jsonb_build_object('pull', true);
end;
$$;
revoke all on function public.acc_tally_bridge_tick(uuid, date) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_tick(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 11. The connector's side (reached only after the route checked the device token, the organisation and the switch)
-- ---------------------------------------------------------------------------
-- Hands out queued jobs (oldest first). A job sent ten minutes ago without an answer is asked again: an import only
-- after a look-up by REMOTEID (it may have reached Tally), at most five times, then the voucher is "unknown" for a person
-- to check. Imports are cancelled while pushing is stopped; exports while pulling is off.
create or replace function public.acc_tally_bridge_claim(p_org_id uuid, p_device_id uuid, p_limit integer, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_stop text;
  j public.acc_tally_jobs;
  p public.acc_tally_push;
  v_out jsonb := '[]'::jsonb;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  if not exists (select 1 from public.acc_tally_devices d where d.id = p_device_id and d.org_id = p_org_id and d.status = 'active') then
    raise exception 'Not paired.' using errcode = 'check_violation', hint = 'not_paired';
  end if;
  select * into s from public.acc_tally_bridge_settings where org_id = p_org_id;

  for j in select * from public.acc_tally_jobs
            where org_id = p_org_id and status = 'sent' and sent_at < now() - interval '10 minutes' order by seq for update loop
    if j.attempts >= 5 then
      update public.acc_tally_jobs set status = 'failed', error_code = 'no_answer', done_at = now() where id = j.id;
      if j.push_id is not null then
        update public.acc_tally_push set status = 'unknown', reason = 'no_answer' where id = j.push_id and status = 'sent';
        perform app.acc_tally_log(p_org_id, 'push', 'unknown', j.id, j.push_id, 'no_answer', null);
      end if;
    else
      update public.acc_tally_jobs set status = 'queued', check_first = check_first or kind = 'import_voucher', device_id = null
       where id = j.id;
      if j.push_id is not null then
        perform app.acc_tally_log(p_org_id, 'push', 'ambiguous', j.id, j.push_id, 'no_answer', null);
      end if;
    end if;
  end loop;

  v_stop := app.acc_tally_push_stop(p_org_id, p_today);
  if v_stop is not null then
    update public.acc_tally_push x set status = 'held', reason = v_stop, detail = null
     where x.org_id = p_org_id and x.status = 'ready'
       and exists (select 1 from public.acc_tally_jobs q where q.push_id = x.id and q.status = 'queued' and not q.check_first);
    update public.acc_tally_jobs set status = 'cancelled', error_code = v_stop, done_at = now()
     where org_id = p_org_id and kind = 'import_voucher' and status = 'queued' and not check_first;
  end if;
  if s.org_id is null or not s.pull_enabled then
    update public.acc_tally_jobs set status = 'cancelled', error_code = 'pull_off', done_at = now()
     where org_id = p_org_id and status = 'queued' and kind <> 'import_voucher';
  end if;

  for j in select * from public.acc_tally_jobs
            where org_id = p_org_id and status = 'queued'
              -- a look-up after an unanswered import is still allowed while pushing is stopped (it settles what Tally holds)
              and (kind <> 'import_voucher' or v_stop is null or check_first)
            order by seq limit least(greatest(coalesce(p_limit, 5), 1), 10) for update skip locked loop
    update public.acc_tally_jobs set status = 'sent', attempts = attempts + 1, sent_at = now(), device_id = p_device_id
     where id = j.id;
    p := null;
    if j.push_id is not null then
      update public.acc_tally_push set status = 'sent', attempts = attempts + 1 where id = j.push_id returning * into p;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', j.id, 'kind', j.kind, 'params', j.params, 'check_first', j.check_first,
      -- while pushing is stopped an unanswered import is only looked up, never sent again
      'lookup_only', j.kind = 'import_voucher' and v_stop is not null,
      'push', case when p.id is not null then jsonb_build_object(
        'id', p.id, 'remote_id', p.remote_id, 'date', p.voucher_date, 'voucher_type', p.voucher_type,
        'role', p.role, 'content', p.content) end));
  end loop;
  return jsonb_build_object('jobs', v_out, 'cost_category', coalesce(s.cost_category, 'Primary Cost Category'));
end;
$$;
revoke all on function public.acc_tally_bridge_claim(uuid, uuid, integer, date) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_claim(uuid, uuid, integer, date) to service_role;

-- The job a result is for: sent to this connector and not answered yet (else null; a late or repeated answer is ignored).
create or replace function public.acc_tally_bridge_job(p_org_id uuid, p_device_id uuid, p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', j.id, 'kind', j.kind, 'params', j.params, 'push_id', j.push_id, 'check_first', j.check_first,
                            'remote_id', p.remote_id, 'attempts', j.attempts)
  from public.acc_tally_jobs j left join public.acc_tally_push p on p.id = j.push_id
  where j.id = p_job_id and j.org_id = p_org_id and j.device_id = p_device_id and j.status = 'sent';
$$;
revoke all on function public.acc_tally_bridge_job(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_job(uuid, uuid, uuid) to service_role;

-- The answer to an import: created / altered / exists (Tally holds it: done), failed (Tally refused it, with its
-- LINEERROR text already redacted), retry (it never reached Tally), ambiguous (no readable answer: asked again only after a
-- look-up, at most five times, then "unknown").
create or replace function public.acc_tally_bridge_import_result(
  p_org_id uuid, p_device_id uuid, p_job_id uuid, p_outcome text, p_master_id bigint, p_code text, p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_tally_jobs;
  v_code text := case when p_code ~ '^[a-z_]{1,40}$' then p_code end;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  select * into j from public.acc_tally_jobs
   where id = p_job_id and org_id = p_org_id and device_id = p_device_id and status = 'sent' and kind = 'import_voucher'
   for update;
  if not found then
    raise exception 'That job is not waiting for an answer.' using errcode = 'check_violation', hint = 'not_expected';
  end if;
  if p_outcome in ('created', 'altered', 'exists') then
    update public.acc_tally_jobs set status = 'done', done_at = now(), result = jsonb_build_object('outcome', p_outcome)
     where id = j.id;
    update public.acc_tally_push set status = 'done', reason = null, detail = null, done_at = now(),
           tally_master_id = coalesce(p_master_id, tally_master_id)
     where id = j.push_id;
    perform app.acc_tally_log(p_org_id, 'push', p_outcome, j.id, j.push_id, null, null);
  elsif p_outcome = 'failed' then
    update public.acc_tally_jobs set status = 'failed', done_at = now(), error_code = coalesce(v_code, 'tally_error')
     where id = j.id;
    update public.acc_tally_push set status = 'failed', reason = coalesce(v_code, 'tally_error'),
           detail = left(nullif(btrim(coalesce(p_message, '')), ''), 300)
     where id = j.push_id;
    perform app.acc_tally_log(p_org_id, 'push', 'failed', j.id, j.push_id, coalesce(v_code, 'tally_error'), p_message);
  elsif p_outcome = 'absent' then
    -- looked up while pushing is stopped: Tally does not hold it, and it is not sent
    update public.acc_tally_jobs set status = 'cancelled', done_at = now(), error_code = 'absent' where id = j.id;
    update public.acc_tally_push set status = 'held', reason = 'push_stopped', detail = null where id = j.push_id;
    perform app.acc_tally_log(p_org_id, 'push', 'cancelled', j.id, j.push_id, 'absent', null);
  elsif p_outcome = 'retry' then
    -- it never reached Tally (not running, port closed): the attempt does not count
    update public.acc_tally_jobs set status = 'queued', device_id = null, attempts = greatest(attempts - 1, 0),
           error_code = coalesce(v_code, 'unreachable')
     where id = j.id;
    update public.acc_tally_push set status = case when j.check_first then 'sent' else 'ready' end where id = j.push_id;
    perform app.acc_tally_log(p_org_id, 'push', 'retry', j.id, j.push_id, coalesce(v_code, 'unreachable'), null);
  elsif p_outcome = 'ambiguous' then
    if j.attempts >= 5 then
      update public.acc_tally_jobs set status = 'failed', done_at = now(), error_code = 'no_answer' where id = j.id;
      update public.acc_tally_push set status = 'unknown', reason = 'no_answer' where id = j.push_id;
      perform app.acc_tally_log(p_org_id, 'push', 'unknown', j.id, j.push_id, coalesce(v_code, 'no_answer'), null);
    else
      update public.acc_tally_jobs set status = 'queued', check_first = true, device_id = null,
             error_code = coalesce(v_code, 'no_answer')
       where id = j.id;
      perform app.acc_tally_log(p_org_id, 'push', 'ambiguous', j.id, j.push_id, coalesce(v_code, 'no_answer'), null);
    end if;
  else
    raise exception 'Unknown outcome.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  return jsonb_build_object('job_id', j.id, 'outcome', p_outcome);
end;
$$;
revoke all on function public.acc_tally_bridge_import_result(uuid, uuid, uuid, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_import_result(uuid, uuid, uuid, text, bigint, text, text) to service_role;

-- An export job's end: done with its counts, or failed with a code (Tally not running, the company not loaded, ...).
create or replace function public.acc_tally_bridge_export_result(
  p_org_id uuid, p_device_id uuid, p_job_id uuid, p_ok boolean, p_code text, p_counts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_tally_jobs;
  v_code text := case when p_code ~ '^[a-z_]{1,40}$' then p_code end;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  select * into j from public.acc_tally_jobs
   where id = p_job_id and org_id = p_org_id and device_id = p_device_id and status = 'sent' and kind <> 'import_voucher'
   for update;
  if not found then
    raise exception 'That job is not waiting for an answer.' using errcode = 'check_violation', hint = 'not_expected';
  end if;
  update public.acc_tally_jobs
     set status = case when p_ok then 'done' else 'failed' end, done_at = now(), result = p_counts,
         error_code = case when p_ok then null else coalesce(v_code, 'error') end
   where id = j.id;
  if not p_ok then
    perform app.acc_tally_log(p_org_id, case when j.kind = 'export_trial_balance' then 'tb' else 'pull' end, 'failed', j.id, null,
                              coalesce(v_code, 'error'), null);
  end if;
  return jsonb_build_object('job_id', j.id, 'status', case when p_ok then 'done' else 'failed' end);
end;
$$;
revoke all on function public.acc_tally_bridge_export_result(uuid, uuid, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_export_result(uuid, uuid, uuid, boolean, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 12. A pull applied through the 22I path (stage, acc_tally_apply_masters, acc_tally_post_vouchers with no person), then
--     finished here: vouchers the bridge pushed are linked back to their source by REMOTEID (their tally_import journal
--     is the one place they count), refusals are logged once a day per voucher and code, Tally's ledger names are kept,
--     the cursor moves on and the bridge import row is removed.
--     p_refusals: [{ guid, date, number, code }] refused before staging; p_names: [{ guid, name }].
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_pull_finish(
  p_org_id uuid, p_job_id uuid, p_import_id uuid, p_cursor text, p_alter_id bigint, p_refusals jsonb, p_names jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  v_counts jsonb := '{}'::jsonb;
  v_linked integer := 0;
begin
  if p_cursor is null or p_cursor not in ('masters', 'vouchers') then
    raise exception 'Invalid cursor.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  if p_import_id is not null then
    select * into imp from public.acc_tally_imports where id = p_import_id and org_id = p_org_id and source = 'bridge' for update;
    if not found then
      raise exception 'Import not found.' using errcode = 'check_violation', hint = 'not_found';
    end if;
    if exists (select 1 from public.acc_tally_staged s where s.import_id = imp.id and s.status = 'pending') then
      raise exception 'Some rows are still waiting to be posted.' using errcode = 'check_violation', hint = 'import_pending';
    end if;
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_counts
      from (select s.kind || '.' || s.status as k, count(*) as n from public.acc_tally_staged s where s.import_id = imp.id group by 1) c;
    with linked as (
      update public.acc_tally_push p
         set mirror_journal_id = s.journal_id,
             status = case when p.status in ('sent', 'unknown', 'failed') then 'done' else p.status end,
             reason = case when p.status in ('sent', 'unknown', 'failed') then null else p.reason end,
             detail = case when p.status in ('sent', 'unknown', 'failed') then null else p.detail end,
             done_at = coalesce(p.done_at, now())
        from public.acc_tally_staged s
       where s.import_id = imp.id and s.kind = 'voucher' and s.status in ('done', 'unchanged') and s.journal_id is not null
         and p.org_id = p_org_id and p.remote_id = s.payload ->> 'remote_id'
         and p.mirror_journal_id is distinct from s.journal_id
      returning p.id
    )
    select count(*) into v_linked from linked;
    insert into public.acc_tally_sync_log (org_id, direction, outcome, job_id, tally_guid, voucher_date, voucher_number, code)
    select p_org_id, 'pull', 'refused', p_job_id, left(s.guid, 100),
           case when s.payload ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' then (s.payload ->> 'date')::date end,
           left(s.payload ->> 'number', 60), coalesce(nullif(s.result_code, ''), 'error')
      from public.acc_tally_staged s
     where s.import_id = imp.id and s.status = 'refused'
       and not exists (select 1 from public.acc_tally_sync_log l where l.org_id = p_org_id and l.direction = 'pull'
                       and l.outcome = 'refused' and l.tally_guid is not distinct from left(s.guid, 100)
                       and l.code = coalesce(nullif(s.result_code, ''), 'error') and l.at > now() - interval '1 day');
    delete from public.acc_tally_imports where id = imp.id;
  end if;

  insert into public.acc_tally_sync_log (org_id, direction, outcome, job_id, tally_guid, voucher_date, voucher_number, code)
  select p_org_id, 'pull', 'refused', p_job_id, left(x ->> 'guid', 100),
         case when x ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' then (x ->> 'date')::date end,
         left(x ->> 'number', 60), left(coalesce(x ->> 'code', 'error'), 40)
    from jsonb_array_elements(case when jsonb_typeof(p_refusals) = 'array' then p_refusals else '[]'::jsonb end) x
   where coalesce(x ->> 'code', 'error') ~ '^[a-z_]{1,40}$'
     and not exists (select 1 from public.acc_tally_sync_log l where l.org_id = p_org_id and l.direction = 'pull'
                     and l.outcome = 'refused' and l.tally_guid is not distinct from left(x ->> 'guid', 100)
                     and l.code = coalesce(x ->> 'code', 'error') and l.at > now() - interval '1 day');

  update public.acc_accounts a set tally_name = left(btrim(x ->> 'name'), 120)
    from jsonb_array_elements(case when jsonb_typeof(p_names) = 'array' then p_names else '[]'::jsonb end) x
   where a.org_id = p_org_id and not a.is_group and a.tally_guid = x ->> 'guid'
     and nullif(btrim(x ->> 'name'), '') is not null and a.tally_name is distinct from left(btrim(x ->> 'name'), 120);

  if p_alter_id is not null and p_alter_id >= 0 then
    insert into public.acc_tally_cursors (org_id, cursor, alter_id, updated_at)
    values (p_org_id, p_cursor, p_alter_id, now())
    on conflict (org_id, cursor) do update
      set alter_id = greatest(coalesce(public.acc_tally_cursors.alter_id, 0), excluded.alter_id), updated_at = now();
  end if;
  v_counts := v_counts || jsonb_build_object('linked', v_linked);
  perform app.acc_tally_log(p_org_id, 'pull', case when p_import_id is null then 'unchanged' else 'imported' end, p_job_id,
                            null, p_cursor, null, v_counts);
  return v_counts;
end;
$$;
revoke all on function public.acc_tally_bridge_pull_finish(uuid, uuid, uuid, text, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_pull_finish(uuid, uuid, uuid, text, bigint, jsonb, jsonb) to service_role;

-- A voucher cancelled, made optional or deleted in Tally (it comes back with a higher ALTERID and the flag): its mirror
-- journal is reversed on its own date, so the mirror follows Tally. Idempotent (a reversed journal is not live any more);
-- a refusal (a locked period, a closed year) is logged with its code. p_items: [{ guid, alter_id }].
create or replace function public.acc_tally_bridge_pull_cancelled(p_org_id uuid, p_job_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x jsonb;
  j public.acc_journals;
  v_hint text;
  v_done integer := 0;
  v_refused integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000 then
    raise exception 'Invalid items.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  for x in select y from jsonb_array_elements(p_items) y loop
    if coalesce(x ->> 'alter_id', '') !~ '^\d{1,9}$' then
      continue;
    end if;
    select * into j from public.acc_journals
     where org_id = p_org_id and source_kind = 'tally_import' and source_id = x ->> 'guid' and status = 'posted'
       and source_version < (x ->> 'alter_id')::integer;
    if not found then
      continue;
    end if;
    begin
      perform app.acc_reverse_internal(p_org_id, j.id, null, j.journal_date, 'Cancelled or deleted in Tally');
      insert into public.acc_tally_sync_log (org_id, direction, outcome, job_id, tally_guid, voucher_date)
      values (p_org_id, 'pull', 'reversed', p_job_id, left(x ->> 'guid', 100), j.journal_date);
      v_done := v_done + 1;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      insert into public.acc_tally_sync_log (org_id, direction, outcome, job_id, tally_guid, voucher_date, code)
      values (p_org_id, 'pull', 'refused', p_job_id, left(x ->> 'guid', 100), j.journal_date,
              case when v_hint ~ '^[a-z_]{1,40}$' then v_hint else 'error' end);
      v_refused := v_refused + 1;
    end;
  end loop;
  return jsonb_build_object('reversed', v_done, 'refused', v_refused);
end;
$$;
revoke all on function public.acc_tally_bridge_pull_cancelled(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_pull_cancelled(uuid, uuid, jsonb) to service_role;

-- The daily drift check: Tally's ledger closing balances at p_as_at (rows [{name, debit, credit}]) against the mirror,
-- through 22I's acc_tally_reconcile (stored with source 'bridge').
create or replace function public.acc_tally_bridge_record_tb(p_org_id uuid, p_job_id uuid, p_as_at date, p_sha256 text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform set_config('app.acc_tally_bridge', 'on', true);
  v := public.acc_tally_reconcile(p_org_id, null, null, null, p_as_at, p_sha256, p_rows);
  perform set_config('app.acc_tally_bridge', '', true);
  update public.acc_tally_reconciliations set source = 'bridge' where id = (v ->> 'id')::uuid and org_id = p_org_id;
  perform app.acc_tally_log(p_org_id, 'tb', case when (v ->> 'reconciled')::boolean then 'reconciled' else 'differences' end,
                            p_job_id, null, null, null,
                            jsonb_build_object('as_at', p_as_at, 'compared', v -> 'compared', 'differences', v -> 'differences',
                                               'total_difference', v -> 'total_difference'));
  return v - 'rows';
end;
$$;
revoke all on function public.acc_tally_bridge_record_tb(uuid, uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_record_tb(uuid, uuid, date, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 13. The scheduler: every 15 minutes (lib/accounting/tally/bridge-server.ts, task accounting_tally_bridge)
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:accounting_tally_bridge', '4,19,34,49 * * * *', $$select app.ping_jobs('accounting_tally_bridge')$$);
