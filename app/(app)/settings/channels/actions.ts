"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { clientForChannel, clientForToken, storeChannelToken } from "@/lib/whatsapp/channel";
import { redactText } from "@/lib/redact";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { refreshChannelFromMeta, syncTemplatesForChannel } from "@/lib/whatsapp/sync";
import { BUSINESS_VERTICALS } from "@/lib/whatsapp/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function fail(err: unknown, fallback: string): ActionResult {
  if (err instanceof WhatsAppApiError) return { ok: false, error: `Meta: ${err.mapped.message}` };
  if (err instanceof Error && /ENCRYPTION_KEY|access token/i.test(err.message))
    return { ok: false, error: err.message };
  console.error("[channels]", redactText(err));
  return { ok: false, error: fallback };
}

const addSchema = z.object({
  name: z.string().trim().min(2).max(60),
  phone_number_id: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/, "phone_number_id is numeric"),
  waba_id: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/, "WABA ID is numeric"),
  access_token: z.string().trim().max(2000).optional().default(""),
});
export type AddChannelInput = z.input<typeof addSchema>;

/**
 * Adds a number: probes Meta with the token (phone fields + profile), stores the
 * channel, encrypts the token (when given), subscribes the app to the WABA, syncs templates.
 */
export async function addChannel(input: AddChannelInput): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = addSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { name, phone_number_id, waba_id, access_token } = parsed.data;
  const env = serverEnv();
  const token = access_token || env.META_SYSTEM_USER_TOKEN;
  if (!token)
    return { ok: false, error: "Paste a System User token or set META_SYSTEM_USER_TOKEN." };
  if (access_token && !env.ENCRYPTION_KEY)
    return { ok: false, error: "ENCRYPTION_KEY is not set; cannot store the token." };

  try {
    const probe = clientForToken(token, { phoneNumberId: phone_number_id, wabaId: waba_id });
    const phone = await probe.getPhoneNumber();
    const admin = createAdminClient();
    const { data: channel, error } = await admin
      .from("channels")
      .insert({
        org_id: member.orgId,
        name,
        waba_id,
        phone_number_id,
        display_phone: phone.display_phone_number ?? null,
        verified_name: phone.verified_name ?? null,
        quality_rating: phone.quality_rating ?? null,
        messaging_limit_tier: phone.messaging_limit_tier ?? null,
        name_status: phone.name_status ?? null,
      })
      .select("*")
      .single();
    if (error) {
      return {
        ok: false,
        error:
          error.code === "23505"
            ? "This phone_number_id is already connected."
            : "Could not save the channel.",
      };
    }
    if (access_token) await storeChannelToken(admin, channel.id, access_token);
    const warnings: string[] = [];
    try {
      await refreshChannelFromMeta(admin, channel);
    } catch (err) {
      warnings.push(
        `profile: ${err instanceof WhatsAppApiError ? err.mapped.message : "not loaded"}`,
      );
    }
    try {
      await probe.subscribeApp(waba_id);
    } catch (err) {
      warnings.push(
        `webhook subscription: ${err instanceof WhatsAppApiError ? err.mapped.message : "failed"}`,
      );
    }
    try {
      await syncTemplatesForChannel(admin, channel);
    } catch (err) {
      warnings.push(
        `templates: ${err instanceof WhatsAppApiError ? err.mapped.message : "not synced"}`,
      );
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "channel.added",
      entity: "channel",
      entityId: channel.id,
      diff: { name, phone_number_id, waba_id, own_token: !!access_token },
    });
    revalidatePath("/settings/channels");
    return {
      ok: true,
      message: warnings.length
        ? `Number added. ${warnings.join("; ")}.`
        : "Number added and subscribed.",
    };
  } catch (err) {
    return fail(err, "Could not reach Meta with these details.");
  }
}

async function ownChannel(orgId: string, channelId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("channels")
    .select("*")
    .eq("id", channelId)
    .eq("org_id", orgId)
    .maybeSingle();
  return { admin, channel: data };
}

export async function refreshChannel(channelId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  try {
    await refreshChannelFromMeta(admin, channel);
    revalidatePath("/settings/channels");
    return { ok: true, message: "Refreshed from Meta." };
  } catch (err) {
    return fail(err, "Refresh failed.");
  }
}

export async function syncChannelTemplates(channelId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  try {
    const r = await syncTemplatesForChannel(admin, channel);
    revalidatePath("/settings/channels");
    return {
      ok: true,
      message: `${r.synced} templates synced${r.removed ? `, ${r.removed} archived` : ""}.`,
    };
  } catch (err) {
    return fail(err, "Template sync failed.");
  }
}

