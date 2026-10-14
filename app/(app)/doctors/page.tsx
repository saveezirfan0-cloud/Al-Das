import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { readBranchAccess } from "@/lib/branches/access";
import { branchView } from "@/lib/branches/server";
import { loadDoctors } from "@/lib/organisation/server";
import { readOrganisationSettings } from "@/lib/organisation/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { DoctorsWorkspace } from "./doctors-workspace";

export const metadata = { title: "Doctors" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The doctors directory (Phase C): every doctor in the branches this person may see, with specialty, branches,
 * services, licence expiry, linked user, working hours and today's appointment count. Read-only data from
 * Settings, Appointments; only the profile and licence fields are edited here (settings.manage or hr.manage).
 */
export default async function DoctorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  if (!canAny(member, ["appointments.view", "hr.view"]))
    throw new ForbiddenError("appointments.view");
  const sp = await searchParams;
  const open = typeof sp.doctor === "string" && UUID_RE.test(sp.doctor) ? sp.doctor : null;

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("settings, timezone")
    .eq("id", member.orgId)
    .single();
  const timezone = org?.timezone ?? member.org.timezone ?? "Asia/Dubai";
  const access = readBranchAccess(member);
  const { rows, branches, today } = await loadDoctors(admin, member.orgId, timezone, access);
  const branch = await branchView(
    member,
    branches.map((b) => b.id),
  );

  return (
    <DoctorsWorkspace
      rows={rows}
      branches={branches}
      today={today}
      leadDays={readOrganisationSettings(org?.settings).expiry_lead_days}
      initialBranch={branch.current}
      openId={open}
      can={{
        edit: canAny(member, ["settings.manage", "hr.manage"]),
        calendar: can(member, "appointments.view"),
        settings: can(member, "settings.manage"),
        rota: canAny(member, ["hr.view", "appointments.view"]),
        revenue: can(member, "finance.revenue.view"),
        revshare: canAny(member, [
          "finance.revshare.view",
          "finance.revshare.manage",
          "finance.revshare.verify",
          "finance.revshare.approve",
        ]),
      }}
    />
  );
}
