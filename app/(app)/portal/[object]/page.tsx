import { notFound } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { canReadObject, canWriteObject } from "@/lib/portal/permissions";
import {
  listSavedViews,
  loadOrgUsers,
  loadPortalRegistry,
  resolveEnabledObject,
  toClientFields,
} from "@/lib/portal/server";
import { getPortalObject } from "@/lib/portal/objects";
import { createAdminClient } from "@/lib/supabase/admin";

import type { PortalBootstrap, PortalGridPrefs } from "../types";
import { PortalWorkspace } from "../portal-workspace";

export async function generateMetadata({ params }: { params: Promise<{ object: string }> }) {
  const { object } = await params;
  return { title: getPortalObject(object)?.label ?? "Portal" };
}

export default async function PortalObjectPage({
  params,
}: {
  params: Promise<{ object: string }>;
}) {
  const { object } = await params;
  const member = await requireMember();
  const admin = createAdminClient();
  const def = await resolveEnabledObject(admin, member.orgId, object);
  // Same response for "does not exist" and "no permission": do not reveal which objects exist.
  if (!def || !canReadObject(member, def)) notFound();

  const [{ registry, linkOptions }, views, users, { data: prefs }] = await Promise.all([
    loadPortalRegistry(admin, member.orgId, def),
    listSavedViews(admin, member.orgId, member.userId, def.key),
    loadOrgUsers(admin, member.orgId),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .eq("grid_key", `portal_${def.key}`)
      .maybeSingle(),
  ]);

  const write = canWriteObject(member, def);
  const bootstrap: PortalBootstrap = {
    object: def,
    userId: member.userId,
    timezone: member.org.timezone,
    can: {
      write,
      create: write && def.allowCreate,
      delete: write && def.allowDelete,
      export: true,
    },
    fields: toClientFields(registry),
    views,
    users,
    linkOptions,
    gridPrefs: (prefs?.prefs as PortalGridPrefs | null) ?? null,
  };

  return <PortalWorkspace key={def.key} bootstrap={bootstrap} />;
}
