-- Double-booking guard. lib/appointments/service.ts checked the slot in TypeScript and then inserted in a
-- separate call, so two staff booking the same specialist at the same instant could both succeed.
--
-- These two functions take a transaction-scoped advisory lock per specialist, re-check overlap against the
-- same busy sources the slot engine uses (availability.ts), then write, all in one transaction. Working
-- hours and lead time stay in TypeScript (they don't change under concurrency); this closes the race.
--
-- Busy = the specialist's awaiting / confirmed / completed appointments at ANY location (one person cannot
-- be in two places) plus time blocks that apply to the location. p_enforce = false is the staff override.
-- Failure is raised as the exception message 'slot_taken'. Service role only; org-pinned.

create or replace function app.assert_slot_free(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.appointments a
    where a.org_id = p_org_id and a.specialist_id = p_specialist_id
      and a.status in ('awaiting', 'confirmed', 'completed')
      and (p_exclude_id is null or a.id <> p_exclude_id)
      and a.starts_at < p_ends_at and a.ends_at > p_starts_at
  ) or exists (
    select 1 from public.time_blocks b
    where b.org_id = p_org_id and b.specialist_id = p_specialist_id
      and (b.location_id is null or b.location_id = p_location_id)
      and b.starts_at < p_ends_at and b.ends_at > p_starts_at
  ) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.book_appointment(
  p_org_id uuid, p_contact_id uuid, p_location_id uuid, p_specialist_id uuid, p_service_id uuid,
  p_department_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_status text,
  p_notes text, p_notify_early boolean, p_source text, p_created_by uuid, p_enforce boolean
)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.appointments;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if p_enforce then
    perform app.assert_slot_free(p_org_id, p_specialist_id, p_location_id, p_starts_at, p_ends_at, null);
  end if;
  insert into public.appointments (
    org_id, contact_id, location_id, specialist_id, service_id, department_id,
    starts_at, ends_at, status, notes, notify_early, source, created_by
  ) values (
    p_org_id, p_contact_id, p_location_id, p_specialist_id, p_service_id, p_department_id,
    p_starts_at, p_ends_at, p_status, p_notes, coalesce(p_notify_early, false), p_source, p_created_by
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.move_appointment(
  p_org_id uuid, p_appointment_id uuid, p_location_id uuid, p_specialist_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_status text, p_enforce boolean
)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.appointments;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if p_enforce then
    perform app.assert_slot_free(p_org_id, p_specialist_id, p_location_id, p_starts_at, p_ends_at, p_appointment_id);
  end if;
  update public.appointments
     set starts_at = p_starts_at, ends_at = p_ends_at, specialist_id = p_specialist_id,
         location_id = p_location_id, status = p_status
   where id = p_appointment_id and org_id = p_org_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'appointment_not_found' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

revoke all on function app.assert_slot_free(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) to service_role;
grant execute on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) to service_role;
