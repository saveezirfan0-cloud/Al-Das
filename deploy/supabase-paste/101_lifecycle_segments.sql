-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Lifecycle stage, age band and segment views (Track P4/P5).
-- Needs every earlier file first, up to and including 100_clinical_view.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261220000200_lifecycle_segments.sql
-- ======================================================================
-- Track P, slices P4 and P5 (docs/45): derived lifecycle stage, age band and the read-only views behind the segment
-- filters (visits, doctor, department, chronic condition, diagnosis group).
--
--   * app.contact_lifecycle_stage() is the SQL twin of lifecycleStage() in lib/contacts/lifecycle.ts. Change both
--     together; tests/unit/contacts/lifecycle-parity.test.ts and tests/db/lifecycle-segments.test.ts keep them equal.
--   * Thresholds come from orgs.settings->'lifecycle' (newPatientDays 90, activeMonths 18), the same defaults and
--     bounds as lib/contacts/lifecycle-settings.ts. An unreadable block means both defaults.
--   * All views are security_invoker: the caller's RLS on contacts / visits / diagnoses decides what they see.
--   * No new table. Nothing is stored; the stage is always derived.

-- Today in the org's timezone; an unreadable timezone falls back to UTC (never raises).
create or replace function app.org_today(p_tz text)
returns date
language plpgsql
stable
set search_path = ''
as $$
begin
  return (now() at time zone coalesce(nullif(btrim(p_tz), ''), 'UTC'))::date;
exception when others then
  return (now() at time zone 'UTC')::date;
end;
$$;
revoke all on function app.org_today(text) from public, anon;
grant execute on function app.org_today(text) to authenticated, service_role;

-- Thresholds from orgs.settings: {new_days, active_months}.
create or replace function app.lifecycle_thresholds(p_settings jsonb)
returns table (new_days integer, active_months integer)
language plpgsql
immutable
set search_path = ''
as $$
declare
  b jsonb := case when jsonb_typeof(p_settings -> 'lifecycle') = 'object' then p_settings -> 'lifecycle' else null end;
  v_new integer := 90;
  v_months integer := 18;
  n numeric;
  ok boolean := true;
begin
  if p_settings -> 'lifecycle' is not null and b is null then
    ok := false;   -- present but not an object: defaults
  end if;
  if ok and b ? 'newPatientDays' then
    if jsonb_typeof(b -> 'newPatientDays') = 'number' then
      n := (b ->> 'newPatientDays')::numeric;
      if n = trunc(n) and n between 1 and 365 then v_new := n::integer; else ok := false; end if;
    else
      ok := false;
    end if;
  end if;
  if ok and b ? 'activeMonths' then
    if jsonb_typeof(b -> 'activeMonths') = 'number' then
      n := (b ->> 'activeMonths')::numeric;
      if n = trunc(n) and n between 1 and 60 then v_months := n::integer; else ok := false; end if;
    else
      ok := false;
    end if;
  end if;
  if not ok then
    v_new := 90;
    v_months := 18;
  end if;
  return query select v_new, v_months;
end;
$$;
revoke all on function app.lifecycle_thresholds(jsonb) from public, anon;
grant execute on function app.lifecycle_thresholds(jsonb) to authenticated, service_role;

-- lead / new_patient / active / lapsed / unknown. Mirrors lifecycleStage() line by line.
create or replace function app.contact_lifecycle_stage(
  p_pin text, p_first date, p_last date, p_today date, p_new_days integer, p_active_months integer
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  has_pin boolean := btrim(coalesce(p_pin, '')) <> '';
  new_cutoff date;
  active_cutoff date;
begin
  if p_today is null then return 'unknown'; end if;
  if p_last is null and p_first is null then
    return case when has_pin then 'unknown' else 'lead' end;
  end if;
  if (p_last is not null and p_last > p_today) or (p_first is not null and p_first > p_today) then
    return 'unknown';
  end if;
  new_cutoff := p_today - p_new_days;
  active_cutoff := (p_today - make_interval(months => p_active_months))::date;   -- day clamped to the month's end
  if p_first is not null and p_first >= new_cutoff and (p_last is null or p_last >= active_cutoff) then
    return 'new_patient';
  end if;
  if p_last is not null then
    return case when p_last >= active_cutoff then 'active' else 'lapsed' end;
  end if;
  return case when p_first >= active_cutoff then 'active' else 'lapsed' end;
end;
$$;
revoke all on function app.contact_lifecycle_stage(text, date, date, date, integer, integer) from public, anon;
grant execute on function app.contact_lifecycle_stage(text, date, date, date, integer, integer) to authenticated, service_role;

-- Age band from the date of birth: 0_11, 12_17, 18_34, 35_49, 50_64, 65_plus, unknown (no or future date).
create or replace function app.contact_age_band(p_dob date, p_today date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_dob is null or p_today is null or p_dob > p_today then 'unknown'
    when date_part('year', age(p_today, p_dob)) < 12 then '0_11'
    when date_part('year', age(p_today, p_dob)) < 18 then '12_17'
    when date_part('year', age(p_today, p_dob)) < 35 then '18_34'
    when date_part('year', age(p_today, p_dob)) < 50 then '35_49'
    when date_part('year', age(p_today, p_dob)) < 65 then '50_64'
    else '65_plus'
  end;
$$;
revoke all on function app.contact_age_band(date, date) from public, anon;
grant execute on function app.contact_age_band(date, date) to authenticated, service_role;

-- One row per contact. first_visit_date is Pulse visits only; last_visit_date already merges Unite's patient date.
create or replace view public.v_contact_lifecycle with (security_invoker = true) as
select c.org_id,
       c.id as contact_id,
       app.contact_lifecycle_stage(
         c.external_id, s.first_visit_date, s.last_visit_date,
         app.org_today(o.timezone), t.new_days, t.active_months
       ) as stage
from public.contacts c
join public.orgs o on o.id = c.org_id
cross join lateral app.lifecycle_thresholds(o.settings) t
left join public.v_contact_visit_stats s on s.org_id = c.org_id and s.contact_id = c.id;

create or replace view public.v_contact_age_band with (security_invoker = true) as
select c.org_id, c.id as contact_id, app.contact_age_band(c.dob, app.org_today(o.timezone)) as age_band
from public.contacts c
join public.orgs o on o.id = c.org_id;

-- One row per real (non-test) visit: doctor and department for the segment filters and the visit count.
create or replace view public.v_contact_visit_segments with (security_invoker = true) as
select v.org_id, v.contact_id, v.specialist_id, v.department_mapped::text as department, v.visit_date
from public.visits v
where v.contact_id is not null and not v.is_test_record;

-- Condition groups per contact. source 'chronic' = the chronic list (contact_chronic_conditions), 'visit' = any
-- coded diagnosis on a visit. A diagnosis with no group is left out of 'visit'; the chronic list keeps it (group null).
create or replace view public.v_contact_diagnosis_groups with (security_invoker = true) as
select cc.org_id, cc.contact_id, d.condition_group_id, 'chronic'::text as source
from public.contact_chronic_conditions cc
join public.ref_diagnoses d on d.id = cc.ref_diagnosis_id
union all
select vd.org_id, vd.contact_id, d.condition_group_id, 'visit'::text as source
from public.visit_diagnoses vd
join public.ref_diagnoses d on d.id = vd.ref_diagnosis_id
where vd.contact_id is not null and d.condition_group_id is not null;

grant select on public.v_contact_lifecycle, public.v_contact_age_band, public.v_contact_visit_segments,
  public.v_contact_diagnosis_groups to authenticated, service_role;
