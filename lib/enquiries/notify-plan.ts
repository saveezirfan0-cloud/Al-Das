import type { EnquiryNotifyEvent } from "@/lib/enquiries/constants";
import type { NotificationRule } from "@/lib/enquiries/settings";

export type NotifyRecipient = { userId: string; inApp: boolean; email: boolean };

/**
 * Who should hear about an enquiry event. Pure: callers pass the assignee and the
 * resolved team members. The acting user is never notified about their own action.
 * One recipient gets one entry even if several rules match (channels are OR-ed).
 */
export function planRecipients(input: {
  event: EnquiryNotifyEvent;
  rules: readonly NotificationRule[];
  assigneeId: string | null;
  actorId: string | null;
  teamMembers: (teamId: string) => readonly string[];
}): NotifyRecipient[] {
  const out = new Map<string, NotifyRecipient>();
  const add = (userId: string | null, rule: NotificationRule) => {
    if (!userId || userId === input.actorId) return;
    const cur = out.get(userId) ?? { userId, inApp: false, email: false };
    cur.inApp ||= rule.in_app;
    cur.email ||= rule.email;
    out.set(userId, cur);
  };
  for (const rule of input.rules) {
    if (!rule.enabled || rule.event !== input.event) continue;
    if (rule.assignee) add(input.assigneeId, rule);
    for (const id of rule.user_ids) add(id, rule);
    if (rule.team_id) for (const id of input.teamMembers(rule.team_id)) add(id, rule);
  }
  return [...out.values()].filter((r) => r.inApp || r.email);
}
