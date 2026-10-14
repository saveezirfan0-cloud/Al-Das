-- Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md).
-- The setting lives in orgs.settings->'finance_access' (no new table). This migration:
--   1. lets security_alerts hold the alert kind raised when the window refuses a finance or accounting request;
--   2. validates the setting (and orgs.timezone while it is on) ONCE, when it is written: app.finance_access_problem
--      behind a trigger on orgs; the read path then only needs a cheap structural read;
--   3. adds the read path: app.finance_window_hours (days and hours), app.finance_window_reason (the whole rule,
--      parity-tested against lib/security/finance-access.ts) and app.finance_window_open (the caller, one org, now());
--   4. redefines app.has_perm and app.has_perm_wild (last defined in 20261008000200_tenancy.sql and
--      20261009000900_rls_helpers.sql, bodies unchanged) so a finance.* or accounting.* key is granted only while the
--      window is open;
--   5. redefines the accounting ledger's own read helpers (app.acc_can_view, acc_can_read_journals,
--      acc_can_read_receivables, acc_can_read_banking, acc_can_read_budgets; each defined once, in
--      20261108000100 / 20261109000200 / 0300 / 0400, bodies unchanged) the same way.
-- RLS, Realtime and direct REST calls with a member's token therefore follow the DAYS AND HOURS. The IP allow-list
-- cannot be checked here (server reads arrive from Vercel, not the person), so it applies to Pulse's own pages,
-- actions and API routes only.

-- ---------------------------------------------------------------------------
-- 1. Alert kind
-- ---------------------------------------------------------------------------
alter table public.security_alerts drop constraint if exists security_alerts_kind_check;
alter table public.security_alerts add constraint security_alerts_kind_check
  check (kind in ('bulk_export', 'off_hours_access', 'failed_logins', 'role_change', 'bulk_api_read',
                  'finance_access_denied'));

