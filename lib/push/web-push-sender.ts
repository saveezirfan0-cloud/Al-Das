import "server-only";

import webpush from "web-push";

import { vapidEnv } from "@/lib/env";
import type {
  PushSender,
  PushSendOptions,
  PushSendResult,
  PushSubscriptionData,
} from "@/lib/push/types";

/** True when VAPID keys are set (run `pnpm push:keys` and put them in the environment). */
export function isPushConfigured(): boolean {
  const v = vapidEnv();
  return !!(v.VAPID_PUBLIC_KEY && v.VAPID_PRIVATE_KEY);
}

/** The real sender: web-push with VAPID. Never constructed in tests (they pass a fake PushSender). */
export function createWebPushSender(): PushSender {
  const v = vapidEnv();
  if (!v.VAPID_PUBLIC_KEY || !v.VAPID_PRIVATE_KEY)
    throw new Error("Web Push is not configured (VAPID keys missing)");
  const vapidDetails = {
    subject: v.VAPID_SUBJECT,
    publicKey: v.VAPID_PUBLIC_KEY,
    privateKey: v.VAPID_PRIVATE_KEY,
  };
  return {
    async send(
      subscription: PushSubscriptionData,
      payload: string,
      options: PushSendOptions,
    ): Promise<PushSendResult> {
      try {
        await webpush.sendNotification(subscription, payload, {
          vapidDetails,
          TTL: options.ttl,
          urgency: options.urgency,
          topic: options.topic,
          timeout: 10_000,
        });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        return { ok: false, status, gone: status === 404 || status === 410 };
      }
    },
  };
}
