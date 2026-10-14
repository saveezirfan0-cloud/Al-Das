import { can, canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { readBranchAccess } from "@/lib/branches/access";
import { branchView } from "@/lib/branches/server";
import {
  loadBranches,
  loadDepartments,
  loadMemberOptions,
  loadStaff,
  todayWindow,
} from "@/lib/organisation/server";
import { readOrganisationSettings } from "@/lib/organisation/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { StaffWorkspace } from "./staff-workspace";

export const metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The staff directory (Phase C, hr.view): job, department, home branch, manager, employment type and the visa and
 * licence expiry badges; the drawer edits the record (hr.manage, audited), its duties and shows its shifts. People
 * limited to some branches see the staff whose home branch they work in. Pay is never shown here.
 */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("hr.view");
  const sp = await searchParams;
  const open = typeof sp.staff === "string" && UUID_RE.test(sp.staff) ? sp.staff : null;
  const manage = can(member, "hr.manage");

  const admin = createAdminClient();
  const access = readBranchAccess(member);
  const [{ data: org }, staff, branches, departments, members, { data: specialists }] =
    await Promise.all([
      admin.from("orgs").select("settings, timezone").eq("id", member.orgId).single(),
      loadStaff(admin, member.orgId, access, { includeArchived: manage }),
      loadBranches(admin, member.orgId, access),
      loadDepartments(admin, member.orgId),
      manage ? loadMemberOptions(admin, member.orgId) : Promise.resolve([]),
      admin
        .from("specialists")
        .select("id, name")
        .eq("org_id", member.orgId)
        .eq("active", true)
        .order("name"),
    ]);
  const branch = await branchView(
    member,
    branches.allowed.map((b) => b.id),
  );
  const timezone = org?.timezone ?? member.org.timezone ?? "Asia/Dubai";

  return (
    <StaffWorkspace
      rows={staff}
      branches={branches.allowed}
      departments={departments}
      members={members}
      specialists={(specialists ?? []).map((s) => ({ value: s.id, label: s.name }))}
      today={todayWindow(timezone).today}
      leadDays={readOrganisationSettings(org?.settings).expiry_lead_days}
      initialBranch={branch.current}
      openId={open}
      can={{
        manage,
        rota: canAny(member, ["hr.view", "appointments.view"]),
      }}
    />
  );
}
