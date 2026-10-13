-- Paste into Supabase > SQL Editor > New query, then Run. Needs 30_finance_invoice_changes.sql applied first (and the
-- paste files before it). The migration-history line is included at the bottom of this file.

-- Slice 20F: doctor revenue share with a complete trail (docs/20_FINANCE_CONTROL_PLAN.md, slice 20F; deck slide 7).
--
-- The nine steps of the trail and where each one lives:
--   1 source data            fin_revshare_inputs(): line net by doctor and service category (configured doctor basis,
--                            current lines, deleted invoices excluded), the month's doctor charges, the applicable scheme
--   2 approved formula       fin_revshare_schemes: a closed rule (jsonb, shape checked here AND by Zod in
--                            lib/finance/revshare.ts), versioned, approved by two different people bound to its sha256
--   3 exclusions/adjustments fin_doctor_charges (lab, referral, consumables, other) deducted per the rule
--   4 calculation            lib/finance/revshare.ts (pure); every step is stored in the run's snapshot
--   5 finance verification   fin_revshare_verify()   (finance.revshare.verify), bound to the snapshot sha256
--   6 approval               fin_revshare_approve()  (finance.revshare.approve), a different person, same sha256
--   7 accounting             fin_revshare_post()     the accounting (Tally) reference
--   8, 9 payment, reference  fin_revshare_record_payment() per doctor: payment date and payment reference
--
--   * Permissions: finance.revshare.view (Finance, CEO), finance.revshare.manage (Finance: schemes, charges, runs,
--     accounting and payment references), finance.revshare.verify (Finance Manager), finance.revshare.approve (CEO). Payouts are
--     doctor compensation: the Medical Director, Billing, Insurance and Cost / Payroll get none of these keys.
--   * Every table has RLS with a select policy on those keys and no write policy. Writes go through the service role
--     after can(): the SECURITY DEFINER functions below (search_path = '', service role only, jsonb) and, for single
--     charges, a server action. Triggers enforce the rules for every role, the service role included.
--   * A month locked by the close (app.fin_month_is_locked) refuses anything that changes its figures: charges, building
--     or rebuilding a draft run and withdrawing a verification. Verifying, approving, posting and recording payments do
--     not change figures and stay possible (a payment is usually made after the close).
--   * A verified run is frozen: its snapshot, its sha256 and its lines never change again; the charges of its month are
--     frozen with it. An approved scheme version never changes (a change is a new version).
-- Amounts, codes and doctor ids only: no patient data.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.revshare.view'),
      ('Finance', 'finance.revshare.manage'),
      ('Finance Manager', 'finance.revshare.verify'),
      ('CEO', 'finance.revshare.view'),
      ('CEO', 'finance.revshare.approve')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The rule vocabulary (closed; the same checks as revshareRuleSchema in lib/finance/revshare.ts)
