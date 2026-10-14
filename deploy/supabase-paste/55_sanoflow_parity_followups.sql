-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Sanoflow parity follow-ups (docs/28 to docs/31). Needs every earlier file first, up to and including
-- 54_phase_20_sanoflow_parity.sql and supabase/migrations/20261111000100_jobs_ping_only_when_work.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- 20f: public.unlink_conversation_contact (move a chat to a new contact; service role only).
-- 20g: campaign A/B tests (campaign_ab_variants, campaign_recipients.variant, campaign_ab_funnel) and media_asset_usage()
-- counting version B files. 20i: Meta ads spend (ad_insights_daily, ad_insights_replace, ad_spend_report, cron
-- pulse:ads_insights_sync). Everything new is OFF or behaves as before until someone changes a setting.
-- The migration-history lines are at the bottom of this file.

-- ======================================================================
-- 20261112000100_inbox_unlink_contact.sql
-- ======================================================================
-- Sanoflow parity G11 (docs/28_PHASE_20F_INBOX_EXTRAS_NOTES.md): move a WhatsApp chat to a NEW contact.
--
-- A WhatsApp chat belongs to the number (phone / BSUID), so "unlink this chat from the contact" means: the person
-- writing is not the contact the chat is filed under (a shared phone, a mis-matched import). One transaction:
--   1. a new contact is created with the name staff typed and takes over the WhatsApp identity (phone_e164,
--      wa_bsuid, wa_profile_name); opt-outs travel with the number (stop_marketing, SMS opt-out, no review requests);
--      promotions_opt_in is NOT copied (consent is never invented);
--   2. this conversation and every other LIVE WhatsApp conversation of the old contact move to the new contact
--      (replies go to the number, so they must follow it); closed ones stay as the old contact's history;
--      messages are never touched: they follow their conversation;
--   3. optionally the old contact becomes a household dependant of the new one (Phase 14), so its appointment
--      messages still reach the shared phone and name the patient;
--   4. both contacts get a timeline event (ids only).
-- Refused when the old contact has household links (move or remove them first), when the conversation is not on a
-- WhatsApp number, when there is no WhatsApp identity to move, or when the latest inbound sender of the chat is not
-- the old contact's main phone / BSUID (a chat on an alternate number would hand the main number to the wrong
-- person). Service role only, called after can().

