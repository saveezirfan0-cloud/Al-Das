/** Pure parts of training mode, importable from tests and client code. */
export const TRAINING_BLOCKED_MESSAGE =
  "Training mode: this workspace never contacts WhatsApp. Messages are shown on screen only.";

/** The stand-in wa_message_id of a message that was never sent. Unique per message, never a real Meta id. */
export function simulatedWaMessageId(messageId: string): string {
  return `training:${messageId}`;
}

export function isSimulatedWaMessageId(waMessageId: string | null | undefined): boolean {
  return typeof waMessageId === "string" && waMessageId.startsWith("training:");
}
