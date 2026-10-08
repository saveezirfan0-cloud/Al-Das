-- Phase 1 / 3: jobs framework tables (scheduled_jobs, job_runs, dead_letters).
-- These are infrastructure tables: RLS is enabled with no policies for the
-- API roles, so only the service role (server code after can() checks) reads them.

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs (id) on delete cascade,
  kind text not null,                                  -- routed to a queue by lib/jobs/scheduler.ts
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  done_at timestamptz,
  dedupe_key text,                                     -- optional: one pending job per key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scheduled_jobs_due_idx on public.scheduled_jobs (run_at) where done_at is null;
create unique index scheduled_jobs_dedupe_idx on public.scheduled_jobs (dedupe_key) where done_at is null and dedupe_key is not null;
create index scheduled_jobs_org_idx on public.scheduled_jobs (org_id, kind) where done_at is null;
create trigger scheduled_jobs_set_updated_at before update on public.scheduled_jobs for each row execute function app.set_updated_at();

create table public.job_runs (
  id bigint generated always as identity primary key,
  queue text not null,
  handler text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed integer not null default 0,
  failed integer not null default 0,
  error text,
  meta jsonb not null default '{}'::jsonb
);
create index job_runs_queue_started_idx on public.job_runs (queue, started_at desc);
create index job_runs_started_idx on public.job_runs (started_at desc);

create table public.dead_letters (
  id bigint generated always as identity primary key,
  queue text not null,
  msg_id bigint,                                       -- pgmq message id (null for scheduled_jobs)
  scheduled_job_id uuid,
  payload jsonb not null,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolution text                                      -- 'retried' | 'discarded'
);
create index dead_letters_open_idx on public.dead_letters (queue, created_at desc) where resolved_at is null;

alter table public.scheduled_jobs enable row level security;
alter table public.job_runs enable row level security;
alter table public.dead_letters enable row level security;
-- No policies: anon/authenticated get nothing; service_role bypasses RLS.

-- ---------------------------------------------------------------------------
-- Scheduler claim/complete/fail. Claim uses FOR UPDATE SKIP LOCKED so several
-- concurrent drains never pick the same row. Stale locks (crashed handler)
-- become claimable again after p_lock_ttl.
-- ---------------------------------------------------------------------------

create or replace function public.claim_scheduled_jobs(
  p_limit integer default 50,
  p_worker text default null,
  p_lock_ttl interval default interval '5 minutes'
)
returns setof public.scheduled_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select s.id
    from public.scheduled_jobs s
    where s.done_at is null
      and s.run_at <= now()
      and s.attempts < s.max_attempts
      and (s.locked_at is null or s.locked_at < now() - p_lock_ttl)
    order by s.run_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.scheduled_jobs s
  set locked_at = now(),
      locked_by = p_worker,
      attempts = s.attempts + 1
  from due
  where s.id = due.id
  returning s.*;
end;
$$;

create or replace function public.complete_scheduled_job(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.scheduled_jobs
  set done_at = now(), locked_at = null, locked_by = null, last_error = null
  where id = p_id and done_at is null;
$$;

-- Releases the lock and either retries later or dead-letters the job.
create or replace function public.fail_scheduled_job(
  p_id uuid,
  p_error text,
  p_retry_in interval default interval '1 minute'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.scheduled_jobs;
begin
  select * into v_job from public.scheduled_jobs where id = p_id for update;
  if not found or v_job.done_at is not null then
    return;
  end if;
  if v_job.attempts >= v_job.max_attempts then
    update public.scheduled_jobs
    set done_at = now(), locked_at = null, locked_by = null, last_error = p_error
    where id = p_id;
    insert into public.dead_letters (queue, scheduled_job_id, payload, error, attempts)
    values ('scheduled_jobs', v_job.id,
            jsonb_build_object('kind', v_job.kind, 'payload', v_job.payload, 'org_id', v_job.org_id),
            p_error, v_job.attempts);
  else
    update public.scheduled_jobs
    set locked_at = null, locked_by = null, last_error = p_error, run_at = now() + p_retry_in
    where id = p_id;
  end if;
end;
$$;

revoke all on function public.claim_scheduled_jobs(integer, text, interval) from public, anon, authenticated;
revoke all on function public.complete_scheduled_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_scheduled_job(uuid, text, interval) from public, anon, authenticated;
grant execute on function public.claim_scheduled_jobs(integer, text, interval) to service_role;
grant execute on function public.complete_scheduled_job(uuid) to service_role;
grant execute on function public.fail_scheduled_job(uuid, text, interval) to service_role;
