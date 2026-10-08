"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { hashInviteToken, inviteState } from "@/lib/invites/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type AcceptState = { error?: string } | undefined;

const acceptSchema = z.object({
  token: z.string().min(10),
  first_name: z.string().trim().min(1, "First name is required").max(80),
  last_name: z.string().trim().max(80).default(""),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128)
    .optional()
    .or(z.literal("")),
});

/**
 * Accepts an invite. Two paths:
 *  - signed out: creates the auth user (email from the invite) with the given password
 *  - signed in with the invited email: just joins the org
 */
export async function acceptInvite(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const parsed = acceptSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { token, first_name, last_name, password } = parsed.data;

  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("invites")
    .select("*")
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  if (!invite) return { error: "This invite link is not valid." };
  const state = inviteState(invite);
  if (state !== "valid")
    return {
      error: `This invite has ${state === "accepted" ? "already been used" : state === "expired" ? "expired" : "been revoked"}.`,
    };

  const supabase = await createClient();
  const {
    data: { user: current },
  } = await supabase.auth.getUser();

  let userId: string;
  if (current) {
    if ((current.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
      return {
        error: `You are signed in as a different account. Sign out and open the link again.`,
      };
    }
    userId = current.id;
  } else {
    if (!password) return { error: "Choose a password to create your account." };
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true,
      user_metadata: { first_name, last_name },
    });
    if (createErr || !created.user) {
      // Likely: account already exists → ask them to sign in first.
      return {
        error:
          "An account with this email already exists. Sign in, then open the invite link again.",
      };
    }
    userId = created.user.id;
  }

  // Profile name (the auth trigger created the row; this sets the name for both paths).
  await admin.from("profiles").update({ first_name, last_name }).eq("id", userId);

  const { error: memErr } = await admin
    .from("memberships")
    .upsert(
      { org_id: invite.org_id, user_id: userId, role_id: invite.role_id, status: "active" },
      { onConflict: "org_id,user_id" },
    );
  if (memErr)
    return {
      error: "Could not add you to the workspace. Ask your administrator to resend the invite.",
    };

  if (invite.team_ids.length > 0) {
    await admin.from("team_members").upsert(
      invite.team_ids.map((team_id) => ({ org_id: invite.org_id, team_id, user_id: userId })),
      { onConflict: "team_id,user_id", ignoreDuplicates: true },
    );
  }

  await admin
    .from("invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
    .eq("id", invite.id);
  await recordAudit(admin, {
    orgId: invite.org_id,
    userId,
    action: "invite.accepted",
    entity: "invite",
    entityId: invite.id,
    diff: { role_id: invite.role_id, team_ids: invite.team_ids },
  });

  if (!current) {
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: invite.email,
      password: password!,
    });
    if (signInErr) redirect("/login");
  }
  redirect("/dashboard");
}
