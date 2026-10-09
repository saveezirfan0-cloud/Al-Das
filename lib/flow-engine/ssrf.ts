/**
 * SSRF guard for the API Action node. Pure parts live here (literal checks); the
 * production HTTP action additionally resolves DNS and re-checks every resolved address.
 */
import { isIP } from "node:net";

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224 // multicast + reserved
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb"))
      return true; // link-local
    if (x.startsWith("fc") || x.startsWith("fd")) return true; // unique local
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7)); // v4-mapped
    return false;
  }
  return true; // not an IP: treat as unsafe when asked
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkOutboundUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Only https:// URLs are allowed" };
  if (url.username || url.password)
    return { ok: false, reason: "Credentials in the URL are not allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { ok: false, reason: "Missing host" };
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: "Internal hosts are not allowed" };
  }
  if (isIP(host) !== 0 && isPrivateAddress(host))
    return { ok: false, reason: "Private addresses are not allowed" };
  return { ok: true, url };
}
