/**
 * Synthetic WhatsApp webhook payloads for load tests. Everything here is fake:
 * sender numbers come from a reserved test block (+971 50 099 xxxxx) and bodies are
 * generic, so no real patient data ever enters a load run (CLAUDE.md rule 10).
 */

export const SYNTHETIC_PHONE_PREFIX = "9715009";

/** wa_id for the i-th synthetic sender, e.g. 971500900042. */
export function syntheticWaId(i: number): string {
  if (i < 0 || i > 99_999) throw new Error("synthetic sender index out of range");
  return `${SYNTHETIC_PHONE_PREFIX}${String(i).padStart(5, "0")}`;
}

/** Inbound senders use indexes 0..49,999; outbound recipients use OUTBOUND_OFFSET + i so the two never collide. */
export const OUTBOUND_OFFSET = 50_000;
export const MAX_SYNTHETIC_PER_DIRECTION = 49_999;

export function syntheticE164(i: number): string {
  return `+${syntheticWaId(i)}`;
}

export function isSyntheticPhone(e164OrWaId: string): boolean {
  return e164OrWaId.replace(/^\+/, "").startsWith(SYNTHETIC_PHONE_PREFIX);
}

export function messageId(runId: string, index: number): string {
  return `wamid.LOAD_${runId}_${index}`;
}

export type MessageEventOptions = {
  runId: string;
  phoneNumberId: string;
  wabaId: string;
  /** Indexes of the messages in this POST (Meta batches several messages per webhook). */
  indexes: number[];
  senders: number;
  nowSeconds?: number;
};

/** One webhook POST body carrying `indexes.length` inbound text messages. */
export function messageEvent(o: MessageEventOptions): Record<string, unknown> {
  const ts = String(o.nowSeconds ?? Math.floor(Date.now() / 1000));
  const senders = [...new Set(o.indexes.map((i) => i % o.senders))];
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+971 4 000 0000",
                phone_number_id: o.phoneNumberId,
              },
              contacts: senders.map((s) => ({
                profile: { name: `Load Sender ${s}` },
                wa_id: syntheticWaId(s),
              })),
              messages: o.indexes.map((i) => ({
                from: syntheticWaId(i % o.senders),
                id: messageId(o.runId, i),
                timestamp: ts,
                type: "text",
                text: { body: `load test message ${i}` },
              })),
            },
          },
        ],
      },
    ],
  };
}

/** Splits 0..n-1 into POSTs of `perPost` messages each. */
export function chunkIndexes(n: number, perPost: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i += perPost)
    out.push(Array.from({ length: Math.min(perPost, n - i) }, (_, k) => i + k));
  return out;
}