-- ---------------------------------------------------------------------------
-- 2. Write-time validation. Mirrors financeAccessSchema (lib/security/finance-access.ts); addresses are checked with
--    Postgres inet syntax. Returns null when the value may be stored, else a short reason. While the window is on, the
--    org timezone must be a named zone Postgres knows (pg_timezone_names): offsets such as '+04:00' or 'UTC+4' are
--    refused, because Postgres reads them POSIX-style (sign reversed) while the app reads them ISO-style.
-- ---------------------------------------------------------------------------
create or replace function app.finance_access_problem(p_cfg jsonb, p_tz text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_enabled boolean := false;
  v_limit boolean := true;
  v_days int := 6;
  v_ips int := 0;
  v_scope text := 'finance_roles';
  v_roles int := 0;
  v_el jsonb;
  v_txt text;
  v_net inet;
  c_hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  c_uuid constant text :=
    '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
begin
  if p_cfg is null or jsonb_typeof(p_cfg) = 'null' then return null; end if;
  if jsonb_typeof(p_cfg) <> 'object' then return 'not an object'; end if;
  if p_cfg ? 'enabled' then
    if jsonb_typeof(p_cfg -> 'enabled') <> 'boolean' then return 'enabled'; end if;
    v_enabled := (p_cfg ->> 'enabled')::boolean;
  end if;
  if p_cfg ? 'limit_hours' then
    if jsonb_typeof(p_cfg -> 'limit_hours') <> 'boolean' then return 'limit_hours'; end if;
    v_limit := (p_cfg ->> 'limit_hours')::boolean;
  end if;
  if p_cfg ? 'days' then
    if jsonb_typeof(p_cfg -> 'days') <> 'array' or jsonb_array_length(p_cfg -> 'days') > 7 then return 'days'; end if;
    for v_el in select value from jsonb_array_elements(p_cfg -> 'days') loop
      if jsonb_typeof(v_el) <> 'number'
         or (v_el #>> '{}')::numeric <> trunc((v_el #>> '{}')::numeric)
         or (v_el #>> '{}')::numeric not between 1 and 7 then
        return 'days';
      end if;
    end loop;
    v_days := jsonb_array_length(p_cfg -> 'days');
  end if;
  if p_cfg ? 'start' then
    if jsonb_typeof(p_cfg -> 'start') <> 'string' or (p_cfg ->> 'start') !~ c_hhmm then return 'start'; end if;
  end if;
  if p_cfg ? 'end' then
    if jsonb_typeof(p_cfg -> 'end') <> 'string' or (p_cfg ->> 'end') !~ c_hhmm then return 'end'; end if;
  end if;
  if p_cfg ? 'ip_allowlist' then
    if jsonb_typeof(p_cfg -> 'ip_allowlist') <> 'array' or jsonb_array_length(p_cfg -> 'ip_allowlist') > 50 then
      return 'ip_allowlist';
    end if;
    for v_el in select value from jsonb_array_elements(p_cfg -> 'ip_allowlist') loop
      if jsonb_typeof(v_el) <> 'string' or char_length(v_el #>> '{}') > 64 then return 'ip_allowlist'; end if;
      v_txt := btrim(v_el #>> '{}');
      continue when v_txt = '';
      begin
        v_net := v_txt::inet;
      exception when others then
        return 'ip_allowlist';
      end;
      if masklen(v_net) = 0 then return 'ip_allowlist'; end if;
      v_ips := v_ips + 1;
    end loop;
  end if;
  if p_cfg ? 'scope' then
    if jsonb_typeof(p_cfg -> 'scope') <> 'string' or (p_cfg ->> 'scope') not in ('finance_roles', 'selected_roles') then
      return 'scope';
    end if;
    v_scope := p_cfg ->> 'scope';
  end if;
  if p_cfg ? 'role_ids' then
    if jsonb_typeof(p_cfg -> 'role_ids') <> 'array' or jsonb_array_length(p_cfg -> 'role_ids') > 200 then
      return 'role_ids';
    end if;
    for v_el in select value from jsonb_array_elements(p_cfg -> 'role_ids') loop
      if jsonb_typeof(v_el) <> 'string' or (v_el #>> '{}') !~ c_uuid then return 'role_ids'; end if;
    end loop;
    v_roles := jsonb_array_length(p_cfg -> 'role_ids');
  end if;
  if not v_enabled then return null; end if;
  -- completeness, only for a window that is switched on
  if v_limit and v_days = 0 then return 'days'; end if;
  if not v_limit and v_ips = 0 then return 'hours or addresses'; end if;
  if v_scope = 'selected_roles' and v_roles = 0 then return 'role_ids'; end if;
  if p_tz is null
     or p_tz ~* '^(posix|right)/' or p_tz in ('posixrules', 'Factory', 'localtime')
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then
    return 'timezone';
  end if;
  return null;
end;
$$;
revoke all on function app.finance_access_problem(jsonb, text) from public, anon, authenticated;
grant execute on function app.finance_access_problem(jsonb, text) to service_role;

-- Refuses an invalid finance_access setting, and a timezone the window cannot use while it is on. Runs only when the
-- setting or the timezone changes, so other updates of an organisation are never held up by it.
create or replace function app.orgs_finance_access_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE'
     and (new.settings -> 'finance_access') is not distinct from (old.settings -> 'finance_access')
     and new.timezone is not distinct from old.timezone then
    return new;
  end if;
  v_problem := app.finance_access_problem(new.settings -> 'finance_access', new.timezone);
  if v_problem is not null then
    raise exception 'finance access window: invalid %', v_problem using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists orgs_finance_access_guard on public.orgs;
create trigger orgs_finance_access_guard
  before insert or update of settings, timezone on public.orgs
  for each row execute function app.orgs_finance_access_guard();

-- ---------------------------------------------------------------------------
-- 3. Read path. A cheap structural read of a value the trigger already validated: no exception blocks, no address
--    loop. Anything ill-typed in a switched-on window still fails closed ('invalid_settings'). Reason words as
--    financeAccessDecision(): 'off', 'not_in_scope', 'inside', 'invalid_settings', 'day_not_allowed', 'outside_hours'
--    (plus 'admin' from finance_window_reason). The address list is never evaluated here.
-- ---------------------------------------------------------------------------
create or replace function app.finance_window_hours(p_cfg jsonb, p_tz text, p_role_id uuid, p_now timestamptz)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scope text;
  v_days jsonb;
  v_start text;
  v_end text;
  v_local timestamp;
  v_day int;
  v_yday int;
  v_min int;
  v_s int;
  v_e int;
  v_today boolean;
  v_prev boolean;
  c_hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if p_cfg is null or jsonb_typeof(p_cfg) = 'null' then return 'off'; end if;
  if jsonb_typeof(p_cfg) <> 'object' then return 'invalid_settings'; end if;
  if p_cfg -> 'enabled' is null or p_cfg -> 'enabled' = 'false'::jsonb then return 'off'; end if;
  if p_cfg -> 'enabled' <> 'true'::jsonb then return 'invalid_settings'; end if;

  v_scope := coalesce(p_cfg -> 'scope', '"finance_roles"'::jsonb) #>> '{}';
  if v_scope = 'selected_roles' then
    if jsonb_typeof(p_cfg -> 'role_ids') is distinct from 'array' then return 'invalid_settings'; end if;
    if p_role_id is null or not ((p_cfg -> 'role_ids') ? p_role_id::text) then return 'not_in_scope'; end if;
  elsif v_scope is distinct from 'finance_roles' then
    return 'invalid_settings';
  end if;

  if p_cfg -> 'limit_hours' = 'false'::jsonb then
    return 'inside'; -- address list only: not enforceable here
  end if;
  if p_cfg -> 'limit_hours' is not null and p_cfg -> 'limit_hours' <> 'true'::jsonb then
    return 'invalid_settings';
  end if;

  v_days := coalesce(p_cfg -> 'days', '[1, 2, 3, 4, 5, 6]'::jsonb);
  v_start := coalesce(p_cfg -> 'start', '"07:00"'::jsonb) #>> '{}';
  v_end := coalesce(p_cfg -> 'end', '"21:00"'::jsonb) #>> '{}';
  if jsonb_typeof(v_days) <> 'array' or jsonb_array_length(v_days) = 0
     or v_start is null or v_start !~ c_hhmm or v_end is null or v_end !~ c_hhmm or p_tz is null then
    return 'invalid_settings';
  end if;

  v_local := p_now at time zone p_tz; -- checked against pg_timezone_names when the window was switched on
  v_day := extract(isodow from v_local)::int;
  v_yday := case when v_day = 1 then 7 else v_day - 1 end;
  v_min := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
  v_s := substr(v_start, 1, 2)::int * 60 + substr(v_start, 4, 2)::int;
  v_e := substr(v_end, 1, 2)::int * 60 + substr(v_end, 4, 2)::int;
  v_today := v_days @> to_jsonb(v_day);
  v_prev := v_days @> to_jsonb(v_yday);

  if v_s = v_e then
    return case when v_today then 'inside' else 'day_not_allowed' end;
  end if;
  if v_s < v_e then
    if not v_today then return 'day_not_allowed'; end if;
    return case when v_min >= v_s and v_min < v_e then 'inside' else 'outside_hours' end;
  end if;
  -- overnight: belongs to the day it opens
  if v_min >= v_s then
    return case when v_today then 'inside' else 'day_not_allowed' end;
  end if;
  if v_min < v_e then
    return case when v_prev then 'inside' else 'day_not_allowed' end;
  end if;
  return case when v_today or v_prev then 'outside_hours' else 'day_not_allowed' end;
end;
$$;
revoke all on function app.finance_window_hours(jsonb, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.finance_window_hours(jsonb, text, uuid, timestamptz) to service_role;

-- The whole rule for one member (Admin and "nothing to restrict" first): financeAccessDecision() without the address.
create or replace function app.finance_window_reason(
  p_cfg jsonb, p_tz text, p_role_id uuid, p_perms jsonb, p_now timestamptz)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_perms) = 'array' and p_perms ? '*' then
    return 'admin';
  end if;
  if jsonb_typeof(p_perms) is distinct from 'array' or not exists (
       select 1 from jsonb_array_elements(p_perms) as e(v)
       where jsonb_typeof(e.v) = 'string'
         and e.v #>> '{}' <> '*'
         and split_part(e.v #>> '{}', '.', 1) in ('finance', 'accounting', '*')) then
    return 'not_in_scope';
  end if;
  return app.finance_window_hours(p_cfg, p_tz, p_role_id, p_now);
end;
$$;
revoke all on function app.finance_window_reason(jsonb, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function app.finance_window_reason(jsonb, text, uuid, jsonb, timestamptz) to service_role;

-- True when the signed-in caller may use finance/accounting keys in the org right now (days and hours only). Called
-- only after a finance or accounting grant was found, so the caller's role holds such a key. Cheap when the window is
-- off: one orgs read by primary key, no membership read.
create or replace function app.finance_window_open(p_org uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
  v_tz text;
  v_role uuid;
  v_perms jsonb;
begin
  select o.settings -> 'finance_access', o.timezone into v_cfg, v_tz
  from public.orgs o where o.id = p_org;
  -- nothing stored, or switched off ('enabled' missing reads as off, as in the app)
  if v_cfg is null or jsonb_typeof(v_cfg) = 'null'
     or (jsonb_typeof(v_cfg) = 'object' and (v_cfg -> 'enabled' is null or v_cfg -> 'enabled' = 'false'::jsonb)) then
    return true;
  end if;
  select m.role_id, r.permissions into v_role, v_perms
  from public.memberships m
  join public.roles r on r.id = m.role_id
  where m.org_id = p_org
    and m.user_id = auth.uid()
    and m.status = 'active'
  limit 1;
  if not found then
    return true; -- not a member: the permission check itself already says no
  end if;
  if v_perms ? '*' then
    return true; -- Admin is never restricted
  end if;
  return app.finance_window_hours(v_cfg, v_tz, v_role, now()) in ('off', 'not_in_scope', 'inside');
end;
$$;
revoke all on function app.finance_window_open(uuid) from public, anon;
grant execute on function app.finance_window_open(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Permission helpers. Bodies as last defined; the CASE keeps non-finance keys from touching orgs.
-- ---------------------------------------------------------------------------
-- True when the caller's role in the org grants the permission (or '*').
create or replace function app.has_perm(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ? p_perm)
    ) then false
    when p_perm not like 'finance.%' and p_perm not like 'accounting.%' then true
    else app.finance_window_open(p_org_id)
  end;
$$;

-- app.has_perm_wild — like app.has_perm (Phase 1) but honours the prefix wildcards that
-- lib/auth/can.ts already understands: '*', 'portal.*' (any portal object, read or write) and
-- 'portal.*.read' (read on any object). Phase 1's SQL has_perm matches exact keys only (OQ-47).
create or replace function app.has_perm_wild(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      cross join lateral jsonb_array_elements_text(r.permissions) as perm(key)
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (
          perm.key = '*'
          or perm.key = p_perm
          -- 'portal.*'  matches 'portal.<anything>' (one or more segments)
          or (perm.key like '%.*' and p_perm like replace(perm.key, '.*', '.%'))
          -- 'portal.*.read' matches 'portal.<one segment>.read'
          or (perm.key like '%.*.%' and p_perm ~ ('^' || replace(replace(perm.key, '.', '\.'), '*', '[^.]+') || '$'))
        )
    ) then false
    when p_perm not like 'finance.%' and p_perm not like 'accounting.%' then true
    else app.finance_window_open(p_org_id)
  end;
$$;
grant execute on function app.has_perm(uuid, text), app.has_perm_wild(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Accounting ledger read helpers. They read roles.permissions directly (not has_perm), so they get the same
--    clause: bodies as last (and only) defined, then the window. Admin passes (finance_window_open returns true for
--    '*'). A CASE keeps a caller without the keys from touching orgs.
-- ---------------------------------------------------------------------------
-- Who may read the accounting reference data (chart, entities, periods, tax codes, cost centres): anyone holding any
-- accounting key. Who may read journals and their lines: the ledger, prepare and approve keys.
create or replace function app.acc_can_view(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ?| array[
          'accounting.view', 'accounting.ledger.view', 'accounting.reports.view', 'accounting.coa.manage',
          'accounting.journals.prepare', 'accounting.journals.approve', 'accounting.sales.manage',
          'accounting.receipts.manage', 'accounting.banking.manage', 'accounting.assets.manage', 'accounting.budgets.manage',
          'accounting.periods.manage', 'accounting.tax.manage', 'accounting.settings.manage', 'accounting.import'])
    ) then false
    else app.finance_window_open(p_org_id)
  end;
$$;

create or replace function app.acc_can_read_journals(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ?| array[
          'accounting.ledger.view', 'accounting.journals.prepare', 'accounting.journals.approve'])
    ) then false
    else app.finance_window_open(p_org_id)
  end;
$$;

-- Who reads receivables.
create or replace function app.acc_can_read_receivables(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ?| array[
          'accounting.sales.manage', 'accounting.receipts.manage', 'accounting.ledger.view', 'accounting.reports.view',
          'accounting.journals.approve'])
    ) then false
    else app.finance_window_open(p_org_id)
  end;
$$;

-- Who reads the banking registers: the people who keep them, and those who read the ledger or post journals.
create or replace function app.acc_can_read_banking(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ?| array[
          'accounting.banking.manage', 'accounting.ledger.view', 'accounting.journals.approve'])
    ) then false
    else app.finance_window_open(p_org_id)
  end;
$$;

-- Who may read budgets: the reports, budgets and approve keys.
create or replace function app.acc_can_read_budgets(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1
      from public.memberships m
      join public.roles r on r.id = m.role_id
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and (r.permissions ? '*' or r.permissions ?| array[
          'accounting.reports.view', 'accounting.budgets.manage', 'accounting.journals.approve'])
    ) then false
    else app.finance_window_open(p_org_id)
  end;
$$;
revoke all on function app.acc_can_view(uuid), app.acc_can_read_journals(uuid), app.acc_can_read_receivables(uuid),
  app.acc_can_read_banking(uuid), app.acc_can_read_budgets(uuid) from public, anon;
grant execute on function app.acc_can_view(uuid), app.acc_can_read_journals(uuid), app.acc_can_read_receivables(uuid),
  app.acc_can_read_banking(uuid), app.acc_can_read_budgets(uuid) to authenticated, service_role;
