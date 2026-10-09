import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export class NoChannelError extends Error {
  constructor() {
    super("No active WhatsApp channel is connected");
    this.name = "NoChannelError";
  }
}

/**
 * The live conversation for (channel, contact), opened if needed. Used by outbound-first senders
 * (flows, recall) that must message a patient who has no open thread. Channel: the given one, else
 * the org's oldest active channel.
 */
export async function ensureConversation(
  admin: AdminClient,
  input: { orgId: string; contactId: string; channelId?: string | null },
): Promise<Tables<"conversations">> {
  let channelId = input.channelId ?? null;
  if (!channelId) {
    const { data: ch } = await admin
      .from("channels")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!ch) throw new NoChannelError();
    channelId = ch.id;
  }
  const live = () =>
    admin
      .from("conversations")
      .select("*")
      .eq("channel_id", channelId!)
      .eq("contact_id", input.contactId)
      .neq("status", "closed")
      .maybeSingle();
  const existing = await live();
  if (existing.data) return existing.data;
  const { data, error } = await admin
    .from("conversations")
    .insert({ org_id: input.orgId, channel_id: channelId, contact_id: input.contactId, status: "open" })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const again = await live();
      if (again.data) return again.data;
    }
    throw new Error(`ensureConversation: ${error.message}`);
  }
  return data;
}
