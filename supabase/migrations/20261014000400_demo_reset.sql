-- Phase 14: support for `pnpm demo:reset` (scripts/demo-reset.ts).
--
-- public.demo_wipe_org(org) deletes every row of a DEMO workspace so the script can seed it again. It refuses to
-- touch an org unless BOTH flags are set: orgs.is_training (Settings, Training mode) and settings.demo_seed = 'true'
-- (written only by the demo script). It keeps the org row, its roles and memberships (system roles cannot be
-- deleted by design), teams, invitations, and the append-only logs (audit_log, record_access_log, auth_events,
-- record_history), and everything tied to a person's own login (notification settings, push devices, sessions).
-- Service role only.
--
-- Everything else with an org_id column is emptied. Foreign keys decide the order: a table that still has children
-- is retried on the next pass. The result lists anything that could not be emptied, so a new table with an
-- unexpected delete guard is noticed instead of silently left behind.

create or replace function public.demo_wipe_org(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
  v_keep constant text[] := array[
    'orgs', 'roles', 'memberships', 'teams', 'team_members', 'invites',
    'audit_log', 'record_access_log', 'auth_events', 'record_history', 'security_alerts',
    'access_reviews', 'privacy_requests', 'user_sessions',
    'notification_preferences', 'push_subscriptions', 'notification_digest_log'
  ];
  v_tables text[];
  v_pending text[];
  v_failed jsonb := '{}'::jsonb;
  v_deleted bigint := 0;
  v_n bigint;
  v_pass int;
  t text;
begin
  select (o.is_training and coalesce(o.settings ->> 'demo_seed', '') = 'true')
    into v_ok from public.orgs o where o.id = p_org_id;
  if not coalesce(v_ok, false) then
    raise exception 'demo_wipe_org: this workspace is not a demo workspace' using errcode = '42501';
  end if;

  select array_agg(c.relname::text order by c.relname) into v_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
   where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any (v_keep));

  v_pending := v_tables;
  for v_pass in 1..8 loop
    exit when coalesce(array_length(v_pending, 1), 0) = 0;
    declare
      v_next text[] := '{}';
    begin
      foreach t in array v_pending loop
        begin
          execute format('delete from public.%I where org_id = $1', t) using p_org_id;
          get diagnostics v_n = row_count;
          v_deleted := v_deleted + v_n;
          -- A cascade can leave rows behind only when something refused; look for what is left.
          execute format('select count(*) from public.%I where org_id = $1', t) into v_n using p_org_id;
          if v_n > 0 then v_next := v_next || t; end if;
        exception when others then
          v_next := v_next || t;
          v_failed := v_failed || jsonb_build_object(t, sqlstate);
        end;
      end loop;
      v_pending := v_next;
    end;
  end loop;

  -- Only the errors of tables that are still not empty matter (a foreign-key refusal on an early pass is normal).
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_failed
    from jsonb_each(v_failed) as e (k, v) where k = any (coalesce(v_pending, '{}'));

  return jsonb_build_object('deleted', v_deleted, 'left_behind', to_jsonb(coalesce(v_pending, '{}')), 'errors', v_failed);
end;
$$;
revoke all on function public.demo_wipe_org(uuid) from public, anon, authenticated;
grant execute on function public.demo_wipe_org(uuid) to service_role;
