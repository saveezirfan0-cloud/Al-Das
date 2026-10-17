-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 97_finance_parallel_run.sql.

-- W7 (clinic plan of 16 Oct 2026): the Tally bridge serves SEVERAL Tally companies, one per accounting entity.
--
-- Before this, the bridge knew one Tally company (the integration's "company" setting) and one entity (the default one):
-- every pushed item went to that company whatever entity it belonged to, the pulls always posted into the default
-- entity, there was one AlterID cursor per organisation and one open export job per kind. With a second Tally company
-- that would have mixed two companies' books. Now:
--
--   * acc_entities.tally_company: the entity's Tally company (unique per organisation). The DEFAULT entity without one
--     falls back to the integration's company setting, so a single-company installation behaves exactly as before.
--     An entity with no company is not bridged: its items wait (held, "no_tally_company"), nothing is sent to another
--     company. A name two entities would share resolves to no company at all (fail closed).
--   * acc_tally_push.entity_id / acc_tally_jobs.entity_id: every voucher and every export belongs to one entity, and
--     the company is worked out from it when the connector claims the job (app.acc_tally_company), never copied.
--   * acc_tally_cursors.entity_id: the AlterID cursors (masters, vouchers) are per entity, i.e. per Tally company
--     (AlterIDs are counted inside one company). The scan position of the Pulse sources ('sources') stays per
--     organisation (entity_id null).
--   * The ledger start is read per entity: pushing stops for an entity on its own day.
--   * An entity's Tally company cannot be changed once the bridge has exchanged anything for it (cursors, vouchers sent
--     or in Tally, mirrored journals): the cursors and REMOTEIDs belong to that company.
--
-- Redefined from their LAST definitions (20261109000700): acc_tally_push_stop, acc_tally_enqueue_push,
-- acc_tally_raise_reversal, acc_tally_bridge_push_apply, _retry, _tick, _claim, _job, _pull_finish, _record_tb; and
-- acc_tally_reconcile is patched in place (an import's own entity). acc_tally_bridge_candidates / _capture
-- (20261109001000) and acc_post_from_source are NOT touched.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.acc_entities add column tally_company text
  check (tally_company is null or char_length(btrim(tally_company)) between 1 and 120);
create unique index acc_entities_tally_company_uidx on public.acc_entities (org_id, lower(btrim(tally_company)))
  where tally_company is not null;

alter table public.acc_tally_push add column entity_id uuid references public.acc_entities (id);
alter table public.acc_tally_jobs add column entity_id uuid references public.acc_entities (id);
alter table public.acc_tally_cursors add column entity_id uuid references public.acc_entities (id);

update public.acc_tally_push x set entity_id = e.id
  from public.acc_entities e where e.org_id = x.org_id and e.is_default;
update public.acc_tally_jobs x set entity_id = e.id
  from public.acc_entities e where e.org_id = x.org_id and e.is_default;
update public.acc_tally_cursors x set entity_id = e.id
  from public.acc_entities e where e.org_id = x.org_id and e.is_default and x.cursor in ('masters', 'vouchers');
alter table public.acc_tally_push alter column entity_id set not null;
alter table public.acc_tally_jobs alter column entity_id set not null;

-- the cursor table keeps a primary key; 'sources' is the organisation's scan position (no entity)
alter table public.acc_tally_cursors drop constraint acc_tally_cursors_pkey;
alter table public.acc_tally_cursors add column id uuid not null default gen_random_uuid();
alter table public.acc_tally_cursors add primary key (id);
alter table public.acc_tally_cursors add check ((cursor = 'sources') = (entity_id is null));
create unique index acc_tally_cursors_org_uidx on public.acc_tally_cursors (org_id, cursor) where entity_id is null;
create unique index acc_tally_cursors_entity_uidx on public.acc_tally_cursors (org_id, entity_id, cursor) where entity_id is not null;

-- one open export per entity and kind (it was one per organisation and kind)
drop index public.acc_tally_jobs_export_open_uidx;
create unique index acc_tally_jobs_export_open_uidx on public.acc_tally_jobs (org_id, entity_id, kind)
  where status in ('queued', 'sent') and kind <> 'import_voucher';
create index acc_tally_push_entity_idx on public.acc_tally_push (org_id, entity_id, status);

create trigger acc_tally_push_entity_org_check before insert or update on public.acc_tally_push
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_tally_jobs_entity_org_check before insert or update on public.acc_tally_jobs
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_tally_cursors_entity_org_check before insert or update on public.acc_tally_cursors
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

-- ---------------------------------------------------------------------------
-- 2. The Tally company of an entity, and why an entity cannot be pushed to now
-- ---------------------------------------------------------------------------
-- The entity's own company; else, for the DEFAULT entity, the integration's company setting. Null when there is none,
-- when the entity is inactive, or when another active entity resolves to the same name (case-insensitive): two entities
-- must never feed one company.
create or replace function app.acc_tally_company(p_org_id uuid, p_entity_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with fallback as (
    select nullif(btrim(a.config ->> 'company'), '') as name
      from public.integration_accounts a where a.org_id = p_org_id and a.kind = 'tally_bridge' limit 1
  ), r as (
    select e.id, coalesce(nullif(btrim(e.tally_company), ''), case when e.is_default then (select f.name from fallback f) end) as name
      from public.acc_entities e where e.org_id = p_org_id and e.active
  )
  select x.name from r x
   where x.id = p_entity_id and x.name is not null
     and not exists (select 1 from r y where y.id <> x.id and lower(y.name) = lower(x.name));
$$;
revoke all on function app.acc_tally_company(uuid, uuid) from public, anon, authenticated;

-- Why nothing may be pushed for this entity now (null: it may): no Tally company, or its ledger start has come.
create or replace function app.acc_tally_entity_stop(p_org_id uuid, p_entity_id uuid, p_today date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
begin
  if app.acc_tally_company(p_org_id, p_entity_id) is null then
    return 'no_tally_company';
  end if;
  select e.ledger_start_date into v_start from public.acc_entities e where e.id = p_entity_id and e.org_id = p_org_id;
  if v_start is not null and coalesce(p_today, current_date) >= v_start then
    return 'ledger_started';
  end if;
  return null;
end;
$$;
revoke all on function app.acc_tally_entity_stop(uuid, uuid, date) from public, anon, authenticated;

-- Why nothing may be pushed for the whole organisation (null: pushing is allowed for at least one entity). The switch,
-- the push setting, the first date and a training workspace stop everything; after that it stops when no entity is left
-- to send for (every bridged entity has reached its ledger start, or none has a Tally company).
create or replace function app.acc_tally_push_stop(p_org_id uuid, p_today date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
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
  if not exists (select 1 from public.acc_entities e
                  where e.org_id = p_org_id and e.active and app.acc_tally_entity_stop(p_org_id, e.id, p_today) is null) then
    return case when exists (select 1 from public.acc_entities e
                              where e.org_id = p_org_id and e.active and app.acc_tally_company(p_org_id, e.id) is not null)
                then 'ledger_started' else 'no_tally_company' end;
  end if;
  return null;
end;
$$;
revoke all on function app.acc_tally_push_stop(uuid, date) from public, anon, authenticated;

-- A bridged entity's Tally company is not changed once the bridge has exchanged anything for it (its AlterID cursors,
-- vouchers sent or in Tally, journals mirrored from it belong to that company). A change that leaves the company the
-- entity resolves to as it is (the default entity naming the integration's company, or going back to it) is allowed.
create or replace function app.acc_entities_tally_company_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now text;
  v_new text;
begin
  if new.tally_company is not distinct from old.tally_company then
    return new;
  end if;
  v_now := app.acc_tally_company(old.org_id, old.id);
  v_new := coalesce(nullif(btrim(new.tally_company), ''),
                    case when old.is_default then
                      (select nullif(btrim(a.config ->> 'company'), '') from public.integration_accounts a
                        where a.org_id = old.org_id and a.kind = 'tally_bridge' limit 1) end);
  if v_now is not null and v_new is not null and lower(v_new) = lower(v_now) then
    return new;
  end if;
  if exists (select 1 from public.acc_tally_cursors c where c.entity_id = old.id)
     or exists (select 1 from public.acc_tally_push p where p.entity_id = old.id and p.status in ('sent', 'done', 'unknown'))
     or exists (select 1 from public.acc_journals j where j.entity_id = old.id and j.source_kind = 'tally_import') then
    raise exception 'The bridge has already exchanged data for this entity with its Tally company; that company cannot be changed.'
      using errcode = 'check_violation', hint = 'tally_company_in_use';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_entities_tally_company_guard() from public, anon, authenticated;
create trigger acc_entities_tally_company_guard before update of tally_company on public.acc_entities
  for each row execute function app.acc_entities_tally_company_guard();

-- ---------------------------------------------------------------------------
-- 3. Helpers that create rows: the entity travels with the voucher and its jobs
-- ---------------------------------------------------------------------------
create or replace function app.acc_tally_enqueue_push(p_push_id uuid, p_check_first boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.acc_tally_jobs (org_id, entity_id, kind, push_id, check_first)
  select p.org_id, p.entity_id, 'import_voucher', p.id, p_check_first from public.acc_tally_push p where p.id = p_push_id
  on conflict (push_id) where status in ('queued', 'sent') do nothing;
$$;
revoke all on function app.acc_tally_enqueue_push(uuid, boolean) from public, anon, authenticated;

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
  insert into public.acc_tally_push (org_id, entity_id, source_kind, source_id, version, role, remote_id, voucher_date, voucher_type,
                                     amount, journal_sha256, content, status, reverses_id)
  values (p.org_id, p.entity_id, p.source_kind, p.source_id, p.version, 'reversal', p.remote_id || '-r', p.voucher_date,
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

-- ---------------------------------------------------------------------------
-- 4. Pushing: each item belongs to an entity (items without one belong to the default entity, as the 22D builders'
--    journals always have)
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_push_apply(p_org_id uuid, p_items jsonb, p_today date, p_cursor jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_default uuid;
  v_entity uuid;
  v_estop text;
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
  select e.id into v_default from public.acc_entities e where e.org_id = p_org_id and e.is_default;

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
    -- the item's entity: its own, else the one its earlier voucher belongs to, else the default one; it must be one of
    -- this organisation's
    v_entity := case when coalesce(it ->> 'entity_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (it ->> 'entity_id')::uuid
                     when nullif(it ->> 'entity_id', '') is null then coalesce(cur.entity_id, v_default) end;
    select e.ledger_start_date into v_start from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id;
    if not found then
      v_counts := app.acc_tally_bump(v_counts, 'invalid');
      continue;
    end if;
    v_estop := app.acc_tally_entity_stop(p_org_id, v_entity, p_today);
    if v_estop = 'ledger_started' then
      -- this entity is the book of record in Pulse from its ledger start: nothing of it is sent any more
      v_counts := app.acc_tally_bump(v_counts, 'entity_stopped');
      continue;
    end if;
    if v_estop = 'no_tally_company' and v_action = 'push' then
      -- nothing is ever sent to a company this entity does not have: the item waits
      it := it || jsonb_build_object('action', 'hold', 'reason', 'no_tally_company', 'detail', 'The entity has no Tally company.');
      v_action := 'hold';
    end if;
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
      insert into public.acc_tally_push (org_id, entity_id, source_kind, source_id, version, remote_id, voucher_date, voucher_type, amount,
                                         journal_sha256, content, status, reason, detail)
      values (p_org_id, v_entity, v_kind, it ->> 'id', 1, v_base || '-1', v_date, it ->> 'voucher_type',
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
      insert into public.acc_tally_push (org_id, entity_id, source_kind, source_id, version, remote_id, voucher_date, voucher_type, amount,
                                         journal_sha256, content, status, reason, detail)
      values (p_org_id, cur.entity_id, v_kind, it ->> 'id', cur.version + 1, v_base || '-' || (cur.version + 1)::text, v_date,
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
    on conflict (org_id, cursor) where entity_id is null do update set stamp = excluded.stamp, stamp_key = excluded.stamp_key, updated_at = now();
  end if;
  return v_counts;
end;
$$;
revoke all on function public.acc_tally_bridge_push_apply(uuid, jsonb, date, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_push_apply(uuid, jsonb, date, jsonb) to service_role;

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
  v_stop := coalesce(app.acc_tally_push_stop(p_org_id, p_today), app.acc_tally_entity_stop(p_org_id, p.entity_id, p_today));
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
-- 5. The scheduler's tick: the pulls are queued per bridged entity (an entity with a Tally company). The first cursor of
--    the DEFAULT entity is where the 22I file import got to; any other entity starts from the beginning of its company.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_tick(p_org_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  e record;
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
  -- an entity that lost its Tally company asks Tally for nothing
  update public.acc_tally_jobs set status = 'cancelled', error_code = 'no_tally_company', done_at = now()
   where org_id = p_org_id and status = 'queued' and kind <> 'import_voucher'
     and app.acc_tally_company(p_org_id, entity_id) is null;

  for e in select x.id, x.is_default from public.acc_entities x
            where x.org_id = p_org_id and x.active and app.acc_tally_company(p_org_id, x.id) is not null
            order by x.is_default desc, x.created_at, x.id loop
    v_masters := coalesce((select c.alter_id from public.acc_tally_cursors c
                            where c.org_id = p_org_id and c.entity_id = e.id and c.cursor = 'masters'),
                          case when e.is_default then (select max(a.tally_alter_id) from public.acc_accounts a where a.org_id = p_org_id) end,
                          0);
    v_vouchers := coalesce((select c.alter_id from public.acc_tally_cursors c
                             where c.org_id = p_org_id and c.entity_id = e.id and c.cursor = 'vouchers'),
                           (select max(j.source_version) from public.acc_journals j
                             where j.org_id = p_org_id and j.entity_id = e.id and j.source_kind = 'tally_import'),
                           0);
    v_from := coalesce((select min(j.journal_date) from public.acc_journals j
                         where j.org_id = p_org_id and j.entity_id = e.id and j.source_kind = 'tally_import'),
                       p_today - 730);
    if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.entity_id = e.id
                   and j.kind = 'export_masters_since' and j.status in ('queued', 'sent')) then
      insert into public.acc_tally_jobs (org_id, entity_id, kind, params)
      values (p_org_id, e.id, 'export_masters_since', jsonb_build_object('since_alter_id', v_masters));
      v_counts := app.acc_tally_bump(v_counts, 'masters');
    end if;
    if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.entity_id = e.id
                   and j.kind = 'export_vouchers_since' and j.status in ('queued', 'sent'))
       and not exists (select 1 from public.acc_tally_imports i where i.org_id = p_org_id and i.entity_id = e.id and i.source = 'bridge'
                       and i.status in ('staged', 'committing')) then
      insert into public.acc_tally_jobs (org_id, entity_id, kind, params)
      values (p_org_id, e.id, 'export_vouchers_since',
              jsonb_build_object('since_alter_id', v_vouchers, 'from', v_from, 'to', p_today + 366));
      v_counts := app.acc_tally_bump(v_counts, 'vouchers');
    end if;
    if not exists (select 1 from public.acc_tally_jobs j where j.org_id = p_org_id and j.entity_id = e.id
                   and j.kind = 'export_trial_balance' and j.params ->> 'as_at' = (p_today - 1)::text
                   and j.status in ('queued', 'sent', 'done')) then
      insert into public.acc_tally_jobs (org_id, entity_id, kind, params)
      values (p_org_id, e.id, 'export_trial_balance', jsonb_build_object('as_at', p_today - 1))
      on conflict do nothing;
      v_counts := app.acc_tally_bump(v_counts, 'trial_balance');
    end if;
  end loop;
  return v_counts || jsonb_build_object('pull', true);
end;
$$;
revoke all on function public.acc_tally_bridge_tick(uuid, date) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_tick(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The connector's side: each job is handed out with its entity and the Tally company worked out NOW from the entity
--    (a job whose entity has no company is not handed out), so one connector can serve several companies.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_bridge_claim(p_org_id uuid, p_device_id uuid, p_limit integer, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.acc_tally_bridge_settings;
  v_stop text;
  v_jstop text;
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

  -- pushing is stopped for the whole organisation (v_stop) or for one entity (no company, or its ledger start)
  v_stop := app.acc_tally_push_stop(p_org_id, p_today);
  update public.acc_tally_push x
     set status = 'held', reason = coalesce(v_stop, app.acc_tally_entity_stop(p_org_id, x.entity_id, p_today)), detail = null
   where x.org_id = p_org_id and x.status = 'ready'
     and coalesce(v_stop, app.acc_tally_entity_stop(p_org_id, x.entity_id, p_today)) is not null
     and exists (select 1 from public.acc_tally_jobs q where q.push_id = x.id and q.status = 'queued' and not q.check_first);
  update public.acc_tally_jobs q
     set status = 'cancelled', error_code = coalesce(v_stop, app.acc_tally_entity_stop(p_org_id, q.entity_id, p_today)), done_at = now()
   where q.org_id = p_org_id and q.kind = 'import_voucher' and q.status = 'queued' and not q.check_first
     and coalesce(v_stop, app.acc_tally_entity_stop(p_org_id, q.entity_id, p_today)) is not null;
  if s.org_id is null or not s.pull_enabled then
    update public.acc_tally_jobs set status = 'cancelled', error_code = 'pull_off', done_at = now()
     where org_id = p_org_id and status = 'queued' and kind <> 'import_voucher';
  end if;
  update public.acc_tally_jobs set status = 'cancelled', error_code = 'no_tally_company', done_at = now()
   where org_id = p_org_id and status = 'queued' and kind <> 'import_voucher'
     and app.acc_tally_company(p_org_id, entity_id) is null;

  for j in select * from public.acc_tally_jobs
            where org_id = p_org_id and status = 'queued'
              and app.acc_tally_company(p_org_id, entity_id) is not null
              -- a look-up after an unanswered import is still allowed while pushing is stopped (it settles what Tally holds)
              and (kind <> 'import_voucher' or check_first
                   or (v_stop is null and app.acc_tally_entity_stop(p_org_id, entity_id, p_today) is null))
            order by seq limit least(greatest(coalesce(p_limit, 5), 1), 10) for update skip locked loop
    v_jstop := coalesce(v_stop, app.acc_tally_entity_stop(p_org_id, j.entity_id, p_today));
    update public.acc_tally_jobs set status = 'sent', attempts = attempts + 1, sent_at = now(), device_id = p_device_id
     where id = j.id;
    p := null;
    if j.push_id is not null then
      update public.acc_tally_push set status = 'sent', attempts = attempts + 1 where id = j.push_id returning * into p;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', j.id, 'kind', j.kind, 'params', j.params, 'check_first', j.check_first,
      'entity_id', j.entity_id, 'company', app.acc_tally_company(p_org_id, j.entity_id),
      -- while pushing is stopped an unanswered import is only looked up, never sent again
      'lookup_only', j.kind = 'import_voucher' and v_jstop is not null,
      'push', case when p.id is not null then jsonb_build_object(
        'id', p.id, 'remote_id', p.remote_id, 'date', p.voucher_date, 'voucher_type', p.voucher_type,
        'role', p.role, 'content', p.content) end));
  end loop;
  return jsonb_build_object('jobs', v_out, 'cost_category', coalesce(s.cost_category, 'Primary Cost Category'));
end;
$$;
revoke all on function public.acc_tally_bridge_claim(uuid, uuid, integer, date) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_claim(uuid, uuid, integer, date) to service_role;

create or replace function public.acc_tally_bridge_job(p_org_id uuid, p_device_id uuid, p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', j.id, 'kind', j.kind, 'params', j.params, 'push_id', j.push_id, 'check_first', j.check_first,
                            'remote_id', p.remote_id, 'attempts', j.attempts, 'entity_id', j.entity_id)
  from public.acc_tally_jobs j left join public.acc_tally_push p on p.id = j.push_id
  where j.id = p_job_id and j.org_id = p_org_id and j.device_id = p_device_id and j.status = 'sent';
$$;
revoke all on function public.acc_tally_bridge_job(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_bridge_job(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. A pull finishes against the job's entity: its cursor moves, nobody else's
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
  v_entity uuid;
  v_counts jsonb := '{}'::jsonb;
  v_linked integer := 0;
begin
  if p_cursor is null or p_cursor not in ('masters', 'vouchers') then
    raise exception 'Invalid cursor.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  perform app.acc_tally_bridge_lock(p_org_id);
  select j.entity_id into v_entity from public.acc_tally_jobs j where j.id = p_job_id and j.org_id = p_org_id;
  if p_import_id is not null then
    select * into imp from public.acc_tally_imports where id = p_import_id and org_id = p_org_id and source = 'bridge' for update;
    if not found then
      raise exception 'Import not found.' using errcode = 'check_violation', hint = 'not_found';
    end if;
    v_entity := coalesce(v_entity, imp.entity_id);
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
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
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
    insert into public.acc_tally_cursors (org_id, entity_id, cursor, alter_id, updated_at)
    values (p_org_id, v_entity, p_cursor, p_alter_id, now())
    on conflict (org_id, entity_id, cursor) where entity_id is not null do update
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

-- The daily drift check is run for the job's entity (it used to be the default entity whatever the job was for).
create or replace function public.acc_tally_bridge_record_tb(p_org_id uuid, p_job_id uuid, p_as_at date, p_sha256 text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_entity uuid;
begin
  select j.entity_id into v_entity from public.acc_tally_jobs j where j.id = p_job_id and j.org_id = p_org_id;
  perform set_config('app.acc_tally_bridge', 'on', true);
  v := public.acc_tally_reconcile(p_org_id, v_entity, null, null, p_as_at, p_sha256, p_rows);
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
-- 8. 22I's reconciliation of an import compares the import's OWN entity (it used the default entity when none was
--    given). Patched in place, as 20261109000700 patched it, so the rest of the function is kept.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.acc_tally_reconcile(uuid, uuid, uuid, uuid, date, text, jsonb)'::regprocedure);
  if position('i.entity_id' in v_def) = 0 then
    v_new := replace(v_def,
      $old$  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;$old$,
      $new$  if v_entity is null and p_import_id is not null then
    select i.entity_id into v_entity from public.acc_tally_imports i where i.id = p_import_id and i.org_id = p_org_id;
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;$new$);
    if v_new = v_def then
      raise exception 'acc_tally_reconcile: the default entity lookup was not found';
    end if;
    execute v_new;
  end if;
end;
$$;
