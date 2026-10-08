import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadContactContext } from "@/lib/contacts/server";
import { createAdminClient } from "@/lib/supabase/admin";

import type { GridPrefs } from "./actions";
import { ContactsWorkspace } from "./contacts-workspace";
import type { ContactsBootstrap } from "./types";

export const metadata = { title: "Contacts" };

export default async function ContactsPage() {
  const member = await requirePerm("contacts.view");
  const admin = createAdminClient();
  const [ctx, { data: prefs }] = await Promise.all([
    loadContactContext(admin, member.orgId),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .eq("grid_key", "contacts")
      .maybeSingle(),
  ]);

  const bootstrap: ContactsBootstrap = {
    userId: member.userId,
    timezone: member.org.timezone,
    can: { manage: can(member, "contacts.manage"), export: can(member, "contacts.export") },
    customFields: ctx.customFields,
    fields: ctx.registry
      .list()
      .filter((f) => f.available)
      .map(({ key, label, group, type, options, optionsSource, sortable }) => ({ key, label, group, type, options, optionsSource, sortable })),
    tags: ctx.tags,
    segments: ctx.segments,
    users: ctx.users,
    gridPrefs: (prefs?.prefs as GridPrefs | null) ?? null,
  };

  return <ContactsWorkspace bootstrap={bootstrap} />;
}