create or replace function public.unlink_conversation_contact(
  p_org_id uuid,
  p_conversation_id uuid,
  p_first_name text,
  p_last_name text,
  p_keep_household boolean,
  p_relationship text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  conv public.conversations;
  ch_type text;
  old public.contacts;
  new_id uuid;
  moved uuid[];
  v_contact_id uuid;
  v_from text;
begin
  if coalesce(btrim(p_first_name), '') = '' and coalesce(btrim(p_last_name), '') = '' then
    raise exception 'the new contact needs a name' using errcode = 'check_violation';
  end if;
  if p_keep_household and coalesce(p_relationship, '') not in ('child', 'parent', 'spouse', 'other') then
    raise exception 'unknown relationship' using errcode = 'check_violation';
  end if;

  -- Lock order as merge_contacts: the contact first (its id from a plain read), then the conversation.
  select c.contact_id into v_contact_id from public.conversations c
   where c.id = p_conversation_id and c.org_id = p_org_id;
  if v_contact_id is null then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;
  select * into old from public.contacts
   where id = v_contact_id and org_id = p_org_id and deleted_at is null
   for update;
  if old.id is null then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;
  select * into conv from public.conversations
   where id = p_conversation_id and org_id = p_org_id
   for update;
  if conv.id is null or conv.contact_id is distinct from old.id then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;
  select ch.type into ch_type from public.channels ch where ch.id = conv.channel_id and ch.org_id = p_org_id;
  if ch_type is distinct from 'whatsapp' then
    raise exception 'only WhatsApp chats can be moved to a new contact' using errcode = 'check_violation';
  end if;

  if old.phone_e164 is null and old.wa_bsuid is null then
    raise exception 'the contact has no WhatsApp number to move' using errcode = 'check_violation';
  end if;
  -- The person writing must be on the contact's MAIN identity (not an alternate number from contact_phones),
  -- because that is what the new contact takes over. Meta's `from` of the latest inbound message: phone digits,
  -- or the BSUID for username users.
  select m.payload ->> 'from' into v_from from public.messages m
   where m.conversation_id = conv.id and m.direction = 'in'
   order by m.at desc limit 1;
  if coalesce(v_from, '') = '' then
    raise exception 'nobody has written in this chat yet' using errcode = 'check_violation';
  end if;
  if not ((old.wa_bsuid is not null and v_from = old.wa_bsuid)
          or (old.phone_e164 is not null and '+' || v_from = old.phone_e164)) then
    raise exception 'the chat runs on a different number from the contact''s main number' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.household_links h
     where h.org_id = p_org_id and (h.guardian_contact_id = old.id or h.dependant_contact_id = old.id)
  ) then
    raise exception 'the contact has family links: remove them first' using errcode = 'check_violation';
  end if;

  -- Free the unique identifiers before the new contact takes them.
  update public.contacts set phone_e164 = null, wa_bsuid = null, wa_profile_name = null where id = old.id;
  -- An alternate-phone row with the same number would keep matching inbound messages to the old contact.
  if old.phone_e164 is not null then
    delete from public.contact_phones where contact_id = old.id and phone_e164 = old.phone_e164;
  end if;

  insert into public.contacts (
    org_id, first_name, last_name, phone_e164, wa_bsuid, wa_profile_name, language, source,
    promotions_opt_in, stop_marketing, sms_opt_out_at, no_review_requests_at, created_by, last_interaction_at
  ) values (
    p_org_id, coalesce(btrim(p_first_name), ''), coalesce(btrim(p_last_name), ''), old.phone_e164, old.wa_bsuid,
    old.wa_profile_name, old.language, 'inbox',
    false, old.stop_marketing, old.sms_opt_out_at, old.no_review_requests_at, p_user_id, conv.last_message_at
  ) returning id into new_id;

  with m as (
    update public.conversations c set contact_id = new_id
     where c.org_id = p_org_id and c.contact_id = old.id
       and (c.id = conv.id or (c.status <> 'closed' and exists (
         select 1 from public.channels ch where ch.id = c.channel_id and ch.type = 'whatsapp')))
    returning c.id
  )
  select coalesce(array_agg(id), '{}') into moved from m;

  if p_keep_household then
    insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id, relationship,
                                        reminders_to_guardian, created_by)
    values (p_org_id, new_id, old.id, p_relationship, true, p_user_id);
  end if;

  insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
  values
    (p_org_id, old.id, 'conversation.moved_out', case when p_user_id is null then 'system' else 'user' end, p_user_id,
     jsonb_build_object('to_contact_id', new_id, 'conversations', cardinality(moved))),
    (p_org_id, new_id, 'conversation.moved_in', case when p_user_id is null then 'system' else 'user' end, p_user_id,
     jsonb_build_object('from_contact_id', old.id, 'conversations', cardinality(moved)));

  return jsonb_build_object('contact_id', new_id, 'old_contact_id', old.id, 'conversation_ids', to_jsonb(moved));
end;
$$;
revoke all on function public.unlink_conversation_contact(uuid, uuid, text, text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.unlink_conversation_contact(uuid, uuid, text, text, boolean, text, uuid)
  to service_role;

-- ======================================================================
-- 20261113000100_sf20g_campaign_ab.sql
-- ======================================================================
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

-- ======================================================================
-- 20261115000100_meta_ads_insights.sql
-- ======================================================================
-- Phase 20i (parity gap G13, last part): Meta ads spend metrics.
--
--   ad_insights_daily        one row per (org, ad, day) pulled from the Meta Marketing API (ad-level insights, one day per row): the ad
--                            id, ad and campaign names, the ad account's currency, spend (exact, in thousandths of that currency),
--                            impressions and clicks. Nothing about a patient: it is Meta's own aggregate for the ad.
--   ad_insights_replace()    the only writer: replaces an org's rows for a pulled date range in one transaction (upsert what Meta
--                            returned, delete what it no longer reports for that range), so a re-pull overwrites the same days
--                            idempotently. Service role only.
--   ad_spend_report()        sums per ad for the Ad attribution report (amounts and counts only). Service role only.
--   pulse:ads_insights_sync  daily pull (lib/jobs/handlers/ads-insights.ts). A workspace whose integration (kind 'meta_ads') is off, or a
--                            training workspace, makes no call.
--
-- The integration is OFF by default (integration_accounts.enabled = false); its credentials (ad account id, an ads_read system-user
-- token) live in integration_accounts like every other integration (token encrypted in config_enc).

create table public.ad_insights_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  ad_id text not null check (ad_id ~ '^[0-9]{1,30}$'),
  day date not null,
  ad_name text check (ad_name is null or char_length(ad_name) <= 200),
  campaign_name text check (campaign_name is null or char_length(campaign_name) <= 200),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  spend_milli bigint not null check (spend_milli >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  pulled_at timestamptz not null default now(),
  primary key (org_id, ad_id, day)
);
create index ad_insights_daily_org_day_idx on public.ad_insights_daily (org_id, day desc);

comment on table public.ad_insights_daily is
  'Meta ad-level daily insights (spend, impressions, clicks). Written only by ad_insights_replace() from the daily pull; no patient data.';
