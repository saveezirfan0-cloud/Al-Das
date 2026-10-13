-- Paste into Supabase > SQL Editor > New query, then Run. Needs 31_finance_revenue_share.sql applied first (apply the paste files in number order).
-- The migration-history line is included at the bottom of this file.

-- Phase 20: keep the Finance Manager preset a superset of Finance in existing workspaces.
--
-- The Finance Manager role (20D, 20261024000100) was created holding the Finance keys of that day. Later Phase 20
-- migrations grant their new keys to the "Finance" system role only, so an existing workspace's Finance Manager would miss
-- them (new workspaces get the full list from lib/auth/permissions.ts). This adds to every system Finance Manager role each
-- key its org's system Finance role holds. Additive and idempotent; it never removes a key.

update public.roles fm
   set permissions = fm.permissions || coalesce((
         select jsonb_agg(k)
         from public.roles f, jsonb_array_elements_text(f.permissions) as k
         where f.org_id = fm.org_id and f.is_system and f.name = 'Finance'
           and not (fm.permissions ? k)
       ), '[]'::jsonb)
 where fm.is_system and fm.name = 'Finance Manager';

insert into supabase_migrations.schema_migrations (version, name) values ('20261102000100', 'finance_manager_sync') on conflict (version) do nothing;
