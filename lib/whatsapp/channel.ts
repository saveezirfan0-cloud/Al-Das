import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { assertNotTraining } from "@/lib/training/mode";
import { WhatsAppClient } from "@/lib/whatsapp/client";

export type ChannelRow = Tables<"channels">;

/** The number sends through Sanoflow (channels.transport = 'sanoflow'): Meta features (sync, templates, media) are not available. */
export class SanoflowNumberError extends Error {
  constructor() {
    super("This number sends through Sanoflow; Meta features are not available for it.");
    this.name = "SanoflowNumberError";
  }
}

/**
 * The access token for a channel: its own encrypted System User token when one
 * was stored, otherwise META_SYSTEM_USER_TOKEN from the environment.
 */
export async function channelAccessToken(admin: AdminClient, channelId: string): Promise<string> {
  const { data } = await admin
    .from("channel_secrets")
    .select("access_token_enc")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (data?.access_token_enc) return decryptSecret(data.access_token_enc);
  const env = serverEnv();
  if (!env.META_SYSTEM_USER_TOKEN) {
    throw new Error("No access token: store one on the channel or set META_SYSTEM_USER_TOKEN");
  }
  return env.META_SYSTEM_USER_TOKEN;
}

export async function storeChannelToken(
  admin: AdminClient,
  channelId: string,
  token: string | null,
): Promise<void> {
  if (!token) {
    await admin.from("channel_secrets").delete().eq("channel_id", channelId);
    return;
  }
  const { error } = await admin.from("channel_secrets").upsert({
    channel_id: channelId,
    access_token_enc: encryptSecret(token),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`storeChannelToken: ${error.message}`);
}

/**
 * Load tests point the client at a local stub (scripts/load/mock-graph.ts) through
 * META_GRAPH_BASE_URL. Only loopback hosts are honoured, so the System User token
 * can never be redirected to another machine by a stray environment variable.
 */
export function graphBaseUrl(raw = process.env.META_GRAPH_BASE_URL): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.protocol === "http:") {
      return u.origin;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** A ready-to-use Cloud API client for a channel row. */
export async function clientForChannel(
  admin: AdminClient,
  channel: Pick<ChannelRow, "id" | "phone_number_id" | "waba_id">,
  fetchImpl?: typeof fetch,
): Promise<WhatsAppClient> {
  // Second line of defence behind the outbound handler: a training workspace never builds a Meta client.
  const { data: owner } = await admin
    .from("channels")
    .select("org_id, transport")
    .eq("id", channel.id)
    .maybeSingle();
  if (owner) await assertNotTraining(admin, owner.org_id);
  // OQ-182: a number Sanoflow holds has no Meta ids or token; nothing may point a Meta call at it.
  if (owner?.transport === "sanoflow") throw new SanoflowNumberError();
  const token = await channelAccessToken(admin, channel.id);
  return new WhatsAppClient({
    accessToken: token,
    phoneNumberId: channel.phone_number_id,
    wabaId: channel.waba_id,
    graphVersion: serverEnv().META_GRAPH_VERSION,
    baseUrl: graphBaseUrl(),
    fetch: fetchImpl,
  });
}

/** Client for a token that is not stored yet (Settings → Channels "Add number" probe). */
export function clientForToken(
  token: string,
  ids: { phoneNumberId?: string; wabaId?: string },
  fetchImpl?: typeof fetch,
): WhatsAppClient {
  return new WhatsAppClient({
    accessToken: token,
    phoneNumberId: ids.phoneNumberId,
    wabaId: ids.wabaId,
    graphVersion: serverEnv().META_GRAPH_VERSION,
    baseUrl: graphBaseUrl(),
    fetch: fetchImpl,
  });
}

export async function channelByPhoneNumberId(
  admin: AdminClient,
  phoneNumberId: string,
): Promise<ChannelRow | null> {
  const { data } = await admin
    .from("channels")
    .select("*")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return data ?? null;
}
