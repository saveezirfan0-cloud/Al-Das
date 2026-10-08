-- LOCAL TEST STUB: mirrors the pg_cron catalog shape so migrations that call
-- cron.schedule()/cron.unschedule() apply on plain Postgres. Nothing runs.
create table cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);
create table cron.job_run_details (
  jobid bigint,
  runid bigint generated always as identity primary key,
  job_pid integer,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end $$;
create function cron.schedule(schedule text, command text) returns bigint
language sql as $$ select cron.schedule(null, schedule, command) $$;
create function cron.unschedule(job_name text) returns boolean
language sql as $$ delete from cron.job where jobname = job_name returning true $$;
create function cron.unschedule(job_id bigint) returns boolean
language sql as $$ delete from cron.job where jobid = job_id returning true $$;
