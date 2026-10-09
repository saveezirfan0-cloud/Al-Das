-- Phase 4: Templates module.
--
-- wa_templates (Phase 3) already mirrors Meta's templates and carries RLS keyed on org + the
-- templates.manage permission. The builder adds: who created a row, when it was submitted, the
-- last submission error, the stored sample file for header media, and the gallery entry a draft
-- came from. Drafts are rows with status = 'DRAFT' and no meta_template_id.
-- A nightly pg_cron job calls /api/jobs/templates_sync.

alter table public.wa_templates
  add column created_by uuid references public.profiles (id) on delete set null,
  add column submitted_at timestamptz,
  add column submit_error text,
  add column media_paths jsonb not null default '{}'::jsonb,   -- {"header": path, "card.0": path} in the wa-media bucket
  add column gallery_key text;

create index wa_templates_listing_idx on public.wa_templates (org_id, archived_at, status);

select cron.schedule('pulse:templates_sync', '0 2 * * *', $$select app.ping_jobs('templates_sync')$$);
