import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { WhatsAppClient } from "@/lib/whatsapp/client";

export type ChannelRow = Tables<"channels">;

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

/** A ready-to-use Cloud API client for a channel row. */
export async function clientForChannel(
  admin: AdminClient,
  channel: Pick<ChannelRow, "id" | "phone_number_id" | "waba_id">,
  fetchImpl?: typeof fetch,
): Promise<WhatsAppClient> {
  const token = await channelAccessToken(admin, channel.id);
  return new WhatsAppClient({
    accessToken: token,
    phoneNumberId: channel.phone_number_id,
    wabaId: channel.waba_id,
    graphVersion: serverEnv().META_GRAPH_VERSION,
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
