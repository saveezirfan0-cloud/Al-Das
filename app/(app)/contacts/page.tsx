import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
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
  const clinical = can(member, "clinical.view");
  const [ctx, { data: prefs }, { data: dripFlows }, { data: locations }, clinicalLists] =
    await Promise.all([
      loadContactContext(admin, member.orgId, { clinical }),
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
      admin
        .from("locations")
        .select("id, name")
        .eq("org_id", member.orgId)
        .eq("active", true)
        .order("name"),
      clinical
        ? Promise.all([
            admin.from("specialists").select("id, name").eq("org_id", member.orgId).order("name"),
            admin
              .from("ref_condition_groups")
              .select("id, name")
              .eq("org_id", member.orgId)
              .order("name"),
          ])
        : Promise.resolve(null),
    ]);
  const access = readBranchAccess(member);

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
      tasksView: can(member, "tasks.view"),
      invoicesView: can(member, "finance.invoices.view"),
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
      .map(({ key, label, group, type, options, optionsSource, sortable, clinical }) => ({
        key,
        label,
        group,
        type,
        options,
        optionsSource,
        sortable,
        clinical,
      })),
    tags: ctx.tags,
    segments: ctx.segments,
    users: ctx.users,
    branches: (locations ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      allowed: canSeeLocation(access, l.id),
    })),
    gridPrefs: (prefs?.prefs as GridPrefs | null) ?? null,
    ...(clinicalLists
      ? {
          clinical: {
            specialists: clinicalLists[0].data ?? [],
            conditionGroups: clinicalLists[1].data ?? [],
          },
        }
      : {}),
  };

  return <ContactsWorkspace bootstrap={bootstrap} />;
}
