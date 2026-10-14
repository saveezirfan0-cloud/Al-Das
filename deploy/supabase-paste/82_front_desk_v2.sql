-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase E front desk and appointments v2: one column on contacts (whatsapp_declined_at) so a walk-in registered without
-- the WhatsApp agreement gets no WhatsApp message from Pulse. Everything else in Phase E is application code.
-- Needs every earlier file first, up to and including 81_organisation.sql. Nothing changes for existing patients: the
-- column is empty for all of them.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261204000100_front_desk_v2.sql
-- ======================================================================
alter table public.contacts
  add column if not exists whatsapp_declined_at timestamptz;

comment on column public.contacts.whatsapp_declined_at is
  'Phase E: the patient did not agree to WhatsApp at the desk; no appointment, offer or desk message is queued while set.';

insert into supabase_migrations.schema_migrations (version, name) values ('20261204000100', 'front_desk_v2') on conflict (version) do nothing;
