import { BlockList, isIP } from "node:net";

/**
 * SSRF protection for every server-side fetch of a URL a user (or a website) controls:
 * knowledge-base URL sources and outbound webhook endpoints.
 *
 * Rules: https only, no embedded credentials, no localhost/internal names, and every address the
 * name resolves to must be public. The same check runs again on the address actually connected to
 * (see safe-request.ts), which defeats DNS rebinding and redirects to internal hosts.
 */

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6 (IPv4-mapped addresses such as ::ffff:10.0.0.1 are checked against the IPv4 rules by BlockList)
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
for (const [net, prefix] of [
  ["64:ff9b::", 96], // NAT64: can embed any IPv4 address
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True when the literal IP is not safe to connect to (private, loopback, link-local, reserved, malformed). */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** Default resolver: every A/AAAA record for the name. */
export const dnsResolver: Resolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

const INTERNAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** Synchronous shape checks (no DNS). Returns the parsed URL. */
export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Enter a valid URL.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("Only https:// URLs are allowed.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("Enter a valid URL.");
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Internal hostnames are not allowed.");
  }
  if (isIP(host) !== 0 && isBlockedIp(host)) throw new UnsafeUrlError("That address is not publicly reachable.");
  // Bare single-label names ("intranet") only resolve inside a private network.
  if (isIP(host) === 0 && !host.includes(".")) throw new UnsafeUrlError("Enter a public hostname.");
  return url;
}

/** Shape checks plus DNS: every address the host resolves to must be public. */
export async function assertPublicHttpsUrl(
  raw: string,
  resolve: Resolver = dnsResolver,
): Promise<URL> {
  const url = parsePublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeUrlError("That hostname could not be resolved.");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("That hostname could not be resolved.");
  if (addresses.some(isBlockedIp)) throw new UnsafeUrlError("That address is not publicly reachable.");
  return url;
}
