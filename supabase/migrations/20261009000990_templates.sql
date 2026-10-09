-- Phase 4: Templates builder.
--   * wa_templates gains the columns the builder needs (provenance, submit/edit tracking, header sample, review gate).
--   * A local status 'DRAFT' (no meta_template_id) is used until a template is submitted to Meta.
--   * Private bucket for header samples (kept so edit / duplicate can re-upload; Meta handles expire).
--   * Nightly sync via pg_cron -> /api/jobs/templates_sync.

alter table public.wa_templates
  add column source text not null default 'meta' check (source in ('meta', 'local', 'gallery')),
  add column gallery_key text,
  add column submitted_at timestamptz,
  add column last_error text,                         -- Meta's answer when a submit/edit failed (redacted)
  add column last_edited_at timestamptz,              -- Meta limits how often an approved template can be edited
  add column header_sample_path text,                 -- <org_id>/<template_id>/<file> in wa-template-media
  add column needs_review boolean not null default false,  -- machine-written copy (Arabic gallery) must be checked by a person before submit
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references public.profiles (id) on delete set null;

create index wa_templates_channel_status_idx on public.wa_templates (org_id, channel_id, status);

-- Existing rows came from Meta's mirror.
update public.wa_templates set source = 'meta' where source is null;

-- ---------------------------------------------------------------------------
-- Header samples. Paths: <org_id>/<template_id>/<file>. Members may read; writes happen
-- server-side with the service role after templates.manage. Guarded for plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('wa-template-media', 'wa-template-media', false, 104857600)
    on conflict (id) do nothing;
    execute $p$
      create policy wa_template_media_select on storage.objects for select to authenticated
        using (bucket_id = 'wa-template-media' and app.is_org_member(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;

-- Nightly mirror of every active channel's templates (also a manual button on /templates).
select cron.schedule('pulse:templates_sync', '40 2 * * *', $$select app.ping_jobs('templates_sync')$$);
