/** Who may open a task (pure): tasks.view plus the branch rule of tasks RLS (app.location_visible_to). */
import { permissionMatches } from "@/lib/auth/permissions";
import { canSeeLocation, parseBranchScope } from "@/lib/branches/access";

/** A membership as read for notifications: permissions, branch scope and branches. */
export type TaskAudienceMember = {
  user_id: string;
  branch_scope: string | null;
  permissions: readonly unknown[];
  locations: readonly string[];
};

export function memberCanSeeTask(m: TaskAudienceMember, locationId: string | null): boolean {
  const viewer = m.permissions.some(
    (p) => typeof p === "string" && permissionMatches(p, "tasks.view"),
  );
  if (!viewer) return false;
  return canSeeLocation(
    { scope: parseBranchScope(m.branch_scope), ids: m.locations, home: null },
    locationId,
  );
}
