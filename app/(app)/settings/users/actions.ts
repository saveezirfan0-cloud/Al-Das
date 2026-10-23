"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { sendEmail } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { generateInviteToken, inviteExpiry, inviteUrl } from "@/lib/invites/token";
import { enquiryViewScopeSchema } from "@/lib/enquiries/scope";
import { cleanMenuHidden } from "@/lib/nav/menu-visibility";
import { createNotification } from "@/lib/notifications";
import { raiseAlert } from "@/lib/security/alerts";
import { roleChangeAlert } from "@/lib/security/anomaly";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult =
  { ok: true; message?: string; link?: string } | { ok: false; error: string };

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role_id: z.string().uuid("Pick a role"),
  team_ids: z.array(z.string().uuid()).default([]),
  /** Menu entries hidden for this person (lib/nav/menu-visibility.ts); unknown values are dropped. */
  menu_hidden: z.array(z.string().max(200)).max(64).default([]),
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
  menu_hidden?: string[];
}): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { email, role_id, team_ids } = parsed.data;
  const menu_hidden = cleanMenuHidden(parsed.data.menu_hidden);
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
      menu_hidden,
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
    diff: { role_id, team_ids, menu_hidden, delivered: delivery.delivered },
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
      menu_hidden: old.menu_hidden,
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
  await raiseAlert(
    admin,
    member.orgId,
    roleChangeAlert({
      actorId: member.userId,
      kind: "member_role_changed",
      targetId: target.user_id,
      roleName: role.name,
      grantsFullAccess: willBeAdmin,
      eventId: randomUUID(),
    }),
  );
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

const memberRoutingSchema = z.object({
  membershipId: z.string().uuid(),
  max_open_conversations: z.number().int().min(1).max(500).nullable(),
  enquiry_scope: enquiryViewScopeSchema,
});

/**
 * Phase 20c: a member's open conversation limit (round-robin skips them at the limit; people can still assign by hand)
 * and their enquiry view (all / team / own, enforced in RLS by app.enquiry_visible_to).
 */
export async function setMemberRouting(
  membershipId: string,
  input: { max_open_conversations: number | null; enquiry_scope: string },
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = memberRoutingSchema.safeParse({ membershipId, ...input });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient(member.userId);
  const { data: target } = await admin
    .from("memberships")
    .select("id, user_id, max_open_conversations, enquiry_scope")
    .eq("id", parsed.data.membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  const { error } = await admin
    .from("memberships")
    .update({
      max_open_conversations: parsed.data.max_open_conversations,
      enquiry_scope: parsed.data.enquiry_scope,
    })
    .eq("id", target.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the member's routing settings." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.routing_updated",
    entity: "membership",
    entityId: target.id,
    diff: {
      user_id: target.user_id,
      max_open_conversations: {
        from: target.max_open_conversations,
        to: parsed.data.max_open_conversations,
      },
      enquiry_scope: { from: target.enquiry_scope, to: parsed.data.enquiry_scope },
    },
  });
  revalidatePath("/settings/users");
  return { ok: true, message: "Routing settings saved." };
}

const memberBranchesSchema = z
  .object({
    membershipId: z.string().uuid(),
    scope: z.enum(["all", "selected"]),
    locationIds: z.array(z.string().uuid()).max(100),
    homeLocationId: z.string().uuid().nullable(),
  })
  .refine((v) => v.scope === "all" || v.locationIds.length > 0, {
    message: "Choose at least one branch, or allow all branches.",
  })
  .refine(
    (v) => !v.homeLocationId || v.scope === "all" || v.locationIds.includes(v.homeLocationId),
    {
      message: "The home branch must be one of the branches they can work in.",
    },
  );

/**
 * Phase B: which branches a member may work in (all, or one or several) and the branch Pulse opens on for them.
 * Enforced in RLS by app.location_visible_to and in the service-role loaders by lib/branches/access.ts.
 */
export async function setMemberBranches(
  membershipId: string,
  input: { scope: string; locationIds: string[]; homeLocationId: string | null },
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = memberBranchesSchema.safeParse({ membershipId, ...input });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { scope, homeLocationId } = parsed.data;
  const locationIds = scope === "all" ? [] : [...new Set(parsed.data.locationIds)];
  const admin = createAdminClient(member.userId);
  const { data: target } = await admin
    .from("memberships")
    .select("id, user_id, branch_scope, home_location_id, membership_locations(location_id)")
    .eq("id", parsed.data.membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  const wanted = [...locationIds, ...(homeLocationId ? [homeLocationId] : [])];
  if (wanted.length) {
    const { data: found } = await admin
      .from("locations")
      .select("id")
      .eq("org_id", member.orgId)
      .in("id", wanted);
    if ((found ?? []).length !== new Set(wanted).size)
      return { ok: false, error: "One of those branches no longer exists." };
  }
  const { error: delError } = await admin
    .from("membership_locations")
    .delete()
    .eq("membership_id", target.id)
    .eq("org_id", member.orgId);
  if (delError) return { ok: false, error: "Could not save the member's branches." };
  if (locationIds.length) {
    const { error: insError } = await admin.from("membership_locations").insert(
      locationIds.map((location_id) => ({
        org_id: member.orgId,
        membership_id: target.id,
        location_id,
      })),
    );
    if (insError) return { ok: false, error: "Could not save the member's branches." };
  }
  const { error } = await admin
    .from("memberships")
    .update({ branch_scope: scope, home_location_id: homeLocationId })
    .eq("id", target.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the member's branches." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.branches_updated",
    entity: "membership",
    entityId: target.id,
    diff: {
      user_id: target.user_id,
      branch_scope: { from: target.branch_scope, to: scope },
      location_ids: {
        from: (target.membership_locations ?? []).map((l) => l.location_id),
        to: locationIds,
      },
      home_location_id: { from: target.home_location_id, to: homeLocationId },
    },
  });
  revalidatePath("/settings/users");
  return { ok: true, message: "Branch access saved." };
}

