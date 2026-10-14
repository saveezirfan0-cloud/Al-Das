-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Replay-safe flow steps (docs/23_PHASE_20B_NOTES.md): flow_step_key on messages, appointments and fin_payment_requests
-- (unique when set), book_appointment_for_flow_step and requeue_lost_flow_message (service role only). Needs every earlier
-- file first, up to and including 58_pin_function_search_path.sql.
-- Builds three partial unique indexes (writes to messages, appointments and payment requests wait while they build; run it
-- outside busy hours).
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261122000100_flow_step_send_key.sql
-- ======================================================================
-- Flow step key (docs/23_PHASE_20B_NOTES.md, "Replay-safe steps"): a replayed flow step never sends, books or charges twice.
--
-- The flow engine writes the step row (unique on run_id + seq) before the node runs and stores the outcome after it. A
-- crash between the node's side effect and "outcome stored" left the step 'running', so the redelivered job ran the node
-- again: a second message, a second booking, a second payment link. Every side effect a flow step makes now carries the
-- step's key (`<run id>:<seq>`, lib/flow-engine/types.ts flowStepKey) in a column with a partial unique index, and the
-- code returns the first row instead of making another (the same pattern as retry_of_message_id in Phase 20d).
--
--   messages.flow_step_key                 the flow step that queued this message (queueOutbound returns it on a replay)
--   appointments.flow_step_key             the flow step that booked this appointment (Book appointment node)
--   fin_payment_requests.flow_step_key     the flow step that asked for this payment link (Payment link node)
--   book_appointment_for_flow_step(...)    book_appointment, unchanged, plus the key in the same transaction; refuses with
--                                          'flow_step_booked' when the step already booked. Service role only.
--   requeue_lost_flow_message(uuid, text)  a replay found its message still 'queued' with no outbound job (crash between
--                                          insert and enqueue): claims it (payload.requeued_at, once) and queues it in one
--                                          statement + pgmq.send, so it is never queued twice. Service role only.
--
-- No new table, so no new policy. Every other insert is unchanged (the columns are null).

-- ---------------------------------------------------------------------------
-- 1. Keys
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists flow_step_key text
    constraint messages_flow_step_key_len check (flow_step_key is null or length(flow_step_key) between 1 and 120);
create unique index if not exists messages_flow_step_key_uidx on public.messages (flow_step_key)
  where flow_step_key is not null;
comment on column public.messages.flow_step_key is
  'The flow step (<run id>:<step seq>) that queued this message. Unique: a replayed step returns this message instead of queueing another.';

alter table public.appointments
  add column if not exists flow_step_key text
    constraint appointments_flow_step_key_len check (flow_step_key is null or length(flow_step_key) between 1 and 120);
create unique index if not exists appointments_flow_step_key_uidx on public.appointments (flow_step_key)
  where flow_step_key is not null;
comment on column public.appointments.flow_step_key is
  'The flow step (<run id>:<step seq>) that booked this appointment. Unique: a replayed Book appointment step gets this booking back.';
-- The key is written in the booking transaction right after the insert; it is bookkeeping, not a change anyone made.
select app.enable_record_history('appointments', 'flow_step_key');

alter table public.fin_payment_requests
  add column if not exists flow_step_key text
    constraint fin_payment_requests_flow_step_key_len check (flow_step_key is null or length(flow_step_key) between 1 and 120);
create unique index if not exists fin_payment_requests_flow_step_key_uidx on public.fin_payment_requests (flow_step_key)
  where flow_step_key is not null;
comment on column public.fin_payment_requests.flow_step_key is
  'The flow step (<run id>:<step seq>) that asked for this link. Unique: a replayed Payment link step gets this request back.';

-- ---------------------------------------------------------------------------
-- 2. Booking from a flow step: book_appointment (signature, lock and slot rule unchanged) + the key, one transaction
-- ---------------------------------------------------------------------------
create or replace function public.book_appointment_for_flow_step(
  p_flow_step_key text,
  p_org_id uuid, p_contact_id uuid, p_location_id uuid, p_specialist_id uuid, p_service_id uuid,
  p_department_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_status text,
  p_notes text, p_notify_early boolean, p_source text, p_created_by uuid, p_enforce boolean
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.appointments;
begin
  if p_flow_step_key is null or length(p_flow_step_key) not between 1 and 120 then
    raise exception 'flow_step_key_required';
  end if;
  -- The same per-specialist lock book_appointment takes (re-entrant in this transaction), so the check below and the
  -- booking are one step; the unique index still refuses a second key if the specialist changed between attempts.
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if exists (
    select 1 from public.appointments a where a.org_id = p_org_id and a.flow_step_key = p_flow_step_key
  ) then
    raise exception 'flow_step_booked';
  end if;
  v_row := public.book_appointment(
    p_org_id, p_contact_id, p_location_id, p_specialist_id, p_service_id, p_department_id,
    p_starts_at, p_ends_at, p_status, p_notes, p_notify_early, p_source, p_created_by, p_enforce
  );
  update public.appointments a set flow_step_key = p_flow_step_key where a.id = v_row.id
    returning * into v_row;
  return v_row;
end;
$$;
comment on function public.book_appointment_for_flow_step(text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) is
  'book_appointment for a flow step: same lock and slot rule, plus appointments.flow_step_key in the same transaction. Raises flow_step_booked on a replay. Service role only.';
revoke all on function public.book_appointment_for_flow_step(text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.book_appointment_for_flow_step(text, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. A replayed step's message whose first enqueue was lost: claim and queue it in one transaction, at most once
-- ---------------------------------------------------------------------------
create or replace function public.requeue_lost_flow_message(p_message_id uuid, p_queue text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_queue not in ('outbound', 'outbound_priority') then
    raise exception 'unknown_queue';
  end if;
  -- The row lock serialises two replays; the payload flag (re-checked on the locked row) lets only the first one through.
  update public.messages m
     set payload = m.payload || jsonb_build_object('requeued_at', now())
   where m.id = p_message_id
     and m.flow_step_key is not null
     and m.status = 'queued'
     and m.wa_message_id is null
     and not (m.payload ? 'requeued_at')
     and not exists (select 1 from pgmq.q_outbound q where q.message ->> 'message_id' = p_message_id::text)
     and not exists (select 1 from pgmq.q_outbound_priority q where q.message ->> 'message_id' = p_message_id::text)
  returning m.id into v_id;
  if v_id is null then
    return false;
  end if;
  perform pgmq.send(p_queue, jsonb_build_object('message_id', v_id::text));
  return true;
end;
$$;
comment on function public.requeue_lost_flow_message(uuid, text) is
  'Queues a flow-step message that is still queued but has no outbound job (its first enqueue was lost). At most once per message. Service role only.';
revoke all on function public.requeue_lost_flow_message(uuid, text) from public, anon, authenticated;
grant execute on function public.requeue_lost_flow_message(uuid, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261122000100', 'flow_step_send_key') on conflict (version) do nothing;
