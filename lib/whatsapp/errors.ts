/**
 * Meta Cloud API error map. Decides whether a failed send is retried, what the
 * agent sees, and which side effects apply (131050 → stop_marketing).
 * Reference: WhatsApp Cloud API error codes (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
 */
export type ErrorCategory =
  | "auth" // token / permission problems → fix the channel
  | "rate_limit" // back off and retry
  | "recipient" // the recipient can't receive this (window, opt-out, invalid)
  | "template" // template missing / params mismatch
  | "media" // upload/download problems
  | "message" // bad payload
  | "account" // WABA / number state
  | "transient" // Meta-side, retry
  | "unknown";

export type MappedError = {
  code: number;
  category: ErrorCategory;
  /** Re-queue the message (visibility timeout) instead of marking it failed. */
  retryable: boolean;
  /** Set contacts.stop_marketing = true. */
  stopMarketing: boolean;
  /** The conversation window has closed: a template is required. */
  requiresTemplate: boolean;
  /** Short human text for the Failed Messages log. */
  message: string;
};

type Entry = Omit<MappedError, "code">;

const KNOWN: Record<number, Entry> = {
  0: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Authentication failed: the access token is invalid.",
  },
  1: {
    category: "transient",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Unknown API error; retrying.",
  },
  2: {
    category: "transient",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "WhatsApp service temporarily unavailable; retrying.",
  },
  3: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "The app lacks the permission for this call.",
  },
  4: {
    category: "rate_limit",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "App-level rate limit reached; retrying.",
  },
  10: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Permission denied for this number or WABA.",
  },
  33: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Unknown phone_number_id: check the channel settings.",
  },
  100: {
    category: "message",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Invalid parameter in the request.",
  },
  130429: {
    category: "rate_limit",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Number throughput limit reached; retrying.",
  },
  130472: {
    category: "recipient",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Recipient is part of a Meta experiment and cannot receive marketing messages.",
  },
  131000: {
    category: "transient",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Something went wrong on Meta's side; retrying.",
  },
  131005: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Access denied: the token lacks whatsapp_business_messaging.",
  },
  131008: {
    category: "message",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "A required parameter is missing.",
  },
  131009: {
    category: "message",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "A parameter value is invalid.",
  },
  131016: {
    category: "transient",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Service unavailable; retrying.",
  },
  131021: {
    category: "recipient",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Cannot send a message to the business's own number.",
  },
  131026: {
    category: "recipient",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message:
      "Message undeliverable: the number is not on WhatsApp, blocked the business or has an old app version.",
  },
  131031: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "The business account is locked (policy or payment).",
  },
  131037: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "The display name is not approved yet.",
  },
  131042: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Payment or business eligibility problem on the WABA.",
  },
  131045: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Phone number registration or certificate problem.",
  },
  131047: {
    category: "recipient",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: true,
    message: "More than 24 hours since the patient last replied: send a template instead.",
  },
  131048: {
    category: "rate_limit",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Spam rate limit hit: the number's quality is restricted.",
  },
  131049: {
    category: "recipient",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Meta chose not to deliver this marketing message to keep engagement healthy.",
  },
  131050: {
    category: "recipient",
    retryable: false,
    stopMarketing: true,
    requiresTemplate: false,
    message: "The patient has stopped marketing messages from this business.",
  },
  131051: {
    category: "message",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Unsupported message type.",
  },
  131052: {
    category: "media",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Media download error on Meta's side; retrying.",
  },
  131053: {
    category: "media",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Media upload error: check the file type and size.",
  },
  131056: {
    category: "rate_limit",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Too many messages to this patient in a short time; retrying later.",
  },
  131057: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "The WABA is in maintenance mode.",
  },
  132000: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template parameter count mismatch.",
  },
  132001: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template does not exist or is not approved for this language.",
  },
  132005: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template text too long after filling variables.",
  },
  132007: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template content violates the format/character policy.",
  },
  132012: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template parameter format mismatch.",
  },
  132015: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template is paused because of low quality.",
  },
  132016: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Template is disabled.",
  },
  132068: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Flow is blocked.",
  },
  132069: {
    category: "template",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Flow is throttled.",
  },
  133000: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Number deregistration incomplete.",
  },
  133004: {
    category: "transient",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Server temporarily unavailable; retrying.",
  },
  133005: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Two-step verification PIN mismatch.",
  },
  133006: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Phone number re-verification needed.",
  },
  133008: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Too many PIN guesses.",
  },
  133009: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "PIN guessed too fast.",
  },
  133010: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Phone number not registered on the Cloud API.",
  },
  133015: {
    category: "account",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Number was recently deleted; retrying.",
  },
  135000: {
    category: "message",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Generic user error: the request was malformed.",
  },
  190: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Access token expired or revoked: reconnect the channel.",
  },
  200: {
    category: "auth",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Permission error.",
  },
  368: {
    category: "account",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: "Temporarily blocked for policy violations.",
  },
  80007: {
    category: "rate_limit",
    retryable: true,
    stopMarketing: false,
    requiresTemplate: false,
    message: "WABA rate limit reached; retrying.",
  },
};