--    { basis: 'net_revenue', default_rate: 0..1, category_rates?: {category: 0..1}, deductions: {lab|referral|
--      consumables|other: 0..1}, threshold?: amount, minimum_guarantee?: amount }
--    rates have at most 4 decimals, amounts at most 2 and below 1,000,000,000; no other key is accepted.
-- ---------------------------------------------------------------------------
create or replace function app.fin_revshare_rate_ok(v jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if v is null or jsonb_typeof(v) <> 'number' then
    return false;
  end if;
  return v::numeric between 0 and 1 and v::numeric * 10000 = trunc(v::numeric * 10000);
end;
$$;

create or replace function app.fin_revshare_amount_ok(v jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if v is null or jsonb_typeof(v) <> 'number' then
    return false;
  end if;
  return v::numeric >= 0 and v::numeric <= 1000000000 and v::numeric * 100 = trunc(v::numeric * 100);
end;
$$;

create or replace function app.fin_revshare_rule_valid(r jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  n integer := 0;
begin
  if r is null or jsonb_typeof(r) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(r) loop
    if k not in ('basis', 'default_rate', 'category_rates', 'deductions', 'threshold', 'minimum_guarantee') then
      return false;
    end if;
  end loop;
  if r -> 'basis' is distinct from '"net_revenue"'::jsonb or not app.fin_revshare_rate_ok(r -> 'default_rate') then
    return false;
  end if;
  if jsonb_typeof(r -> 'deductions') is distinct from 'object' then
    return false;
  end if;
  for k, v in select d.key, d.value from jsonb_each(r -> 'deductions') d loop
    if k not in ('lab', 'referral', 'consumables', 'other') or not app.fin_revshare_rate_ok(v) then
      return false;
    end if;
  end loop;
  if r ? 'category_rates' then
    if jsonb_typeof(r -> 'category_rates') <> 'object' then
      return false;
    end if;
    for k, v in select c.key, c.value from jsonb_each(r -> 'category_rates') c loop
      n := n + 1;
      if n > 30 or k <> btrim(k) or char_length(k) not between 1 and 60 or not app.fin_revshare_rate_ok(v) then
        return false;
      end if;
    end loop;
  end if;
  if r ? 'threshold' and not app.fin_revshare_amount_ok(r -> 'threshold') then
    return false;
  end if;
  if r ? 'minimum_guarantee' and not app.fin_revshare_amount_ok(r -> 'minimum_guarantee') then
    return false;
  end if;
  return true;
end;
$$;

-- sha256 of a jsonb value's canonical text (the same fingerprint as the close pack)
create or replace function app.fin_jsonb_sha256(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(v::text, 'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- 3. Doctor charges (step 3): lab, referral, consumables and other costs charged to a doctor's account for a month
-- ---------------------------------------------------------------------------
create table public.fin_doctor_charges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  doctor_dha_id text not null check (doctor_dha_id = upper(btrim(doctor_dha_id)) and char_length(doctor_dha_id) between 1 and 40),
  kind text not null check (kind in ('lab', 'referral', 'consumables', 'other')),
  amount numeric(14, 2) not null check (amount > 0 and amount <= 1000000000),
  -- where it came from: typed in, a CSV upload, or (later slices) the lab or referral reconciliation
  source text not null default 'manual' check (source in ('manual', 'upload', 'lab_recon', 'referral_recon')),
  reference text check (reference is null or (btrim(reference) <> '' and char_length(reference) <= 80)),
  note text check (note is null or (btrim(note) <> '' and char_length(note) <= 300)),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fin_doctor_charges_month_idx on public.fin_doctor_charges (org_id, month, doctor_dha_id);

-- ---------------------------------------------------------------------------
-- 4. Schemes (step 2): one row per doctor and version
-- ---------------------------------------------------------------------------
create table public.fin_revshare_schemes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  doctor_dha_id text not null check (doctor_dha_id = upper(btrim(doctor_dha_id)) and char_length(doctor_dha_id) between 1 and 40),
  version integer not null check (version between 1 and 10000),
  effective_from date not null check (effective_from = date_trunc('month', effective_from)::date),
  status text not null default 'draft' check (status in ('draft', 'verified', 'approved', 'retired')),
  rule jsonb not null check (app.fin_revshare_rule_valid(rule)),
  rule_hash text not null,   -- set by the trigger: sha256 of the rule
  note text check (note is null or (btrim(note) <> '' and char_length(note) <= 300)),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  retired_by uuid references public.profiles (id) on delete set null,
  retired_at timestamptz,
  unique (org_id, doctor_dha_id, version),
  check ((status in ('verified', 'approved', 'retired')) = (verified_at is not null)),
  check ((status in ('approved', 'retired')) = (approved_at is not null)),
  check ((status = 'retired') = (retired_at is not null)),
  check (verified_by is null or approved_by is null or verified_by <> approved_by),
  -- maker, checker, approver: whoever prepared (or last edited) the version never verifies it
  check (verified_by is null or created_by is null or verified_by <> created_by)
);
-- at most one version in preparation per doctor
create unique index fin_revshare_schemes_open_uidx on public.fin_revshare_schemes (org_id, doctor_dha_id)
  where status in ('draft', 'verified');
create index fin_revshare_schemes_pick_idx on public.fin_revshare_schemes (org_id, doctor_dha_id, effective_from desc, version desc);
create trigger fin_revshare_schemes_set_updated_at before update on public.fin_revshare_schemes
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Monthly runs (steps 4 to 9) and their lines
-- ---------------------------------------------------------------------------
create table public.fin_revshare_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  status text not null default 'draft' check (status in ('draft', 'verified', 'approved', 'posted', 'paid')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text not null,   -- set by the trigger: sha256 of the snapshot
  total_payout numeric(14, 2) not null default 0 check (total_payout >= 0),
  built_by uuid references public.profiles (id) on delete set null,
  built_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  posted_ref text check (posted_ref is null or (btrim(posted_ref) <> '' and char_length(posted_ref) <= 80)),
  posted_by uuid references public.profiles (id) on delete set null,
  posted_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, month),
  check ((status in ('verified', 'approved', 'posted', 'paid')) = (verified_at is not null)),
  check ((status in ('approved', 'posted', 'paid')) = (approved_at is not null)),
  check ((status in ('posted', 'paid')) = (posted_at is not null and posted_ref is not null)),
  check ((status = 'paid') = (paid_at is not null)),
  check (verified_by is null or approved_by is null or verified_by <> approved_by),
  -- maker, checker, approver: whoever built the run never verifies it
  check (verified_by is null or built_by is null or verified_by <> built_by)
);
create index fin_revshare_runs_org_idx on public.fin_revshare_runs (org_id, month desc);
create trigger fin_revshare_runs_set_updated_at before update on public.fin_revshare_runs
  for each row execute function app.set_updated_at();

create table public.fin_revshare_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  run_id uuid not null references public.fin_revshare_runs (id) on delete cascade,
  doctor_dha_id text not null check (char_length(doctor_dha_id) between 1 and 40),
  scheme_id uuid not null,         -- the approved version used (kept as a value: the snapshot holds its rule and hash)
  scheme_version integer not null,
  payout numeric(14, 2) not null check (payout >= 0),
  paid_on date,
  payment_ref text check (payment_ref is null or (btrim(payment_ref) <> '' and char_length(payment_ref) <= 80)),
  paid_by uuid references public.profiles (id) on delete set null,
  paid_recorded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, doctor_dha_id),
  check ((paid_on is null) = (payment_ref is null) and (paid_on is null) = (paid_recorded_at is null)),
  check (paid_on is null or payout > 0)
);
create index fin_revshare_lines_run_idx on public.fin_revshare_lines (run_id);
create trigger fin_revshare_lines_run_org_check before insert or update of run_id, org_id on public.fin_revshare_lines
  for each row execute function app.check_parent_org('fin_revshare_runs', 'run_id');

-- Is a month's revenue share past its draft? (its charges are then frozen with it)
create or replace function app.fin_revshare_month_frozen(p_org_id uuid, p_month date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fin_revshare_runs r
    where r.org_id = p_org_id and r.month = date_trunc('month', p_month)::date and r.status <> 'draft'
  );
$$;
revoke all on function app.fin_revshare_month_frozen(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Guards (every role, the service role included). A row without the key fields (the cross-org probe in the security
--    tests) passes through so RLS answers; deleting the whole organisation cascades through.
-- ---------------------------------------------------------------------------
create or replace function app.fin_doctor_charges_check(p_org_id uuid, p_month date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or p_month is null or not exists (select 1 from public.orgs o where o.id = p_org_id) then
    return;
  end if;
  if app.fin_month_is_locked(p_org_id, p_month) then
    raise exception 'the month % is locked by the month-end close; its charges cannot change', to_char(p_month, 'YYYY-MM')
      using errcode = '42501';
  end if;
  if app.fin_revshare_month_frozen(p_org_id, p_month) then
    raise exception 'the revenue share of % is verified; its charges cannot change (return the run to draft first)', to_char(p_month, 'YYYY-MM')
      using errcode = 'check_violation';
  end if;
end;
$$;
revoke all on function app.fin_doctor_charges_check(uuid, date) from public, anon, authenticated;

create or replace function app.fin_doctor_charges_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform app.fin_doctor_charges_check(old.org_id, old.month);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app.fin_doctor_charges_check(new.org_id, new.month);
    return new;
  end if;
  return old;
end;
$$;
revoke all on function app.fin_doctor_charges_guard() from public, anon, authenticated;
create trigger fin_doctor_charges_guard before insert or update or delete on public.fin_doctor_charges
  for each row execute function app.fin_doctor_charges_guard();

create or replace function app.fin_revshare_scheme_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_cols text[] := array['created_by', 'verified_by', 'approved_by', 'retired_by'];
  c text;
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'retired') and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'an approved scheme version cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.verified_by is not null or new.approved_by is not null or new.retired_by is not null then
      raise exception 'a scheme version starts as a draft' using errcode = 'check_violation';
    end if;
    new.rule_hash := app.fin_jsonb_sha256(new.rule);
    return new;
  end if;

  -- UPDATE
  if new.org_id <> old.org_id or new.doctor_dha_id <> old.doctor_dha_id or new.version <> old.version then
    raise exception 'the doctor and version of a scheme cannot change' using errcode = 'check_violation';
  end if;
  if old.status in ('approved', 'retired') then
    -- only approved -> retired, or the FK action that nulls a deleted user's id
    for c in select unnest(v_user_cols) loop
      if (to_jsonb(new) ->> c) is not null and (to_jsonb(new) ->> c) is distinct from (to_jsonb(old) ->> c)
         and not (old.status = 'approved' and new.status = 'retired' and c = 'retired_by') then
        raise exception 'an approved scheme version is immutable; create a new version' using errcode = 'check_violation';
      end if;
    end loop;
    if (to_jsonb(new) - v_user_cols - 'updated_at' - 'status' - 'retired_at')
       is distinct from (to_jsonb(old) - v_user_cols - 'updated_at' - 'status' - 'retired_at')
       or not ((old.status = new.status and new.retired_at is not distinct from old.retired_at)
               or (old.status = 'approved' and new.status = 'retired')) then
      raise exception 'an approved scheme version is immutable; create a new version' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
       (old.status = 'draft' and new.status in ('draft', 'verified'))
    or (old.status = 'verified' and new.status in ('draft', 'approved', 'verified'))
  ) then
    raise exception 'invalid scheme transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  new.rule_hash := app.fin_jsonb_sha256(new.rule);
  if old.status = 'verified' and new.status in ('verified', 'approved')
     and (new.rule is distinct from old.rule or new.effective_from is distinct from old.effective_from
          or new.verified_at is distinct from old.verified_at
          or (new.verified_by is not null and new.verified_by is distinct from old.verified_by)) then
    raise exception 'a verified scheme cannot be edited; editing returns it to draft' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_revshare_scheme_guard() from public, anon, authenticated;
create trigger fin_revshare_schemes_guard before insert or update or delete on public.fin_revshare_schemes
  for each row execute function app.fin_revshare_scheme_guard();

create or replace function app.fin_revshare_run_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_cols text[] := array['built_by', 'verified_by', 'approved_by', 'posted_by'];
  v_allowed text[];
  c text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      if old.status <> 'draft' then
        raise exception 'a verified revenue share run cannot be deleted' using errcode = 'check_violation';
      end if;
      if app.fin_month_is_locked(old.org_id, old.month) then
        raise exception 'the month is locked by the month-end close' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.org_id is null or new.month is null or new.snapshot is null then
      return new;   -- the RLS probe; constraints answer otherwise
    end if;
    if new.status <> 'draft' or new.verified_by is not null or new.approved_by is not null or new.posted_by is not null then
      raise exception 'a run starts as a draft' using errcode = 'check_violation';
    end if;
    if app.fin_month_is_locked(new.org_id, new.month) then
      raise exception 'the month % is locked by the month-end close', to_char(new.month, 'YYYY-MM') using errcode = '42501';
    end if;
    new.snapshot_hash := app.fin_jsonb_sha256(new.snapshot);
    return new;
  end if;

  -- UPDATE
  if new.org_id <> old.org_id or new.month <> old.month then
    raise exception 'the month of a run cannot change' using errcode = 'check_violation';
  end if;
  v_allowed := case
    when old.status = 'draft' and new.status = 'draft' then
      array['snapshot', 'snapshot_hash', 'total_payout', 'built_by', 'built_at']
    when (old.status, new.status) in (('draft', 'verified'), ('verified', 'draft')) then
      array['status', 'verified_by', 'verified_at']
    when old.status = 'verified' and new.status = 'approved' then array['status', 'approved_by', 'approved_at']
    when old.status = 'approved' and new.status = 'posted' then array['status', 'posted_ref', 'posted_by', 'posted_at']
    when old.status = 'posted' and new.status = 'paid' then array['status', 'paid_at']
    when old.status = new.status then array[]::text[]
    else null end;
  if v_allowed is null then
    raise exception 'invalid run transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  -- a deleted user's id may become null in any state; any other change of a person's id must be an allowed one
  for c in select unnest(v_user_cols) loop
    if (to_jsonb(new) ->> c) is not null and (to_jsonb(new) ->> c) is distinct from (to_jsonb(old) ->> c)
       and not (c = any (v_allowed)) then
      raise exception 'a % run is frozen', old.status using errcode = 'check_violation';
    end if;
  end loop;
  if (to_jsonb(new) - v_allowed - v_user_cols - 'updated_at') is distinct from (to_jsonb(old) - v_allowed - v_user_cols - 'updated_at') then
    raise exception 'a % run is frozen', old.status using errcode = 'check_violation';
  end if;
  if app.fin_month_is_locked(new.org_id, new.month)
     and ((old.status = 'draft' and new.status = 'draft' and new.snapshot is distinct from old.snapshot)
          or (old.status = 'verified' and new.status = 'draft')) then
    raise exception 'the month % is locked by the month-end close', to_char(new.month, 'YYYY-MM') using errcode = '42501';
  end if;
  if old.status = 'draft' and new.status = 'draft' then
    new.snapshot_hash := app.fin_jsonb_sha256(new.snapshot);
  elsif new.snapshot_hash is distinct from app.fin_jsonb_sha256(new.snapshot) then
    raise exception 'the snapshot does not match its hash' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_revshare_run_guard() from public, anon, authenticated;
create trigger fin_revshare_runs_guard before insert or update or delete on public.fin_revshare_runs
  for each row execute function app.fin_revshare_run_guard();

-- Lines are written with their draft run and frozen with it; only the payment columns change, while the run is posted.
create or replace function app.fin_revshare_line_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_month date;
  v_run uuid := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
begin
  select r.status, r.month into v_status, v_month from public.fin_revshare_runs r where r.id = v_run;
  if v_status is null
     or not exists (select 1 from public.orgs o where o.id = case when tg_op = 'DELETE' then old.org_id else new.org_id end) then
    return case when tg_op = 'DELETE' then old else new end;   -- the parent is going (cascade) or the RLS probe
  end if;
  if tg_op in ('INSERT', 'DELETE') then
    if v_status <> 'draft' then
      raise exception 'the lines of a % run are frozen', v_status using errcode = 'check_violation';
    end if;
    if app.fin_month_is_locked(case when tg_op = 'DELETE' then old.org_id else new.org_id end, v_month) then
      raise exception 'the month % is locked by the month-end close', to_char(v_month, 'YYYY-MM') using errcode = '42501';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if (to_jsonb(new) - 'paid_on' - 'payment_ref' - 'paid_by' - 'paid_recorded_at')
     is distinct from (to_jsonb(old) - 'paid_on' - 'payment_ref' - 'paid_by' - 'paid_recorded_at') then
    raise exception 'a revenue share line cannot change once written' using errcode = 'check_violation';
  end if;
  if (new.paid_on, new.payment_ref, new.paid_recorded_at) is distinct from (old.paid_on, old.payment_ref, old.paid_recorded_at)
     or (new.paid_by is not null and new.paid_by is distinct from old.paid_by) then
    if v_status <> 'posted' then
      raise exception 'payments are recorded after the run is posted to accounting and before it is complete' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_revshare_line_guard() from public, anon, authenticated;
create trigger fin_revshare_lines_guard before insert or update or delete on public.fin_revshare_lines
  for each row execute function app.fin_revshare_line_guard();

-- ---------------------------------------------------------------------------
-- 7. RLS: compensation data, read by the revenue-share keys only; nobody writes from the browser
-- ---------------------------------------------------------------------------
alter table public.fin_doctor_charges enable row level security;
alter table public.fin_revshare_schemes enable row level security;
alter table public.fin_revshare_runs enable row level security;
alter table public.fin_revshare_lines enable row level security;
create policy fin_doctor_charges_select on public.fin_doctor_charges for select to authenticated
  using (app.has_perm(org_id, 'finance.revshare.view') or app.has_perm(org_id, 'finance.revshare.manage')
      or app.has_perm(org_id, 'finance.revshare.verify') or app.has_perm(org_id, 'finance.revshare.approve'));
create policy fin_revshare_schemes_select on public.fin_revshare_schemes for select to authenticated
  using (app.has_perm(org_id, 'finance.revshare.view') or app.has_perm(org_id, 'finance.revshare.manage')
      or app.has_perm(org_id, 'finance.revshare.verify') or app.has_perm(org_id, 'finance.revshare.approve'));
create policy fin_revshare_runs_select on public.fin_revshare_runs for select to authenticated
  using (app.has_perm(org_id, 'finance.revshare.view') or app.has_perm(org_id, 'finance.revshare.manage')
      or app.has_perm(org_id, 'finance.revshare.verify') or app.has_perm(org_id, 'finance.revshare.approve'));
create policy fin_revshare_lines_select on public.fin_revshare_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.revshare.view') or app.has_perm(org_id, 'finance.revshare.manage')
      or app.has_perm(org_id, 'finance.revshare.verify') or app.has_perm(org_id, 'finance.revshare.approve'));

