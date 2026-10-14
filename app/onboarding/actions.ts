"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { getCurrentMember, getCurrentUser, isMemberLookupError } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { seedFinanceSetup } from "@/lib/finance/seed";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
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

/** First-run only: creates the workspace with the seed roles (finance and accounting included) and makes the caller Admin. */
export async function createWorkspace(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  if (!serverEnv().ALLOW_WORKSPACE_CREATION)
    return { error: "Workspace creation is disabled. Ask an administrator for an invite." };
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Someone who already belongs to a workspace, or whose membership could not be checked, never creates another.
  try {
    if (await getCurrentMember()) redirect("/dashboard");
  } catch (e) {
    if (isMemberLookupError(e))
      return { error: "Could not check your existing workspaces. Try again in a minute." };
    throw e;
  }

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
  if (orgId) {
    await recordAudit(admin, {
      orgId,
      userId: user.id,
      action: "org.created",
      entity: "org",
      entityId: orgId,
    });
    // The finance and accounting roles come with SYSTEM_ROLES and the reference rows with the org triggers; this makes
    // sure of both with the same steps as `pnpm finance:seed`. A failure never fails the new workspace: an Admin can
    // run it again under Settings, Roles.
    try {
      await seedFinanceSetup(admin, orgId);
    } catch (err) {
      console.error("[onboarding] finance setup failed", { error: redactText(err, 100) });
    }
  }
  redirect("/dashboard");
}
