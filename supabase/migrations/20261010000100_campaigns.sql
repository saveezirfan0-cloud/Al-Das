-- Phase 7: campaigns (template broadcasts) — campaigns, recipients, funnel sync,
-- reply tracking, batched dispatch and the campaign_tick cron.
--
-- Flow: the app snapshots the audience into campaign_recipients (pending / skipped),
-- the campaign_fanout handler resolves variables and calls campaign_dispatch() in
-- batches (conversation + queued message + recipient update, one transaction), the
-- outbound queue sends, status webhooks move messages forward, and a trigger mirrors
-- each message's status onto its recipient so the funnel is always consistent.

-- Campaign sends land in a conversation but must not flood the inbox: such a
-- conversation stays hidden until the patient replies (or an agent opens it).
alter table public.conversations add column campaign_only boolean not null default false;

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  channel_id uuid not null references public.channels (id) on delete restrict,
  template_id uuid not null references public.wa_templates (id) on delete restrict,
  audience_type text not null check (audience_type in ('segment', 'csv')),
  segment_id uuid references public.segments (id) on delete set null,
  csv_opt_in_confirmed boolean not null default false,   -- creator confirmed consent for CSV rows created by this campaign
  variable_map jsonb not null default '{}'::jsonb,       -- {"body.1": "contact.first_name", "header.media": "text:https://…"}
  fallbacks jsonb not null default '{}'::jsonb,          -- {"body.1": "there"} used when the mapped value is blank
  status text not null default 'preparing' check (status in (
    'preparing', 'scheduled', 'queued', 'sending', 'paused', 'completed', 'cancelled', 'failed'
  )),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  paused_reason text,
  cancelled_at timestamptz,
  retry_rounds integer not null default 0 check (retry_rounds between 0 and 3),
  retry_delay_minutes integer not null default 60 check (retry_delay_minutes between 5 and 1440),
  retry_round integer not null default 0 check (retry_round between 0 and 3),
  next_retry_at timestamptz,
  guardrails jsonb not null default '{}'::jsonb,         -- {max_failure_pct, min_sample, pause_on_red_quality}
  guard_since timestamptz,                               -- guardrails only count outcomes after this (start / last resume)
  quality_at_start text,
  stats jsonb not null default '{}'::jsonb,              -- funnel snapshot, refreshed by the stats op
  stats_refreshed_at timestamptz,
  error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((audience_type = 'segment') or segment_id is null)
);
create index campaigns_org_created_idx on public.campaigns (org_id, created_at desc);
create index campaigns_org_status_idx on public.campaigns (org_id, status);
create index campaigns_active_idx on public.campaigns (status) where status in ('scheduled', 'queued', 'sending', 'paused');
create trigger campaigns_set_updated_at before update on public.campaigns for each row execute function app.set_updated_at();
create trigger campaigns_channel_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger campaigns_template_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('wa_templates', 'template_id');
create trigger campaigns_segment_org_check before insert or update on public.campaigns
  for each row execute function app.check_parent_org('segments', 'segment_id');

-- ---------------------------------------------------------------------------
-- campaign_recipients: the audience snapshot and the per-recipient state machine.
--   pending → queued → sent → delivered → read      failed (terminal, unless a retry round re-queues it)
--   pending → skipped (opted out, no destination, missing variable, …)
-- ---------------------------------------------------------------------------

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'pending' check (status in (
    'pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'
  )),
  skip_reason text,
  csv_data jsonb not null default '{}'::jsonb,           -- extra CSV columns, usable as csv.<column> variables
  vars jsonb not null default '{}'::jsonb,               -- resolved template values of the last dispatch
  round integer not null default 0,
  attempts integer not null default 0,
  message_id uuid references public.messages (id) on delete set null,   -- the latest message for this recipient
  wa_message_id text,
  error_code integer,
  error_message text,
  dispatched_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_recipients_status_idx on public.campaign_recipients (campaign_id, status, created_at, id);
create index campaign_recipients_contact_idx on public.campaign_recipients (contact_id, created_at desc);
create index campaign_recipients_message_idx on public.campaign_recipients (message_id) where message_id is not null;
create index campaign_recipients_dispatched_idx on public.campaign_recipients (campaign_id, dispatched_at) where dispatched_at is not null;
create trigger campaign_recipients_set_updated_at before update on public.campaign_recipients for each row execute function app.set_updated_at();
create trigger campaign_recipients_campaign_org_check before insert or update on public.campaign_recipients
  for each row execute function app.check_parent_org('campaigns', 'campaign_id');
create trigger campaign_recipients_contact_org_check before insert or update on public.campaign_recipients
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.messages
  add constraint messages_campaign_recipient_id_fkey
  foreign key (campaign_recipient_id) references public.campaign_recipients (id) on delete set null;