-- ---------------------------------------------------------------------------
-- 8. Step 1: the inputs of a month. The same function feeds the build and the checks at store and verify time, so a
--    run is always built from what the database holds. Ordered deterministically; amounts rounded to 2 decimals.
-- ---------------------------------------------------------------------------
create or replace function public.fin_revshare_inputs(p_org_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_basis text;
  v_result jsonb;
begin
  if p_month is null then
    raise exception 'choose a month' using errcode = 'invalid_parameter_value';
  end if;
  select s.doctor_basis into v_basis from public.fin_ref_finance_settings s where s.org_id = p_org_id;

  with ln as (
    select upper(nullif(btrim(case v_basis
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end), '')) as doctor_id,
           coalesce(nullif(btrim(s.service_category), ''), 'Unmapped') as category,
           i.id as invoice_id,
           coalesce(l.line_net, 0) as net
    from public.fin_invoices i
    join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
    left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date >= v_month and i.transaction_date < v_end
  ), rev as (
    select doctor_id, category, round(sum(net), 2) as net, count(*) as lines, count(distinct invoice_id) as invoices
    from ln group by doctor_id, category
  ), ch as (
    select c.id, c.doctor_dha_id, c.kind, c.amount, c.source, c.reference
    from public.fin_doctor_charges c
    where c.org_id = p_org_id and c.month = v_month
  ), latest as (
    -- the newest version (by start month, then version) that has started; a retired one means "no scheme"
    select distinct on (s.doctor_dha_id) s.*
    from public.fin_revshare_schemes s
    where s.org_id = p_org_id and s.status in ('approved', 'retired') and s.effective_from <= v_month
    order by s.doctor_dha_id, s.effective_from desc, s.version desc
  ), sch as (
    select * from latest where status = 'approved'
  ), ids as (
    select doctor_id as id from rev where doctor_id is not null
    union select doctor_dha_id from ch
    union select doctor_dha_id from sch
  )
  select jsonb_build_object(
    'month', v_month,
    'doctor_basis', v_basis,
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('doctor_dha_id', r.doctor_id, 'category', r.category, 'net', r.net,
                                          'lines', r.lines, 'invoices', r.invoices)
                       order by r.doctor_id nulls last, r.category)
      from rev r), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'doctor_dha_id', c.doctor_dha_id, 'kind', c.kind, 'amount', c.amount,
                                          'source', c.source, 'reference', c.reference)
                       order by c.doctor_dha_id, c.kind, c.id)
      from ch c), '[]'::jsonb),
    'schemes', coalesce((
      select jsonb_agg(jsonb_build_object('doctor_dha_id', s.doctor_dha_id, 'scheme_id', s.id, 'version', s.version,
                                          'effective_from', s.effective_from, 'rule', s.rule, 'rule_hash', s.rule_hash,
                                          'verified_by', s.verified_by, 'verified_at', s.verified_at,
                                          'approved_by', s.approved_by, 'approved_at', s.approved_at)
                       order by s.doctor_dha_id)
      from sch s), '[]'::jsonb),
    'doctors', coalesce((
      select jsonb_agg(jsonb_build_object('dha_id', d.id,
               'name', (select f.name from public.fin_ref_doctors f
                        where f.org_id = p_org_id and upper(btrim(f.dha_id)) = d.id order by f.dha_id limit 1))
               order by d.id)
      from ids d), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.fin_revshare_inputs(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_revshare_inputs(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Schemes: save a draft (new version or edit), verify, approve (different person, same hash), retire, delete a draft
-- ---------------------------------------------------------------------------
create or replace function public.fin_revshare_scheme_save(
  p_org_id uuid, p_scheme_id uuid, p_doctor text, p_effective_from date, p_rule jsonb, p_note text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doctor text := upper(btrim(coalesce(p_doctor, '')));
  v_scheme public.fin_revshare_schemes;
  v_id uuid;
begin
  if not app.fin_revshare_rule_valid(p_rule) then
    raise exception 'the rule is not valid' using errcode = 'check_violation';
  end if;
  if p_scheme_id is null then
    perform pg_advisory_xact_lock(hashtext('fin_revshare_scheme:' || p_org_id::text || ':' || v_doctor));
    if exists (select 1 from public.fin_revshare_schemes s
               where s.org_id = p_org_id and s.doctor_dha_id = v_doctor and s.status in ('draft', 'verified')) then
      raise exception 'this doctor already has a version in preparation; edit that one' using errcode = 'check_violation';
    end if;
    insert into public.fin_revshare_schemes (org_id, doctor_dha_id, version, effective_from, rule, rule_hash, note, created_by)
    values (p_org_id, v_doctor,
            coalesce((select max(s.version) from public.fin_revshare_schemes s
                      where s.org_id = p_org_id and s.doctor_dha_id = v_doctor), 0) + 1,
            date_trunc('month', p_effective_from)::date, p_rule, '', nullif(btrim(coalesce(p_note, '')), ''), p_user_id)
    returning id into v_id;
    return v_id;
  end if;
  select * into v_scheme from public.fin_revshare_schemes where id = p_scheme_id and org_id = p_org_id for update;
  if not found then
    raise exception 'scheme not found' using errcode = 'no_data_found';
  end if;
  if v_scheme.status not in ('draft', 'verified') then
    raise exception 'an approved scheme version cannot be edited; create a new version' using errcode = 'check_violation';
  end if;
  update public.fin_revshare_schemes
     set rule = p_rule, effective_from = date_trunc('month', p_effective_from)::date,
         note = nullif(btrim(coalesce(p_note, '')), ''),
         status = 'draft', verified_by = null, verified_at = null,
         created_by = p_user_id   -- whoever changes the rule is its preparer, so they cannot verify it
   where id = v_scheme.id;
  return v_scheme.id;
end;
$$;
revoke all on function public.fin_revshare_scheme_save(uuid, uuid, text, date, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.fin_revshare_scheme_save(uuid, uuid, text, date, jsonb, text, uuid) to service_role;

-- p_step: 'verify' (draft -> verified), 'approve' (verified -> approved, a different person), 'retire' (approved ->
-- retired), 'delete' (a draft or verified version is removed). p_hash must be the rule hash the person saw.
create or replace function public.fin_revshare_scheme_step(
  p_org_id uuid, p_scheme_id uuid, p_step text, p_user_id uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_revshare_schemes;
begin
  select * into v from public.fin_revshare_schemes where id = p_scheme_id and org_id = p_org_id for update;
  if not found then
    raise exception 'scheme not found' using errcode = 'no_data_found';
  end if;
  if p_hash is distinct from v.rule_hash then
    raise exception 'the rule changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  if p_step = 'verify' then
    if v.status <> 'draft' then
      raise exception 'only a draft can be verified (this version is %)', v.status using errcode = 'check_violation';
    end if;
    if v.created_by = p_user_id then
      raise exception 'the person who prepared this version cannot verify it' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'verified', verified_by = p_user_id, verified_at = now() where id = v.id;
  elsif p_step = 'approve' then
    if v.status <> 'verified' then
      raise exception 'only a verified version can be approved (this version is %)', v.status using errcode = 'check_violation';
    end if;
    if v.verified_by = p_user_id then
      raise exception 'the verification and the approval must be two different people' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'approved', approved_by = p_user_id, approved_at = now() where id = v.id;
  elsif p_step = 'retire' then
    if v.status <> 'approved' then
      raise exception 'only an approved version can be retired' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'retired', retired_by = p_user_id, retired_at = now() where id = v.id;
  elsif p_step = 'delete' then
    if v.status not in ('draft', 'verified') then
      raise exception 'only a version in preparation can be deleted' using errcode = 'check_violation';
    end if;
    delete from public.fin_revshare_schemes where id = v.id;
  else
    raise exception 'unknown step' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;
revoke all on function public.fin_revshare_scheme_step(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_scheme_step(uuid, uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Charges from a CSV: a file replaces the UPLOADED charges of the same month and kind (re-uploading a corrected file
--     never double-counts; typed-in and reconciliation charges are untouched). All or nothing.
--     p_rows: [{month, doctor_dha_id, kind, amount, reference, note}]
-- ---------------------------------------------------------------------------
create or replace function public.fin_doctor_charges_replace_upload(p_org_id uuid, p_rows jsonb, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
  v_added integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'the file has no rows' using errcode = 'check_violation';
  end if;
  with keys as (
    select distinct (x ->> 'month')::date as month, x ->> 'kind' as kind from jsonb_array_elements(p_rows) x
  )
  delete from public.fin_doctor_charges c
   using keys k
   where c.org_id = p_org_id and c.source = 'upload' and c.month = k.month and c.kind = k.kind;
  get diagnostics v_removed = row_count;
  insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, source, reference, note, created_by)
  select p_org_id, (x ->> 'month')::date, upper(btrim(x ->> 'doctor_dha_id')), x ->> 'kind', (x ->> 'amount')::numeric,
         'upload', nullif(btrim(coalesce(x ->> 'reference', '')), ''), nullif(btrim(coalesce(x ->> 'note', '')), ''), p_user_id
  from jsonb_array_elements(p_rows) x;
  get diagnostics v_added = row_count;
  return jsonb_build_object('removed', v_removed, 'added', v_added);
end;
$$;
revoke all on function public.fin_doctor_charges_replace_upload(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_doctor_charges_replace_upload(uuid, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Runs. The server builds the snapshot with lib/finance/revshare.ts from fin_revshare_inputs(); storing it checks
--     that its inputs are exactly what the database holds now and that every result uses the month's approved scheme.
-- ---------------------------------------------------------------------------
create or replace function public.fin_revshare_store_draft(p_org_id uuid, p_month date, p_user_id uuid, p_snapshot jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_run public.fin_revshare_runs;
  v_results jsonb := p_snapshot -> 'results';
  v_schemes jsonb := p_snapshot -> 'inputs' -> 'schemes';
begin
  if p_month is null or jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception 'nothing to store' using errcode = 'invalid_parameter_value';
  end if;
  if v_month >= date_trunc('month', current_date)::date then
    raise exception 'a month can only be calculated after it has ended' using errcode = 'check_violation';
  end if;
  if app.fin_month_is_locked(p_org_id, v_month) then
    raise exception 'the month % is locked by the month-end close', to_char(v_month, 'YYYY-MM') using errcode = '42501';
  end if;
  if (p_snapshot ->> 'month')::date is distinct from v_month then
    raise exception 'the snapshot is for another month' using errcode = 'check_violation';
  end if;
  if (p_snapshot -> 'inputs') is distinct from public.fin_revshare_inputs(p_org_id, v_month) then
    raise exception 'the source data changed while the run was being built; build it again' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(v_results) is distinct from 'array' or jsonb_array_length(v_results) <> jsonb_array_length(v_schemes)
     or exists (
       select 1 from jsonb_array_elements(v_results) r
       where not exists (select 1 from jsonb_array_elements(v_schemes) s
                         where s ->> 'scheme_id' = r ->> 'scheme_id' and s ->> 'doctor_dha_id' = r ->> 'doctor_dha_id'
                           and (s ->> 'version')::integer = (r ->> 'scheme_version')::integer)) then
    raise exception 'every doctor with an approved scheme needs exactly one result' using errcode = 'check_violation';
  end if;

  insert into public.fin_revshare_runs (org_id, month, snapshot, snapshot_hash, built_by)
  values (p_org_id, v_month, '{}'::jsonb, '', p_user_id)
  on conflict (org_id, month) do nothing;
  select * into v_run from public.fin_revshare_runs where org_id = p_org_id and month = v_month for update;
  if v_run.status <> 'draft' then
    raise exception 'the run for this month is % and cannot be rebuilt', v_run.status using errcode = 'check_violation';
  end if;
  delete from public.fin_revshare_lines where run_id = v_run.id;
  update public.fin_revshare_runs
     set snapshot = p_snapshot,
         total_payout = coalesce((select sum((r ->> 'payout')::numeric) from jsonb_array_elements(v_results) r), 0),
         built_by = p_user_id, built_at = now()
   where id = v_run.id;
  insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout)
  select p_org_id, v_run.id, r ->> 'doctor_dha_id', (r ->> 'scheme_id')::uuid, (r ->> 'scheme_version')::integer,
         (r ->> 'payout')::numeric
  from jsonb_array_elements(v_results) r;
  return v_run.id;
end;
$$;
revoke all on function public.fin_revshare_store_draft(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fin_revshare_store_draft(uuid, date, uuid, jsonb) to service_role;

-- p_step: 'verify' (draft -> verified: the inputs must still be current), 'withdraw' (verified -> draft),
-- 'approve' (verified -> approved by a different person). p_hash must be the snapshot hash the person saw.
create or replace function public.fin_revshare_run_step(
  p_org_id uuid, p_run_id uuid, p_step text, p_user_id uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_revshare_runs;
begin
  select * into v from public.fin_revshare_runs where id = p_run_id and org_id = p_org_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'no_data_found';
  end if;
  if p_hash is distinct from v.snapshot_hash then
    raise exception 'the run changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  if p_step = 'verify' then
    if v.status <> 'draft' then
      raise exception 'only a draft can be verified (this run is %)', v.status using errcode = 'check_violation';
    end if;
    if (v.snapshot -> 'inputs') is distinct from public.fin_revshare_inputs(p_org_id, v.month) then
      raise exception 'the source data changed since this draft was built; rebuild it, then verify' using errcode = 'check_violation';
    end if;
    if v.built_by = p_user_id then
      raise exception 'the person who built this run cannot verify it' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'verified', verified_by = p_user_id, verified_at = now() where id = v.id;
  elsif p_step = 'withdraw' then
    if v.status <> 'verified' then
      raise exception 'only a verified run waiting for approval can be returned to draft' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'draft', verified_by = null, verified_at = null where id = v.id;
  elsif p_step = 'approve' then
    if v.status <> 'verified' then
      raise exception 'only a verified run can be approved (this run is %)', v.status using errcode = 'check_violation';
    end if;
    if v.verified_by = p_user_id then
      raise exception 'the verification and the approval must be two different people' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'approved', approved_by = p_user_id, approved_at = now() where id = v.id;
  else
    raise exception 'unknown step' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;
revoke all on function public.fin_revshare_run_step(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_run_step(uuid, uuid, text, uuid, text) to service_role;

-- Step 7: the accounting reference (approved -> posted; straight on to paid when nobody is owed anything)
create or replace function public.fin_revshare_post(p_org_id uuid, p_run_id uuid, p_user_id uuid, p_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_revshare_runs;
begin
  select * into v from public.fin_revshare_runs where id = p_run_id and org_id = p_org_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'no_data_found';
  end if;
  if v.status <> 'approved' then
    raise exception 'only an approved run can be posted (this run is %)', v.status using errcode = 'check_violation';
  end if;
  if char_length(btrim(coalesce(p_ref, ''))) not between 1 and 80 then
    raise exception 'give the accounting reference (1 to 80 characters)' using errcode = 'check_violation';
  end if;
  update public.fin_revshare_runs set status = 'posted', posted_ref = btrim(p_ref), posted_by = p_user_id, posted_at = now()
   where id = v.id;
  if not exists (select 1 from public.fin_revshare_lines l where l.run_id = v.id and l.payout > 0 and l.payment_ref is null) then
    update public.fin_revshare_runs set status = 'paid', paid_at = now() where id = v.id;
  end if;
end;
$$;
revoke all on function public.fin_revshare_post(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_post(uuid, uuid, uuid, text) to service_role;

-- Steps 8 and 9: one doctor's payment. Correctable while the run is posted; the run is paid once every payout is.
create or replace function public.fin_revshare_record_payment(
  p_org_id uuid, p_line_id uuid, p_user_id uuid, p_paid_on date, p_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.fin_revshare_lines;
  v_run public.fin_revshare_runs;
begin
  select * into v_line from public.fin_revshare_lines where id = p_line_id and org_id = p_org_id;
  if not found then
    raise exception 'line not found' using errcode = 'no_data_found';
  end if;
  select * into v_run from public.fin_revshare_runs where id = v_line.run_id for update;
  if v_run.status <> 'posted' then
    raise exception 'payments are recorded once the run is posted to accounting (this run is %)', v_run.status using errcode = 'check_violation';
  end if;
  if v_line.payout <= 0 then
    raise exception 'nothing is payable on this line' using errcode = 'check_violation';
  end if;
  if p_paid_on is null or p_paid_on < v_run.month or p_paid_on > current_date + 1 then
    raise exception 'the payment date must be after the start of the month and not in the future' using errcode = 'check_violation';
  end if;
  if char_length(btrim(coalesce(p_ref, ''))) not between 1 and 80 then
    raise exception 'give the payment reference (1 to 80 characters)' using errcode = 'check_violation';
  end if;
  update public.fin_revshare_lines
     set paid_on = p_paid_on, payment_ref = btrim(p_ref), paid_by = p_user_id, paid_recorded_at = now()
   where id = v_line.id;
  if not exists (select 1 from public.fin_revshare_lines l where l.run_id = v_run.id and l.payout > 0 and l.payment_ref is null) then
    update public.fin_revshare_runs set status = 'paid', paid_at = now() where id = v_run.id;
    return 'paid';
  end if;
  return 'posted';
end;
$$;
revoke all on function public.fin_revshare_record_payment(uuid, uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_record_payment(uuid, uuid, uuid, date, text) to service_role;

-- The liability for the board pack: approved (or posted) and not yet paid, per run month and in total.
create or replace function public.fin_revshare_liability(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with u as (
    select r.month, r.status, count(l.id) as doctors, round(coalesce(sum(l.payout), 0), 2) as unpaid
    from public.fin_revshare_runs r
    join public.fin_revshare_lines l on l.run_id = r.id and l.payout > 0 and l.payment_ref is null
    where r.org_id = p_org_id and r.status in ('approved', 'posted')
    group by r.month, r.status
  )
  select jsonb_build_object(
    'total', coalesce((select sum(unpaid) from u), 0),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('month', u.month, 'status', u.status, 'doctors', u.doctors,
                                                          'unpaid', u.unpaid) order by u.month) from u), '[]'::jsonb));
$$;
revoke all on function public.fin_revshare_liability(uuid) from public, anon, authenticated;
grant execute on function public.fin_revshare_liability(uuid) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261101000100', 'finance_revenue_share') on conflict (version) do nothing;
