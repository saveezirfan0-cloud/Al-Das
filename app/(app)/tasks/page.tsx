import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadReferenceData } from "@/lib/enquiries/reference";
import { createAdminClient } from "@/lib/supabase/admin";

import { TasksWorkspace } from "./tasks-workspace";

export const metadata = { title: "Tasks" };

export default async function TasksPage() {
  const member = await requirePerm("tasks.manage");
  const { users } = await loadReferenceData(createAdminClient(), member.orgId);
  return (
    <TasksWorkspace
      timezone={member.org.timezone}
      users={users}
      canSearchPatients={can(member, "contacts.view")}
      canLookUpEnquiries={can(member, "enquiries.view")}
      canViewEnquiries={can(member, "enquiries.view")}
    />
  );
}
