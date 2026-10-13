/**
 * The life of an e-signature request (pure; mirrored by a database trigger). Forward only: a late or repeated provider event can never
 * move a request backwards or out of a final state.
 */
export const ESIGN_STATUSES = [
  "creating",
  "pending",
  "signed",
  "declined",
  "expired",
  "cancelled",
  "failed",
] as const;
export type EsignStatus = (typeof ESIGN_STATUSES)[number];

const NEXT: Record<EsignStatus, readonly EsignStatus[]> = {
  creating: ["pending", "failed"],
  pending: ["signed", "declined", "expired", "cancelled"],
  signed: [],
  declined: [],
  expired: [],
  cancelled: [],
  failed: [],
};

export function isEsignStatus(v: unknown): v is EsignStatus {
  return typeof v === "string" && (ESIGN_STATUSES as readonly string[]).includes(v);
}

export function canMoveEsign(from: EsignStatus, to: EsignStatus): boolean {
  return NEXT[from].includes(to);
}

export function isFinalEsign(s: EsignStatus): boolean {
  return NEXT[s].length === 0;
}

export const ESIGN_STATUS_LABEL: Record<EsignStatus, string> = {
  creating: "Sending",
  pending: "Waiting for signature",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Could not be sent",
};

/** What a provider callback event means for our status, or null when it changes nothing we track. */
export type ProviderOutcome =
  "signed" | "declined" | "expired" | "cancelled" | "partly_signed" | null;

export function outcomeForEvent(eventType: string, isComplete: boolean): ProviderOutcome {
  switch (eventType) {
    case "signature_request_all_signed":
      return "signed";
    case "signature_request_signed":
      // one signer signed; the request is done only when every signer has
      return isComplete ? "signed" : "partly_signed";
    case "signature_request_declined":
      return "declined";
    case "signature_request_expired":
      return "expired";
    case "signature_request_canceled":
      return "cancelled";
    default:
      return null;
  }
}
