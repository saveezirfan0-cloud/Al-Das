-- Phase 20d (docs/26_PHASE_20D_NOTES.md): recurring campaigns and the monthly campaign message budget.
--
--   campaign_recurrences        a repeating campaign: what to send (number, template, mapping, retries, guardrails),
--                               to which segment, and when (5-field cron in a timezone). Each run creates an ORDINARY
--                               campaign (campaigns.recurrence_id + run_key), so the audience is re-evaluated, the
--                               engine, funnel, retry rounds and guardrails are the existing ones, and a run can never
--                               be created twice (unique recurrence_id + run_key; next_run_at claimed atomically).
--   campaign_budget_months      messages dispatched by campaigns per org and calendar month (org timezone). The
--                               fanout claims room here BEFORE it dispatches (campaign_budget_claim), so the limit an
--                               administrator sets (orgs.settings.campaign_budget.monthly_limit) is a hard stop.
--   media_asset_usage()         also sees carousel card headers in a template mapping and library files in an active
--                               recurring campaign's mapping (reported as kind 'campaign').
--
-- RLS: both tables are readable with campaigns.view; every write is the service role (server actions after can(),
-- the campaign jobs). No contact data in either table.

-- ---------------------------------------------------------------------------
-- Recurring campaigns
-- ---------------------------------------------------------------------------
create table public.campaign_recurrences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  channel_id uuid not null references public.channels (id) on delete restrict,
  template_id uuid not null references public.wa_templates (id) on delete restrict,
  segment_id uuid references public.segments (id) on delete set null,
  variable_map jsonb not null default '{}'::jsonb,
  fallbacks jsonb not null default '{}'::jsonb,
  retry_rounds integer not null default 0 check (retry_rounds between 0 and 3),
  retry_delay_minutes integer not null default 60 check (retry_delay_minutes between 5 and 1440),
  guardrails jsonb not null default '{}'::jsonb,
  cron text not null check (char_length(cron) between 9 and 120),
  timezone text not null check (char_length(timezone) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'paused')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_outcome text check (last_run_outcome is null or char_length(last_run_outcome) <= 80),
  last_campaign_id uuid references public.campaigns (id) on delete set null,
  runs integer not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'paused' or next_run_at is not null)
);
create index campaign_recurrences_org_idx on public.campaign_recurrences (org_id, created_at desc);
create index campaign_recurrences_due_idx on public.campaign_recurrences (next_run_at) where status = 'active';
create trigger campaign_recurrences_set_updated_at before update on public.campaign_recurrences
  for each row execute function app.set_updated_at();
create trigger campaign_recurrences_channel_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger campaign_recurrences_template_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('wa_templates', 'template_id');
create trigger campaign_recurrences_segment_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('segments', 'segment_id');

alter table public.campaign_recurrences enable row level security;
create policy campaign_recurrences_select on public.campaign_recurrences for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
-- writes: server actions (campaigns.create, service role after can()) and the campaign jobs

alter table public.campaigns
  add column if not exists recurrence_id uuid references public.campaign_recurrences (id) on delete set null,
  add column if not exists run_key text check (run_key is null or char_length(run_key) <= 40);
create unique index if not exists campaigns_recurrence_run_uidx on public.campaigns (recurrence_id, run_key)
  where recurrence_id is not null;
create index if not exists campaigns_recurrence_idx on public.campaigns (recurrence_id, created_at desc)
  where recurrence_id is not null;
comment on column public.campaigns.run_key is
  'Phase 20d: the scheduled time (UTC, minute) of the recurring run that created this campaign; one campaign per run.';

