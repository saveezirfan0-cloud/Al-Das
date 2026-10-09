import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadOrgUsers } from "@/lib/enquiries/server";
import { createAdminClient } from "@/lib/supabase/admin";

import type { TasksBootstrap } from "./types";
import { TasksWorkspace } from "./tasks-workspace";

export const metadata = { title: "Tasks" };

export default async function TasksPage() {
  const member = await requirePerm("tasks.view");
  const users = await loadOrgUsers(createAdminClient(), member.orgId);
  const bootstrap: TasksBootstrap = {
    orgId: member.orgId,
    userId: member.userId,
    timezone: member.org.timezone,
    users,
    can: {
      manage: can(member, "tasks.manage"),
      contacts: can(member, "contacts.view"),
      enquiries: can(member, "enquiries.view"),
    },
  };
  return <TasksWorkspace bootstrap={bootstrap} />;
}
