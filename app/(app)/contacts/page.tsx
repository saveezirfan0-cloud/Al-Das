import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadContactContext } from "@/lib/contacts/server";
import { createAdminClient } from "@/lib/supabase/admin";

import type { GridPrefs } from "./actions";
import { ContactsWorkspace } from "./contacts-workspace";
import type { ContactsBootstrap } from "./types";

export const metadata = { title: "Patients" };

export default async function ContactsPage() {
  const member = await requirePerm("contacts.view");
  const admin = createAdminClient();
  const canDrip = can(member, "contacts.manage") && can(member, "flows.manage");
  const [ctx, { data: prefs }, { data: dripFlows }] = await Promise.all([
    loadContactContext(admin, member.orgId),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .eq("grid_key", "contacts")
      .maybeSingle(),
    canDrip
      ? admin
          .from("flows")
          .select("id, name, status")
          .eq("org_id", member.orgId)
          .eq("trigger_type", "segment_joined")
          .order("name")
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; status: string }> }),
  ]);

  const bootstrap: ContactsBootstrap = {
    userId: member.userId,
    timezone: member.org.timezone,
    can: {
      manage: can(member, "contacts.manage"),
      export: can(member, "contacts.export"),
      enquiriesView: can(member, "enquiries.view"),
      enquiriesManage: can(member, "enquiries.manage"),
      documentsView: can(member, "documents.view"),
      drip: canDrip,
    },
    dripFlows: (dripFlows ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      active: f.status === "active",
    })),
    customFields: ctx.customFields,
    fields: ctx.registry
      .list()
      .filter((f) => f.available)
      .map(({ key, label, group, type, options, optionsSource, sortable }) => ({
        key,
        label,
        group,
        type,
        options,
        optionsSource,
        sortable,
      })),
    tags: ctx.tags,
    segments: ctx.segments,
    users: ctx.users,
    gridPrefs: (prefs?.prefs as GridPrefs | null) ?? null,
  };

  return <ContactsWorkspace bootstrap={bootstrap} />;
}
