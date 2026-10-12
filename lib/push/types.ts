/** What a browser gives us when someone allows notifications (PushSubscription.toJSON()). */
export type PushSubscriptionData = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushSendOptions = {
  /** Seconds the push service may hold the message while the device is offline. */
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** Newer messages with the same topic replace undelivered older ones at the push service. */
  topic?: string;
};

export type PushSendResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      /** 404 and 410: the subscription no longer exists and must be deleted. */
      gone: boolean;
    };

/**
 * The only thing the app knows about the push network. The real implementation (web-push + VAPID) lives
 * in web-push-sender.ts; tests pass a fake. Nothing in the test suite may reach a real push service.
 */
export interface PushSender {
  send(
    subscription: PushSubscriptionData,
    payload: string,
    options: PushSendOptions,
  ): Promise<PushSendResult>;
}
