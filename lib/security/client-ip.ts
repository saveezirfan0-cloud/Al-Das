/**
 * Client IP addresses: reading them from the platform headers, parsing IPv4/IPv6, and matching CIDR ranges.
 * Pure (no Node built-ins) so the settings form, the server and the tests share one implementation.
 *
 * Header order (Vercel sets all three at its edge and overwrites anything the client sent):
 * `x-vercel-forwarded-for`, then `x-real-ip`, then the FIRST hop of `x-forwarded-for`. Off Vercel anyone can send these
 * headers, so `requestClientIp` (used for the finance allow-list) trusts them only when `VERCEL=1`.
 */

/** The raw first-hop value from the platform headers, or null when none is present. Not validated. */
export function rawClientIp(h: Pick<Headers, "get">): string | null {
  const vercel = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || null;
}

export type ParsedIp = { version: 4 | 6; bytes: number[] };

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // decimal only, no leading zeros (an "010" octet is octal to some tools and decimal to others)
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIpv6(s: string): number[] | null {
  if (s.length > 45 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.includes(".")) {
        // embedded IPv4, only as the last item
        if (i !== items.length - 1) return null;
        const v4 = parseIpv4(item);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  let words: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" stands for at least one zero group
    words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as the IPv4 address, so a v4 range matches it. */
function unmap(ip: ParsedIp): ParsedIp {
  if (ip.version !== 6) return ip;
  const b = ip.bytes;
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  return mapped ? { version: 4, bytes: b.slice(12) } : ip;
}

/** Parses a bare IPv4 or IPv6 address (no port, no brackets, no zone). Null when it is not one. */
export function parseIp(input: string): ParsedIp | null {
  const s = input.trim();
  if (!s) return null;
  if (s.includes(":")) {
    const bytes = parseIpv6(s);
    return bytes ? unmap({ version: 6, bytes }) : null;
  }
  const bytes = parseIpv4(s);
  return bytes ? { version: 4, bytes } : null;
}

/**
 * Turns a header value into a parsed address: strips "[v6]:port" brackets and an IPv4 ":port". Anything that is not a
 * valid address (including "unknown") is null, so a garbage header can never match an allow-list.
 */
export function parseClientIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  let s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  return parseIp(s);
}

/** True when this server runs on Vercel, whose edge sets the forwarding headers and overwrites client values. */
export function forwardingHeadersTrusted(): boolean {
  return typeof process !== "undefined" && process.env?.VERCEL === "1";
}

/**
 * The client address of this request for SECURITY decisions (the finance access allow-list), parsed. Null when the
 * headers cannot be trusted (not on Vercel: anyone could send them), when missing, or when not an address; a null
 * address is refused whenever an allow-list is set. Rate limiting keeps using the raw value (`rawClientIp`).
 */
export function requestClientIp(
  h: Pick<Headers, "get">,
  trusted: boolean = forwardingHeadersTrusted(),
): ParsedIp | null {
  if (!trusted) return null;
  return parseClientIp(rawClientIp(h));
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return ip.bytes.join(".");
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((ip.bytes[i] << 8) | ip.bytes[i + 1]);
  // RFC 5952: compress the longest run (2+) of zero groups, the first one on a tie
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best.len < 2) return hex.join(":");
  const left = hex.slice(0, best.start).join(":");
  const right = hex.slice(best.start + best.len).join(":");
  return `${left}::${right}`;
}

export type IpRange = { version: 4 | 6; bytes: number[]; prefix: number };

export type RangeParse = { ok: true; range: IpRange; text: string } | { ok: false; error: string };

/**
 * Parses one allow-list entry: an address ("203.0.113.7", "2001:db8::1") or a CIDR range ("203.0.113.0/24",
 * "2001:db8::/48"). Host bits are cleared, so "203.0.113.9/24" is stored as "203.0.113.0/24". A /0 range is refused:
 * it allows every address, which is what an empty list already means.
 */
export function parseIpRange(input: string): RangeParse {
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter an address or a range." };
  if (s.length > 64) return { ok: false, error: `"${s.slice(0, 20)}…" is too long.` };
  const slash = s.indexOf("/");
  const addrText = slash === -1 ? s : s.slice(0, slash);
  const ip = parseIp(addrText);
  if (!ip) return { ok: false, error: `"${s}" is not an IPv4 or IPv6 address.` };
  const max = ip.version === 4 ? 32 : 128;
  const written = addrText.includes(":") ? 128 : 32;
  let prefix = max;
  if (slash !== -1) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p) || Number(p) > written)
      return { ok: false, error: `"${s}": the range size must be /0 to /${written}.` };
    prefix = Number(p);
    // "::ffff:a.b.c.d/n" was unmapped to IPv4; its prefix counted the 96 mapped bits
    if (ip.version === 4 && written === 128) {
      if (prefix < 96) return { ok: false, error: `"${s}" mixes IPv4 and IPv6 ranges.` };
      prefix -= 96;
    }
  }
  if (prefix === 0)
    return {
      ok: false,
      error: `"${s}" allows every address. Leave the list empty to allow any location.`,
    };
  const bytes = ip.bytes.map((b, i) => {
    const bitsLeft = prefix - i * 8;
    if (bitsLeft >= 8) return b;
    if (bitsLeft <= 0) return 0;
    return b & ((0xff << (8 - bitsLeft)) & 0xff);
  });
  const range: IpRange = { version: ip.version, bytes, prefix };
  const text =
    prefix === max
      ? formatIp({ version: ip.version, bytes })
      : `${formatIp({ version: ip.version, bytes })}/${prefix}`;
  return { ok: true, range, text };
}

/** True when the address falls inside the range (same IP version only). */
export function ipInRange(ip: ParsedIp, range: IpRange): boolean {
  if (ip.version !== range.version) return false;
  let bits = range.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip.bytes[i] & mask) !== (range.bytes[i] & mask)) return false;
  }
  return true;
}

/** True when the address matches any entry. Unparseable entries never match (they are refused when saved). */
export function ipAllowed(ip: ParsedIp, entries: readonly string[]): boolean {
  return entries.some((e) => {
    const r = parseIpRange(e);
    return r.ok && ipInRange(ip, r.range);
  });
}

/**
 * A short, non-reversible label for logs and alerts: the IPv4 /24 or the IPv6 /48 network, never the full address.
 * Enough to tell "the office" from "somewhere else" without storing who connected from where.
 */
export function ipNetworkLabel(ip: ParsedIp): string {
  if (ip.version === 4) return `${ip.bytes.slice(0, 3).join(".")}.0/24`;
  const net = parseIpRange(`${formatIp(ip)}/48`);
  return net.ok ? net.text : "ipv6";
}
