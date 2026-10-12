import type { NotificationChannel } from "@/lib/notify/events";
import { genericEmail, pushUrl, type PushIds } from "@/lib/notify/push-payload";
import { resolveDelivery, type PrefRow } from "@/lib/notify/preferences";
import type { Json } from "@/lib/supabase/types";

/**
 * One front door for "tell this person". It applies the person's preferences (channels per event, master
 * switches, quiet hours) and fans out to:
 *   in_app  a row in `notifications` (the bell, the notification centre, Realtime). May carry context.
 *   email   a job on the `notifications` queue with a GENERIC sentence and a link (never names or text).
 *   push    a job on the `notifications` queue carrying ids only; the handler builds the payload.
 *
 * Pure orchestration over injected dependencies, so the rules are unit-tested without a database.
 * The Supabase-backed dependencies are in dispatch-db.ts.
 */

export type NotifyInput = {
  orgId: string;
  /** Recipients. Non-members and duplicates are dropped. */
  userIds: readonly string[];
  /** Preference key from lib/notify/events.ts. */
  event: string;
  /** notifications.type for the in-app row (existing UI conventions: "mention", "inbox.assigned", "task.due"…). */
  type: string;
  /** In-app copy. It may mention context (the bell is private to the recipient); e-mail and push never use it. */
  title: string;
  body?: string | null;
  payload?: NonNullable<Json>;
  /** Ids for the push payload and the e-mail link. */
  ids?: PushIds;
  /** Do not notify this person (usually the one who just acted). */
  exceptUserId?: string | null;
  /**
   * Restrict to these channels. Used where another path already covers a channel (the enquiry rules send
   * their own in-app and e-mail messages, so only push is added on top).
   */
  only?: readonly NotificationChannel[];
};

export type RecipientContext = {
  email: string | null;
  /** The person's own timezone, if they set one. */
  timezone: string | null;
  prefs: PrefRow[];
};

export type DispatchDeps = {
  now(): Date;
  appUrl: string;
  /** Active members among `userIds`, with what is needed to decide. */
  loadContext(
    orgId: string,
    userIds: string[],
  ): Promise<{ orgTimezone: string; recipients: Map<string, RecipientContext> }>;
  insertInApp(
    rows: Array<{
      org_id: string;
      user_id: string;
      type: string;
      title: string;
      body: string | null;
      payload: NonNullable<Json>;
    }>,
  ): Promise<void>;
  enqueueEmail(job: { type: "email"; to: string; subject: string; text: string }): Promise<void>;
  enqueuePush(job: {
    type: "push";
    org_id: string;
    user_id: string;
    event: string;
    ids: PushIds;
  }): Promise<void>;
};

export type DispatchResult = { in_app: number; email: number; push: number; recipients: number };

export async function dispatchNotification(
  deps: DispatchDeps,
  input: NotifyInput,
): Promise<DispatchResult> {
  const result: DispatchResult = { in_app: 0, email: 0, push: 0, recipients: 0 };
  const wanted = [...new Set(input.userIds)].filter((id) => id && id !== input.exceptUserId);
  if (wanted.length === 0) return result;

  const { orgTimezone, recipients } = await deps.loadContext(input.orgId, wanted);
  const now = deps.now();
  const rows: Parameters<DispatchDeps["insertInApp"]>[0] = [];
  const mail = genericEmail(input.event);
  const link = `${deps.appUrl.replace(/\/$/, "")}${pushUrl(input.event, input.ids ?? {})}`;

  for (const userId of wanted) {
    const ctx = recipients.get(userId);
    if (!ctx) continue; // not an active member of this org
    result.recipients++;
    const { deliver } = resolveDelivery({
      event: input.event,
      prefs: ctx.prefs,
      now,
      timezone: ctx.timezone || orgTimezone || "UTC",
    });
    const allow = (c: NotificationChannel) => deliver[c] && (!input.only || input.only.includes(c));
    if (allow("in_app")) {
      rows.push({
        org_id: input.orgId,
        user_id: userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        payload: input.payload ?? {},
      });
      result.in_app++;
    }
    if (allow("email") && ctx.email && mail) {
      await deps.enqueueEmail({
        type: "email",
        to: ctx.email,
        subject: mail.subject,
        text: `${mail.sentence}\n\nOpen it: ${link}`,
      });
      result.email++;
    }
    if (allow("push")) {
      await deps.enqueuePush({
        type: "push",
        org_id: input.orgId,
        user_id: userId,
        event: input.event,
        ids: input.ids ?? {},
      });
      result.push++;
    }
  }
  if (rows.length) await deps.insertInApp(rows);
  return result;
}
