-- Phase 20c (booking half, G6): booking capacity. docs/25_PHASE_20C_BOOKING_NOTES.md.
--
-- 1. services:    buffer_before_min / buffer_after_min (the specialist is busy that long before and after the
--                 visit) and capacity (patients one session can take at once; default 1).
-- 2. specialists: slot_length_min (step of their slot list; null = the org's slot_granularity_min) and
--                 max_per_slot (bookings they accept in one slot; default 1).
-- 3. specialist_recurring_blocks: weekly unavailable time by weekday (lunch, admin time), wall-clock minutes in
--                 the location's timezone, like working_hours. Settings table: members read, settings.manage writes.
-- 4. app.slot_conflict(): the one SQL rule, mirrored by lib/appointments/slots.ts (slotFits). Under the existing
--                 per-specialist advisory lock, book_appointment / move_appointment / accept_slot_offer re-check
--                 buffers, recurring blocks and capacity atomically. Signatures are unchanged.
-- 5. appointment_capacity_conflicts(): flags rows that break the rules (e.g. a Unite appointment). Read-only:
--                 the Unite sync writes appointments directly and is never checked or refused.
--
-- The rule. Every interval is widened by its own service buffers. A candidate fits when it overlaps no one-off
-- or recurring block, and the number n of busy appointments (awaiting / confirmed / completed) whose widened
-- interval overlaps the candidate's widened interval is 0, or n < the smallest "places" among the candidate and
-- every overlapping appointment, where places = least(service.capacity, specialist.max_per_slot) (no service = 1).
-- With every default (capacity 1, max 1, no buffers, no recurring blocks) this is exactly the old rule: any
-- overlap is slot_taken. Counting every overlapping booking (not the peak at one instant) can only refuse more,
-- never overbook.

-- ---------------------------------------------------------------------------
-- 1–2. Columns
-- ---------------------------------------------------------------------------
alter table public.services
  add column buffer_before_min integer not null default 0 check (buffer_before_min between 0 and 240),
  add column buffer_after_min integer not null default 0 check (buffer_after_min between 0 and 240),
  add column capacity integer not null default 1 check (capacity between 1 and 50);

alter table public.specialists
  add column slot_length_min integer check (slot_length_min is null or slot_length_min between 5 and 240),
  add column max_per_slot integer not null default 1 check (max_per_slot between 1 and 50);

-- ---------------------------------------------------------------------------
-- 3. Recurring blocks
-- ---------------------------------------------------------------------------
create table public.specialist_recurring_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  -- null = at every location the specialist works at
  location_id uuid references public.locations (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),           -- ISO: 1 = Monday … 7 = Sunday
  start_min smallint not null check (start_min between 0 and 1439),    -- minutes after local midnight
  end_min smallint not null check (end_min between 1 and 1440),
  reason text check (reason is null or char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_min > start_min)
);
create index specialist_recurring_blocks_specialist_idx
  on public.specialist_recurring_blocks (specialist_id, weekday);

create trigger specialist_recurring_blocks_set_updated_at before update on public.specialist_recurring_blocks
  for each row execute function app.set_updated_at();
create trigger specialist_recurring_blocks_specialist_org_check before insert or update on public.specialist_recurring_blocks
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger specialist_recurring_blocks_location_org_check before insert or update on public.specialist_recurring_blocks
  for each row execute function app.check_parent_org('locations', 'location_id');

alter table public.specialist_recurring_blocks enable row level security;
-- Same as working_hours: any member reads (slot lists need it), settings.manage writes.
create policy specialist_recurring_blocks_select on public.specialist_recurring_blocks for select to authenticated
  using (app.is_org_member(org_id));
create policy specialist_recurring_blocks_insert on public.specialist_recurring_blocks for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy specialist_recurring_blocks_update on public.specialist_recurring_blocks for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy specialist_recurring_blocks_delete on public.specialist_recurring_blocks for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- 4. The rule
-- ---------------------------------------------------------------------------

