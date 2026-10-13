-- Phase 19b (3/5): telehealth links on video appointments.
--
--   services.default_visit_mode      'in_person' (default) or 'video': what a booking of that service is, unless overridden
--   appointments.visit_mode          null = follow the service; 'in_person' or 'video' overrides it for this booking. Pulse-only: the
--                                    Unite sync never writes it
--   telehealth_rooms                 one video room per appointment: an unguessable 256-bit token (only its SHA-256 and an AES-256-GCM
--                                    copy are stored, so staff can be shown the link and reminders can carry it), the provider's room
--                                    name, and the window it is valid for. No patient name, number or id ever goes into a room name.
--                                    Service role only: staff get the link through a server action that checks the permission.
--
-- A room is created when it is first needed (a member of staff presses Join, or a reminder that carries the link is rendered), is
-- replaced when the appointment moves, and is revoked when the appointment is cancelled, a no-show or completed.

alter table public.services
  add column if not exists default_visit_mode text not null default 'in_person'
    check (default_visit_mode in ('in_person', 'video'));
comment on column public.services.default_visit_mode is
  'in_person or video. A booking of this service is a video visit unless appointments.visit_mode overrides it.';

alter table public.appointments
  add column if not exists visit_mode text check (visit_mode is null or visit_mode in ('in_person', 'video'));
comment on column public.appointments.visit_mode is
  'Null follows services.default_visit_mode. Pulse-only; the Unite sync never writes it.';

create table public.telehealth_rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  provider text not null check (provider in ('static', 'daily')),
  room_ref text check (room_ref is null or char_length(room_ref) <= 200),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_enc text not null,
  status text not null default 'creating' check (status in ('creating', 'active', 'revoked')),
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 40),
  for_starts_at timestamptz not null,
  for_ends_at timestamptz not null,
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  provider_deleted_at timestamptz
);
-- one live room per appointment
create unique index telehealth_rooms_live_uidx on public.telehealth_rooms (appointment_id) where status in ('creating', 'active');
create index telehealth_rooms_org_idx on public.telehealth_rooms (org_id, created_at desc);

create trigger telehealth_rooms_appointment_org_check before insert or update of appointment_id, org_id on public.telehealth_rooms
  for each row execute function app.check_parent_org('appointments', 'appointment_id');

alter table public.telehealth_rooms enable row level security;
-- no policies: holds the encrypted room token. Only server code (service role, after can()) reads or writes it.