const memberMenuSchema = z.object({
  membershipId: z.string().uuid(),
  hidden: z.array(z.string().max(200)).max(64),
});

/**
 * Settings, Users, Menu access: the menu entries hidden for one person, on top of what their role and Settings, Menu
 * already hide. Their pages send them to /page-hidden (lib/auth/session.ts); their role's permissions are unchanged.
 */
export async function setMemberMenu(membershipId: string, hidden: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = memberMenuSchema.safeParse({ membershipId, hidden });
  if (!parsed.success) return { ok: false, error: "That menu choice is not valid." };
  const next = cleanMenuHidden(parsed.data.hidden);
  const admin = createAdminClient(member.userId);
  const { data: target } = await admin
    .from("memberships")
    .select("id, user_id, menu_hidden")
    .eq("id", parsed.data.membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  const { error } = await admin
    .from("memberships")
    .update({ menu_hidden: next })
    .eq("id", target.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the member's menu." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.menu_updated",
    entity: "membership",
    entityId: target.id,
    diff: { user_id: target.user_id, menu_hidden: { from: target.menu_hidden, to: next } },
  });
  revalidatePath("/settings/users");
  return {
    ok: true,
    message: next.length ? "Menu access saved." : "They now see their full menu.",
  };
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

// ---------------------------------------------------------------------------
// Off-boarding
// ---------------------------------------------------------------------------

export type OffboardPreview = {
  name: string;
  openConversations: number;
  openTasks: number;
  apiKeys: number;
  teams: number;
  candidates: Array<{ userId: string; name: string }>;
};

/** What off-boarding would touch, shown in the confirmation step. Counts only. */
export async function previewOffboarding(
  membershipId: string,
): Promise<{ ok: true; data: OffboardPreview } | { ok: false; error: string }> {
  const member = await requirePerm("settings.manage");
  if (!z.string().uuid().safeParse(membershipId).success)
    return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("memberships")
    .select(
      "id, user_id, status, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)",
    )
    .eq("id", membershipId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Member not found." };
  const uid = target.user_id;
  const count = (q: PromiseLike<{ count: number | null }>) => q.then((r) => r.count ?? 0);
  const [openConversations, openTasks, apiKeys, teams, { data: others }] = await Promise.all([
    count(
      admin
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("assignee_user_id", uid)
        .neq("status", "closed"),
    ),
    count(
      admin
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .is("deleted_at", null)
        .eq("assignee_id", uid)
        .eq("done", false),
    ),
    count(
      admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("created_by", uid)
        .is("revoked_at", null),
    ),
    count(
      admin
        .from("team_members")
        .select("user_id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("user_id", uid),
    ),
    admin
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .neq("user_id", uid),
  ]);
  const label = (p: { first_name: string; last_name: string; email: string | null } | null) =>
    `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || p?.email || "Unknown user";
  return {
    ok: true,
    data: {
      name: label(target.profiles),
      openConversations,
      openTasks,
      apiKeys,
      teams,
      candidates: (others ?? [])
        .map((o) => ({ userId: o.user_id, name: label(o.profiles) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

/**
 * Off-boards a member in one step (a single database transaction): suspends the account, revokes the API
 * keys they created, hands their open conversations and tasks to someone else (or unassigns them), takes
 * them out of every team and marks their sessions revoked. The audit entry is written in the same transaction.
 */
export async function offboardMember(
  membershipId: string,
  reassignToUserId: string | null,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = z
    .object({ membershipId: z.string().uuid(), reassignTo: z.string().uuid().nullable() })
    .safeParse({ membershipId, reassignTo: reassignToUserId });
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("offboard_member", {
    p_org: member.orgId,
    p_membership: parsed.data.membershipId,
    p_actor: member.userId,
    p_reassign_to: parsed.data.reassignTo ?? undefined,
  });
  if (error) {
    const known = /last administrator|yourself|already suspended|not found|hand-over/i.test(
      error.message,
    );
    return { ok: false, error: known ? error.message : "Could not off-board the member." };
  }
  const result = (data ?? {}) as Record<string, Json>;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "membership.offboarded",
    entity: "membership",
    entityId: parsed.data.membershipId,
    diff: result,
  });
  const moved = Number(result.conversations_reassigned ?? 0) + Number(result.tasks_reassigned ?? 0);
  if (parsed.data.reassignTo && moved > 0) {
    await createNotification(admin, {
      orgId: member.orgId,
      userId: parsed.data.reassignTo,
      type: "system",
      title: "Work handed over to you",
      body: `${result.conversations_reassigned ?? 0} conversation(s) and ${result.tasks_reassigned ?? 0} task(s) were reassigned to you.`,
    });
  }
  revalidatePath("/settings/users");
  return {
    ok: true,
    message: `Off-boarded: ${result.api_keys_revoked ?? 0} API key(s) revoked, ${result.conversations_reassigned ?? 0} conversation(s) and ${result.tasks_reassigned ?? 0} task(s) ${parsed.data.reassignTo ? "reassigned" : "unassigned"}.`,
  };
}
