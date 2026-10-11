-- Phase 4: template builder — authoring metadata on wa_templates and the nightly Meta sync.
--
-- wa_templates already mirrors Meta (Phase 3). The builder adds local drafts (status 'DRAFT',
-- no meta_template_id), who authored a template, when it was last submitted, and which
-- gallery entry it started from. RLS is unchanged: members read, templates.manage writes
-- (the app writes through server actions with the service role after can()).

alter table public.wa_templates
  add column created_by uuid references public.profiles (id) on delete set null,
  add column submitted_at timestamptz,
  add column gallery_key text;

create index wa_templates_waba_status_idx on public.wa_templates (org_id, waba_id, status) where archived_at is null;

-- Nightly pull of every WABA's templates (statuses and categories can change without a webhook).
select cron.schedule('pulse:templates_sync', '40 3 * * *', $$select app.ping_jobs('templates_sync')$$);
