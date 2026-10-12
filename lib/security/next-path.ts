/** Only same-site relative paths are followed after sign-in or verification (no open redirects). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
    return fallback;
  if (/^\/(mfa|login)(\/|$)/.test(next)) return fallback;
  return next;
}
