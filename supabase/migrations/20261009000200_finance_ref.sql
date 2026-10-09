-- Finance F1 / 2: reference data maintained by admins in the portal, plus the
-- permission helper used by every finance policy.

-- Which permission lets a member see an exception, by the role that owns it.
create or replace function app.fin_owner_perm(p_owner_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_owner_role
    when 'insurance' then 'finance.claims.view'
    when 'billing'   then 'finance.invoices.view'
    when 'finance'   then 'finance.view'
    else 'finance.capture.manage'                    -- 'admin' and anything unknown fail towards admins
  end;
$$;

create table public.fin_ref_branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{1,4}$'),
  name text not null,
  unite_clinic_long_name text,                        -- confirm exact names from the first full pull
  unite_clinic_short_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
create unique index fin_ref_branches_clinic_uidx on public.fin_ref_branches (org_id, unite_clinic_long_name)
  where unite_clinic_long_name is not null;

create table public.fin_ref_doctors (
  org_id uuid not null references public.orgs (id) on delete cascade,
  dha_id text not null,
  name text,
  department text,
  specialty text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, dha_id)
);

create table public.fin_ref_services (
  org_id uuid not null references public.orgs (id) on delete cascade,
  item_code text not null,                            -- Unite ItemCode (internal codes such as T-100007 are not CPT)
  cpt_code text,
  description text,
  item_type text,
  service_category text not null default 'Unmapped',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, item_code)
);
create index fin_ref_services_unmapped_idx on public.fin_ref_services (org_id) where service_category = 'Unmapped';

create table public.fin_ref_payers (
  org_id uuid not null references public.orgs (id) on delete cascade,
  payer_id text not null,
  payer_name text,
  receiver_id text,
  receiver_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, payer_id)
);

create table public.fin_ref_exception_rules (
  org_id uuid not null references public.orgs (id) on delete cascade,
  rule_code text not null check (rule_code ~ '^E[0-9]{2}$'),
  description text not null,
  owner_role text not null check (owner_role in ('insurance', 'billing', 'finance', 'admin')),
  threshold_days integer check (threshold_days is null or threshold_days >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, rule_code)
);

create trigger fin_ref_branches_set_updated_at before update on public.fin_ref_branches for each row execute function app.set_updated_at();
create trigger fin_ref_doctors_set_updated_at before update on public.fin_ref_doctors for each row execute function app.set_updated_at();
create trigger fin_ref_services_set_updated_at before update on public.fin_ref_services for each row execute function app.set_updated_at();
create trigger fin_ref_payers_set_updated_at before update on public.fin_ref_payers for each row execute function app.set_updated_at();
create trigger fin_ref_exception_rules_set_updated_at before update on public.fin_ref_exception_rules for each row execute function app.set_updated_at();

-- RLS: org members with a finance permission read; finance.reference.manage writes.
alter table public.fin_ref_branches enable row level security;
alter table public.fin_ref_doctors enable row level security;
alter table public.fin_ref_services enable row level security;
alter table public.fin_ref_payers enable row level security;
alter table public.fin_ref_exception_rules enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_ref_branches', 'fin_ref_doctors', 'fin_ref_services', 'fin_ref_payers', 'fin_ref_exception_rules'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (app.has_perm(org_id, 'finance.view') or app.has_perm(org_id, 'finance.invoices.view')
          or app.has_perm(org_id, 'finance.claims.view') or app.has_perm(org_id, 'finance.reference.manage')
          or app.has_perm(org_id, 'finance.capture.manage'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (app.has_perm(org_id, 'finance.reference.manage'))
      with check (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Per-org seed: branches, exception rules, capture settings (disabled).
-- Idempotent; never overwrites admin edits. Runs for every new org via trigger
-- and is back-filled for existing orgs below.
-- ---------------------------------------------------------------------------

create or replace function public.seed_finance_reference(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.fin_ref_branches (org_id, code, name) values
    (p_org_id, 'P', 'Palm Jumeirah'),
    (p_org_id, 'M', 'Meadows'),
    (p_org_id, 'G', 'Golden Mile')
  on conflict (org_id, code) do nothing;

  insert into public.fin_ref_exception_rules (org_id, rule_code, description, owner_role, threshold_days) values
    (p_org_id, 'E01', 'Insurance invoice with no claim activity after N days',                         'insurance', 30),
    (p_org_id, 'E02', 'Claim activity with no matching Unite invoice',                                 'insurance', null),
    (p_org_id, 'E03', 'Claimed amount differs from invoiced line amount, or ambiguous line match',     'billing',   null),
    (p_org_id, 'E04', 'Rejected or partially rejected claim not resubmitted after N days',             'insurance', 14),
    (p_org_id, 'E05', 'Outstanding insurance balance older than N days',                               'insurance', 60),
    (p_org_id, 'E06', 'Claim activity in the previous Diligence file but missing from the latest',     'insurance', null),
    (p_org_id, 'E07', 'Unknown clinic / branch on an invoice',                                         'admin',     null),
    (p_org_id, 'E08', 'AppointmentId not found in appointments',                                       'admin',     null),
    (p_org_id, 'E09', 'Capture failure, count mismatch, or gap in the invoice number sequence',        'admin',     null),
    (p_org_id, 'E10', 'Diligence file failed validation',                                              'insurance', null)
  on conflict (org_id, rule_code) do nothing;

  insert into public.fin_capture_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;
end;
$$;
revoke all on function public.seed_finance_reference(uuid) from public, anon, authenticated;
grant execute on function public.seed_finance_reference(uuid) to service_role;

create or replace function app.seed_finance_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_finance_reference(new.id);
  return new;
end;
$$;
create trigger orgs_seed_finance after insert on public.orgs
  for each row execute function app.seed_finance_on_org_insert();

select public.seed_finance_reference(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- Adds finance role presets to an existing org (new orgs get them from the
-- app's SYSTEM_ROLES). p_roles: [{name, description, permissions[]}].
-- Existing roles with the same name are left untouched.
-- ---------------------------------------------------------------------------
create or replace function public.seed_finance_roles(p_org_id uuid, p_roles jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_added integer := 0;
begin
  if jsonb_typeof(p_roles) <> 'array' then
    raise exception 'p_roles must be an array' using errcode = 'check_violation';
  end if;
  for r in select * from jsonb_array_elements(p_roles) loop
    insert into public.roles (org_id, name, description, permissions, is_system)
    values (p_org_id, r ->> 'name', r ->> 'description', coalesce(r -> 'permissions', '[]'::jsonb), true)
    on conflict (org_id, name) do nothing;
    if found then v_added := v_added + 1; end if;
  end loop;
  return v_added;
end;
$$;
revoke all on function public.seed_finance_roles(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.seed_finance_roles(uuid, jsonb) to service_role;
