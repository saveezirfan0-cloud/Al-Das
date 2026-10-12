-- Phase 13 (speed): indexes found by reading the code's queries against the existing indexes.
-- (The Supabase performance advisor was not available in the build sandbox. A catalogue query for foreign keys
-- without a leading index returned about 150 candidates; almost all are covered by an (org_id, ...) composite
-- that every query uses, or are never filtered on. The ones below are the ones a real query needs.)
--
-- Every index is partial or narrow, so the write cost is small. All are IF NOT EXISTS so a re-run is harmless.

-- 1. clinical_followups: evaluateVisit() looks up the OPEN follow-ups of one visit
--    (where org_id = $1 and visit_id = $2 and source = 'engine' and closed_at is null) for each visit it
--    evaluates, up to 500 per run, every 10 minutes. The existing indexes lead with dedupe_key or call_status,
--    so each lookup scanned every open follow-up of the organisation.
create index if not exists clinical_followups_visit_open_idx
  on public.clinical_followups (org_id, visit_id)
  where closed_at is null;

-- 2. tasks: the Tasks page's "Done" view (done = true, sorted by due date, with an exact count) could not use
--    tasks_open_due_idx, which is partial on "not done". Done tasks only ever accumulate (every failed reminder
--    leaves a call task), so this view got slower every month.
create index if not exists tasks_org_done_due_idx
  on public.tasks (org_id, due_at desc)
  where done;

-- 3. audit_log: the Activity log filtered by person (where org_id = $1 and user_id = $2 order by at desc) walked
--    audit_log_org_at_idx backwards until it found enough rows by that person, which for a quiet person is the
--    whole history. Rows with no user (system, API keys) are not worth indexing.
create index if not exists audit_log_org_user_at_idx
  on public.audit_log (org_id, user_id, at desc)
  where user_id is not null;

-- 4. contacts: "my patients" views filter on the owner or assignee, both exposed in the filter builder
--    (lib/filters/field-registry.ts). Most contacts have neither set, so the partial indexes stay small.
create index if not exists contacts_org_owner_idx
  on public.contacts (org_id, owner_id)
  where owner_id is not null and deleted_at is null;
create index if not exists contacts_org_assignee_idx
  on public.contacts (org_id, assignee_id)
  where assignee_id is not null and deleted_at is null;
