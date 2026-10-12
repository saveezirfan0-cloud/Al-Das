-- Phase 5b: a task can point at the appointment it was raised for, and the management dashboard can
-- answer "how many enquiries turned into a booking".

-- A failed appointment reminder raises a "call patient" task (lib/jobs/handlers/appointments.ts).
alter table public.tasks add column appointment_id uuid references public.appointments (id) on delete set null;
create trigger tasks_appointment_org_check before insert or update of appointment_id on public.tasks
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
-- One open call task per appointment: the database makes the handler's "already raised" check race-proof.
create unique index tasks_open_call_per_appointment_uidx on public.tasks (appointment_id)
  where appointment_id is not null and type = 'call' and not done;

-- Conversion to appointments (docs/audit/reports.md §5.1b). Appointments carry no enquiry link, so the
-- link is the contact: an enquiry created in the period counts as booked when its contact has a
-- non-cancelled appointment starting after the enquiry was created. Enquiries with no contact never
-- count as booked. Live tables (the period is small); service role only like the other report_* functions.
create or replace function public.report_enquiry_booking_conversion(p_org uuid, p_from date, p_to date)
returns table (created integer, booked integer)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         (count(*) filter (where exists (
            select 1 from public.appointments a
            where a.org_id = p_org and a.contact_id = e.contact_id
              and a.status <> 'cancelled' and a.starts_at >= e.created_at
         )))::integer
  from public.enquiries e
  join public.orgs o on o.id = e.org_id
  where e.org_id = p_org
    and e.deleted_at is null
    and (e.created_at at time zone o.timezone)::date between p_from and p_to;
$$;
revoke all on function public.report_enquiry_booking_conversion(uuid, date, date) from public, anon, authenticated;
grant execute on function public.report_enquiry_booking_conversion(uuid, date, date) to service_role;
