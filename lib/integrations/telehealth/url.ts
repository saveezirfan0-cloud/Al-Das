/**
 * The meeting address of the "static room" provider (pure): an https address with exactly one {token} where the room's unguessable
 * token goes. The host is the allow-list: it is the only host a link is ever built for, and it must be a public name (no IP address,
 * no localhost, no internal suffix), so a setting typed into a form can never point patients at an internal address.
 */
export const TOKEN_PLACEHOLDER = "{token}";

const DENIED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".home.arpa",
];

export type TemplateCheck =
  { ok: true; template: string; host: string } | { ok: false; error: string };

export function validateRoomTemplate(raw: unknown): TemplateCheck {
  if (typeof raw !== "string") return { ok: false, error: "Enter the meeting address." };
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter the meeting address." };
  if (text.length > 300) return { ok: false, error: "That address is too long." };
  if (/[\s\u0000-\u001f\u007f]/.test(text))
    return { ok: false, error: "The address has spaces or invalid characters." };
  if (!text.startsWith("https://"))
    return { ok: false, error: "The address must start with https://." };
  const count = text.split(TOKEN_PLACEHOLDER).length - 1;
  if (count !== 1)
    return { ok: false, error: `The address must contain ${TOKEN_PLACEHOLDER} exactly once.` };
  const afterScheme = text.slice("https://".length);
  const firstSlash = afterScheme.search(/[/?#]/);
  const authority = firstSlash === -1 ? afterScheme : afterScheme.slice(0, firstSlash);
  if (authority.includes(TOKEN_PLACEHOLDER) || firstSlash === -1)
    return {
      ok: false,
      error: `Put ${TOKEN_PLACEHOLDER} after the host name, for example https://meet.example.com/${TOKEN_PLACEHOLDER}.`,
    };
  let u: URL;
  try {
    u = new URL(text.replace(TOKEN_PLACEHOLDER, "x".repeat(43)));
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The address must start with https://." };
  if (u.username || u.password)
    return { ok: false, error: "The address must not contain a user name or password." };
  if (u.port) return { ok: false, error: "The address must not name a port." };
  const host = u.hostname.toLowerCase();
  if (host.includes(":") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host))
    return { ok: false, error: "Use a meeting service's name, not an IP address." };
  if (host === "localhost" || DENIED_SUFFIXES.some((s) => host.endsWith(s)))
    return { ok: false, error: "Use a public meeting service, not an internal address." };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
    return { ok: false, error: "That host name is not valid." };
  return { ok: true, template: text, host };
}

/** Builds a room address from a validated template. The token is base64url, so it needs no escaping. */
export function buildRoomUrl(template: string, token: string): string | null {
  const t = validateRoomTemplate(template);
  if (!t.ok || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  return t.template.replace(TOKEN_PLACEHOLDER, token);
}
