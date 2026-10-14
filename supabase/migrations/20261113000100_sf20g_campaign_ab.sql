-- Phase 20g (Sanoflow parity G9): campaign A/B tests. docs/29_PHASE_20G_SHOWBUSY_AB_NOTES.md
--
--   campaign_ab_variants         variant B of a one-off campaign: a second approved template (or the same template with
--                                another variable mapping) and the share of recipients who get it (split_pct, 1 to 99).
--                                Written once by the createCampaign server action (campaigns.create, service role)
--                                before the audience snapshot; never updated.
--   campaign_recipients.variant  'a' / 'b' for an A/B campaign, null otherwise. Set by a trigger when the recipient row
--                                is inserted, from a hash of (campaign id, contact id), so a retry round, a resumed
--                                fanout or a re-run snapshot (on conflict do nothing) can never flip a recipient. It
--                                never changes afterwards.
--   campaign_ab_funnel()         A vs B: total, eligible, pending, queued, sent, delivered, read, replied, clicked,
--                                failed, skipped. Same cumulative rules as campaign_funnel(); clicked = a quick-reply
--                                tap answering the recipient's message (as in report_template_performance).
--   media_asset_usage()          also sees a Media Library file in a variant B mapping (kind 'campaign').
--
-- Recurring campaigns have no variants (campaign_recurrence_claim creates plain campaigns). No contact data here.

create table public.campaign_ab_variants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  campaign_id uuid not null unique references public.campaigns (id) on delete cascade,
  template_id uuid not null references public.wa_templates (id) on delete restrict,
  variable_map jsonb not null default '{}'::jsonb check (jsonb_typeof(variable_map) = 'object'),
  fallbacks jsonb not null default '{}'::jsonb check (jsonb_typeof(fallbacks) = 'object'),
  split_pct integer not null check (split_pct between 1 and 99),
  created_at timestamptz not null default now()
);
create index campaign_ab_variants_org_idx on public.campaign_ab_variants (org_id);
create index campaign_ab_variants_template_idx on public.campaign_ab_variants (template_id);
create trigger campaign_ab_variants_campaign_org_check before insert or update on public.campaign_ab_variants
  for each row execute function app.check_parent_org('campaigns', 'campaign_id');
create trigger campaign_ab_variants_template_org_check before insert or update on public.campaign_ab_variants
  for each row execute function app.check_parent_org('wa_templates', 'template_id');

-- A variant is fixed: added before the audience exists, never edited (the split already decided who got what).
create or replace function app.campaign_ab_variant_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'a campaign''s variant B cannot be changed' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.campaign_recipients r where r.campaign_id = new.campaign_id) then
    raise exception 'variant B must be added before the audience' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger campaign_ab_variants_guard before insert or update on public.campaign_ab_variants
  for each row execute function app.campaign_ab_variant_guard();

alter table public.campaign_ab_variants enable row level security;
create policy campaign_ab_variants_select on public.campaign_ab_variants for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
-- writes: the createCampaign server action (campaigns.create, service role after can()); no browser writes.

-- ---------------------------------------------------------------------------
-- Deterministic assignment
-- ---------------------------------------------------------------------------
alter table public.campaign_recipients
  add column if not exists variant text check (variant is null or variant in ('a', 'b'));
comment on column public.campaign_recipients.variant is
  'Phase 20g A/B test: a or b (null = not an A/B campaign). Hash of campaign and contact; set on insert, never changed.';

-- 0..99 from the first 32 bits of md5(campaign:contact). Not a secret, only a stable, even spread.
create or replace function app.campaign_ab_bucket(p_campaign uuid, p_contact uuid)
returns integer
language sql
immutable
set search_path = ''
as $$
  select ((('x' || substr(md5(p_campaign::text || ':' || p_contact::text), 1, 8))::bit(32)::bigint) % 100)::integer;
$$;

create or replace function app.campaign_recipient_variant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_split integer;
begin
  if tg_op = 'UPDATE' then
    if new.variant is distinct from old.variant then
      raise exception 'a recipient''s A/B variant never changes' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select v.split_pct into v_split from public.campaign_ab_variants v where v.campaign_id = new.campaign_id;
  new.variant := case
    when v_split is null then null
    when app.campaign_ab_bucket(new.campaign_id, new.contact_id) < v_split then 'b'
    else 'a'
  end;
  return new;
end;
$$;
create trigger campaign_recipients_ab_variant before insert or update of variant on public.campaign_recipients
  for each row execute function app.campaign_recipient_variant();

-- ---------------------------------------------------------------------------
-- A vs B funnel (service role; the page reads it after can('campaigns.view') like campaign_funnel)
-- ---------------------------------------------------------------------------
create or replace function public.campaign_ab_funnel(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select cr.variant, cr.status, cr.replied_at,
           (cr.wa_message_id is not null and exists (
             select 1 from public.messages m
             where m.reply_to_wa_message_id = cr.wa_message_id and m.direction = 'in' and m.kind = 'button'
               and m.org_id = cr.org_id
           )) as clicked
    from public.campaign_recipients cr
    where cr.campaign_id = p_campaign_id and cr.variant is not null
  )
  select coalesce(jsonb_object_agg(x.variant, x.counts), '{}'::jsonb)
  from (
    select variant, jsonb_build_object(
      'total', count(*),
      'eligible', count(*) filter (where status <> 'skipped'),
      'pending', count(*) filter (where status = 'pending'),
      'queued', count(*) filter (where status = 'queued'),
      'sent', count(*) filter (where status in ('sent', 'delivered', 'read')),
      'delivered', count(*) filter (where status in ('delivered', 'read')),
      'read', count(*) filter (where status = 'read'),
      'replied', count(*) filter (where replied_at is not null),
      'clicked', count(*) filter (where clicked),
      'failed', count(*) filter (where status = 'failed'),
      'skipped', count(*) filter (where status = 'skipped')
    ) as counts
    from r
    group by variant
  ) x;
$$;
revoke all on function public.campaign_ab_funnel(uuid) from public, anon, authenticated;
grant execute on function public.campaign_ab_funnel(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- media_asset_usage: starts from the Phase 20d definition (20261110000600) and adds variant B mappings.
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
     and (
       (jsonb_typeof(c.variable_map) = 'object'
         and exists (select 1 from jsonb_each_text(c.variable_map) e where e.value = 'media:' || p_asset::text))
       or exists (
         select 1 from public.campaign_ab_variants v
         where v.campaign_id = c.id
           and exists (select 1 from jsonb_each_text(v.variable_map) e where e.value = 'media:' || p_asset::text)
       )
     )
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
