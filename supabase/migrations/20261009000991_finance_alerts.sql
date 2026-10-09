-- Finance F6: monitoring alerts. An hourly job evaluates capture health, Diligence freshness and
-- overdue exceptions and notifies the people who hold finance.capture.manage, once per problem
-- (not once per hour). This table remembers what has already been announced.

create table public.fin_alert_state (
  org_id uuid not null references public.orgs (id) on delete cascade,
  alert_key text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  first_seen_at timestamptz not null default now(),
  last_notified_at timestamptz,
  cleared_at timestamptz,
  primary key (org_id, alert_key)
);
alter table public.fin_alert_state enable row level security;   -- service role only

-- One alerts message per org per hour, whether or not Unite capture is enabled
-- ("no Diligence upload" and "overdue exceptions" do not depend on it).
create or replace function public.fin_alerts_enqueue()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_n integer := 0;
begin
  for s in select org_id from public.fin_capture_settings loop
    if not exists (
      select 1 from pgmq.q_finance_capture
      where message ->> 'kind' = 'alerts' and message ->> 'org_id' = s.org_id::text
    ) then
      perform pgmq.send('finance_capture', jsonb_build_object('kind', 'alerts', 'org_id', s.org_id));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.fin_alerts_enqueue() from public, anon, authenticated;
grant execute on function public.fin_alerts_enqueue() to service_role;

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname = 'pulse:finance_alerts' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;
select cron.schedule('pulse:finance_alerts', '35 * * * *', $$select public.fin_alerts_enqueue()$$);