comment on column public.ad_insights_daily.spend_milli is
  'Spend in thousandths of the ad account currency (exact; three decimals covers KWD, BHD and OMR).';

alter table public.ad_insights_daily enable row level security;
create policy ad_insights_daily_select on public.ad_insights_daily for select to authenticated
  using (app.has_perm(org_id, 'ads.view'));
-- writes: ad_insights_replace() only (service role)

-- ---------------------------------------------------------------------------
-- ad_insights_replace: the pulled range becomes exactly what Meta returned for it.
--   p_rows = [{ "ad_id", "day", "ad_name", "campaign_name", "currency", "spend_milli", "impressions", "clicks" }, ...]
-- Rows outside [p_since, p_until] are refused (the whole call fails), so a bad batch can never touch other days.
-- ---------------------------------------------------------------------------
create or replace function public.ad_insights_replace(p_org uuid, p_since date, p_until date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upserted integer := 0;
  v_removed integer := 0;
begin
  if p_org is null or p_since is null or p_until is null or p_until < p_since or p_until - p_since > 92 then
    raise exception 'ad_insights_replace: invalid range' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'ad_insights_replace: rows must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
     where (r ->> 'day') is null or (r ->> 'day')::date < p_since or (r ->> 'day')::date > p_until
  ) then
    raise exception 'ad_insights_replace: row outside the range' using errcode = '22023';
  end if;

  -- One writer per organisation at a time (two overlapping runs give the same result, never a mix).
  perform pg_advisory_xact_lock(hashtextextended('ad_insights:' || p_org::text, 0));

  with incoming as (
    select r ->> 'ad_id' as ad_id, (r ->> 'day')::date as day
      from jsonb_array_elements(p_rows) r
  ), gone as (
    delete from public.ad_insights_daily d
     where d.org_id = p_org and d.day between p_since and p_until
       and not exists (select 1 from incoming i where i.ad_id = d.ad_id and i.day = d.day)
    returning 1
  )
  select count(*) into v_removed from gone;

  with ins as (
    insert into public.ad_insights_daily as d
      (org_id, ad_id, day, ad_name, campaign_name, currency, spend_milli, impressions, clicks, pulled_at)
    select p_org,
           r ->> 'ad_id',
           (r ->> 'day')::date,
           nullif(r ->> 'ad_name', ''),
           nullif(r ->> 'campaign_name', ''),
           r ->> 'currency',
           (r ->> 'spend_milli')::bigint,
           coalesce((r ->> 'impressions')::bigint, 0),
           coalesce((r ->> 'clicks')::bigint, 0),
           now()
      from jsonb_array_elements(p_rows) r
    on conflict (org_id, ad_id, day) do update
      set ad_name = excluded.ad_name,
          campaign_name = excluded.campaign_name,
          currency = excluded.currency,
          spend_milli = excluded.spend_milli,
          impressions = excluded.impressions,
          clicks = excluded.clicks,
          pulled_at = excluded.pulled_at
    returning 1
  )
  select count(*) into v_upserted from ins;

  return jsonb_build_object('upserted', v_upserted, 'removed', v_removed);
end;
$$;
revoke all on function public.ad_insights_replace(uuid, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.ad_insights_replace(uuid, date, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- ad_spend_report: totals per ad and currency from p_since (inclusive). Amounts and counts only.
-- ---------------------------------------------------------------------------
create or replace function public.ad_spend_report(p_org uuid, p_since date)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.spend_milli desc, t.ad_id), '[]'::jsonb)
    from (
      select d.ad_id,
             d.currency,
             (array_agg(d.ad_name order by d.day desc) filter (where d.ad_name is not null))[1] as ad_name,
             (array_agg(d.campaign_name order by d.day desc) filter (where d.campaign_name is not null))[1] as campaign_name,
             sum(d.spend_milli)::bigint as spend_milli,
             sum(d.impressions)::bigint as impressions,
             sum(d.clicks)::bigint as clicks,
             count(*)::integer as days,
             max(d.pulled_at) as pulled_at
        from public.ad_insights_daily d
       where d.org_id = p_org and d.day >= p_since
       group by d.ad_id, d.currency
    ) t;
$$;
revoke all on function public.ad_spend_report(uuid, date) from public, anon, authenticated;
grant execute on function public.ad_spend_report(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Daily pull (04:17 UTC, early morning in the Gulf, after Meta has settled the previous day). A maintenance task, not a queue.
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:ads_insights_sync', '17 4 * * *', $$select app.ping_jobs('ads_insights_sync')$$);

insert into supabase_migrations.schema_migrations (version, name) values ('20261112000100', 'inbox_unlink_contact') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261113000100', 'sf20g_campaign_ab') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261115000100', 'meta_ads_insights') on conflict (version) do nothing;
