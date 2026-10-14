-- Phase E (docs/34_CLINIC_OS_PLAN.md): front desk and appointments v2.
--
--   contacts.whatsapp_declined_at   set when the desk registers a walk-in WITH a phone number but WITHOUT the patient's
--                                   agreement to be contacted on WhatsApp. While it is set Pulse queues no appointment
--                                   message (reminder, confirmation, move, cancellation), no waiting-list offer and no
--                                   desk message (location, running late) to that person. Null (every existing patient)
--                                   changes nothing. Cleared when the patient later agrees (patient card or walk-in form).
--
-- No new table: the rest of Phase E (booking from the desk, check panel, slip and receipt, the end-of-day summary per
-- branch, the diary's check-in badges, drag-and-drop moves and the branch week view) reads what already exists.
-- contacts keeps its RLS and policies; the column is written only by server actions after can().

alter table public.contacts
  add column if not exists whatsapp_declined_at timestamptz;

comment on column public.contacts.whatsapp_declined_at is
  'Phase E: the patient did not agree to WhatsApp at the desk; no appointment, offer or desk message is queued while set.';
