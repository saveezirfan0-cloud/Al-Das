import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export class NoChannelError extends Error {
  constructor() {
    super("No active WhatsApp channel is connected");
    this.name = "NoChannelError";
  }
}

/** The number to message from: the one asked for, else the org's oldest active channel. */
export async function resolveChannelId(
  admin: AdminClient,
  orgId: string,
  preferred?: string | null,
): Promise<string> {
  if (preferred) return preferred;
  const { data } = await admin
    .from("channels")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) throw new NoChannelError();
  return data.id;
}