create index messages_campaign_recipient_idx on public.messages (campaign_recipient_id) where campaign_recipient_id is not null;

-- ---------------------------------------------------------------------------
-- Message status → recipient status (forward only, latest message only).
-- ---------------------------------------------------------------------------

create or replace function app.sync_campaign_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.campaign_recipient_id is null or new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'sent' then
    update public.campaign_recipients r
    set status = 'sent', sent_at = coalesce(r.sent_at, now()), wa_message_id = new.wa_message_id,
        error_code = null, error_message = null, failed_at = null
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued');
  elsif new.status = 'delivered' then
    update public.campaign_recipients r
    set status = 'delivered', sent_at = coalesce(r.sent_at, now()), delivered_at = coalesce(r.delivered_at, now()),
        wa_message_id = coalesce(new.wa_message_id, r.wa_message_id)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued', 'sent');
  elsif new.status = 'read' then
    update public.campaign_recipients r
    set status = 'read', sent_at = coalesce(r.sent_at, now()), delivered_at = coalesce(r.delivered_at, now()),
        read_at = coalesce(r.read_at, now()), wa_message_id = coalesce(new.wa_message_id, r.wa_message_id)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status in ('pending', 'queued', 'sent', 'delivered');
  elsif new.status = 'failed' then
    update public.campaign_recipients r
    set status = 'failed', failed_at = now(), error_code = new.error_code, error_message = left(new.error_message, 500)
    where r.id = new.campaign_recipient_id and r.message_id = new.id and r.status not in ('read', 'skipped', 'failed');
  end if;
  return new;
end;
$$;
create trigger messages_sync_campaign_recipient after update of status on public.messages
  for each row execute function app.sync_campaign_recipient();

-- A patient message within 7 days of a campaign message in the same conversation
-- counts as a reply to the most recent campaign message (reactions do not count).
create or replace function app.mark_campaign_replied()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  if new.direction <> 'in' or new.kind = 'reaction' then
    return new;
  end if;
  select m.campaign_recipient_id into v_recipient
  from public.messages m
  where m.conversation_id = new.conversation_id
    and m.direction = 'out'
    and m.campaign_recipient_id is not null
    and m.at <= new.at
    and m.at >= new.at - interval '7 days'
  order by m.at desc
  limit 1;
  if v_recipient is not null then
    update public.campaign_recipients set replied_at = new.at where id = v_recipient and replied_at is null;
  end if;
  return new;
end;
$$;
create trigger messages_mark_campaign_replied after insert on public.messages
  for each row when (new.direction = 'in') execute function app.mark_campaign_replied();

-- ---------------------------------------------------------------------------
-- Batched dispatch. One call handles up to a few hundred recipients:
-- for each still-pending recipient (row-locked, SKIP LOCKED so two workers never
-- double-dispatch) it either marks it skipped, or finds/creates the live
-- conversation, inserts the queued template message and moves the recipient to
-- 'queued'. The caller then pushes the returned message ids to the outbound queue.
--   p_items: [{recipient_id, skip?} | {recipient_id, body, spec, vars}]
-- ---------------------------------------------------------------------------

create or replace function public.campaign_dispatch(p_campaign_id uuid, p_items jsonb)
returns table (recipient_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns;
  item jsonb;
  r public.campaign_recipients;
  v_conv uuid;
  v_msg uuid;
begin
  select * into c from public.campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into r from public.campaign_recipients cr
    where cr.id = (item ->> 'recipient_id')::uuid and cr.campaign_id = p_campaign_id and cr.status = 'pending'
    for update skip locked;
    if r.id is null then
      continue;
    end if;
    if item ->> 'skip' is not null then
      update public.campaign_recipients set status = 'skipped', skip_reason = left(item ->> 'skip', 200) where id = r.id;
      continue;
    end if;

    select id into v_conv from public.conversations
    where channel_id = c.channel_id and contact_id = r.contact_id and status <> 'closed';
    if v_conv is null then
      insert into public.conversations (org_id, channel_id, contact_id, status, campaign_only, opened_at)
      values (c.org_id, c.channel_id, r.contact_id, 'waiting', true, now())
      on conflict (channel_id, contact_id) where status <> 'closed' do nothing
      returning id into v_conv;
      if v_conv is null then
        select id into v_conv from public.conversations
        where channel_id = c.channel_id and contact_id = r.contact_id and status <> 'closed';
      end if;
    end if;

    insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, campaign_recipient_id, at)
    values (c.org_id, v_conv, 'out', 'template', item ->> 'body', jsonb_build_object('send', item -> 'spec'), 'queued', r.id, now())
    returning id into v_msg;

    update public.conversations
    set last_message_at = now(), last_message_preview = left(coalesce(item ->> 'body', ''), 140), last_message_direction = 'out'
    where id = v_conv;

    update public.campaign_recipients
    set status = 'queued', vars = coalesce(item -> 'vars', '{}'::jsonb), attempts = attempts + 1,
        dispatched_at = now(), message_id = v_msg, round = c.retry_round,
        error_code = null, error_message = null, failed_at = null, skip_reason = null
    where id = r.id;

    recipient_id := r.id;
    message_id := v_msg;
    return next;
  end loop;
