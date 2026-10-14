import "server-only";

import { routeConversation } from "@/lib/inbox/routing";
import { readInboxSettings } from "@/lib/inbox/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

/**
 * The live conversation for a contact on a number, opening one when there is none. Used by
 * automations that message a patient first (appointment reminders, status notifications).
 */
export async function ensureConversation(
  admin: AdminClient,
  orgId: string,
  contactId: string,
  channelId: string,
): Promise<Tables<"conversations">> {
  const find = () =>
    admin
      .from("conversations")
      .select("*")
      .eq("org_id", orgId)
      .eq("channel_id", channelId)
      .eq("contact_id", contactId)
      .neq("status", "closed")
      .maybeSingle();

  const existing = await find();
  if (existing.data) return existing.data;

  const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      org_id: orgId,
      channel_id: channelId,
      contact_id: contactId,
      status: "open",
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const again = await find(); // raced with an inbound message
      if (again.data) return again.data;
    }
    throw new Error(`ensureConversation: ${error.message}`);
  }
  // Phase 20c: route after the insert, in one SQL transaction (capacity-aware round-robin, fallback team).
  const routed = await routeConversation(
    admin,
    orgId,
    created.id,
    readInboxSettings(org?.settings),
  );
  if (!routed) return created;
  return { ...created, assignee_team_id: routed.teamId, assignee_user_id: routed.userId };
}
