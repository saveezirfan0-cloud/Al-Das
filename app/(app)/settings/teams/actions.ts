"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { DAYS } from "@/lib/flow-engine/office-hours";
import { AUTO_REPLY_MAX_LENGTH, officeHoursFromForm } from "@/lib/inbox/routing-rules";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const teamSchema = z
  .object({
    name: z.string().trim().min(2, "Name is too short").max(60),
    description: z.string().trim().max(240).default(""),
    round_robin: z.boolean().default(false),
    member_ids: z.array(z.string().uuid()).default([]),
    // Phase 20c routing
    auto_reply_text: z.string().trim().max(AUTO_REPLY_MAX_LENGTH).default(""),
    office_days: z.array(z.enum(DAYS)).max(7).default([]),
    office_start: hhmm.default("08:00"),
    office_end: hhmm.default("20:00"),
    fallback_team_id: z.string().uuid().nullable().default(null),
  })
  .refine((t) => t.office_days.length === 0 || t.office_start < t.office_end, {
    message: "Office hours must end after they start.",
    path: ["office_end"],
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

type ParsedTeam = z.output<typeof teamSchema>;

/** Routing columns for teams (Phase 20c). Office hours use the org timezone; no days ticked = always open. */
async function routingColumns(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  teamId: string | null,
  t: ParsedTeam,
): Promise<
  | {
      ok: true;
      cols: {
        auto_reply_text: string | null;
        office_hours: Json | null;
        fallback_team_id: string | null;
      };
    }
  | { ok: false; error: string }
> {
  if (t.fallback_team_id) {
    if (t.fallback_team_id === teamId)
      return { ok: false, error: "A team cannot be its own fallback team." };
    const { data: fb } = await admin
      .from("teams")
      .select("id")
      .eq("id", t.fallback_team_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!fb) return { ok: false, error: "That fallback team does not exist." };
  }
  const { data: org } = await admin.from("orgs").select("timezone").eq("id", orgId).single();
  const hours = officeHoursFromForm({
    days: t.office_days,
    start: t.office_start,
    end: t.office_end,
    timezone: org?.timezone || "Asia/Dubai",
  });
  return {
    ok: true,
    cols: {
      auto_reply_text: t.auto_reply_text || null,
      office_hours: (hours as unknown as Json) ?? null,
      fallback_team_id: t.fallback_team_id,
    },
  };
}

export async function createTeam(input: TeamInput): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = teamSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const admin = createAdminClient();
  const routing = await routingColumns(admin, member.orgId, null, parsed.data);
  if (!routing.ok) return routing;
  const { data, error } = await admin
    .from("teams")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      round_robin: parsed.data.round_robin,
      ...routing.cols,
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
    diff: {
      name: parsed.data.name,
      round_robin: parsed.data.round_robin,
      members: sync.added,
      auto_reply: !!routing.cols.auto_reply_text,
      office_hours: !!routing.cols.office_hours,
      fallback_team_id: routing.cols.fallback_team_id,
    },
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
  const routing = await routingColumns(admin, member.orgId, teamId, parsed.data);
  if (!routing.ok) return routing;
  const { error } = await admin
    .from("teams")
    .update({
      name: parsed.data.name,
      description: parsed.data.description || null,
      round_robin: parsed.data.round_robin,
      ...routing.cols,
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
    diff: {
      name: parsed.data.name,
      round_robin: parsed.data.round_robin,
      ...sync,
      auto_reply: !!routing.cols.auto_reply_text,
      office_hours: !!routing.cols.office_hours,
      fallback_team_id: routing.cols.fallback_team_id,
    },
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
