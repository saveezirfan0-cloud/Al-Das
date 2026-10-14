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