-- Volatile on purpose (like the old assert_slot_free): called right after the advisory lock, it must read
-- what committed while we waited.
-- null = the interval fits; 'blocked' = a one-off or recurring block; 'full' = no place left.
-- p_service_id may be null (no buffers, one place). p_exclude_id: the appointment being moved or checked.
create or replace function app.slot_conflict(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before integer := 0;
  v_after integer := 0;
  v_places integer := 1;
  v_max integer := 1;
  v_s timestamptz;
  v_e timestamptz;
  v_tz text;
  v_n integer;
  v_min_places integer;
begin
  if p_service_id is not null then
    select s.buffer_before_min, s.buffer_after_min, s.capacity
      into v_before, v_after, v_places
      from public.services s where s.id = p_service_id and s.org_id = p_org_id;
  end if;
  select sp.max_per_slot into v_max from public.specialists sp where sp.id = p_specialist_id and sp.org_id = p_org_id;
  v_places := least(coalesce(v_places, 1), coalesce(v_max, 1));
  v_s := p_starts_at - make_interval(mins => coalesce(v_before, 0));
  v_e := p_ends_at + make_interval(mins => coalesce(v_after, 0));

  -- One-off blocks (that apply to this location), against the buffered interval.
  if exists (
    select 1 from public.time_blocks b
    where b.org_id = p_org_id and b.specialist_id = p_specialist_id
      and (b.location_id is null or b.location_id = p_location_id)
      and b.starts_at < v_e and b.ends_at > v_s
  ) then
    return 'blocked';
  end if;

  -- Recurring blocks: expand each local date the buffered interval touches in the location's clock.
  select l.timezone into v_tz from public.locations l where l.id = p_location_id and l.org_id = p_org_id;
  if v_tz is null then
    select o.timezone into v_tz from public.orgs o where o.id = p_org_id;
  end if;
  v_tz := coalesce(v_tz, 'Asia/Dubai');
  if exists (
    select 1
    from public.specialist_recurring_blocks r,
         generate_series(0, ((v_e at time zone v_tz)::date - (v_s at time zone v_tz)::date)) as g(i)
    where r.org_id = p_org_id and r.specialist_id = p_specialist_id
      and (r.location_id is null or r.location_id = p_location_id)
      and r.weekday = extract(isodow from ((v_s at time zone v_tz)::date + g.i))
      and ((((v_s at time zone v_tz)::date + g.i) + make_interval(mins => r.start_min::int)) at time zone v_tz) < v_e
      and ((((v_s at time zone v_tz)::date + g.i) + make_interval(mins => r.end_min::int)) at time zone v_tz) > v_s
  ) then
    return 'blocked';
  end if;

  -- Capacity. The first two range conditions are index-friendly (buffers are at most 240 minutes).
  select count(*)::int, min(least(coalesce(s.capacity, 1), coalesce(v_max, 1)))::int
    into v_n, v_min_places
    from public.appointments a
    left join public.services s on s.id = a.service_id
   where a.org_id = p_org_id and a.specialist_id = p_specialist_id
     and a.status in ('awaiting', 'confirmed', 'completed')
     and (p_exclude_id is null or a.id <> p_exclude_id)
     and a.starts_at < v_e + interval '240 minutes'
     and a.ends_at > v_s - interval '240 minutes'
     and a.starts_at - make_interval(mins => coalesce(s.buffer_before_min, 0)) < v_e
     and a.ends_at + make_interval(mins => coalesce(s.buffer_after_min, 0)) > v_s;
  if v_n > 0 and v_n >= least(v_places, v_min_places) then
    return 'full';
  end if;
  return null;
end;
$$;

create or replace function app.assert_slot_fits(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if app.slot_conflict(p_org_id, p_specialist_id, p_location_id, p_service_id, p_starts_at, p_ends_at, p_exclude_id) is not null then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;
end;
$$;

-- Kept for compatibility (same signature as 20261012000100): no service, so no own buffers and one place.
create or replace function app.assert_slot_free(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, null, p_starts_at, p_ends_at, p_exclude_id);
end;
$$;

revoke all on function app.slot_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function app.assert_slot_fits(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;

-- Same signatures as 20261012000100; only the check changed (now with the service).
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
    perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, p_service_id, p_starts_at, p_ends_at, null);
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
  v_service uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if p_enforce then
    select a.service_id into v_service from public.appointments a where a.id = p_appointment_id and a.org_id = p_org_id;
    perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, v_service, p_starts_at, p_ends_at, p_appointment_id);
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

-- Same as 20261014000300 except the re-check now uses the offered service (buffers and places).
create or replace function public.accept_slot_offer(
  p_org_id uuid,
  p_offer_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.slot_offers;
  e public.waitlist_entries;
  v_appt public.appointments;
  v_department uuid;
begin
  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id;
  if o.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Same key as book_appointment / move_appointment.
  perform pg_advisory_xact_lock(hashtextextended(o.specialist_id::text, 0));

  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id for update;
  if o.status <> 'pending' then
    return jsonb_build_object('result', case when o.status = 'taken' then 'taken' else 'not_pending' end,
                              'status', o.status);
  end if;
  if o.expires_at <= p_now then
    update public.slot_offers set status = 'expired', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'expired');
  end if;

  select * into e from public.waitlist_entries where id = o.waitlist_entry_id and org_id = p_org_id for update;
  if e.id is null or e.status <> 'waiting' then
    update public.slot_offers set status = 'withdrawn', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'not_pending', 'status', 'withdrawn');
  end if;

  -- Someone else (another patient's YES, or a staff booking) may have taken the last place.
  if app.slot_conflict(p_org_id, o.specialist_id, o.location_id, o.service_id, o.starts_at, o.ends_at, null) is not null then
    update public.slot_offers set status = 'taken', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'taken');
  end if;

  select coalesce(s.department_id, sp.department_id) into v_department
    from public.services s, public.specialists sp
   where s.id = o.service_id and sp.id = o.specialist_id;

  v_appt := public.book_appointment(
    p_org_id, e.contact_id, o.location_id, o.specialist_id, o.service_id, v_department,
    o.starts_at, o.ends_at, 'confirmed', null, false, 'bot', null, true
  );

  update public.slot_offers
     set status = 'accepted', responded_at = p_now, appointment_id = v_appt.id
   where id = o.id;
  update public.waitlist_entries
     set status = 'booked', booked_appointment_id = v_appt.id
   where id = e.id;
  -- Everyone else holding an offer for this slot is told it has gone only when no place is left.
  if app.slot_conflict(p_org_id, o.specialist_id, o.location_id, o.service_id, o.starts_at, o.ends_at, null) is not null then
    update public.slot_offers
       set status = 'taken', responded_at = p_now
     where org_id = p_org_id and specialist_id = o.specialist_id and starts_at = o.starts_at
       and status = 'pending' and id <> o.id;
  end if;

  return jsonb_build_object('result', 'booked', 'appointment_id', v_appt.id, 'contact_id', e.contact_id,
                            'entry_id', e.id);
end;
$$;
revoke all on function public.accept_slot_offer(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.accept_slot_offer(uuid, uuid, timestamptz) to service_role;

revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) to service_role;
grant execute on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Conflict flags (display only; nothing is refused or changed)
-- ---------------------------------------------------------------------------
-- Upcoming-style rows (awaiting / confirmed) among p_ids that break the rule against everything else.
create or replace function public.appointment_capacity_conflicts(p_org_id uuid, p_ids uuid[])
returns table (appointment_id uuid, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.id, x.reason
  from (
    select a.id,
           app.slot_conflict(a.org_id, a.specialist_id, a.location_id, a.service_id, a.starts_at, a.ends_at, a.id) as reason
    from public.appointments a
    where a.org_id = p_org_id
      and a.id = any (p_ids[1:2000])
      and a.specialist_id is not null
      and a.status in ('awaiting', 'confirmed')
  ) x
  where x.reason is not null;
$$;
revoke all on function public.appointment_capacity_conflicts(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.appointment_capacity_conflicts(uuid, uuid[]) to service_role;
