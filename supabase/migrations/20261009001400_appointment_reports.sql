-- Phase 10 follow-up: appointment reports, now that Phase 6 tables exist.
--
-- One live view (security_invoker, revoked from API roles) gives the reports a stable contract;
-- the report_* functions aggregate in SQL and are service-role only, like the others in
-- 20261009001300_report_functions.sql. Appointments are bucketed by the day they take place
-- (starts_at in the org timezone), not the day they were created.
--
-- Definitions (docs/audit/reports.md §5):
--   no-show rate   no_show / (completed + no_show): of the appointments that reached an outcome,
--                  how many the patient missed. Awaiting/confirmed/cancelled are not in the base.
--   Unite status   appointments.status is whatever unite_appointment_status_map says; a Unite code
--                  whose mapping is still empty leaves status 'awaiting' (OQ-23), so the Unite report also lists
--                  the raw codes and how they currently map.

create view public.v_appointment_facts
with (security_invoker = true) as
select a.id,
       a.org_id,
       (a.starts_at at time zone o.timezone)::date as day,
       a.status,
       a.source,
       a.location_id,
       l.name as location_name,
       a.specialist_id,
       sp.name as specialist_name,
       a.external_status
from public.appointments a
join public.orgs o on o.id = a.org_id
left join public.locations l on l.id = a.location_id
left join public.specialists sp on sp.id = a.specialist_id;

revoke all on public.v_appointment_facts from public, anon, authenticated;
grant select on public.v_appointment_facts to service_role;

create or replace function public.report_appointments_summary(p_org uuid, p_from date, p_to date)
returns table (total integer, awaiting integer, confirmed integer, cancelled integer, completed integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where status = 'awaiting')::integer,
         count(*) filter (where status = 'confirmed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to;
$$;

create or replace function public.report_appointments_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, awaiting integer, confirmed integer, cancelled integer, completed integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  agg as (
    select day,
           count(*) filter (where status = 'awaiting')::integer as awaiting,
           count(*) filter (where status = 'confirmed')::integer as confirmed,
           count(*) filter (where status = 'cancelled')::integer as cancelled,
           count(*) filter (where status = 'completed')::integer as completed,
           count(*) filter (where status = 'no_show')::integer as no_show
    from public.v_appointment_facts
    where org_id = p_org and day between p_from and p_to
    group by day
  )
  select days.day, coalesce(agg.awaiting, 0), coalesce(agg.confirmed, 0), coalesce(agg.cancelled, 0),
         coalesce(agg.completed, 0), coalesce(agg.no_show, 0)
  from days left join agg on agg.day = days.day
  order by days.day;
$$;

create or replace function public.report_appointments_by_location(p_org uuid, p_from date, p_to date)
returns table (location_id uuid, location_name text, total integer, completed integer, cancelled integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select location_id, coalesce(location_name, 'No location'), count(*)::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to
  group by location_id, location_name
  order by count(*) desc, 2
  limit 100;
$$;

create or replace function public.report_appointments_by_specialist(p_org uuid, p_from date, p_to date)
returns table (specialist_id uuid, specialist_name text, total integer, completed integer, cancelled integer, no_show integer)
language sql stable
set search_path = public, pg_temp
as $$
  select specialist_id, coalesce(specialist_name, 'No specialist'), count(*)::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         count(*) filter (where status = 'no_show')::integer
  from public.v_appointment_facts
  where org_id = p_org and day between p_from and p_to
  group by specialist_id, specialist_name
  order by count(*) desc, 2
  limit 100;
$$;

-- Appointments that came from Unite, per day.
create or replace function public.report_unite_appointments_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, appointments integer, unmapped integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  agg as (
    select f.day, count(*)::integer as n,
           count(*) filter (where f.external_status is not null and m.status is null)::integer as unmapped
    from public.v_appointment_facts f
    left join public.unite_appointment_status_map m on m.org_id = f.org_id and m.code = upper(f.external_status)
    where f.org_id = p_org and f.source = 'unite' and f.day between p_from and p_to
    group by f.day
  )
  select days.day, coalesce(agg.n, 0), coalesce(agg.unmapped, 0)
  from days left join agg on agg.day = days.day
  order by days.day;
$$;

-- Raw Unite status codes in the period and what each currently maps to (null = meaning not confirmed yet, OQ-23).
create or replace function public.report_unite_status_codes(p_org uuid, p_from date, p_to date)
returns table (code text, mapped_status text, appointments integer)
language sql stable
set search_path = public, pg_temp
as $$
  select f.external_status, m.status, count(*)::integer
  from public.v_appointment_facts f
  left join public.unite_appointment_status_map m on m.org_id = f.org_id and m.code = upper(f.external_status)
  where f.org_id = p_org and f.source = 'unite' and f.day between p_from and p_to and f.external_status is not null
  group by f.external_status, m.status
  order by count(*) desc, 1
  limit 50;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'report_appointments_summary', 'report_appointments_by_day', 'report_appointments_by_location',
    'report_appointments_by_specialist', 'report_unite_appointments_by_day', 'report_unite_status_codes'
  ] loop
    execute format('revoke all on function public.%I(uuid, date, date) from public, anon, authenticated', fn);
    execute format('grant execute on function public.%I(uuid, date, date) to service_role', fn);
  end loop;
end $$;
