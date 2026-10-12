-- WhatsApp cost: daily pricing analytics pulled from Meta (lib/whatsapp/pricing.ts), one row per WABA, day,
-- pricing category, pricing type and country. Cost is the WABA's own currency, as Meta reports it.
-- Business spend data, no patient data: readable with reports.view, written only by the nightly task.

create table public.wa_pricing_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  waba_id text not null,
  day date not null,                       -- UTC calendar day the Meta bucket starts on
  category text not null,                  -- MARKETING, UTILITY, AUTHENTICATION, SERVICE, ...
  pricing_type text not null,              -- REGULAR, FREE_CUSTOMER_SERVICE, FREE_ENTRY_POINT, ...
  country text not null,
  volume integer not null check (volume >= 0),
  cost numeric(14, 6) not null check (cost >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  synced_at timestamptz not null default now(),
  primary key (org_id, waba_id, day, category, pricing_type, country)
);
create index wa_pricing_daily_day_idx on public.wa_pricing_daily (org_id, day);

alter table public.wa_pricing_daily enable row level security;
create policy wa_pricing_daily_select on public.wa_pricing_daily for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'reports.view'));
-- No insert/update/delete policies: only the service role (the sync task) writes.

-- The report contract (service role only, like the other v_* report sources).
create view public.v_wa_cost_daily
with (security_invoker = true) as
select org_id, waba_id, day, category, pricing_type, country, volume, cost, currency
from public.wa_pricing_daily;
revoke all on public.v_wa_cost_daily from public, anon, authenticated;
grant select on public.v_wa_cost_daily to service_role;

-- Cost per day and category for the period. Days are the stored UTC days (Meta's buckets), not the org timezone.
create or replace function public.report_wa_cost_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, category text, currency text, volume integer, cost numeric)
language sql stable
set search_path = public, pg_temp
as $$
  select day, category, currency, sum(volume)::integer, sum(cost)
  from public.v_wa_cost_daily
  where org_id = p_org and day between p_from and p_to
  group by day, category, currency
  order by day, category
  limit 2000;
$$;
revoke all on function public.report_wa_cost_by_day(uuid, date, date) from public, anon, authenticated;
grant execute on function public.report_wa_cost_by_day(uuid, date, date) to service_role;

select cron.schedule('pulse:wa_pricing_sync', '50 3 * * *', $$select app.ping_jobs('wa_pricing_sync')$$);
