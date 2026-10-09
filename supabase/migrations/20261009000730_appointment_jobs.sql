-- Phase 6 (6a): queue + cron for appointment reminders.
--   appointments queue : scheduled_jobs of kind 'appointment.reminder' land here (lib/jobs/handlers/appointments.ts)
--   appointments_sweep : maintenance task (every 5 min) that reconciles reminders after booking-rule edits
-- Queue names must stay in sync with lib/jobs/queues.ts.

select pgmq.create('appointments');

select cron.schedule('pulse:appointments',       '10 seconds', $$select app.ping_jobs('appointments')$$);
select cron.schedule('pulse:appointments_sweep', '*/5 * * * *', $$select app.ping_jobs('appointments_sweep')$$);
