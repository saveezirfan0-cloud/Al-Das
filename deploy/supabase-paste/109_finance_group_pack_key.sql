-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 108_recall_variables_map.sql.
-- Production normally gets this through .github/workflows/db-migrate.yml on merge; this file is the manual route.

-- docs/51: Al Das's submission for the Bindrai group reporting pack (Finance, Group pack).
--
--   * finance.group_pack.export (Finance Manager; Admin through '*'): download the month's submission as one Excel file
--     (/api/finance/group-pack). It carries the clinic-wide profit and loss, so it is not in the Finance preset and is
--     never held by Revenue & Collections or Costs & Expenses (reporting separation, docs/42).
--
-- No table: the file is built from figures Pulse already has (Unite report, close pack, ledger, payables), read with the
-- service role after can(); every download is audited and written to the access log.

-- Permission for the existing Finance Manager role (new orgs get it from lib/auth/permissions.ts)
update public.roles r
   set permissions = r.permissions || to_jsonb('finance.group_pack.export'::text)
 where r.is_system and r.name = 'Finance Manager' and not (r.permissions ? 'finance.group_pack.export');
