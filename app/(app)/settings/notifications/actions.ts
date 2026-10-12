"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import {
  readEscalationSettings,
  escalationSettingsSchema,
  validateEscalation,
  writeEscalationSettings,
} from "@/lib/notify/escalation";
import { buildPreferenceRows, preferencesInput } from "@/lib/notify/preferences-input";
import { parseSubscription } from "@/lib/push/endpoint";
import { deliverPush } from "@/lib/push/deliver";
import {
  dbPushStore,
  decryptSubscription,
  removeSubscription,
  saveSubscription,
} from "@/lib/push/store-db";
import { createWebPushSender, isPushConfigured } from "@/lib/push/web-push-sender";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { uaFamily } from "@/lib/security/ua";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PATH = "/settings/notifications";
const MAX_DEVICES = 10;

/** Saves the caller's own channel choices, per-event toggles and quiet hours. RLS limits writes to their own rows. */
export async function savePreferences(input: unknown): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = preferencesInput.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const { rows, error } = buildPreferenceRows({
    orgId: member.orgId,
    userId: member.userId,
    input: parsed.data,
    canDo: (perm) => can(member, perm),
  });
  if (error) return { ok: false, error };
  if (rows.length === 0) return { ok: true, message: "Nothing to change." };
  const supabase = await createClient(); // the caller's own client: RLS only lets them write their own rows
  const { error: upErr } = await supabase
    .from("notification_preferences")
    .upsert(rows, { onConflict: "org_id,user_id,event,channel" });
  if (upErr) return { ok: false, error: "Could not save your notification settings." };
  revalidatePath(PATH);
  return { ok: true, message: "Notification settings saved." };
}

const subscribeInput = z.object({ subscription: z.unknown() });

/** Registers the caller's browser for Web Push. The endpoint is checked against known push services (SSRF). */
export async function registerPushSubscription(input: unknown): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = subscribeInput.safeParse(input);
  const subscription = parsed.success ? parseSubscription(parsed.data.subscription) : null;
  if (!subscription)
    return { ok: false, error: "This browser's push registration was not recognised." };
  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "push-register",
    member.userId,
    RATE_RULES.pushRegisterPerUser,
  );
  if (!limited.allowed)
    return { ok: false, error: `Too many attempts. Try again in ${waitText(limited.retryAfter)}.` };

  const { count } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId);
  if ((count ?? 0) >= MAX_DEVICES)
    return { ok: false, error: `You can register up to ${MAX_DEVICES} devices. Remove one first.` };

  const ua = (await headers()).get("user-agent");
  try {
    await saveSubscription(admin, {
      orgId: member.orgId,
      userId: member.userId,
      subscription,
      uaFamily: uaFamily(ua),
    });
  } catch {
    return { ok: false, error: "Could not register this device." };
  }
  revalidatePath(PATH);
  return { ok: true, message: "This device will now receive push notifications." };
}

export async function unregisterPushSubscription(endpoint: string): Promise<ActionResult> {
  const member = await requireMember();
  if (typeof endpoint !== "string" || endpoint.length > 1000)
    return { ok: false, error: "Invalid device." };
  await removeSubscription(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    endpoint,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Device removed." };
}

/** Removes one of the caller's own registered devices by id (the list in settings). */
export async function removePushDevice(id: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid device." };
  await createAdminClient()
    .from("push_subscriptions")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId);
  revalidatePath(PATH);
  return { ok: true, message: "Device removed." };
}

/** Sends a generic test push to the caller's own devices. */
export async function sendTestPush(): Promise<ActionResult> {
  const member = await requireMember();
  if (!isPushConfigured())
    return { ok: false, error: "Push is not set up on this server yet (VAPID keys are missing)." };
  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "push-test",
    member.userId,
    RATE_RULES.pushTestPerUser,
  );
  if (!limited.allowed)
    return {
      ok: false,
      error: `Please wait ${waitText(limited.retryAfter)} before sending another test.`,
    };
  const outcome = await deliverPush(
    { store: dbPushStore(admin), sender: createWebPushSender(), decrypt: decryptSubscription },
    { org_id: member.orgId, user_id: member.userId, event: "test" },
  );
  if (outcome.skipped === "no_devices")
    return { ok: false, error: "No device is registered yet. Turn on push on this device first." };
  if (outcome.sent === 0)
    return {
      ok: false,
      error: "The push service did not accept the message. Try registering the device again.",
    };
  revalidatePath(PATH);
  return {
    ok: true,
    message: `Test sent to ${outcome.sent} device${outcome.sent === 1 ? "" : "s"}.`,
  };
}

// --- Escalation ladder (administrators) ---------------------------------------------------------------

export async function saveEscalation(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = escalationSettingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const problem = validateEscalation(parsed.data);
  if (problem) return { ok: false, error: problem };

  const admin = createAdminClient();
  if (parsed.data.on_call_user_ids.length) {
    const { data: members } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .in("user_id", parsed.data.on_call_user_ids);
    if ((members?.length ?? 0) !== new Set(parsed.data.on_call_user_ids).size)
      return {
        ok: false,
        error: "Every on-call person must be an active member of this workspace.",
      };
  }
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const next = writeEscalationSettings(org?.settings, parsed.data);
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the escalation settings." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "escalation.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { before: readEscalationSettings(org?.settings), after: parsed.data } as unknown as Json,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Escalation settings saved." };
}

const leadInput = z.object({ team_id: z.string().uuid(), user_id: z.string().uuid().nullable() });

export async function setTeamLead(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = leadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: team } = await admin
    .from("teams")
    .select("id")
    .eq("id", parsed.data.team_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!team) return { ok: false, error: "That team does not exist." };
  if (parsed.data.user_id) {
    const { data: m } = await admin
      .from("team_members")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("team_id", team.id)
      .eq("user_id", parsed.data.user_id)
      .maybeSingle();
    if (!m) return { ok: false, error: "The team lead must be a member of the team." };
  }
  const { error } = await admin
    .from("teams")
    .update({ lead_user_id: parsed.data.user_id })
    .eq("id", team.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not set the team lead." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "team.lead_set",
    entity: "team",
    entityId: team.id,
    diff: { lead_user_id: parsed.data.user_id },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Team lead saved." };
}
