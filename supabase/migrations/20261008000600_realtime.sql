-- Phase 1 / 6: realtime for in-app notifications and presence.
-- Supabase Realtime streams changes from tables in the supabase_realtime
-- publication; RLS still applies to subscribers. Guarded so the migration also
-- applies on a plain Postgres (tests) where the publication does not exist.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
    alter publication supabase_realtime add table public.memberships;
  end if;
end $$;

-- Old row values in change events (needed for filtered subscriptions on updates).
alter table public.notifications replica identity full;
alter table public.memberships replica identity full;