export function mapMetaError(
  code: number | null | undefined,
  fallbackMessage?: string,
): MappedError {
  const c = typeof code === "number" ? code : -1;
  const known = KNOWN[c];
  if (known) return { code: c, ...known };
  if (c >= 200 && c <= 299) {
    return {
      code: c,
      category: "auth",
      retryable: false,
      stopMarketing: false,
      requiresTemplate: false,
      message: "Permission error from Meta.",
    };
  }
  if (c >= 500 && c <= 599) {
    return {
      code: c,
      category: "transient",
      retryable: true,
      stopMarketing: false,
      requiresTemplate: false,
      message: "Meta service error; retrying.",
    };
  }
  return {
    code: c,
    category: "unknown",
    retryable: false,
    stopMarketing: false,
    requiresTemplate: false,
    message: fallbackMessage ? fallbackMessage.slice(0, 300) : "Unknown error.",
  };
}

/** Shape of the Graph API error body. */
export type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_data?: { messaging_product?: string; details?: string };
    error_user_title?: string;
    error_user_msg?: string;
  };
};

export class WhatsAppApiError extends Error {
  readonly code: number;
  readonly subcode: number | null;
  readonly httpStatus: number;
  readonly fbtraceId: string | null;
  readonly details: string | null;
  /** Meta's own wording for the person (error_user_title / error_user_msg), when it sends one. */
  readonly userMessage: string | null;
  readonly mapped: MappedError;

  constructor(
    httpStatus: number,
    body: GraphErrorBody | null,
    fallback = "WhatsApp API request failed",
  ) {
    const err = body?.error;
    const code = typeof err?.code === "number" ? err.code : httpStatus >= 500 ? httpStatus : -1;
    const mapped = mapMetaError(code, err?.message ?? fallback);
    super(`${mapped.message} (code ${code})`);
    this.name = "WhatsAppApiError";
    this.code = code;
    this.subcode = typeof err?.error_subcode === "number" ? err.error_subcode : null;
    this.httpStatus = httpStatus;
    this.fbtraceId = err?.fbtrace_id ?? null;
    this.details = err?.error_data?.details ?? null;
    this.userMessage =
      [err?.error_user_title, err?.error_user_msg].filter(Boolean).join(": ").slice(0, 400) || null;
    this.mapped = mapped;
  }
}

/** Error codes a campaign retry round may re-send (everything the error map marks retryable, incl. 5xx). */
export function retryableErrorCodes(): number[] {
  const codes = Object.entries(KNOWN)
    .filter(([, e]) => e.retryable)
    .map(([c]) => Number(c));
  for (let c = 500; c <= 599; c++) codes.push(c);
  return codes;
}
