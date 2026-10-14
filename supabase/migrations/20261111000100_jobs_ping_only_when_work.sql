-- Ping Vercel only when there is work.
--
-- pg_cron called /api/jobs/<queue> every 10 or 30 seconds for every queue,
-- whether or not anything was waiting: about 114,000 function invocations a
-- day on an idle system, which is what used up the Vercel Active CPU allowance.
--
-- app.ping_jobs now checks in the database first (a cheap indexed lookup, no
-- HTTP) and only calls Vercel when:
--   * scheduler        -> a scheduled_jobs row is due (same rule as claim_scheduled_jobs)
--   * a pgmq queue     -> a message is visible (vt <= now()); messages backing
--                         off after a failure are not counted until they are due
--   * anything else    -> always (maintenance tasks such as campaign_tick,
--                         recall_run, flow_recurring and the sweeps run on their
--                         own schedule as before)
-- If the check itself fails for any reason it falls back to pinging, so a
-- queue can never be starved by this optimisation.
--
-- Latency is unchanged: a queue with work is still picked up on the next tick.
-- Starts from the only previous definition (20261008000500_cron.sql).

create or replace function app.queue_has_work(p_queue text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has boolean;
begin
  if p_queue = 'scheduler' then
    return exists (
      select 1
      from public.scheduled_jobs s
      where s.done_at is null
        and s.run_at <= now()
        and s.attempts < s.max_attempts
        and (s.locked_at is null or s.locked_at < now() - interval '5 minutes')
    );
  end if;

  if exists (select 1 from pgmq.meta m where m.queue_name = p_queue) then
    execute format('select exists (select 1 from pgmq.%I where vt <= now())', 'q_' || p_queue)
      into v_has;
    return coalesce(v_has, true);
  end if;

  -- Not a queue: a maintenance task with its own cadence.
  return true;
exception when others then
  return true;
end;
$$;
revoke all on function app.queue_has_work(text) from public, anon, authenticated;

create or replace function app.ping_jobs(p_queue text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  if not app.queue_has_work(p_queue) then
    return null;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'app_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'job_secret' limit 1;
  if v_url is null or v_secret is null then
    raise notice 'app.ping_jobs: vault secrets app_url/job_secret are not set; skipping %', p_queue;
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/api/jobs/' || p_queue,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Job-Secret', v_secret),
    body := jsonb_build_object('source', 'pg_cron', 'queue', p_queue),
    timeout_milliseconds := 55000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function app.ping_jobs(text) from public, anon, authenticated;
-- The scheduler check uses the existing scheduled_jobs_due_idx (20261008000300_jobs.sql).
