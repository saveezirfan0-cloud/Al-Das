/**
 * The review link a clinic gives a location (pure). It ends up inside a WhatsApp message to a patient, so it must be a plain
 * https address on one of Google's own hosts: no other site, no credentials in the address, no port, no whitespace.
 *
 *   google.com / www.google.com / search.google.com / maps.google.com   e.g. https://search.google.com/local/writereview?placeid=...
 *   g.page                                                              e.g. https://g.page/r/xxxx/review
 *   maps.app.goo.gl                                                     e.g. https://maps.app.goo.gl/xxxx
 */
export const REVIEW_HOSTS: readonly string[] = [
  "google.com",
  "www.google.com",
  "search.google.com",
  "maps.google.com",
  "g.page",
  "maps.app.goo.gl",
];

export const MAX_REVIEW_URL_LENGTH = 500;

export type ReviewUrlResult = { ok: true; url: string } | { ok: false; error: string };

export function validateReviewUrl(raw: unknown): ReviewUrlResult {
  if (typeof raw !== "string") return { ok: false, error: "Enter the review link." };
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter the review link." };
  if (text.length > MAX_REVIEW_URL_LENGTH) return { ok: false, error: "That link is too long." };
  if (/[\s\u0000-\u001f\u007f]/.test(text))
    return { ok: false, error: "The link has spaces or invalid characters." };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The link must start with https://." };
  if (u.username || u.password)
    return { ok: false, error: "The link must not contain a user name or password." };
  if (u.port) return { ok: false, error: "The link must not name a port." };
  if (!REVIEW_HOSTS.includes(u.hostname.toLowerCase()))
    return {
      ok: false,
      error: "Use your Google review link (google.com, g.page or maps.app.goo.gl).",
    };
  return { ok: true, url: u.toString() };
}
