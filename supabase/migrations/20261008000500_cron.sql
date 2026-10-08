-- Phase 1 / 5: pg_cron + pg_net drive the queue handlers.
--
-- Every few seconds pg_cron calls app.ping_jobs('<queue>'), which POSTs to
-- <app_url>/api/jobs/<queue> with the X-Job-Secret header. The URL and secret
-- come from Supabase Vault. After deploying, run once in the SQL editor:
--
--   select vault.create_secret('https://pulse.example.com', 'app_url');
--   select vault.create_secret('<same value as JOB_SECRET env>', 'job_secret');
--
-- Until both secrets exist, ping_jobs is a no-op (it raises a NOTICE).

create extension if not exists pg_cron;
create extension if not exists pg_net;

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

-- Schedules. pg_cron supports "N seconds" intervals (1–59).
-- Hot paths every 10s, slower lanes every 30s. Idempotent: unschedule first.
do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname like 'pulse:%' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:scheduler',         '10 seconds', $$select app.ping_jobs('scheduler')$$);
select cron.schedule('pulse:meta_events',       '10 seconds', $$select app.ping_jobs('meta_events')$$);
select cron.schedule('pulse:outbound_priority', '10 seconds', $$select app.ping_jobs('outbound_priority')$$);
select cron.schedule('pulse:outbound',          '10 seconds', $$select app.ping_jobs('outbound')$$);
select cron.schedule('pulse:flow_steps',        '10 seconds', $$select app.ping_jobs('flow_steps')$$);
select cron.schedule('pulse:media_fetch',       '10 seconds', $$select app.ping_jobs('media_fetch')$$);
select cron.schedule('pulse:notifications',     '10 seconds', $$select app.ping_jobs('notifications')$$);
select cron.schedule('pulse:campaign_fanout',   '30 seconds', $$select app.ping_jobs('campaign_fanout')$$);
select cron.schedule('pulse:webhooks_out',      '30 seconds', $$select app.ping_jobs('webhooks_out')$$);
select cron.schedule('pulse:unite_sync',        '30 seconds', $$select app.ping_jobs('unite_sync')$$);
select cron.schedule('pulse:kb_ingest',         '30 seconds', $$select app.ping_jobs('kb_ingest')$$);

-- Housekeeping: keep job_runs for 14 days, dead letters that were resolved for 30 days,
-- finished scheduled_jobs for 7 days, pg_net responses for 1 day.
select cron.schedule('pulse:housekeeping', '15 3 * * *', $$
  delete from public.job_runs where started_at < now() - interval '14 days';
  delete from public.dead_letters where resolved_at is not null and resolved_at < now() - interval '30 days';
  delete from public.scheduled_jobs where done_at is not null and done_at < now() - interval '7 days';
  delete from net._http_response where created < now() - interval '1 day';
$$);

-- Cron visibility for the System Health page (service role only).
create or replace function public.job_cron_status()
returns table (jobname text, schedule text, active boolean, last_status text, last_start timestamptz, last_end timestamptz)
language sql
security definer
set search_path = ''
as $$
  select j.jobname::text, j.schedule::text, j.active,
         d.status::text, d.start_time, d.end_time
  from cron.job j
  left join lateral (
    select status, start_time, end_time
    from cron.job_run_details r
    where r.jobid = j.jobid
    order by start_time desc
    limit 1
  ) d on true
  where j.jobname like 'pulse:%'
  order by j.jobname;
$$;
revoke all on function public.job_cron_status() from public, anon, authenticated;
grant execute on function public.job_cron_status() to service_role;
