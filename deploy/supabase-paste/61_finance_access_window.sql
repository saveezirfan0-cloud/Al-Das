-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Finance access window: the 'finance_access_denied' alert kind, app.finance_window_reason / app.finance_window_open,
-- and app.has_perm / app.has_perm_wild that grant finance.* and accounting.* keys only inside the window's days and
-- hours. Needs every earlier file first, up to and including 60. The window is off until an administrator turns it on
-- under Settings, Security; while it is off nothing changes.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261121000100_finance_access_window.sql
-- ======================================================================
-- Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md).
-- The setting lives in orgs.settings->'finance_access' (no new table). This migration:
--   1. lets security_alerts hold the alert kind raised when the window refuses a finance or accounting request;
--   2. adds app.finance_window_reason (pure rule, parity-tested against lib/security/finance-access.ts) and
--      app.finance_window_open (the caller's window in one org, now());
--   3. redefines app.has_perm and app.has_perm_wild (from their last definitions, 20261008000200_tenancy.sql and
--      20261009000900_rls_helpers.sql, unchanged otherwise) so a finance.* or accounting.* key is granted only while
--      the window is open. RLS, Realtime and direct REST calls with a member's token therefore follow the DAYS AND
--      HOURS too. The IP allow-list cannot be checked here (server reads arrive from Vercel, not the person), so it
--      applies to Pulse's own pages, actions and API routes only.

-- ---------------------------------------------------------------------------
-- 1. Alert kind
-- ---------------------------------------------------------------------------
alter table public.security_alerts drop constraint if exists security_alerts_kind_check;
alter table public.security_alerts add constraint security_alerts_kind_check
  check (kind in ('bulk_export', 'off_hours_access', 'failed_logins', 'role_change', 'bulk_api_read',
                  'finance_access_denied'));

-- ---------------------------------------------------------------------------
-- 2. The rule. Returns the same reason words as financeAccessDecision() in lib/security/finance-access.ts:
--    allowed: 'admin', 'off', 'not_in_scope', 'inside'; refused: 'invalid_settings', 'day_not_allowed',
--    'outside_hours'. The address list is validated (a malformed stored value fails closed, as in the app) but never
--    evaluated. Validation mirrors financeAccessSchema; addresses are checked with Postgres inet syntax.
-- ---------------------------------------------------------------------------
create or replace function app.finance_window_reason(
  p_cfg jsonb, p_tz text, p_role_id uuid, p_perms jsonb, p_now timestamptz)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_enabled boolean := false;
  v_limit boolean := true;
  v_days int[] := array[1, 2, 3, 4, 5, 6];
  v_start text := '07:00';
  v_end text := '21:00';
  v_ips int := 0;
  v_scope text := 'finance_roles';
  v_roles text[] := '{}';
  v_el jsonb;
  v_txt text;
  v_net inet;
  v_local timestamp;
  v_day int;
  v_min int;
  v_s int;
  v_e int;
  v_today boolean;
  v_yday boolean;
  c_hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  c_uuid constant text :=
    '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
begin
  -- Admin is never restricted.
  if jsonb_typeof(p_perms) = 'array' and p_perms ? '*' then
    return 'admin';
  end if;
  -- Nothing to restrict: no finance., accounting. or wildcard-area key.
  if jsonb_typeof(p_perms) is distinct from 'array' or not exists (
       select 1 from jsonb_array_elements(p_perms) as e(v)
       where jsonb_typeof(e.v) = 'string'
         and e.v #>> '{}' <> '*'
         and split_part(e.v #>> '{}', '.', 1) in ('finance', 'accounting', '*')) then
    return 'not_in_scope';
  end if;
  -- Nothing stored, or plainly switched off (honoured before full validation).
  if p_cfg is null or jsonb_typeof(p_cfg) = 'null' then
    return 'off';
  end if;
  if jsonb_typeof(p_cfg) = 'object' and p_cfg -> 'enabled' = 'false'::jsonb then
    return 'off';
  end if;
  if jsonb_typeof(p_cfg) <> 'object' then
    return 'invalid_settings';
  end if;

  -- Validation (a present key must have the right shape; absent keys take the defaults).
  if p_cfg ? 'enabled' then
    if jsonb_typeof(p_cfg -> 'enabled') <> 'boolean' then return 'invalid_settings'; end if;
    v_enabled := (p_cfg ->> 'enabled')::boolean;
  end if;
  if p_cfg ? 'limit_hours' then
    if jsonb_typeof(p_cfg -> 'limit_hours') <> 'boolean' then return 'invalid_settings'; end if;
    v_limit := (p_cfg ->> 'limit_hours')::boolean;
  end if;
  if p_cfg ? 'days' then
    if jsonb_typeof(p_cfg -> 'days') <> 'array' or jsonb_array_length(p_cfg -> 'days') > 7 then
      return 'invalid_settings';
    end if;
    v_days := '{}';
    for v_el in select value from jsonb_array_elements(p_cfg -> 'days') loop
      if jsonb_typeof(v_el) <> 'number'
         or (v_el #>> '{}')::numeric <> trunc((v_el #>> '{}')::numeric)
         or (v_el #>> '{}')::numeric not between 1 and 7 then
        return 'invalid_settings';
      end if;
      v_days := array_append(v_days, (v_el #>> '{}')::numeric::int);
    end loop;
  end if;
  if p_cfg ? 'start' then
    if jsonb_typeof(p_cfg -> 'start') <> 'string' or (p_cfg ->> 'start') !~ c_hhmm then return 'invalid_settings'; end if;
    v_start := p_cfg ->> 'start';
  end if;
  if p_cfg ? 'end' then
    if jsonb_typeof(p_cfg -> 'end') <> 'string' or (p_cfg ->> 'end') !~ c_hhmm then return 'invalid_settings'; end if;
    v_end := p_cfg ->> 'end';
  end if;
  if p_cfg ? 'ip_allowlist' then
    if jsonb_typeof(p_cfg -> 'ip_allowlist') <> 'array' or jsonb_array_length(p_cfg -> 'ip_allowlist') > 50 then
      return 'invalid_settings';
    end if;
    for v_el in select value from jsonb_array_elements(p_cfg -> 'ip_allowlist') loop
      if jsonb_typeof(v_el) <> 'string' or char_length(v_el #>> '{}') > 64 then return 'invalid_settings'; end if;
      v_txt := btrim(v_el #>> '{}');
      continue when v_txt = '';
      begin
        v_net := v_txt::inet;
      exception when others then
        return 'invalid_settings';
      end;
      if masklen(v_net) = 0 then return 'invalid_settings'; end if;
      v_ips := v_ips + 1;
    end loop;
  end if;
  if p_cfg ? 'scope' then
    if jsonb_typeof(p_cfg -> 'scope') <> 'string' or (p_cfg ->> 'scope') not in ('finance_roles', 'selected_roles') then
      return 'invalid_settings';
    end if;
    v_scope := p_cfg ->> 'scope';
  end if;
  if p_cfg ? 'role_ids' then
    if jsonb_typeof(p_cfg -> 'role_ids') <> 'array' or jsonb_array_length(p_cfg -> 'role_ids') > 200 then
      return 'invalid_settings';
    end if;
    for v_el in select value from jsonb_array_elements(p_cfg -> 'role_ids') loop
      if jsonb_typeof(v_el) <> 'string' or (v_el #>> '{}') !~ c_uuid then return 'invalid_settings'; end if;
      v_roles := array_append(v_roles, v_el #>> '{}');
    end loop;
  end if;

  if not v_enabled then
    return 'off';
  end if;
  -- Completeness rules for a window that is switched on.
  if v_limit and cardinality(v_days) = 0 then return 'invalid_settings'; end if;
  if not v_limit and v_ips = 0 then return 'invalid_settings'; end if;
  if v_scope = 'selected_roles' and cardinality(v_roles) = 0 then return 'invalid_settings'; end if;

  if v_scope = 'selected_roles' and not (p_role_id::text = any (v_roles)) then
    return 'not_in_scope';
  end if;
  if not v_limit then
    return 'inside'; -- address list only: not enforceable here
  end if;

  begin
    v_local := p_now at time zone p_tz;
  exception when others then
    return 'invalid_settings';
  end;
  if v_local is null then return 'invalid_settings'; end if;
  v_day := extract(isodow from v_local)::int;
  v_min := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
  v_s := split_part(v_start, ':', 1)::int * 60 + split_part(v_start, ':', 2)::int;
  v_e := split_part(v_end, ':', 1)::int * 60 + split_part(v_end, ':', 2)::int;
  v_today := v_day = any (v_days);
  v_yday := (case when v_day = 1 then 7 else v_day - 1 end) = any (v_days);

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
    return case when v_yday then 'inside' else 'day_not_allowed' end;
  end if;
  return case when v_today or v_yday then 'outside_hours' else 'day_not_allowed' end;
end;
$$;
revoke all on function app.finance_window_reason(jsonb, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function app.finance_window_reason(jsonb, text, uuid, jsonb, timestamptz) to service_role;

-- True when the signed-in caller may use finance/accounting keys in the org right now (days and hours only).
-- Cheap when the window is off: one orgs read, no membership read.
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
  if v_cfg is null or jsonb_typeof(v_cfg) = 'null'
     or (jsonb_typeof(v_cfg) = 'object' and v_cfg -> 'enabled' = 'false'::jsonb) then
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
  return app.finance_window_reason(v_cfg, v_tz, v_role, v_perms, now())
         in ('admin', 'off', 'not_in_scope', 'inside');
end;
$$;
revoke all on function app.finance_window_open(uuid) from public, anon;
grant execute on function app.finance_window_open(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Permission helpers. Bodies as last defined; the CASE keeps non-finance keys from touching orgs.
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

insert into supabase_migrations.schema_migrations (version, name) values ('20261121000100', 'finance_access_window') on conflict (version) do nothing;
