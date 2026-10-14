import "server-only";

import {
  autoReplyDecision,
  parseRouteOutcome,
  type AutoReplyDecision,
  type RouteOutcome,
} from "@/lib/inbox/routing-rules";
import { queueOutbound } from "@/lib/inbox/send";
import type { InboxSettings } from "@/lib/inbox/settings";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Routes a new, unowned conversation into the workspace's default team (Phase 20c). Pick, capacity check, fallback team
 * and the owner write happen in ONE SQL transaction (public.route_conversation), so two webhooks in flight cannot both
 * take a member's last free place. Never throws: an inbound message must be stored even when routing fails (the
 * conversation then stays unassigned and the escalation ladder covers it).
 */
export async function routeConversation(
  admin: AdminClient,
  orgId: string,
  conversationId: string,
  settings: Pick<InboxSettings, "default_team_id" | "auto_assign">,
): Promise<RouteOutcome | null> {
  if (!settings.default_team_id) return null;
  try {
    const { data, error } = await admin.rpc("route_conversation", {
      p_org_id: orgId,
      p_conversation_id: conversationId,
      p_team_id: settings.default_team_id,
      p_round_robin: settings.auto_assign === "round_robin",
    });
    if (error) {
      console.warn("[routing] route_conversation failed", { code: error.code ?? "unknown" });
      return null;
    }
    return parseRouteOutcome(data);
  } catch (err) {
    console.warn("[routing] route_conversation threw", { error: redactText(err) });
    return null;
  }
}

/**
 * The team auto-reply (Phase 20c): at most once per conversation (auto_reply_sent_at is claimed atomically BEFORE the
 * message is queued, so a retried webhook job never sends it twice; a crash between claim and queue loses it rather
 * than duplicating it), only inside the 24 h window, through queueOutbound (training mode, rate limits and the outbound
 * handler's checks all apply). Never throws.
 */
export async function sendTeamAutoReply(
  admin: AdminClient,
  input: {
    orgId: string;
    conversationId: string;
    outcome: RouteOutcome | null;
    alreadySentAt: string | null;
    lastInboundAt: Date | null;
    now?: Date;
  },
): Promise<AutoReplyDecision["reason"]> {
  const now = input.now ?? new Date();
  const decision = autoReplyDecision({
    outcome: input.outcome,
    alreadySentAt: input.alreadySentAt,
    lastInboundAt: input.lastInboundAt,
    now,
  });
  if (!decision.send) return decision.reason;
  try {
    const { data: claimed } = await admin
      .from("conversations")
      .update({ auto_reply_sent_at: now.toISOString() })
      .eq("id", input.conversationId)
      .eq("org_id", input.orgId)
      .is("auto_reply_sent_at", null)
      .select("id");
    if (!claimed || claimed.length === 0) return "already_sent";
    await queueOutbound(admin, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      spec: { type: "text", body: decision.text },
      body: decision.text,
      sentByUserId: null,
      priority: true,
    });
  } catch (err) {
    console.warn("[routing] team auto-reply failed", { error: redactText(err) });
  }
  return decision.reason;
}
