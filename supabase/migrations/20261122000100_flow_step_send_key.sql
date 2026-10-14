-- Flow step send key (docs/23_PHASE_20B_NOTES.md, "Replay-safe sends"): a replayed flow step never queues its message twice.
--
-- The flow engine writes the step row (unique on run_id + seq) before the node runs and stores the outcome after it. A
-- crash between "message queued" and "outcome stored" left the step 'running', so the redelivered job ran the node again
-- and queued a second copy. Every message a flow step queues now carries the step's key (`<run id>:<seq>`); the partial
-- unique index refuses a second row with the same key and queueOutbound returns the first one instead (the same pattern
-- as retry_of_message_id in Phase 20d).
--
--   messages.flow_step_key           the flow step that queued this message; unique when set; null for everything else
--   outbound_message_enqueued(uuid)  does an outbound queue still hold a job for this message? Lets a replay re-queue a
--                                    row whose original enqueue was lost (crash between insert and enqueue) without ever
--                                    queueing a message twice. Service role only.
--
-- No new table, so no new policy (messages keeps its own). Behaviour of every other insert is unchanged (column is null).

alter table public.messages
  add column if not exists flow_step_key text
    constraint messages_flow_step_key_len check (flow_step_key is null or length(flow_step_key) between 1 and 120);
create unique index if not exists messages_flow_step_key_uidx on public.messages (flow_step_key)
  where flow_step_key is not null;
comment on column public.messages.flow_step_key is
  'The flow step (<run id>:<step seq>) that queued this message. Unique: a replayed step returns this message instead of queueing another.';

create or replace function public.outbound_message_enqueued(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from pgmq.q_outbound q where q.message ->> 'message_id' = p_message_id::text)
      or exists (select 1 from pgmq.q_outbound_priority q where q.message ->> 'message_id' = p_message_id::text);
$$;
comment on function public.outbound_message_enqueued(uuid) is
  'True while an outbound / outbound_priority job for this message is waiting or in flight. Service role only (flow step replay).';

revoke all on function public.outbound_message_enqueued(uuid) from public, anon, authenticated;
grant execute on function public.outbound_message_enqueued(uuid) to service_role;