end;
$$;
revoke all on function public.campaign_dispatch(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.campaign_dispatch(uuid, jsonb) to service_role;

-- Re-queue failed recipients whose error code is retryable (round bump done by the caller).
create or replace function public.campaign_requeue_failed(p_campaign_id uuid, p_codes integer[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.campaign_recipients
  set status = 'pending', error_message = null
  where campaign_id = p_campaign_id and status = 'failed' and error_code = any (p_codes);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.campaign_requeue_failed(uuid, integer[]) from public, anon, authenticated;
grant execute on function public.campaign_requeue_failed(uuid, integer[]) to service_role;

-- Funnel counters. sent/delivered/read are cumulative (a read message was also delivered and sent).
create or replace function public.campaign_funnel(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*),
    'eligible', count(*) filter (where status <> 'skipped'),
    'pending', count(*) filter (where status = 'pending'),
    'queued', count(*) filter (where status = 'queued'),
    'sent', count(*) filter (where status in ('sent', 'delivered', 'read')),
    'delivered', count(*) filter (where status in ('delivered', 'read')),
    'read', count(*) filter (where status = 'read'),
    'replied', count(*) filter (where replied_at is not null),
    'failed', count(*) filter (where status = 'failed'),
    'skipped', count(*) filter (where status = 'skipped')
  )
  from public.campaign_recipients
  where campaign_id = p_campaign_id;
$$;
revoke all on function public.campaign_funnel(uuid) from public, anon, authenticated;
grant execute on function public.campaign_funnel(uuid) to service_role;

-- Batched enqueue (pgmq.send_batch) for the fanout handler.
create or replace function public.job_enqueue_batch(p_queue text, p_payloads jsonb[], p_delay integer default 0)
returns bigint[]
language sql
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x), '{}'::bigint[])
  from pgmq.send_batch(p_queue, p_payloads, greatest(coalesce(p_delay, 0), 0)) as x;
$$;
revoke all on function public.job_enqueue_batch(text, jsonb[], integer) from public, anon, authenticated;
grant execute on function public.job_enqueue_batch(text, jsonb[], integer) to service_role;

-- ---------------------------------------------------------------------------
-- Audience snapshots. Mirrors lib/campaigns/recipients.ts classifyRecipient()
-- (a DB test keeps the two in step): MARKETING templates need an explicit opt-in
-- and no stop_marketing; every audience needs a phone or a BSUID.
-- ---------------------------------------------------------------------------

create or replace function app.campaign_skip_reason(
  p_deleted_at timestamptz, p_phone text, p_bsuid text, p_opt_in boolean, p_stop boolean, p_marketing boolean
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_deleted_at is not null then 'deleted'
    when p_phone is null and p_bsuid is null then 'no_destination'
    when p_marketing and coalesce(p_stop, false) then 'stop_marketing'
    when p_marketing and p_opt_in is not true then 'no_opt_in'
    else null
  end;
$$;

-- Segment audience: p_where/p_params come from the lib/filters compiler (parameterised,
-- same contract as contacts_ids). Dry run only counts. Returns {total, eligible, skipped:{reason:n}}.
create or replace function public.campaign_snapshot_segment(
  p_org_id uuid, p_campaign_id uuid, p_where text, p_params jsonb, p_marketing boolean,
  p_limit integer, p_dry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  if not p_dry and not exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id) then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  execute format($q$
    with src as (
      select c.id,
             app.campaign_skip_reason(c.deleted_at, c.phone_e164, c.wa_bsuid, c.promotions_opt_in, c.stop_marketing, $3) as reason
      from public.contacts c
      where c.org_id = $2 and c.deleted_at is null and (%s)
      order by c.created_at, c.id
      limit $4
    ), ins as (
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, skip_reason)
      select $2, $5, id, case when reason is null then 'pending' else 'skipped' end, reason
      from src where not $6
      on conflict (campaign_id, contact_id) do nothing
      returning 1
    )
    select jsonb_build_object(
      'total', (select count(*) from src),
      'eligible', (select count(*) from src where reason is null),
      'skipped', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) as n from src where reason is not null group by reason) x), '{}'::jsonb)
    )
  $q$, p_where) into v_result
  using coalesce(p_params, '[]'::jsonb), p_org_id, p_marketing, greatest(1, p_limit), p_campaign_id, coalesce(p_dry, false);
  return v_result;
