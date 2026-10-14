/**
 * Where a signed-in person lands (pure). The Receptionist role opens on the Front desk, the Doctor role on My day;
 * everyone else on the dashboard. A role that has lost the permission its page needs falls back to the dashboard
 * rather than a page it cannot open.
 */
import { can, type MemberLike } from "@/lib/auth/can";

export const FRONT_DESK_PATH = "/front-desk";
export const MY_DAY_PATH = "/my-day";
export const DEFAULT_LANDING_PATH = "/dashboard";

export function landingPathFor(
  member: Pick<MemberLike, "status" | "permissions"> & { roleName?: string },
): string {
  const role = (member.roleName ?? "").trim().toLowerCase();
  if (role === "receptionist" && can(member as MemberLike, "frontdesk.use")) return FRONT_DESK_PATH;
  if (role === "doctor" && can(member as MemberLike, "appointments.view")) return MY_DAY_PATH;
  return DEFAULT_LANDING_PATH;
}
