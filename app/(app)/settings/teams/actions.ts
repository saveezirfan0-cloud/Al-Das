"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const teamSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(60),
  description: z.string().trim().max(240).default(""),
  round_robin: z.boolean().default(false),
  member_ids: z.array(z.string().uuid()).default([]),
});

export type TeamInput = z.input<typeof teamSchema>;

async function syncMembers(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  teamId: string,
  userIds: string[],
) {
  // Only active org members can be in a team (the DB trigger also enforces membership).
  const { data: valid } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);
  const keep = new Set((valid ?? []).map((m) => m.user_id));
  const { data: current } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", teamId);
  const existing = new Set((current ?? []).map((m) => m.user_id));
  const toAdd = [...keep].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !keep.has(id));
  if (toAdd.length)
    await admin
      .from("team_members")
      .insert(toAdd.map((user_id) => ({ org_id: orgId, team_id: teamId, user_id })));
  if (toRemove.length)
    await admin.from("team_members").delete().eq("team_id", teamId).in("user_id", toRemove);
  return { added: toAdd.length, removed: toRemove.length };
}

export async function createTeam(input: TeamInput): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = teamSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("teams")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      round_robin: parsed.data.round_robin,
    })
    .select("id")
    .single();
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505"
          ? "A team with that name already exists."
          : "Could not create the team.",
    };
  const sync = await syncMembers(admin, member.orgId, data.id, parsed.data.member_ids);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "team.created",
    entity: "team",
    entityId: data.id,
    diff: { name: parsed.data.name, round_robin: parsed.data.round_robin, members: sync.added },
  });
  revalidatePath("/settings/teams");
  return { ok: true, message: "Team created." };
}

export async function updateTeam(teamId: string, input: TeamInput): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = teamSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Team not found." };
  const { error } = await admin
    .from("teams")
    .update({
      name: parsed.data.name,
      description: parsed.data.description || null,
      round_robin: parsed.data.round_robin,
    })
    .eq("id", teamId);
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505"
          ? "A team with that name already exists."
          : "Could not update the team.",
    };
  const sync = await syncMembers(admin, member.orgId, teamId, parsed.data.member_ids);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "team.updated",
    entity: "team",
    entityId: teamId,
    diff: { name: parsed.data.name, round_robin: parsed.data.round_robin, ...sync },
  });
  revalidatePath("/settings/teams");
  return { ok: true, message: "Team saved." };
}

export async function deleteTeam(teamId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("teams")
    .select("id, name")
    .eq("id", teamId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Team not found." };
  const { error } = await admin.from("teams").delete().eq("id", teamId);
  if (error) return { ok: false, error: "Could not delete the team." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "team.deleted",
    entity: "team",
    entityId: teamId,
    diff: { name: existing.name },
  });
  revalidatePath("/settings/teams");
  return { ok: true, message: "Team deleted." };
}
