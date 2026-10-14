-- One doctor, one identity (docs/40_MANAGEMENT_PLATFORM_PLAN.md §2: "specialists ↔ fin_ref_doctors.dha_id").
--
-- A doctor exists three times: the diary (specialists), the finance reference (fin_ref_doctors, keyed by dha_id) and
-- the Unite collection report (fin_report_visits.doctor_key, a normalised name). Two nullable link columns on
-- specialists tie them together:
--
--   specialists.dha_id             -> fin_ref_doctors.dha_id (same org)
--   specialists.report_doctor_key  -> fin_report_visits.doctor_key (lib/finance/unite-report-mapping.ts normaliser)
--
-- Each is unique per org when set, so a finance doctor or a report name belongs to one diary doctor at most. No foreign
-- key: the report has no doctor table, and a finance doctor must stay deletable by finance.reference.manage; the server
-- action checks that the target exists when it links, and the drawer shows a stale link as such.
--
-- Access. Reading: specialists stay readable by every member (the booking drawer needs them); the two columns hold a
-- licence number (public) and a normalised doctor name, no amounts and no patient data. The Doctors page only shows
-- them to people with finance access. Writing: the browser UPDATE policy (settings.manage) would let a signed-in user
-- set them directly, skipping the finance check and the audit, so a trigger refuses any change to them from a signed-in
-- session: only the Doctors page server action (settings.manage AND finance.reference.manage, audited, service role)
-- sets them. specialists has no record history, so app.can_view_record_history() is unchanged.
--
-- fin_report_doctor_keys(): the distinct report doctor keys with their most frequent spelling, for the link picker.
-- Keys and names only (no amounts, counts or patients). SECURITY DEFINER, service role only; the server checks
-- finance.reference.manage first.

-- ---------------------------------------------------------------------------
-- 1. Link columns
-- ---------------------------------------------------------------------------
alter table public.specialists
  add column dha_id text
    check (dha_id is null or (char_length(dha_id) between 1 and 200 and dha_id = btrim(dha_id))),
  add column report_doctor_key text
    check (report_doctor_key is null
           or (char_length(report_doctor_key) between 1 and 200 and report_doctor_key <> '(no doctor)'));

create unique index specialists_org_dha_uidx on public.specialists (org_id, dha_id) where dha_id is not null;
create unique index specialists_org_report_key_uidx on public.specialists (org_id, report_doctor_key)
  where report_doctor_key is not null;

-- ---------------------------------------------------------------------------
-- 2. Only the server sets the links (a signed-in session cannot, whatever its role)
-- ---------------------------------------------------------------------------
create or replace function app.specialists_finance_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.dha_id is not null or new.report_doctor_key is not null;
  else
    v_changed := new.dha_id is distinct from old.dha_id
                 or new.report_doctor_key is distinct from old.report_doctor_key;
  end if;
  if v_changed and auth.uid() is not null then
    raise exception 'A doctor''s finance link is changed on the Doctors page only.'
      using errcode = 'insufficient_privilege', hint = 'doctor_link_server_only';
  end if;
  return new;
end;
$$;
revoke all on function app.specialists_finance_link_guard() from public, anon, authenticated;

create trigger specialists_finance_link_guard before insert or update on public.specialists
  for each row execute function app.specialists_finance_link_guard();

-- ---------------------------------------------------------------------------
-- 3. Report doctor keys for the picker
-- ---------------------------------------------------------------------------
create or replace function public.fin_report_doctor_keys(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', n.doctor_key, 'name', n.doctor_name)
                            order by n.doctor_key collate "C"), '[]'::jsonb)
  from (
    select distinct on (x.doctor_key) x.doctor_key, x.doctor_name
    from (
      select r.doctor_key, r.doctor_name, count(*) as n
      from public.fin_report_visits r
      where r.org_id = p_org_id and r.is_current and r.doctor_key <> '(no doctor)'
      group by r.doctor_key, r.doctor_name
    ) x
    order by x.doctor_key, x.n desc, x.doctor_name collate "C"
  ) n;
$$;
revoke all on function public.fin_report_doctor_keys(uuid) from public, anon, authenticated;
grant execute on function public.fin_report_doctor_keys(uuid) to service_role;
