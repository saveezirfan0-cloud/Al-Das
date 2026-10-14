import { describe, expect, it } from "vitest";

import {
  formatIp,
  ipAllowed,
  ipInRange,
  ipNetworkLabel,
  parseClientIp,
  parseIp,
  parseIpRange,
  rawClientIp,
  requestClientIp,
} from "@/lib/security/client-ip";

// Addresses are from the documentation ranges (RFC 5737 / RFC 3849) only.

const h = (entries: Record<string, string>) => new Headers(entries);

describe("rawClientIp / requestClientIp", () => {
  it("prefers x-vercel-forwarded-for, then x-real-ip, then the first x-forwarded-for hop", () => {
    expect(
      rawClientIp(
        h({
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-real-ip": "198.51.100.1",
          "x-forwarded-for": "192.0.2.1",
        }),
      ),
    ).toBe("203.0.113.7");
    expect(rawClientIp(h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.1" }))).toBe(
      "198.51.100.1",
    );
    expect(rawClientIp(h({ "x-forwarded-for": "192.0.2.1, 10.0.0.1, 10.0.0.2" }))).toBe(
      "192.0.2.1",
    );
  });

  it("returns null when no header is present", () => {
    expect(rawClientIp(h({}))).toBeNull();
    expect(requestClientIp(h({}))).toBeNull();
    expect(rawClientIp(h({ "x-forwarded-for": " , 10.0.0.1" }))).toBeNull();
  });

  it("parses the header value and refuses garbage", () => {
    expect(requestClientIp(h({ "x-real-ip": "203.0.113.7" }))).toEqual({
      version: 4,
      bytes: [203, 0, 113, 7],
    });
    expect(requestClientIp(h({ "x-real-ip": "unknown" }))).toBeNull();
    expect(requestClientIp(h({ "x-real-ip": "203.0.113.7; drop" }))).toBeNull();
  });
});

describe("parseIp / parseClientIp", () => {
  it("accepts IPv4 and refuses malformed or octal-looking octets", () => {
    expect(parseIp("192.0.2.255")?.bytes).toEqual([192, 0, 2, 255]);
    for (const bad of ["192.0.2", "192.0.2.256", "192.0.2.01", "1.2.3.4.5", "a.b.c.d", "", " "])
      expect(parseIp(bad)).toBeNull();
  });

  it("accepts IPv6 forms and refuses malformed ones", () => {
    expect(formatIp(parseIp("2001:db8::1")!)).toBe("2001:db8::1");
    expect(formatIp(parseIp("2001:0DB8:0000:0000:0000:0000:0000:0001")!)).toBe("2001:db8::1");
    expect(formatIp(parseIp("::")!)).toBe("::");
    expect(formatIp(parseIp("::1")!)).toBe("::1");
    expect(formatIp(parseIp("2001:db8:0:1:0:0:0:1")!)).toBe("2001:db8:0:1::1");
    expect(formatIp(parseIp("64:ff9b::192.0.2.33")!)).toBe("64:ff9b::c000:221");
    for (const bad of [
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "2001:db8:1:2:3:4:5",
      "12345::1",
      "fe80::1%eth0",
      "2001:db8::g",
      "::1.2.3.4:5",
      ":::",
      "1:2:3:4:5:6:7::8",
    ])
      expect(parseIp(bad), bad).toBeNull();
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(parseIp("::ffff:203.0.113.7")).toEqual({ version: 4, bytes: [203, 0, 113, 7] });
    expect(parseIp("::ffff:cb00:7107")).toEqual({ version: 4, bytes: [203, 0, 113, 7] });
  });

  it("strips ports and brackets from header values", () => {
    expect(parseClientIp("203.0.113.7:51234")?.bytes).toEqual([203, 0, 113, 7]);
    expect(formatIp(parseClientIp("[2001:db8::7]:443")!)).toBe("2001:db8::7");
    expect(formatIp(parseClientIp("[2001:db8::7]")!)).toBe("2001:db8::7");
    expect(parseClientIp(null)).toBeNull();
    expect(parseClientIp("")).toBeNull();
  });
});

describe("parseIpRange", () => {
  it("canonicalises addresses and clears host bits", () => {
    expect(parseIpRange("203.0.113.7")).toMatchObject({ ok: true, text: "203.0.113.7" });
    expect(parseIpRange("203.0.113.9/24")).toMatchObject({ ok: true, text: "203.0.113.0/24" });
    expect(parseIpRange("10.200.3.4/12")).toMatchObject({ ok: true, text: "10.192.0.0/12" });
    expect(parseIpRange("2001:DB8:abcd:12::/48")).toMatchObject({
      ok: true,
      text: "2001:db8:abcd::/48",
    });
    expect(parseIpRange("2001:db8::1/128")).toMatchObject({ ok: true, text: "2001:db8::1" });
    expect(parseIpRange("::ffff:203.0.113.0/120")).toMatchObject({
      ok: true,
      text: "203.0.113.0/24",
    });
  });

  it("refuses bad entries with a reason", () => {
    for (const bad of [
      "",
      "203.0.113.0/33",
      "2001:db8::/129",
      "203.0.113.0/-1",
      "203.0.113.0/",
      "203.0.113.0/2a",
      "example.com",
      "0.0.0.0/0",
      "::/0",
      "::ffff:1.2.3.0/64",
      "x".repeat(65),
    ]) {
      const r = parseIpRange(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe("ipInRange / ipAllowed", () => {
  const range = (s: string) => {
    const r = parseIpRange(s);
    if (!r.ok) throw new Error(r.error);
    return r.range;
  };

  it("matches IPv4 CIDR boundaries", () => {
    expect(ipInRange(parseIp("203.0.113.0")!, range("203.0.113.0/24"))).toBe(true);
    expect(ipInRange(parseIp("203.0.113.255")!, range("203.0.113.0/24"))).toBe(true);
    expect(ipInRange(parseIp("203.0.114.0")!, range("203.0.113.0/24"))).toBe(false);
    expect(ipInRange(parseIp("198.51.100.130")!, range("198.51.100.128/25"))).toBe(true);
    expect(ipInRange(parseIp("198.51.100.127")!, range("198.51.100.128/25"))).toBe(false);
    expect(ipInRange(parseIp("203.0.113.7")!, range("203.0.113.7"))).toBe(true);
    expect(ipInRange(parseIp("203.0.113.8")!, range("203.0.113.7"))).toBe(false);
  });

  it("matches IPv6 CIDR boundaries", () => {
    expect(ipInRange(parseIp("2001:db8:abcd:ffff::1")!, range("2001:db8:abcd::/48"))).toBe(true);
    expect(ipInRange(parseIp("2001:db8:abce::1")!, range("2001:db8:abcd::/48"))).toBe(false);
    expect(ipInRange(parseIp("2001:db8::8000")!, range("2001:db8::8000/113"))).toBe(true);
    expect(ipInRange(parseIp("2001:db8::7fff")!, range("2001:db8::8000/113"))).toBe(false);
  });

  it("never matches across IP versions, except mapped IPv4", () => {
    expect(ipInRange(parseIp("2001:db8::1")!, range("203.0.113.0/24"))).toBe(false);
    expect(ipInRange(parseIp("203.0.113.1")!, range("2001:db8::/32"))).toBe(false);
    expect(ipInRange(parseIp("::ffff:203.0.113.1")!, range("203.0.113.0/24"))).toBe(true);
  });

  it("checks a list and ignores unparseable entries", () => {
    const list = ["junk", "198.51.100.0/24", "2001:db8::/32"];
    expect(ipAllowed(parseIp("198.51.100.9")!, list)).toBe(true);
    expect(ipAllowed(parseIp("2001:db8:1::1")!, list)).toBe(true);
    expect(ipAllowed(parseIp("192.0.2.1")!, list)).toBe(false);
    expect(ipAllowed(parseIp("192.0.2.1")!, [])).toBe(false);
  });
});

describe("ipNetworkLabel", () => {
  it("keeps only the network, never the full address", () => {
    expect(ipNetworkLabel(parseIp("203.0.113.77")!)).toBe("203.0.113.0/24");
    expect(ipNetworkLabel(parseIp("2001:db8:abcd:12:3:4:5:6")!)).toBe("2001:db8:abcd::/48");
  });
});
