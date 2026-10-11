import { PORTAL_OBJECT_PERMISSION_RE, permissionMatches } from "@/lib/auth/permissions";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import type { PortalObjectDef } from "@/lib/portal/types";

/** Extra non-portal keys the portal's write permissions can point at. */
const EXTRA_KEYS = new Set(["clinical.settings.manage"]);

export function isPortalPermissionKey(key: string): boolean {
  return PORTAL_OBJECT_PERMISSION_RE.test(key) || EXTRA_KEYS.has(key);
}

/** Every per-object permission key a role editor should offer. */
export function portalObjectPermissionKeys(): Array<{
  key: string;
  label: string;
  object: string;
}> {
  const out: Array<{ key: string; label: string; object: string }> = [];
  for (const o of PORTAL_OBJECTS) {
    out.push({ key: o.readPerm, label: `${o.label}: read`, object: o.key });
    if (o.writePerm) out.push({ key: o.writePerm, label: `${o.label}: edit`, object: o.key });
  }
  return out;
}

type Granted = { permissions: readonly string[]; status?: string | null } | null | undefined;

function has(member: Granted, perm: string): boolean {
  if (!member || (member.status && member.status !== "active")) return false;
  return member.permissions.some((g) => permissionMatches(g, perm));
}

export function canReadObject(member: Granted, def: PortalObjectDef): boolean {
  return has(member, def.readPerm);
}

/** Editing needs the object's write key; `portal.*` (Manager) covers both read and write. */
export function canWriteObject(member: Granted, def: PortalObjectDef): boolean {
  return !!def.writePerm && has(member, def.writePerm);
}

export function readableObjects(member: Granted): PortalObjectDef[] {
  return PORTAL_OBJECTS.filter((o) => canReadObject(member, o));
}
