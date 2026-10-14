/**
 * Phase 20h: when a WhatsApp send goes through Meta's Marketing Messages Lite API (MM Lite) instead of /messages (pure).
 *
 * Only a template message, only one sent by a campaign, only when its template is in the MARKETING category, and only while
 * the `wa_mm_lite` integration is switched on for the workspace. Everything else (inbox replies, reminders, utility or
 * authentication templates, flows, one-off template sends) keeps using /messages. Every earlier guard of the outbound job
 * (training mode, campaign withdrawal, stop_marketing, the per-number send slot, TTL) runs before this decision.
 */
export type MmLiteInput = {
  specType: string;
  campaignRecipientId: string | null | undefined;
  templateCategory: string | null | undefined;
  enabled: boolean;
};

export function sendsThroughMmLite(i: MmLiteInput): boolean {
  return (
    i.enabled === true &&
    i.specType === "template" &&
    typeof i.campaignRecipientId === "string" &&
    i.campaignRecipientId.length > 0 &&
    (i.templateCategory ?? "").toUpperCase() === "MARKETING"
  );
}
