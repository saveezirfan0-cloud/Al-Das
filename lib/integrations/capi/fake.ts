import type { CapiClient, CapiSendResult } from "@/lib/integrations/capi/client";
import type { CapiPayload } from "@/lib/integrations/capi/event";

/** An in-memory stand-in for tests: records every payload, and can be told to fail. Never touches the network. */
export function createFakeCapiClient(
  script: { results?: CapiSendResult[]; verify?: { ok: boolean; code?: string } } = {},
): CapiClient & { sent: CapiPayload[] } {
  const sent: CapiPayload[] = [];
  const results = [...(script.results ?? [])];
  return {
    id: "meta_capi",
    sent,
    async sendEvents(payload) {
      sent.push(JSON.parse(JSON.stringify(payload)) as CapiPayload);
      return results.shift() ?? { ok: true, eventsReceived: payload.data.length };
    },
    async verify() {
      return script.verify ?? { ok: true };
    },
  };
}
