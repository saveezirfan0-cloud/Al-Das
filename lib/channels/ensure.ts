import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

import { CHANNEL_TYPE_LABEL, channelRef, type ChannelType } from "./types";

export type ChannelRow = { id: string; org_id: string; type: string; status: string; name: string };

/**
 * The inbox channel row of a website chat, Instagram account or Facebook Page, created on first use. It has no WhatsApp
 * Business Account (waba_id = '') and a namespaced phone_number_id, so no WhatsApp code path can pick it up.
 */
export async function ensureChannel(
  admin: AdminClient,
  a: { orgId: string; type: Exclude<ChannelType, "whatsapp">; externalId: string; name?: string },
): Promise<ChannelRow> {
  const ref = channelRef(a.type, a.externalId);
  const existing = await admin
    .from("channels")
    .select("id, org_id, type, status, name")
    .eq("phone_number_id", ref)
    .maybeSingle();
  if (existing.data) {
    if (existing.data.org_id !== a.orgId || existing.data.type !== a.type)
      throw new Error("channel reference belongs to another workspace");
    return existing.data;
  }
  const { error } = await admin.from("channels").insert({
    org_id: a.orgId,
    type: a.type,
    name: a.name ?? CHANNEL_TYPE_LABEL[a.type],
    waba_id: "",
    phone_number_id: ref,
    status: "active",
  });
  if (error && error.code !== "23505") throw new Error(`channel insert failed: ${error.code}`);
  const again = await admin
    .from("channels")
    .select("id, org_id, type, status, name")
    .eq("phone_number_id", ref)
    .single();
  if (!again.data || again.data.org_id !== a.orgId || again.data.type !== a.type)
    throw new Error("channel reference belongs to another workspace");
  return again.data;
}
