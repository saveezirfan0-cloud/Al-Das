"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { sendEmail } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { generateInviteToken, inviteExpiry, inviteUrl } from "@/lib/invites/token";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult =
  { ok: true; message?: string; link?: string } | { ok: false; error: string };

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role_id: z.string().uuid("Pick a role"),
  team_ids: z.array(z.string().uuid()).default([]),
});

/** Why an invite email didn't go out, in words an admin can act on. */
function undeliveredMessage(reason: string, shareHint: string): string {
  return reason === "email_not_configured"
    ? `Email isn't configured, so ${shareHint}`
    : `The email couldn't be sent (${reason}). ${shareHint[0].toUpperCase()}${shareHint.slice(1)}`;
}

async function deliverInvite(opts: {
  email: string;
  link: string;
  orgName: string;
  roleName: string;
  inviterName: string;
}) {
  const text = [
    `${opts.inviterName} invited you to join ${opts.orgName} on Pulse as ${opts.roleName}.`,
    ``,
    `Accept the invite: ${opts.link}`,
    ``,
    `The link expires in 7 days. If you weren't expecting this, you can ignore it.`,
  ].join("\n");
  return sendEmail({ to: opts.email, subject: `You're invited to ${opts.orgName} on Pulse`, text });
}

export async function inviteUser(input: {
  email: string;
  role_id: string;
  team_ids: string[];
}): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { email, role_id, team_ids } = parsed.data;
  const admin = createAdminClient();

  const { data: role } = await admin
    .from("roles")
    .select("id, name")
    .eq("id", role_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!role) return { ok: false, error: "That role does not exist in this workspace." };

  if (team_ids.length > 0) {
    const { count } = await admin
      .from("teams")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .in("id", team_ids);
    if ((count ?? 0) !== team_ids.length)
      return { ok: false, error: "One of the teams does not exist in this workspace." };
  }

  // Already a member?
  const { data: existingUsers } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .limit(1);
  if (existingUsers && existingUsers.length > 0) {
    const { data: existing } = await admin
      .from("memberships")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("user_id", existingUsers[0].id)
      .maybeSingle();
    if (existing) return { ok: false, error: "That person is already a member of this workspace." };
  }

  // Supersede any open invite for the same email.
  await admin
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("org_id", member.orgId)
    .ilike("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null);

  const { token, hash } = generateInviteToken();
  const { data: invite, error } = await admin
    .from("invites")
    .insert({
      org_id: member.orgId,
      email,
      role_id,
      team_ids,
      token_hash: hash,
      invited_by: member.userId,
      expires_at: inviteExpiry().toISOString(),
    })
    .select("id")
    .single();
  if (error || !invite) return { ok: false, error: "Could not create the invite." };

  const link = inviteUrl(serverEnv().APP_URL, token);
  const inviterName =
    `${member.profile.first_name} ${member.profile.last_name}`.trim() ||
    member.user.email ||
    "An administrator";
  const delivery = await deliverInvite({
    email,
    link,
    orgName: member.org.name,
    roleName: role.name,
    inviterName,
  });

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "invite.created",
    entity: "invite",
    entityId: invite.id,
    diff: { role_id, team_ids, delivered: delivery.delivered },
  });
  revalidatePath("/settings/users");
  return delivery.delivered
    ? { ok: true, message: `Invite sent to ${email}.` }
    : {
        ok: true,
        message: undeliveredMessage(delivery.reason, "share this link with them directly."),
        link,
      };
}

export async function resendInvite(inviteId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data: old } = await admin
    .from("invites")
    .select("*, roles(name)")
    .eq("id", inviteId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!old || old.accepted_at) return { ok: false, error: "Invite not found." };

  // Rotate the token (the old link stops working).
  const { token, hash } = generateInviteToken();
  await admin.from("invites").update({ revoked_at: new Date().toISOString() }).eq("id", old.id);
  const { data: invite, error } = await admin
    .from("invites")
    .insert({
      org_id: member.orgId,
      email: old.email,
      role_id: old.role_id,
      team_ids: old.team_ids,
      token_hash: hash,
      invited_by: member.userId,
      expires_at: inviteExpiry().toISOString(),
    })
    .select("id")
    .single();
  if (error || !invite) return { ok: false, error: "Could not resend the invite." };

  const link = inviteUrl(serverEnv().APP_URL, token);
  const inviterName =
    `${member.profile.first_name} ${member.profile.last_name}`.trim() || "An administrator";
  const delivery = await deliverInvite({
    email: old.email,
    link,
    orgName: member.org.name,
    roleName: old.roles?.name ?? "member",
    inviterName,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "invite.resent",
    entity: "invite",
    entityId: invite.id,
    diff: { previous: old.id },
  });
  revalidatePath("/settings/users");
  return delivery.delivered
    ? { ok: true, message: "Invite resent." }
    : {
        ok: true,
        message: undeliveredMessage(delivery.reason, "share this link directly."),
        link,
      };
}