export async function subscribeChannelApp(channelId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  try {
    const client = await clientForChannel(admin, channel);
    await client.subscribeApp();
    const apps = await client.getSubscribedApps();
    const meta = {
      ...((channel.meta as Record<string, unknown>) ?? {}),
      subscribed_apps: apps.data as unknown as Json,
      subscribed_at: new Date().toISOString(),
    };
    await admin
      .from("channels")
      .update({ meta: meta as NonNullable<Json> })
      .eq("id", channel.id);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "channel.app_subscribed",
      entity: "channel",
      entityId: channel.id,
    });
    revalidatePath("/settings/channels");
    return {
      ok: true,
      message: `Webhook subscribed (${apps.data.length} app${apps.data.length === 1 ? "" : "s"} on the WABA).`,
    };
  } catch (err) {
    return fail(err, "Subscription failed.");
  }
}

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  catalog_id: z.string().trim().max(40).optional().default(""),
  send_rate_per_sec: z.coerce.number().int().min(1).max(1000),
  status: z.enum(["active", "paused"]),
  access_token: z.string().trim().max(2000).optional().default(""),
  clear_token: z.boolean().optional().default(false),
});
export type UpdateChannelInput = z.input<typeof updateSchema>;

export async function updateChannel(
  channelId: string,
  input: UpdateChannelInput,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  const d = parsed.data;
  const { error } = await admin
    .from("channels")
    .update({
      name: d.name,
      catalog_id: d.catalog_id || null,
      send_rate_per_sec: d.send_rate_per_sec,
      status: d.status,
    })
    .eq("id", channel.id);
  if (error) return { ok: false, error: "Could not update the channel." };
  try {
    if (d.clear_token) await storeChannelToken(admin, channel.id, null);
    else if (d.access_token) await storeChannelToken(admin, channel.id, d.access_token);
  } catch (err) {
    return fail(err, "Could not store the token.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "channel.updated",
    entity: "channel",
    entityId: channel.id,
    diff: {
      name: d.name,
      status: d.status,
      send_rate_per_sec: d.send_rate_per_sec,
      catalog: !!d.catalog_id,
      token_changed: !!d.access_token || d.clear_token,
    },
  });
  revalidatePath("/settings/channels");
  return { ok: true, message: "Channel saved." };
}

const profileSchema = z.object({
  about: z.string().trim().max(139).optional().default(""),
  address: z.string().trim().max(256).optional().default(""),
  description: z.string().trim().max(512).optional().default(""),
  email: z.string().trim().max(128).optional().default(""),
  vertical: z.enum(BUSINESS_VERTICALS).optional(),
  websites: z.array(z.string().trim().url()).max(2).optional().default([]),
});
export type ProfileInput = z.input<typeof profileSchema>;

export async function updateChannelProfile(
  channelId: string,
  input: ProfileInput,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  try {
    const client = await clientForChannel(admin, channel);
    const p = parsed.data;
    await client.updateBusinessProfile({
      about: p.about || undefined,
      address: p.address || undefined,
      description: p.description || undefined,
      email: p.email || undefined,
      vertical: p.vertical,
      websites: p.websites.length ? p.websites : undefined,
    });
    await refreshChannelFromMeta(admin, channel);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "channel.profile_updated",
      entity: "channel",
      entityId: channel.id,
    });
    revalidatePath("/settings/channels");
    return { ok: true, message: "Business profile updated." };
  } catch (err) {
    return fail(err, "Could not update the profile.");
  }
}

export async function removeChannel(channelId: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const { admin, channel } = await ownChannel(member.orgId, channelId);
  if (!channel) return { ok: false, error: "Channel not found." };
  const { count } = await admin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channel.id);
  if ((count ?? 0) > 0) {
    const { error } = await admin
      .from("channels")
      .update({ status: "disconnected" })
      .eq("id", channel.id);
    if (error) return { ok: false, error: "Could not disconnect the channel." };
    await storeChannelToken(admin, channel.id, null);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "channel.disconnected",
      entity: "channel",
      entityId: channel.id,
    });
    revalidatePath("/settings/channels");
    return { ok: true, message: "Channel disconnected (conversations are kept)." };
  }
  const { error } = await admin.from("channels").delete().eq("id", channel.id);
  if (error) return { ok: false, error: "Could not remove the channel." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "channel.removed",
    entity: "channel",
    entityId: channel.id,
  });
  revalidatePath("/settings/channels");
  return { ok: true, message: "Channel removed." };
}
