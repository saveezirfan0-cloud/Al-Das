import "server-only";

import type { ClinicFacts, WhatsAppFacts } from "@/lib/golive/readiness";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The facts behind the clinic set-up rows (Go-live checklist and the dashboard's first-run card): head counts only, no
 * row leaves the database. Service role, so the caller has already checked settings.manage; `staff` is asked for only
 * when the viewer holds hr.view.
 */
export async function loadClinicSetupFacts(
  admin: AdminClient,
  orgId: string,
  opts: { staff: boolean },
): Promise<{ clinic: ClinicFacts; whatsapp: WhatsAppFacts }> {
  const head = { count: "exact" as const, head: true };
  const [
    locations,
    locationsWithCode,
    services,
    doctors,
    doctorsWithHours,
    doctorsLinked,
    members,
    invites,
    staff,
    channels,
  ] = await Promise.all([
    admin.from("locations").select("id", head).eq("org_id", orgId).eq("active", true),
    admin
      .from("locations")
      .select("id", head)
      .eq("org_id", orgId)
      .eq("active", true)
      .not("branch_code", "is", null),
    admin.from("services").select("id", head).eq("org_id", orgId).eq("active", true),
    admin.from("specialists").select("id", head).eq("org_id", orgId).eq("active", true),
    admin
      .from("specialists")
      .select("id, working_hours!inner(id)", head)
      .eq("org_id", orgId)
      .eq("active", true),
    admin
      .from("specialists")
      .select("id", head)
      .eq("org_id", orgId)
      .eq("active", true)
      .not("user_id", "is", null),
    admin.from("memberships").select("id", head).eq("org_id", orgId),
    admin
      .from("invites")
      .select("id", head)
      .eq("org_id", orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
    opts.staff
      ? admin.from("staff_members").select("id", head).eq("org_id", orgId).is("deleted_at", null)
      : null,
    admin.from("channels").select("status").eq("org_id", orgId).eq("type", "whatsapp"),
  ]);
  const channelRows = channels.data ?? [];
  return {
    clinic: {
      locations: locations.count ?? 0,
      locationsWithCode: locationsWithCode.count ?? 0,
      services: services.count ?? 0,
      doctors: doctors.count ?? 0,
      doctorsWithHours: doctorsWithHours.count ?? 0,
      doctorsLinked: doctorsLinked.count ?? 0,
      members: members.count ?? 0,
      pendingInvites: invites.count ?? 0,
      staff: staff ? (staff.count ?? 0) : null,
    },
    whatsapp: {
      channels: channelRows.length,
      active: channelRows.filter((c) => c.status === "active").length,
    },
  };
}
