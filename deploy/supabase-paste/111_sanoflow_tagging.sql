-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 110_make_parity.sql.
-- Production normally gets this through .github/workflows/db-migrate.yml on merge; this file is the manual route.

-- Sanoflow contact tags after recall sends (docs/49 D11, owner decision 22 Oct 2026; docs/50_SANOFLOW_SENDING_NOTES.md).
--
-- After a Live birthday or chronic recall message goes out through Sanoflow, Pulse writes Make's tag to the patient's Sanoflow
-- contact (birthday tag 3590 and the first and last name; chronic tag 4654 and label 1800). The write runs as its own job on
-- its own queue, so a slow or failing Sanoflow contacts API can never hold up or repeat a message.
--
--   sanoflow_tags queue       { org_id, contact_id, programme }: ids only
--   pulse:sanoflow_tags       queue drain every 10 s

select pgmq.create('sanoflow_tags');
select cron.schedule('pulse:sanoflow_tags', '10 seconds', $$select app.ping_jobs('sanoflow_tags')$$);
