import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadEnquiryContext, loadEnquiryViews } from "@/lib/enquiries/server";
import { createAdminClient } from "@/lib/supabase/admin";

import type { GridPrefs } from "@/app/(app)/contacts/actions";
import { EnquiriesWorkspace } from "./enquiries-workspace";
import type { EnquiriesBootstrap } from "./types";

export const metadata = { title: "Enquiries" };

export default async function EnquiriesPage() {
  const member = await requirePerm("enquiries.view");
  const admin = createAdminClient();
  const [ctx, views, { data: prefs }] = await Promise.all([
    loadEnquiryContext(admin, member.orgId),
    loadEnquiryViews(admin, member.orgId, member.userId),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .eq("grid_key", "enquiries")
      .maybeSingle(),
  ]);

  const bootstrap: EnquiriesBootstrap = {
    orgId: member.orgId,
    userId: member.userId,
    timezone: member.org.timezone,
    can: {
      manage: can(member, "enquiries.manage"),
      export: can(member, "enquiries.export"),
      delete: can(member, "enquiries.delete"),
      settings: can(member, "settings.manage"),
      contacts: can(member, "contacts.view"),
      tasks: can(member, "tasks.view"),
    },
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
    pipelines: ctx.pipelines,
    lookups: ctx.lookups,
    users: ctx.users,
    teams: ctx.teams,
    sources: ctx.settings.sources,
    views,
    gridPrefs: (prefs?.prefs as GridPrefs | null) ?? null,
  };

  return <EnquiriesWorkspace bootstrap={bootstrap} />;
}
