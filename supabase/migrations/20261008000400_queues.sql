-- Phase 1 / 4: pgmq queues and the service-role RPC wrappers used by lib/jobs.
-- Requires the pgmq extension (enabled by default on Supabase; see
-- supabase/test/README for the local stand-in).

create extension if not exists pgmq;

-- Queue names must stay in sync with lib/jobs/queues.ts.
select pgmq.create('meta_events');
select pgmq.create('outbound');
select pgmq.create('outbound_priority');
select pgmq.create('campaign_fanout');
select pgmq.create('flow_steps');
select pgmq.create('media_fetch');
select pgmq.create('webhooks_out');
select pgmq.create('unite_sync');
select pgmq.create('kb_ingest');
select pgmq.create('notifications');

-- Enqueue a message, optionally delayed by p_delay seconds. Returns msg_id.
create or replace function public.job_enqueue(p_queue text, p_payload jsonb, p_delay integer default 0)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pgmq.send(p_queue, p_payload, greatest(coalesce(p_delay, 0), 0));
$$;

-- Read up to p_qty messages, hiding them for p_vt seconds.
create or replace function public.job_read(p_queue text, p_vt integer default 60, p_qty integer default 50)
returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
language sql
security definer
set search_path = ''
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  from pgmq.read(p_queue, p_vt, p_qty) r;
$$;

-- Archive processed messages (kept in pgmq.a_<queue> for audit).
create or replace function public.job_archive(p_queue text, p_msg_ids bigint[])
returns integer
language sql
security definer
set search_path = ''
as $$
  select count(*)::integer from pgmq.archive(p_queue, p_msg_ids);
$$;

-- Move a poisoned message to dead_letters and archive it. Idempotent per (queue, msg_id).
create or replace function public.job_dead_letter(p_queue text, p_msg_id bigint, p_payload jsonb, p_error text, p_attempts integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  select id into v_id from public.dead_letters where queue = p_queue and msg_id = p_msg_id and resolved_at is null;
  if v_id is null then
    insert into public.dead_letters (queue, msg_id, payload, error, attempts)
    values (p_queue, p_msg_id, p_payload, p_error, p_attempts)
    returning id into v_id;
  end if;
  perform pgmq.archive(p_queue, p_msg_id);
  return v_id;
end;
$$;

-- Re-enqueue a dead letter and mark it resolved.
create or replace function public.job_retry_dead_letter(p_id bigint, p_user_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dl public.dead_letters;
  v_msg bigint;
begin
  select * into v_dl from public.dead_letters where id = p_id and resolved_at is null for update;
  if not found then
    return null;
  end if;
  if v_dl.queue = 'scheduled_jobs' then
    insert into public.scheduled_jobs (org_id, kind, payload, run_at, max_attempts)
    values ((v_dl.payload ->> 'org_id')::uuid, v_dl.payload ->> 'kind', coalesce(v_dl.payload -> 'payload', '{}'::jsonb), now(), 3);
    v_msg := null;
  else
    v_msg := pgmq.send(v_dl.queue, v_dl.payload, 0);
  end if;
  update public.dead_letters set resolved_at = now(), resolved_by = p_user_id, resolution = 'retried' where id = p_id;
  return v_msg;
end;
$$;

-- Queue depths for the System Health page.
create or replace function public.job_queue_metrics()
returns table (queue_name text, queue_length bigint, newest_msg_age_sec integer, oldest_msg_age_sec integer, total_messages bigint, scrape_time timestamptz)
language sql
security definer
set search_path = ''
as $$
  select m.queue_name, m.queue_length, m.newest_msg_age_sec, m.oldest_msg_age_sec, m.total_messages, m.scrape_time
  from pgmq.metrics_all() m;
$$;

revoke all on function public.job_enqueue(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.job_read(text, integer, integer) from public, anon, authenticated;
revoke all on function public.job_archive(text, bigint[]) from public, anon, authenticated;
revoke all on function public.job_dead_letter(text, bigint, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.job_retry_dead_letter(bigint, uuid) from public, anon, authenticated;
revoke all on function public.job_queue_metrics() from public, anon, authenticated;
grant execute on function public.job_enqueue(text, jsonb, integer) to service_role;
grant execute on function public.job_read(text, integer, integer) to service_role;
grant execute on function public.job_archive(text, bigint[]) to service_role;
grant execute on function public.job_dead_letter(text, bigint, jsonb, text, integer) to service_role;
grant execute on function public.job_retry_dead_letter(bigint, uuid) to service_role;
grant execute on function public.job_queue_metrics() to service_role;
