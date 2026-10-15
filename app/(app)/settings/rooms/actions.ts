"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { roomSchema } from "@/lib/capacity/rooms";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * Rooms (M3). Every action needs rooms.manage and keeps to the branches the member may see
 * (Phase B); writes use the service role after the check and are audited. Nothing here touches bookings.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PERM = "rooms.manage";
const uuid = z.string().uuid();

const refresh = () => {
  revalidatePath("/settings/rooms");
  revalidatePath("/finance/capacity");
};

/** The room, when it belongs to the member's org and a branch they may see. */
async function roomInScope(admin: AdminClient, member: CurrentMember, id: string) {
  const { data } = await admin
    .from("rooms")
    .select("id, name, location_id")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return data && canSeeLocation(readBranchAccess(member), data.location_id) ? data : null;
}

export async function saveRoom(values: Record<string, string>): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const parsed = roomSchema.safeParse(values);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid room." };
  const { id, location_id, ...row } = parsed.data;
  const admin = createAdminClient(member.userId);

  if (id) {
    // The branch of an existing room is fixed here: a room is recreated rather than moved.
    if (!(await roomInScope(admin, member, id))) return { ok: false, error: "Room not found." };
    const { error } = await admin.from("rooms").update(row).eq("id", id).eq("org_id", member.orgId);
    if (error)
      return {
        ok: false,
        error:
          error.code === "23505"
            ? "This branch already has a room with that name."
            : "Could not save the room.",
      };
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "rooms.room_updated",
      entity: "room",
      entityId: id,
      diff: { name: row.name, kind: row.kind, monthly_cost: row.monthly_cost, active: row.active },
    });
    refresh();
    return { ok: true, message: "Room saved." };
  }

  if (!location_id) return { ok: false, error: "Choose the branch." };
  const { data: loc } = await admin
    .from("locations")
    .select("id")
    .eq("id", location_id)
    .eq("org_id", member.orgId)
    .eq("active", true)
    .maybeSingle();
  if (!loc || !canSeeLocation(readBranchAccess(member), loc.id))
    return { ok: false, error: "Branch not found." };
  const { data, error } = await admin
    .from("rooms")
    .insert({ ...row, org_id: member.orgId, location_id })
    .select("id")
    .single();
  if (error || !data)
    return {
      ok: false,
      error:
        error?.code === "23505"
          ? "This branch already has a room with that name."
          : "Could not add the room.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "rooms.room_created",
    entity: "room",
    entityId: data.id,
    diff: {
      location_id,
      name: row.name,
      kind: row.kind,
      monthly_cost: row.monthly_cost,
      active: row.active,
    },
  });
  refresh();
  return { ok: true, message: "Room added." };
}

export async function deleteRoom(id: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid room." };
  const admin = createAdminClient(member.userId);
  const room = await roomInScope(admin, member, id);
  if (!room) return { ok: false, error: "Room not found." };
  const { error } = await admin.from("rooms").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the room." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "rooms.room_deleted",
    entity: "room",
    entityId: id,
    diff: { name: room.name },
  });
  refresh();
  return { ok: true, message: "Room deleted." };
}
