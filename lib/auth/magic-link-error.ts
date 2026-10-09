/**
 * Turns a Supabase Auth OTP / magic-link error into copy safe to show on the
 * sign-in page. Only the error code and HTTP status are inspected, never the
 * email address.
 */
export type OtpError = { code?: string | null; status?: number | null };

export const MAGIC_LINK_COPY = {
  noAccount:
    "We couldn't send a link to that address. Ask your admin for an invite if you're new.",
  rateLimited:
    "Too many sign-in emails were requested. Wait a few minutes, or sign in with your password.",
  mailFailed:
    "We couldn't send the email right now. Sign in with your password, or try again shortly.",
} as const;

export function magicLinkErrorMessage(error: OtpError): string {
  const code = error.code ?? "";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error.status === 429) {
    return MAGIC_LINK_COPY.rateLimited;
  }
  // shouldCreateUser is false, so an unknown address comes back as otp_disabled / user_not_found.
  if (code === "otp_disabled" || code === "user_not_found" || code === "signup_disabled") {
    return MAGIC_LINK_COPY.noAccount;
  }
  if (error.status && error.status >= 500) return MAGIC_LINK_COPY.mailFailed;
  if (code === "unexpected_failure" || code === "smtp_failed") return MAGIC_LINK_COPY.mailFailed;
  return MAGIC_LINK_COPY.noAccount;
}
