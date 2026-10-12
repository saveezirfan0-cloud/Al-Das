import type { SmsProvider, SmsSendInput, SmsSendResult } from "@/lib/integrations/sms/types";

/** A scripted SMS provider for tests. Records what it was asked to send; never touches the network. */
export function createFakeSmsProvider(
  script: Array<SmsSendResult | ((input: SmsSendInput) => SmsSendResult)> = [],
): SmsProvider & { sent: SmsSendInput[] } {
  const sent: SmsSendInput[] = [];
  let n = 0;
  return {
    id: "fake",
    sent,
    async send(input) {
      sent.push(input);
      const next = script[Math.min(sent.length - 1, script.length - 1)];
      if (next) return typeof next === "function" ? next(input) : next;
      n += 1;
      return {
        ok: true,
        providerMessageId: `SMfake${String(n).padStart(4, "0")}`,
        status: "queued",
        segments: 1,
      };
    },
    async verify() {
      return { ok: true };
    },
  };
}
