"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requireMember } from "@/lib/auth/session";
import { recordAuthEvent } from "@/lib/security/auth-events";
import { endSessionRows, type SessionScope } from "@/lib/security/sessions";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type FormState = { error?: string; message?: string } | undefined;

const profileSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required").max(80),
  last_name: z.string().trim().max(80).default(""),
  designation: z.string().trim().max(120).default(""),
  timezone: z.string().trim().max(64).default(""),
  language: z.enum(["en", "ar"]).default("en"),
});

export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const member = await requireMember();
  const parsed = profileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;

  // Own profile: the user's client is enough (RLS: id = auth.uid()).
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      first_name: d.first_name,
      last_name: d.last_name,
      designation: d.designation || null,
      timezone: d.timezone || null,
      language: d.language,
    })
    .eq("id", member.userId);
  if (error) return { error: "Could not save your profile." };

  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "profile.updated",
    entity: "profile",
    entityId: member.userId,
    diff: { fields: ["first_name", "last_name", "designation", "timezone", "language"] },
  });
  revalidatePath("/", "layout");
  return { message: "Profile saved." };
}

const passwordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const member = await requireMember();
  const parsed = passwordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };

  const admin = createAdminClient();
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "password.changed",
    entity: "profile",
    entityId: member.userId,
  });
  await recordAuthEvent(admin, {
    type: "password_changed",
    userId: member.userId,
    orgId: member.orgId,
    method: "password",
    headers: await headers(),
  });
  return { message: "Password updated." };
}

const SCOPES = { this_device: "local", others: "others", everywhere: "global" } as const;

async function endSessions(scope: SessionScope): Promise<void> {
  const member = await requireMember();
  const supabase = await createClient();
  const admin = createAdminClient();
  // Mark our device rows first: after a global sign-out the session that identifies "this device" is gone.
  await endSessionRows(admin, supabase, member, scope);
  await recordAuthEvent(admin, {
    type:
      scope === "everywhere"
        ? "sign_out_everywhere"
        : scope === "others"
          ? "session_revoked"
          : "sign_out",
    userId: member.userId,
    orgId: member.orgId,
    headers: await headers(),
  });
  if (scope !== "this_device") {
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action:
        scope === "everywhere" ? "session.signed_out_everywhere" : "session.signed_out_others",
      entity: "profile",
      entityId: member.userId,
    });
  }
  await supabase.auth.signOut({ scope: SCOPES[scope] });
  if (scope !== "others") redirect("/login");
  revalidatePath("/settings/account");
}

/** Signs this browser out. Other devices stay signed in. */
export async function signOutThisDevice(): Promise<void> {
  await endSessions("this_device");
}

/** Signs out every other device and keeps this one. */
export async function signOutOtherDevices(): Promise<void> {
  await endSessions("others");
}

/** Signs out every device, including this one. */
export async function signOutEverywhere(): Promise<void> {
  await endSessions("everywhere");
}