end;
$$;
revoke all on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean) from public, anon, authenticated;
grant execute on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean) to service_role;

-- CSV audience: rows are [{phone_e164, first_name, last_name, data}]. Rows are matched to existing contacts
-- by primary or alternate phone; unknown numbers become new contacts (source 'campaign_csv') only when the
-- template is not MARKETING or the creator confirmed consent (stored as promotions_opt_in). Existing contacts
-- keep their own consent record. Dry run only counts. Returns {total, eligible, created, skipped:{reason:n}}.
create or replace function public.campaign_add_csv_rows(
  p_org_id uuid, p_campaign_id uuid, p_rows jsonb, p_marketing boolean, p_confirmed boolean,
  p_user uuid, p_dry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v public.contacts;
  v_reason text;
  v_phone text;
  v_total integer := 0;
  v_eligible integer := 0;
  v_created integer := 0;
  v_skipped jsonb := '{}'::jsonb;
begin
  if not p_dry and not exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id) then
    raise exception 'campaign not found' using errcode = 'no_data_found';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_total := v_total + 1;
    v_phone := r ->> 'phone_e164';
    v := null;
    select * into v from public.contacts where org_id = p_org_id and phone_e164 = v_phone and deleted_at is null;
    if v.id is null then
      select c.* into v
      from public.contact_phones cp join public.contacts c on c.id = cp.contact_id
      where cp.org_id = p_org_id and cp.phone_e164 = v_phone and c.deleted_at is null
      limit 1;
    end if;

    if v.id is null then
      if p_marketing and not coalesce(p_confirmed, false) then
        v_skipped := jsonb_set(v_skipped, '{no_opt_in}', to_jsonb(coalesce((v_skipped ->> 'no_opt_in')::integer, 0) + 1));
        continue;
      end if;
      v_created := v_created + 1;
      v_eligible := v_eligible + 1;
      if p_dry then
        continue;
      end if;
      insert into public.contacts (org_id, first_name, last_name, phone_e164, source, promotions_opt_in, created_by)
      values (p_org_id, coalesce(r ->> 'first_name', ''), coalesce(r ->> 'last_name', ''), v_phone, 'campaign_csv', coalesce(p_confirmed, false), p_user)
      on conflict (org_id, phone_e164) where phone_e164 is not null and deleted_at is null do nothing
      returning * into v;
      if v.id is null then
        select * into v from public.contacts where org_id = p_org_id and phone_e164 = v_phone and deleted_at is null;
      end if;
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, csv_data)
      values (p_org_id, p_campaign_id, v.id, 'pending', coalesce(r -> 'data', '{}'::jsonb))
      on conflict (campaign_id, contact_id) do nothing;
      continue;
    end if;

    v_reason := app.campaign_skip_reason(v.deleted_at, v.phone_e164, v.wa_bsuid, v.promotions_opt_in, v.stop_marketing, p_marketing);
    if v_reason is null then
      v_eligible := v_eligible + 1;
    else
      v_skipped := jsonb_set(v_skipped, array[v_reason], to_jsonb(coalesce((v_skipped ->> v_reason)::integer, 0) + 1));
    end if;
    if not p_dry then
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, skip_reason, csv_data)
      values (p_org_id, p_campaign_id, v.id, case when v_reason is null then 'pending' else 'skipped' end, v_reason, coalesce(r -> 'data', '{}'::jsonb))
      on conflict (campaign_id, contact_id) do nothing;
    end if;
  end loop;
  return jsonb_build_object('total', v_total, 'eligible', v_eligible, 'created', v_created, 'skipped', v_skipped);
end;
$$;
revoke all on function public.campaign_add_csv_rows(uuid, uuid, jsonb, boolean, boolean, uuid, boolean) from public, anon, authenticated;
grant execute on function public.campaign_add_csv_rows(uuid, uuid, jsonb, boolean, boolean, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: campaigns.view reads; every write goes through server actions (service role).
-- ---------------------------------------------------------------------------

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

create policy campaigns_select on public.campaigns for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
create policy campaign_recipients_select on public.campaign_recipients for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));

-- Stats refresh, guardrails, scheduled starts and retry rounds are driven by the tick.
select cron.schedule('pulse:campaign_tick', '30 seconds', $$select app.ping_jobs('campaign_tick')$$);
