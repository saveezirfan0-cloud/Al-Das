-- Menu visibility (Settings, Menu and Settings, Users, Menu access).
--
--   orgs.settings.menu.hidden   menu entries hidden for everyone in the workspace (JSON, lib/nav/menu-visibility.ts)
--   memberships.menu_hidden     menu entries hidden for one person, on top of what their role already hides
--   invites.menu_hidden         chosen when inviting; copied to the membership when the invite is accepted
--
-- Values are top-level menu hrefs (NAV_ITEMS in components/shell/nav.ts); unknown values are ignored when read.
-- Hiding narrows what a person sees and opens (lib/auth/session.ts sends a hidden page to /page-hidden); it never
-- grants anything, so the role's permissions stay the access rule. Writes are server actions with settings.manage
-- through the service role (memberships and invites have SELECT policies only).

alter table public.memberships
  add column menu_hidden text[] not null default '{}'
    check (cardinality(menu_hidden) <= 64);

alter table public.invites
  add column menu_hidden text[] not null default '{}'
    check (cardinality(menu_hidden) <= 64);
