"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { getCurrentMember, getCurrentUser } from "@/lib/auth/session";
import { recordAuthEvent } from "@/lib/security/auth-events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type MfaResult = { ok: true } | { ok: false; error: string };

/** True when the signed-in session is at aal2 and the user holds a verified authenticator-app factor. */
async function hasVerifiedSession(): Promise<boolean> {
  const supabase = await createClient();
  const [{ data: aal }, { data: factors }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  return aal?.currentLevel === "aal2" && (factors?.totp.length ?? 0) > 0;
}

/**
 * Called by the enrolment page after the browser verified the first code. Supabase Auth did the real
 * work; this checks the result server-side and writes the auth event and the audit entry.
 */
export async function confirmMfaEnrolled(): Promise<MfaResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!(await hasVerifiedSession()))
    return { ok: false, error: "The code was not verified. Try again." };
  const member = await getCurrentMember();
  const admin = createAdminClient();
  await recordAuthEvent(admin, {
    type: "mfa_enrolled",
    userId: user.id,
    orgId: member?.orgId ?? null,
    method: "mfa",
    headers: await headers(),
  });
  if (member) {
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: user.id,
      action: "mfa.enrolled",
      entity: "profile",
      entityId: user.id,
    });
  }
  return { ok: true };
}

/** Called after a successful challenge at sign-in. */
export async function confirmMfaVerified(): Promise<MfaResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!(await hasVerifiedSession()))
    return { ok: false, error: "The code was not verified. Try again." };
  const member = await getCurrentMember();
  await recordAuthEvent(createAdminClient(), {
    type: "mfa_verified",
    userId: user.id,
    orgId: member?.orgId ?? null,
    method: "mfa",
    headers: await headers(),
  });
  return { ok: true };
}

const factorSchema = z.string().uuid();

/** Removes one of the caller's own authenticator apps. Supabase Auth itself demands an aal2 session. */
export async function removeMfaFactor(factorId: string): Promise<MfaResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!factorSchema.safeParse(factorId).success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error)
    return {
      ok: false,
      error: "Could not remove the authenticator. Verify your code again, then retry.",
    };
  const member = await getCurrentMember();
  const admin = createAdminClient();
  await recordAuthEvent(admin, {
    type: "mfa_removed",
    userId: user.id,
    orgId: member?.orgId ?? null,
    method: "mfa",
    headers: await headers(),
  });
  if (member) {
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: user.id,
      action: "mfa.removed",
      entity: "profile",
      entityId: user.id,
    });
  }
  return { ok: true };
}