export async function revokeInvite(inviteId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("org_id", member.orgId)
    .is("accepted_at", null)
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Invite not found." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "invite.revoked",
    entity: "invite",
    entityId: inviteId,
  });
  revalidatePath("/settings/users");
  return { ok: true, message: "Invite revoked." };
}

async function adminCount(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<number> {
  const { data } = await admin
    .from("memberships")
    .select("id, roles!inner(permissions)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (data ?? []).filter((m) => ((m.roles?.permissions as unknown[]) ?? []).includes("*"))
    .length;
}

export async function changeMemberRole(
  membershipId: string,
  roleId: string,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [{ data: target }, { data: role }] = await Promise.all([
    admin
      .from("memberships")
      .select("id, user_id, role_id, roles(permissions)")
      .eq("id", membershipId)
      .eq("org_id", member.orgId)
      .maybeSingle(),
    admin
      .from("roles")
      .select("id, name, permissions")
      .eq("id", roleId)
      .eq("org_id", member.orgId)
      .maybeSingle(),
  ]);
  if (!target || !role) return { ok: false, error: "Member or role not found." };
  const wasAdmin = ((target.roles?.permissions as unknown[]) ?? []).includes("*");
  const willBeAdmin = ((role.permissions as unknown[]) ?? []).includes("*");
  if (wasAdmin && !willBeAdmin && (await adminCount(admin, member.orgId)) <= 1) {
    return {
      ok: false,
      error: "This is the last administrator. Give someone else the Admin role first.",
    };
  }
  const { error } = await admin
    .from("memberships")
    .update({ role_id: roleId })
    .eq("id", membershipId);
  if (error) return { ok: false, error: "Could not change the role." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.role_changed",
    entity: "membership",
    entityId: membershipId,
    diff: { from: target.role_id, to: roleId, user_id: target.user_id },
  });
  revalidatePath("/settings/users");
  return { ok: true, message: `Role changed to ${role.name}.` };
}

export async function setMemberStatus(
  membershipId: string,
  status: "active" | "suspended",
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (membershipId === member.membershipId)
    return { ok: false, error: "You can't suspend your own account." };
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("memberships")
    .select("id, user_id, roles(permissions)")
    .eq("id", membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  if (
    status === "suspended" &&
    ((target.roles?.permissions as unknown[]) ?? []).includes("*") &&
    (await adminCount(admin, member.orgId)) <= 1
  ) {
    return { ok: false, error: "This is the last administrator." };
  }
  const { error } = await admin
    .from("memberships")
    .update({ status, presence: "offline" })
    .eq("id", membershipId);
  if (error) return { ok: false, error: "Could not update the member." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: status === "suspended" ? "membership.suspended" : "membership.reactivated",
    entity: "membership",
    entityId: membershipId,
    diff: { user_id: target.user_id },
  });
  revalidatePath("/settings/users");
  return { ok: true, message: status === "suspended" ? "Access suspended." : "Access restored." };
}

export async function removeMember(membershipId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (membershipId === member.membershipId)
    return { ok: false, error: "You can't remove your own account." };
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("memberships")
    .select("id, user_id, roles(permissions)")
    .eq("id", membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  if (
    ((target.roles?.permissions as unknown[]) ?? []).includes("*") &&
    (await adminCount(admin, member.orgId)) <= 1
  ) {
    return { ok: false, error: "This is the last administrator." };
  }
  await admin
    .from("team_members")
    .delete()
    .eq("org_id", member.orgId)
    .eq("user_id", target.user_id);
  const { error } = await admin.from("memberships").delete().eq("id", membershipId);
  if (error) return { ok: false, error: "Could not remove the member." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.removed",
    entity: "membership",
    entityId: membershipId,
    diff: { user_id: target.user_id },
  });
  revalidatePath("/settings/users");
  return { ok: true, message: "Member removed." };
}
