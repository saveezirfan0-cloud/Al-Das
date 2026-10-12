/**
 * Where a signed-in person lands (pure). The Receptionist role opens on the Front desk; everyone else on the
 * dashboard. A role named Receptionist that has lost the front desk permission falls back to the dashboard
 * rather than a page it cannot open.
 */
import { can, type MemberLike } from "@/lib/auth/can";

export const FRONT_DESK_PATH = "/front-desk";
export const DEFAULT_LANDING_PATH = "/dashboard";

export function landingPathFor(
  member: Pick<MemberLike, "status" | "permissions"> & { roleName?: string },
): string {
  const isReceptionist = (member.roleName ?? "").trim().toLowerCase() === "receptionist";
  if (isReceptionist && can(member as MemberLike, "frontdesk.use")) return FRONT_DESK_PATH;
  return DEFAULT_LANDING_PATH;
}
