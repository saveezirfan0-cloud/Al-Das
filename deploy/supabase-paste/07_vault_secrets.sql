-- Run AFTER files 01-06. Three small steps, run them one at a time.

-- STEP 1: make a random secret. Copy the value it shows.
select encode(gen_random_bytes(32), 'hex') as new_job_secret;

-- STEP 2 (Vercel, not SQL): Project al-das > Settings > Environment Variables >
--   JOB_SECRET > Edit > paste the value > keep Production + Preview ticked > Save,
--   then Deployments > latest > Redeploy.

-- STEP 3: store the same value and the app URL for pg_cron. Replace PASTE_SECRET_HERE
-- with the value from step 1 (keep the quotes), then Run.
do $$
declare
  v_secret text := 'PASTE_SECRET_HERE';
  v_url    text := 'https://al-das.vercel.app';
  v_id uuid;
begin
  if v_secret = 'PASTE_SECRET_HERE' then
    raise exception 'Replace PASTE_SECRET_HERE with the secret from step 1';
  end if;

  select id into v_id from vault.secrets where name = 'job_secret';
  if v_id is null then perform vault.create_secret(v_secret, 'job_secret');
  else perform vault.update_secret(v_id, v_secret); end if;

  select id into v_id from vault.secrets where name = 'app_url';
  if v_id is null then perform vault.create_secret(v_url, 'app_url');
  else perform vault.update_secret(v_id, v_url); end if;
end $$;

-- CHECK: both names should be listed.
select name from vault.secrets where name in ('job_secret', 'app_url') order by name;
