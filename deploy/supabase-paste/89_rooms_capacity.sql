-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Rooms and capacity (M3A): rooms per branch, the open-hours setting
-- and the rooms.manage permission.
-- Needs every earlier file first, up to and including 88_finance_contribution.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261208000500_rooms_capacity.sql
-- ======================================================================
-- M3 first slice: rooms and the capacity measures' inputs (docs/40_MANAGEMENT_PLATFORM_PLAN.md §4 M3,
-- docs/23_PHASE_M3A_NOTES.md). Sorts after 20261202000100_organisation.sql, whose rota_shifts is Pulse's one rota (a
-- shift's free-text `room` is to be linked to rooms.id in a follow-up; room names are unique per branch for that).
--
--   1. rooms.manage for the existing Manager system roles (Admin holds '*'; new orgs get it from lib/auth/permissions.ts).
--   2. rooms: one row per room of a branch (location): kind, monthly cost (null = unknown; 0 is refused, never "unknown").
--   3. fin_ref_finance_settings.room_open_hours_per_day (default 10): a room's open hours on each open day, used for
--      occupancy until branches carry real opening hours.
--
-- Browsers read rooms through the select policy below; every write is a server action using the service role after can()
-- (rooms.manage, finance.targets.manage) and recordAudit. Booking is untouched:
-- app.slot_conflict / slotFits never read rooms.

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

-- ---------------------------------------------------------------------------
-- 3. Setting
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column room_open_hours_per_day numeric(4, 2) not null default 10
    check (room_open_hours_per_day > 0 and room_open_hours_per_day <= 24);

-- ---------------------------------------------------------------------------
-- RLS: select policies only; writes are server actions (service role after can()).
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;

-- Rooms of a branch the member may not work in are hidden (Phase B: app.location_visible_to is the one rule).
create policy rooms_select on public.rooms for select to authenticated
  using (app.has_perm(org_id, 'rooms.manage') and app.location_visible_to(org_id, auth.uid(), location_id));

