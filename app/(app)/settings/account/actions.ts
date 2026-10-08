"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requireMember } from "@/lib/auth/session";
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

  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "password.changed",
    entity: "profile",
    entityId: member.userId,
  });
  return { message: "Password updated." };
}
