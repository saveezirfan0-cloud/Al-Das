"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type OnboardingState = { error?: string } | undefined;

const schema = z.object({
  name: z.string().trim().min(2, "Workspace name is too short").max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/,
      "Use 3–40 lowercase letters, numbers or dashes",
    ),
});

/** First-run only: creates the workspace with the seed roles and makes the caller Admin. */
export async function createWorkspace(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  if (!serverEnv().ALLOW_WORKSPACE_CREATION)
    return { error: "Workspace creation is disabled. Ask an administrator for an invite." };
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const admin = createAdminClient();
  const limited = await checkRateLimit(admin, "workspace-create", user.id, RATE_RULES.workspaceCreatePerUser);
  if (!limited.allowed)
    return { error: `Too many attempts. Try again in ${waitText(limited.retryAfter)}.` };
  const { data: orgId, error } = await admin.rpc("create_org", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_roles: SYSTEM_ROLES.map((r) => ({
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
    p_owner_id: user.id,
  });
  if (error) {
    if (error.code === "23505") return { error: "That workspace URL is taken. Pick another." };
    return { error: "Could not create the workspace." };
  }
  if (orgId)
    await recordAudit(admin, {
      orgId,
      userId: user.id,
      action: "org.created",
      entity: "org",
      entityId: orgId,
    });
  redirect("/dashboard");
}
