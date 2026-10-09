-- Finance F1 / 5: the finance_capture queue and its hourly cron entry.
--
-- No handler is registered for this queue in F1, so /api/jobs/finance_capture
-- answers `skipped` and NOTHING calls the Unite Finance API (CLAUDE.md rule 7:
-- the API is sync-once). The F2 handler additionally requires
-- fin_capture_settings.enabled = true for the org.

select pgmq.create('finance_capture');

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname = 'pulse:finance_capture' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:finance_capture', '5 * * * *', $$select app.ping_jobs('finance_capture')$$);
