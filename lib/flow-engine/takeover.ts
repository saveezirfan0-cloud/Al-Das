import "server-only";

import { createFlowDeps } from "@/lib/flow-engine/supabase-deps";
import { cancelActiveRunForConversation } from "@/lib/flow-engine/run";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Human takeover: an agent replied, assigned, closed or took the conversation back from the bot.
 * Cancels the live flow run (and any nested run); pending timers become no-ops because the run is
 * no longer waiting. Returns true when a run was cancelled.
 */
export async function takeOverFromBot(
  admin: AdminClient,
  conversationId: string,
  reason = "Human takeover",
): Promise<boolean> {
  try {
    return await cancelActiveRunForConversation(createFlowDeps(admin), conversationId, reason);
  } catch (err) {
    // Never block the agent's action on bot bookkeeping.
    console.error("[flows] takeover failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
