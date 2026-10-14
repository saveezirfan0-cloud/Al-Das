-- Phase 20b: flow parity (docs/23_PHASE_20B_NOTES.md).
--
-- 1. Four new flow triggers: message_received, window_closing, wa_flow_completed, segment_joined (drip).
-- 2. Segment drip: when contacts are added to a STATIC segment whose drip flow (segments.drip_flow_id, unused until now) is an
--    active segment_joined flow, one durable scheduled job per new member ('flow.drip', routed to the flow_steps queue). The
--    job handler re-checks everything at fire time (still a member, drip unchanged, flow still active), so this trigger only
--    has to be cheap and correct. Dynamic segments keep using the Recurring trigger. Existing members are never back-filled.
-- No new tables. New node types live in the graph JSON (validated in lib/flow-engine), so they need no schema change.

alter table public.flows drop constraint if exists flows_trigger_type_check;
alter table public.flows add constraint flows_trigger_type_check check (trigger_type in (
  'conversation_opened', 'conversation_closed', 'conversation_waiting', 'template_button',
  'shortcut', 'enquiry_added', 'enquiry_stage_updated', 'enquiry_status_updated',
  'webhook', 'recurring', 'appointment_created', 'appointment_updated', 'appointment_status_changed',
  'conversation_ai_tagged',
  'message_received', 'window_closing', 'wa_flow_completed', 'segment_joined'));

-- Statement-level so a bulk add of thousands of contacts is one INSERT … SELECT, not thousands of round trips.
create or replace function app.queue_segment_drip()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.scheduled_jobs (org_id, kind, payload, run_at, dedupe_key)
  select a.org_id,
         'flow.drip',
         jsonb_build_object('segment_id', a.segment_id, 'contact_id', a.contact_id, 'flow_id', s.drip_flow_id),
         now(),
         'flow.drip:' || a.segment_id || ':' || a.contact_id || ':' || s.drip_flow_id
    from added a
    join public.segments s on s.id = a.segment_id and s.org_id = a.org_id
    join public.flows f on f.id = s.drip_flow_id and f.org_id = s.org_id
   where s.kind = 'static'
     and f.status = 'active'
     and f.trigger_type = 'segment_joined'
  on conflict (dedupe_key) where done_at is null and dedupe_key is not null do nothing;
  return null;
end;
$$;
revoke all on function app.queue_segment_drip() from public;

create trigger segment_members_queue_drip
  after insert on public.segment_members
  referencing new table as added
  for each statement execute function app.queue_segment_drip();

-- A segment's drip flow must belong to the same workspace (the FK alone does not check the org).
create or replace function app.check_segment_drip_flow_org()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.drip_flow_id is not null and not exists (
    select 1 from public.flows f where f.id = new.drip_flow_id and f.org_id = new.org_id
  ) then
    raise exception 'drip flow % does not belong to org %', new.drip_flow_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger segments_drip_flow_org_check
  before insert or update of drip_flow_id, org_id on public.segments
  for each row execute function app.check_segment_drip_flow_org();

-- The message_received debounce looks up recent runs of one flow in one conversation.
create index if not exists flow_runs_flow_conversation_started_idx
  on public.flow_runs (flow_id, conversation_id, started_at desc)
  where conversation_id is not null;
