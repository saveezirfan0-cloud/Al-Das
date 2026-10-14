-- M3 first slice: rooms, the weekly room rota and the capacity measures' inputs (docs/40_MANAGEMENT_PLATFORM_PLAN.md
-- §4 M3, docs/23_PHASE_M3A_NOTES.md).
--
--   1. rooms.manage for the existing Manager system roles (Admin holds '*'; new orgs get it from lib/auth/permissions.ts).
--   2. rooms: one row per room of a branch (location): kind, monthly cost (null = unknown; 0 is refused, never "unknown").
--   3. room_rota: which doctor uses which room, per ISO weekday (1 = Monday ... 7 = Sunday, like working_hours) and
--      wall-clock minutes in the branch's timezone. A room is never double-booked: a trigger, under a per-room advisory
--      lock, refuses overlapping minutes on the same weekday. The doctor must work at the room's branch
--      (specialist_locations). A room cannot move to another branch while it has a rota.
--   4. fin_ref_doctor_keys: links a Unite report doctor key (fin_report_visits.doctor_key, a normalised name) to a Pulse
--      doctor (specialists), so revenue can be set against available hours. Several keys may point at one doctor.
--   5. fin_ref_finance_settings.room_open_hours_per_day (default 10): a room's open hours on each open day, used for
--      occupancy until branches carry real opening hours.
--
-- Browsers read through the select policies below; every write is a server action using the service role after can()
-- (rooms.manage, finance.reference.manage, finance.targets.manage) and recordAudit. Booking is untouched:
-- app.slot_conflict / slotFits never read rooms or the rota.

-- ---------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------
update public.roles r
   set permissions = r.permissions || to_jsonb('rooms.manage'::text)
 where r.is_system and r.name = 'Manager' and not (r.permissions ? 'rooms.manage');

-- ---------------------------------------------------------------------------
-- 2. Rooms
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null default 'consultation' check (kind in ('consultation', 'procedure', 'dental', 'other')),
  monthly_cost numeric(12, 2) check (monthly_cost is null or (monthly_cost > 0 and monthly_cost <= 10000000)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, name)
);
create index rooms_org_location_idx on public.rooms (org_id, location_id);

create trigger rooms_set_updated_at before update on public.rooms
  for each row execute function app.set_updated_at();
create trigger rooms_location_org_check before insert or update on public.rooms
  for each row execute function app.check_parent_org('locations', 'location_id');

-- A rota row names a doctor who works at the room's branch; moving the room would silently break that.
create or replace function app.rooms_location_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_id is distinct from old.location_id
     and exists (select 1 from public.room_rota rr where rr.room_id = old.id) then
    raise exception 'room_has_rota: clear the rota before moving the room to another branch'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Weekly room rota
-- ---------------------------------------------------------------------------
create table public.room_rota (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),           -- ISO: 1 = Monday ... 7 = Sunday
  start_min smallint not null check (start_min between 0 and 1439),    -- minutes after local midnight
  end_min smallint not null check (end_min between 1 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_min > start_min)
);
create index room_rota_room_idx on public.room_rota (room_id, weekday);
create index room_rota_specialist_idx on public.room_rota (specialist_id);
create index room_rota_org_idx on public.room_rota (org_id);

create trigger rooms_location_guard before update of location_id on public.rooms
  for each row execute function app.rooms_location_guard();

create trigger room_rota_set_updated_at before update on public.room_rota
  for each row execute function app.set_updated_at();
create trigger room_rota_room_org_check before insert or update on public.room_rota
  for each row execute function app.check_parent_org('rooms', 'room_id');
create trigger room_rota_specialist_org_check before insert or update on public.room_rota
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

-- The two rota rules. The advisory lock serialises writers of one room, and each statement below takes a fresh snapshot
-- (READ COMMITTED), so two overlapping inserts can never both pass. Half-open minutes: 09:00-12:00 and 12:00-15:00 fit.
create or replace function app.room_rota_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_location uuid;
begin
  if new.room_id is null or new.specialist_id is null then
    return new;  -- NOT NULL (and RLS, for a browser) refuses it
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room_rota:' || new.room_id::text, 0));

  select r.location_id into v_location from public.rooms r where r.id = new.room_id;
  if not exists (
    select 1 from public.specialist_locations sl
    where sl.specialist_id = new.specialist_id and sl.location_id = v_location
  ) then
    raise exception 'specialist_not_at_room_location: the doctor does not work at this room''s branch'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.room_rota o
    where o.room_id = new.room_id
      and o.weekday = new.weekday
      and o.id <> new.id
      and o.start_min < new.end_min
      and o.end_min > new.start_min
  ) then
    raise exception 'room_double_booked: the room is already on the rota at that time'
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;

-- Named to fire after the *_org_check triggers (same-timing triggers run in name order).
create trigger room_rota_validate before insert or update on public.room_rota
  for each row execute function app.room_rota_check();

-- ---------------------------------------------------------------------------
-- 4. Unite report doctor key -> Pulse doctor
-- ---------------------------------------------------------------------------
create table public.fin_ref_doctor_keys (
  org_id uuid not null references public.orgs (id) on delete cascade,
  doctor_key text not null check (char_length(doctor_key) between 1 and 200),
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, doctor_key)
);
create index fin_ref_doctor_keys_specialist_idx on public.fin_ref_doctor_keys (specialist_id);

create trigger fin_ref_doctor_keys_specialist_org_check before insert or update on public.fin_ref_doctor_keys
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

-- ---------------------------------------------------------------------------
-- 5. Setting
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column room_open_hours_per_day numeric(4, 2) not null default 10
    check (room_open_hours_per_day > 0 and room_open_hours_per_day <= 24);

-- ---------------------------------------------------------------------------
-- RLS: select policies only; writes are server actions (service role after can()).
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.room_rota enable row level security;
alter table public.fin_ref_doctor_keys enable row level security;

-- Rooms of a branch the member may not work in are hidden (Phase B: app.location_visible_to is the one rule).
create policy rooms_select on public.rooms for select to authenticated
  using (app.has_perm(org_id, 'rooms.manage') and app.location_visible_to(org_id, auth.uid(), location_id));

-- A rota row follows its room: the subquery reads rooms under the caller's own policy above.
create policy room_rota_select on public.room_rota for select to authenticated
  using (
    app.has_perm(org_id, 'rooms.manage')
    and exists (select 1 from public.rooms r where r.id = room_rota.room_id and r.org_id = room_rota.org_id)
  );

create policy fin_ref_doctor_keys_select on public.fin_ref_doctor_keys for select to authenticated
  using (app.has_perm(org_id, 'finance.revenue.view') or app.has_perm(org_id, 'finance.reference.manage'));
