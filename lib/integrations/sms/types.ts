/**
 * The provider seam for SMS (Phase 19). Pulse talks to an `SmsProvider`, never to a vendor directly, so a second gateway is a new
 * adapter and tests use the fake in fake.ts. Adapters never see more than the number, the text and a reference.
 */

export type SmsSendInput = {
  /** E.164. */
  to: string;
  body: string;
  /** Our sms_messages id; adapters pass it through where the provider supports a client reference. */
  clientRef: string;
  /** Where the provider reports delivery. */
  statusCallbackUrl: string;
};

export type SmsSendResult =
  | { ok: true; providerMessageId: string; status: string; segments: number | null }
  | {
      ok: false;
      /** A short stable code (the provider's error number, or "auth", "breaker_open", "timeout", ...). Never message text. */
      code: string;
      /** Trying again later may work (rate limit, breaker open). */
      retryable: boolean;
      /** The provider may already have sent it. Do not send again. */
      ambiguous: boolean;
      /** The recipient has unsubscribed at the provider. */
      optOut: boolean;
    };

export interface SmsProvider {
  readonly id: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
  /** A read-only call that proves the credentials work. */
  verify(): Promise<{ ok: boolean; code?: string }>;
}
