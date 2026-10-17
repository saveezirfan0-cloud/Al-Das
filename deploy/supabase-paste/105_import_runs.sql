-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Importer run counts for the migration status page (Track P0 follow-up).
-- Needs every earlier file first, up to and including 104_contact_insurers.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261220000600_import_runs.sql
-- ======================================================================
-- Import runs (docs/45 P0 follow-up).
--
-- The migration control centre showed "records linked" (external_refs) but nothing about the import runs themselves:
-- the importers' dry-run reports are files, not tables. Each importer now records one row per entity per run here when it
-- finishes. COUNTS ONLY: no record id, name, phone, value or message text. Service role only (the importers and the
-- status page loader, after settings.manage); no policies, so signed-in users read nothing.

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null check (source in ('airtable', 'sanoflow')),
  /** The same key the importer writes to external_refs.entity ("<baseId>.<tableId>[#suffix]" or a Sanoflow entity). */
  entity text not null check (length(entity) between 1 and 200),
  label text not null check (length(label) between 1 and 200),
  dry_run boolean not null,
  run_at timestamptz not null,
  counters jsonb not null check (jsonb_typeof(counters) = 'object'),
  created_at timestamptz not null default now(),
  -- A retried recording of the same run is a no-op.
  unique (org_id, source, entity, run_at, dry_run)
);
create index import_runs_lookup_idx on public.import_runs (org_id, source, entity, run_at desc);

alter table public.import_runs enable row level security;
revoke all on public.import_runs from anon, authenticated;
grant select, insert on public.import_runs to service_role;
