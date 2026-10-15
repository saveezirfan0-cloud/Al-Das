import "server-only";

import { emit } from "@/lib/events/emit";
import { takeOverFromBot } from "@/lib/flow-engine/takeover";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";

type ContactName = Parameters<typeof contactDisplayName>[0];

/**
 * Assigns a conversation to a person and/or team: the row, the bot hand-over, the new owner's notification and the
 * domain event. Shared by the single Assign menu and the Phase F bulk assign; callers check inbox.send and that the
 * member can see the conversation (RLS), and pass an admin client carrying the actor (assignment log, Phase 20c).
 */
export async function assignConversationRecord(
  admin: AdminClient,
  a: {
    orgId: string;
    actorId: string;
    conversationId: string;
    contact: ContactName | null;
    userId: string | null;
    teamId: string | null;
  },
): Promise<boolean> {
  const { error } = await admin
    .from("conversations")
    .update({ assignee_user_id: a.userId, assignee_team_id: a.teamId, bot_active: false })
    .eq("id", a.conversationId)
    .eq("org_id", a.orgId);
  if (error) return false;
  await takeOverFromBot(admin, a.conversationId);
  if (a.userId && a.userId !== a.actorId) {
    await notify(admin, {
      orgId: a.orgId,
      userIds: [a.userId],
      event: "inbox.assigned",
      type: "inbox.assigned",
      title: "Conversation assigned to you",
      body: a.contact ? `With ${contactDisplayName(a.contact)}` : null,
      payload: { conversation_id: a.conversationId },
      ids: { conversation_id: a.conversationId },
    });
  }
  await emit(a.orgId, "conversation.assigned", {
    conversation_id: a.conversationId,
    user_id: a.userId,
    team_id: a.teamId,
    by: a.actorId,
  });
  return true;
}
