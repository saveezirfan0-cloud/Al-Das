-- The Tally bridge's direct HTTPS connection (docs/44_TALLY_DIRECT_CONNECTION.md).
--
-- Phase 22J's connector runs on the Tally PC. When Tally is hosted (a partner's cloud server or TallyPrime Server behind
-- a gateway) the partner gives an https address and credentials instead; they are stored in the tally_bridge integration
-- (provider "https", the secret encrypted in integration_accounts.config_enc) and Pulse runs the same four allow-listed
-- jobs itself from the accounting_tally_bridge task. To reuse the bridge's whole job protocol unchanged (claim, the
-- ten-minute no-answer rule, look-up before a resend, results), Pulse acts as a device of its own: a row in
-- acc_tally_devices with transport 'direct' whose token nobody holds.
--
-- One device per organisation stays the rule: taking the direct connection revokes an active connector (and its
-- unanswered jobs are asked again, an import only after a look-up), and pairing a connector revokes the direct device
-- (acc_tally_bridge_pair_exchange already revokes every active device). Revoking the direct device on the Tally bridge
-- page keeps it off until the integration's settings are saved again or it is switched off and on.

alter table public.acc_tally_devices
  add column transport text not null default 'connector' check (transport in ('connector', 'direct'));

-- The organisation's direct device (created on first use), with Tally's state recorded; null when an administrator
-- revoked it after the integration was last changed. Service role only: called by the accounting_tally_bridge task after
-- it checked that the integration is on with the "https" provider.
create or replace function public.acc_tally_bridge_direct_device(p_org_id uuid, p_tally_state text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_changed timestamptz;
  v_state text := case when p_tally_state in ('ok', 'unreachable', 'no_company', 'error') then p_tally_state end;
begin
  perform app.acc_tally_bridge_lock(p_org_id);
  select id into v_id from public.acc_tally_devices
   where org_id = p_org_id and transport = 'direct' and status = 'active'
   order by created_at desc limit 1;
  if v_id is not null then
    update public.acc_tally_devices
       set last_seen_at = now(), tally_state = coalesce(v_state, tally_state)
     where id = v_id;
    return v_id;
  end if;
  select a.updated_at into v_changed from public.integration_accounts a
   where a.org_id = p_org_id and a.kind = 'tally_bridge' and a.enabled;
  if v_changed is null then
    return null;
  end if;
  if exists (select 1 from public.acc_tally_devices d
              where d.org_id = p_org_id and d.transport = 'direct' and d.status = 'revoked' and d.revoked_at > v_changed) then
    return null;
  end if;
  -- one device per organisation: the connector steps aside and its unanswered jobs are asked again
  update public.acc_tally_devices set status = 'revoked', revoked_at = now()
   where org_id = p_org_id and status = 'active';
  update public.acc_tally_devices set status = 'expired', pairing_sha256 = null
   where org_id = p_org_id and status = 'pairing';
  update public.acc_tally_jobs set status = 'queued', check_first = check_first or kind = 'import_voucher', device_id = null
   where org_id = p_org_id and status = 'sent';
  insert into public.acc_tally_devices (org_id, label, status, transport, token_sha256, paired_at, last_seen_at, tally_state)
  values (p_org_id, 'Direct HTTPS connection', 'active', 'direct',
          encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
          now(), now(), v_state)
  returning id into v_id;
  perform app.acc_tally_log(p_org_id, 'pair', 'paired', null, null, 'direct', null);
  return v_id;
end;
$$;
revoke all on function public.acc_tally_bridge_direct_device(uuid, text) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_direct_device(uuid, text) to service_role;

-- A direct device's token is never presented (nobody holds it), but refuse it at the connector door all the same.
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
  select * into d from public.acc_tally_devices
   where token_sha256 = p_token_sha256 and status = 'active' and transport = 'connector';
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