-- One run of a recurring campaign. Atomically moves next_run_at from p_run_at to p_next_run_at (only the caller that
-- still sees p_run_at wins: overlapping jobs, the tick safety net and a replayed job cannot run it twice). With a
-- skip reason the run is only recorded; otherwise a 'preparing' campaign is created for it (the caller snapshots the
-- audience and starts it). Returns the new campaign id, or null (not claimed, paused, stale time or skipped).
create or replace function public.campaign_recurrence_claim(
  p_recurrence_id uuid, p_run_at timestamptz, p_next_run_at timestamptz, p_skip_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.campaign_recurrences;
  v_id uuid;
  v_key text;
begin
  if p_next_run_at is null or p_next_run_at <= p_run_at then
    raise exception 'next run must be after this run' using errcode = 'invalid_parameter_value';
  end if;
  update public.campaign_recurrences
     set next_run_at = p_next_run_at, last_run_at = now(), runs = runs + 1,
         last_run_outcome = case when p_skip_reason is null then 'running' else left('skipped:' || p_skip_reason, 80) end
   where id = p_recurrence_id and status = 'active' and next_run_at = p_run_at
  returning * into r;
  if r.id is null or p_skip_reason is not null then
    return null;
  end if;
  v_key := to_char(p_run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"');
  insert into public.campaigns (
    org_id, name, channel_id, template_id, audience_type, segment_id, variable_map, fallbacks, status,
    retry_rounds, retry_delay_minutes, guardrails, created_by, recurrence_id, run_key
  )
  values (
    r.org_id, left(r.name || ' · ' || to_char(p_run_at at time zone r.timezone, 'DD Mon YYYY HH24:MI'), 120),
    r.channel_id, r.template_id, 'segment', r.segment_id, r.variable_map, r.fallbacks, 'preparing',
    r.retry_rounds, r.retry_delay_minutes, r.guardrails, r.created_by, r.id, v_key
  )
  on conflict (recurrence_id, run_key) where recurrence_id is not null do nothing
  returning id into v_id;
  if v_id is not null then
    update public.campaign_recurrences set last_campaign_id = v_id, last_run_outcome = 'created' where id = r.id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.campaign_recurrence_claim(uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.campaign_recurrence_claim(uuid, timestamptz, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- Monthly campaign message budget
-- ---------------------------------------------------------------------------
create table public.campaign_budget_months (
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, month)
);
alter table public.campaign_budget_months enable row level security;
create policy campaign_budget_months_select on public.campaign_budget_months for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
-- writes: campaign_budget_claim / campaign_budget_refund (service role)

-- The limit an administrator set (orgs.settings.campaign_budget.monthly_limit), null = no limit. A value that is
-- present but not a whole number fails closed (0) rather than lifting the stop.
create or replace function app.campaign_budget_limit(p_settings jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_settings is null or p_settings -> 'campaign_budget' -> 'monthly_limit' is null
      or jsonb_typeof(p_settings -> 'campaign_budget' -> 'monthly_limit') = 'null' then null
    when (p_settings -> 'campaign_budget' ->> 'monthly_limit') ~ '^[0-9]{1,9}$'
      then (p_settings -> 'campaign_budget' ->> 'monthly_limit')::integer
    else 0
  end;
$$;

-- Claims room for p_requested campaign messages in the current month (org timezone) and returns how many may be
-- dispatched now: all of them without a limit, at most what is left with one, 0 once the limit is reached. The
-- month row is locked, so two fanouts running at once can never pass the limit together.
create or replace function public.campaign_budget_claim(p_org uuid, p_requested integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_month date;
  v_used integer;
  v_grant integer;
begin
  if coalesce(p_requested, 0) <= 0 then
    return 0;
  end if;
  select app.campaign_budget_limit(o.settings), date_trunc('month', now() at time zone o.timezone)::date
    into v_limit, v_month
    from public.orgs o where o.id = p_org;
  if v_month is null then
    return 0; -- unknown org: fail closed
  end if;
  insert into public.campaign_budget_months (org_id, month) values (p_org, v_month)
  on conflict (org_id, month) do nothing;
  select used into v_used from public.campaign_budget_months where org_id = p_org and month = v_month for update;
  v_grant := case when v_limit is null then p_requested else greatest(0, least(p_requested, v_limit - v_used)) end;
  if v_grant > 0 then
    update public.campaign_budget_months set used = used + v_grant, updated_at = now()
     where org_id = p_org and month = v_month;
  end if;
  return v_grant;
end;
$$;
revoke all on function public.campaign_budget_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.campaign_budget_claim(uuid, integer) to service_role;

-- Gives back room that was claimed but not used (recipients skipped at dispatch). Never below zero.
create or replace function public.campaign_budget_refund(p_org uuid, p_count integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.campaign_budget_months b
     set used = greatest(0, b.used - greatest(coalesce(p_count, 0), 0)), updated_at = now()
    from public.orgs o
   where o.id = p_org and b.org_id = p_org
     and b.month = date_trunc('month', now() at time zone o.timezone)::date
     and coalesce(p_count, 0) > 0;
$$;
revoke all on function public.campaign_budget_refund(uuid, integer) from public, anon, authenticated;
grant execute on function public.campaign_budget_refund(uuid, integer) to service_role;

-- The meter: this month's use and the limit (null = none).
create or replace function public.campaign_budget_status(p_org uuid)
returns table (month date, used integer, monthly_limit integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.month, coalesce(b.used, 0), app.campaign_budget_limit(o.settings)
    from public.orgs o
    cross join lateral (select date_trunc('month', now() at time zone o.timezone)::date as month) m
    left join public.campaign_budget_months b on b.org_id = o.id and b.month = m.month
   where o.id = p_org;
$$;
revoke all on function public.campaign_budget_status(uuid) from public, anon, authenticated;
grant execute on function public.campaign_budget_status(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- media_asset_usage: carousel card headers (any key of a template mapping) and active recurring campaigns.
-- Same contract as 20261015000100_media_library.sql.
-- ---------------------------------------------------------------------------
create or replace function public.media_asset_usage(p_org uuid, p_asset uuid)
returns table (kind text, ref_id uuid, ref_name text, ref_status text, blocking boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select 'template'::text, t.id, t.name, t.status,
         (t.archived_at is null and t.status not in ('REJECTED', 'DISABLED', 'DELETED', 'PENDING_DELETION'))
    from public.wa_templates t
   where t.org_id = p_org
     and jsonb_typeof(t.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(t.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'campaign'::text, c.id, c.name, c.status,
         (c.status in ('preparing', 'scheduled', 'queued', 'sending', 'paused'))
    from public.campaigns c
   where c.org_id = p_org
     and jsonb_typeof(c.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(c.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'campaign'::text, r.id, left('Recurring: ' || r.name, 140), 'recurring ' || r.status, (r.status = 'active')
    from public.campaign_recurrences r
   where r.org_id = p_org
     and jsonb_typeof(r.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(r.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'quick_reply'::text, q.id, q.shortcut, null::text, true
    from public.quick_replies q
   where q.org_id = p_org and q.media_asset_id = p_asset;
$$;
revoke all on function public.media_asset_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_asset_usage(uuid, uuid) to service_role;
