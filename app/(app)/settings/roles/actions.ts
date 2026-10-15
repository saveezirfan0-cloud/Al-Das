"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { isAssignablePermission } from "@/lib/auth/permissions";
import { requirePerm } from "@/lib/auth/session";
import { seedFinanceSetup } from "@/lib/finance/seed";
import { redactText } from "@/lib/redact";
import { raiseAlert } from "@/lib/security/alerts";
import { roleChangeAlert } from "@/lib/security/anomaly";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const roleSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(60),
  description: z.string().trim().max(240).default(""),
  permissions: z
    .array(z.string())
    .refine((ps) => ps.every(isAssignablePermission), "Unknown permission"),
});

export async function createRole(input: z.input<typeof roleSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("roles")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      permissions: parsed.data.permissions,
    })
    .select("id")
    .single();
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505"
          ? "A role with that name already exists."
          : "Could not create the role.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "role.created",
    entity: "role",
    entityId: data.id,
    diff: { name: parsed.data.name, permissions: parsed.data.permissions },
  });
  await raiseAlert(
    admin,
    member.orgId,
    roleChangeAlert({
      actorId: member.userId,
      kind: "role_created",
      targetId: data.id,
      roleName: parsed.data.name,
      grantsFullAccess: parsed.data.permissions.includes("*"),
      eventId: randomUUID(),
    }),
  );
  revalidatePath("/settings/roles");
  return { ok: true, message: "Role created." };
}

export async function updateRole(
  roleId: string,
  input: z.input<typeof roleSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("roles")
    .select("id, name, is_system, permissions")
    .eq("id", roleId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Role not found." };

  const wasAdmin = ((existing.permissions as unknown[]) ?? []).includes("*");
  if (wasAdmin && !parsed.data.permissions.includes("*"))
    return { ok: false, error: "The Admin role must keep full access." };

  const update = existing.is_system
    ? { description: parsed.data.description || null, permissions: parsed.data.permissions } // name is locked by trigger
    : {
        name: parsed.data.name,
        description: parsed.data.description || null,
        permissions: parsed.data.permissions,
      };
  const { error } = await admin.from("roles").update(update).eq("id", roleId);
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505"
          ? "A role with that name already exists."
          : "Could not update the role.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "role.updated",
    entity: "role",
    entityId: roleId,
    diff: { before: existing.permissions, after: parsed.data.permissions },
  });
  const sameSet =
    JSON.stringify([...(existing.permissions as string[])].sort()) ===
    JSON.stringify([...parsed.data.permissions].sort());
  if (!sameSet) {
    await raiseAlert(
      admin,
      member.orgId,
      roleChangeAlert({
        actorId: member.userId,
        kind: "role_permissions_changed",
        targetId: roleId,
        roleName: existing.name,
        grantsFullAccess: parsed.data.permissions.includes("*"),
        eventId: randomUUID(),
      }),
    );
  }
  revalidatePath("/settings/roles");
  revalidatePath("/", "layout");
  return { ok: true, message: "Role saved." };
}

export async function deleteRole(roleId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("roles")
    .select("id, name, is_system")
    .eq("id", roleId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Role not found." };
  if (existing.is_system) return { ok: false, error: "System roles can't be deleted." };
  const { count } = await admin
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("role_id", roleId);
  if ((count ?? 0) > 0)
    return {
      ok: false,
      error: `${count} member${count === 1 ? " has" : "s have"} this role. Reassign them first.`,
    };
  const { count: inviteCount } = await admin
    .from("invites")
    .select("id", { count: "exact", head: true })
    .eq("role_id", roleId)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if ((inviteCount ?? 0) > 0)
    return { ok: false, error: "Pending invites use this role. Revoke them first." };
  const { error } = await admin.from("roles").delete().eq("id", roleId);
  if (error) return { ok: false, error: "Could not delete the role." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "role.deleted",
    entity: "role",
    entityId: roleId,
    diff: { name: existing.name },
  });
  await raiseAlert(
    admin,
    member.orgId,
    roleChangeAlert({
      actorId: member.userId,
      kind: "role_deleted",
      targetId: roleId,
      roleName: existing.name,
      eventId: randomUUID(),
    }),
  );
  revalidatePath("/settings/roles");
  return { ok: true, message: "Role deleted." };
}

/**
 * Adds the Finance, Insurance, CEO, Cost/Payroll and Accounting role presets and the finance reference rows, as
 * `pnpm finance:seed` does (for a workspace that was created without them). Admin only: settings.manage like every
 * role change, plus full access, because these roles carry finance and accounting rights. Idempotent: roles that
 * already exist (same name) are left as they are.
 */
export async function addFinanceRoles(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!member.permissions.includes("*"))
    return { ok: false, error: "Only an administrator can add the finance and accounting roles." };
  const admin = createAdminClient(member.userId);
  let rolesAdded: number;
  try {
    ({ rolesAdded } = await seedFinanceSetup(admin, member.orgId));
  } catch (err) {
    console.error("[roles] finance setup failed", { error: redactText(err, 100) });
    return { ok: false, error: "Could not add the finance and accounting roles." };
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "role.finance_presets_added",
    entity: "role",
    diff: { roles_added: rolesAdded },
  });
  revalidatePath("/settings/roles");
  return {
    ok: true,
    message: rolesAdded
      ? `${rolesAdded} role${rolesAdded === 1 ? "" : "s"} added.`
      : "All finance and accounting roles were already there.",
  };
}
