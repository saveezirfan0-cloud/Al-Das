import { permissionMatches } from "@/lib/auth/permissions";

/** The minimum a permission check needs; produced by lib/auth/session.ts. */
export type MemberLike = {
  userId: string;
  orgId: string;
  roleId: string;
  roleName?: string;
  status: "active" | "suspended";
  permissions: readonly string[];
};

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(public readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

/** True when the member's role grants the permission. Suspended members have no permissions. */
export function can(member: MemberLike | null | undefined, permission: string): boolean {
  if (!member || member.status !== "active") return false;
  if (!Array.isArray(member.permissions)) return false;
  return member.permissions.some(
    (granted) => typeof granted === "string" && permissionMatches(granted, permission),
  );
}

/** True when the member has every listed permission. */
export function canAll(
  member: MemberLike | null | undefined,
  permissions: readonly string[],
): boolean {
  return permissions.every((p) => can(member, p));
}

/** True when the member has at least one of the listed permissions. */
export function canAny(
  member: MemberLike | null | undefined,
  permissions: readonly string[],
): boolean {
  return permissions.some((p) => can(member, p));
}

/** Throws ForbiddenError unless the permission is granted. Use at the top of every mutation. */
export function assertCan(
  member: MemberLike | null | undefined,
  permission: string,
): asserts member is MemberLike {
  if (!can(member, permission)) throw new ForbiddenError(permission);
}
