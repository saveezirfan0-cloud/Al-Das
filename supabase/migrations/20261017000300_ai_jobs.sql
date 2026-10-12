-- Phase 17 (3/3): queue and schedules for the AI copilots.
--   ai_insights queue        intent detection jobs ({ type: 'intent', message_id }) queued when an inbound message arrives
--   ai_quality_weekly task   Mondays 04:30 UTC: builds last week's reply-quality report per organisation
-- Queue names must stay in sync with lib/jobs/queues.ts.

select pgmq.create('ai_insights');

select cron.schedule('pulse:ai_insights',       '30 seconds', $$select app.ping_jobs('ai_insights')$$);
select cron.schedule('pulse:ai_quality_weekly', '30 4 * * 1', $$select app.ping_jobs('ai_quality_weekly')$$);
