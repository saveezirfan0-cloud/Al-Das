"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  financeAccessSchema,
  readFinanceAccess,
  writeFinanceAccess,
  type FinanceAccessInput,
} from "@/lib/security/finance-access";
import {
  securitySettingsSchema,
  writeSecuritySettings,
  readSecuritySettings,
} from "@/lib/security/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/security";

/** Turns "two-step verification required" on or off for every member holding a role. */
export async function setRoleRequireMfa(roleId: string, required: boolean): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  if (!z.string().uuid().safeParse(roleId).success || typeof required !== "boolean") {
    return { ok: false, error: "Invalid input" };
  }
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("roles")
    .update({ require_mfa: required })
    .eq("id", roleId)
    .eq("org_id", member.orgId)
    .select("id, name");
  if (error || !data?.length) return { ok: false, error: "Role not found." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: required ? "role.mfa_required" : "role.mfa_optional",
    entity: "role",
    entityId: roleId,
    diff: { name: data[0].name, require_mfa: required },
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message: required
      ? `${data[0].name}: members without an authenticator app are asked to set one up at their next page view.`
      : `${data[0].name}: two-step verification is optional again.`,
  };
}

/** Retention, sampling and alert thresholds (stored in orgs.settings.security). */
export async function saveSecuritySettings(
  input: z.input<typeof securitySettingsSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const parsed = securitySettingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const before = readSecuritySettings(org?.settings);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeSecuritySettings(org?.settings, parsed.data) as never })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the settings." };
  const changed = Object.keys(parsed.data).filter(
    (k) =>
      JSON.stringify(parsed.data[k as keyof typeof parsed.data]) !==
      JSON.stringify(before[k as keyof typeof before]),
  );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "security_settings.updated",
    entity: "org",
    entityId: member.orgId,
    diff: { changed },
  });
  revalidatePath(PATH);
  revalidatePath("/", "layout");
  return { ok: true, message: "Security settings saved." };
}

/**
 * Finance access window (orgs.settings.finance_access): days, hours, address list and the roles it covers. Admin is
 * never restricted, whatever is saved. The audit row carries what changed and counts, not the addresses.
 */
export async function saveFinanceAccessWindow(input: FinanceAccessInput): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const parsed = financeAccessSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const next = parsed.data;
  const admin = createAdminClient(member.userId);

  if (next.role_ids.length > 0) {
    const { data: roles, error: rolesError } = await admin
      .from("roles")
      .select("id")
      .eq("org_id", member.orgId)
      .in("id", next.role_ids);
    if (rolesError) return { ok: false, error: "Could not check the roles." };
    if ((roles ?? []).length !== next.role_ids.length)
      return {
        ok: false,
        error: "One of the chosen roles no longer exists. Reload and try again.",
      };
  }

  const { data: org, error: orgError } = await admin
    .from("orgs")
    .select("settings")
    .eq("id", member.orgId)
    .single();
  if (orgError || !org) return { ok: false, error: "Could not load the settings." };
  const stored = readFinanceAccess(org.settings);
  const before = stored.ok ? stored.settings : null;
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeFinanceAccess(org.settings, next) as never })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the finance access window." };

  const changed = before
    ? (Object.keys(next) as Array<keyof typeof next>).filter(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]),
      )
    : ["unreadable_before"];
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance_access_window.updated",
    entity: "org",
    entityId: member.orgId,
    diff: {
      changed,
      enabled: next.enabled,
      limit_hours: next.limit_hours,
      days: next.days,
      start: next.start,
      end: next.end,
      address_entries: next.ip_allowlist.length,
      scope: next.scope,
      role_count: next.role_ids.length,
    },
  });
  revalidatePath(PATH);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: next.enabled
      ? "Finance access window saved. It applies from the next page anyone opens."
      : "Finance access window saved and switched off.",
  };
}
