import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { allowedLocations } from "@/lib/branches/access";
import { branchView } from "@/lib/branches/server";
import { loadOrgUsers } from "@/lib/enquiries/server";
import { createAdminClient } from "@/lib/supabase/admin";

import type { TasksBootstrap } from "./types";
import { TasksWorkspace } from "./tasks-workspace";

export const metadata = { title: "Tasks" };

export default async function TasksPage() {
  const member = await requirePerm("tasks.view");
  const admin = createAdminClient();
  const [users, { data: locations }] = await Promise.all([
    loadOrgUsers(admin, member.orgId),
    admin
      .from("locations")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
  ]);
  // Phase B: new tasks default to the switcher's branch; the list follows it unless a branch is picked.
  const branch = await branchView(
    member,
    (locations ?? []).map((l) => l.id),
  );
  const bootstrap: TasksBootstrap = {
    orgId: member.orgId,
    userId: member.userId,
    timezone: member.org.timezone,
    users,
    branches: allowedLocations(locations ?? [], branch.access),
    branchNames: Object.fromEntries((locations ?? []).map((l) => [l.id, l.name])),
    currentBranch: branch.current,
    can: {
      manage: can(member, "tasks.manage"),
      contacts: can(member, "contacts.view"),
      enquiries: can(member, "enquiries.view"),
    },
  };
  return <TasksWorkspace bootstrap={bootstrap} />;
}
