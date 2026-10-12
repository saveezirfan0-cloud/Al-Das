"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireMember } from "@/lib/auth/session";
import { isSnoozePreset, snoozeUntil } from "@/lib/notify/snooze";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const id = z.string().uuid();
const PATH = "/notifications";

/** Snooze, read, unread and dismiss act on the caller's own notifications only (RLS: user_id = auth.uid()). */
export async function snoozeNotification(
  notificationId: string,
  preset: string,
): Promise<ActionResult> {
  const member = await requireMember();
  if (!id.safeParse(notificationId).success || !isSnoozePreset(preset))
    return { ok: false, error: "Invalid input" };
  const until = snoozeUntil(
    preset,
    new Date(),
    member.profile.timezone || member.org.timezone || "UTC",
  );
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ snoozed_until: until.toISOString() })
    .eq("id", notificationId)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not snooze that notification." };
  revalidatePath(PATH);
  return { ok: true, message: "Snoozed." };
}

export async function unsnoozeNotification(notificationId: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!id.safeParse(notificationId).success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ snoozed_until: null })
    .eq("id", notificationId)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not bring that notification back." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setNotificationRead(
  notificationId: string,
  read: boolean,
): Promise<ActionResult> {
  const member = await requireMember();
  if (!id.safeParse(notificationId).success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq("id", notificationId)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not update that notification." };
  revalidatePath(PATH);
  return { ok: true };
}

export async function dismissNotification(notificationId: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!id.safeParse(notificationId).success) return { ok: false, error: "Invalid input" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("id", notificationId)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not dismiss that notification." };
  revalidatePath(PATH);
  return { ok: true };
}
