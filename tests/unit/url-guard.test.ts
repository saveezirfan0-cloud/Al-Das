import { describe, expect, it } from "vitest";

import { assertPublicHttpsUrl, isBlockedIp, parsePublicHttpsUrl, UnsafeUrlError } from "@/lib/net/url-guard";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "2002:7f00:1::1", // 6to4 embedding 127.0.0.1
    "2001:0:4136:e378:8000:63bf:80ff:fffe", // Teredo
    "fec0::1", // site-local
    "192.88.99.1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("parsePublicHttpsUrl", () => {
  it("accepts a normal https URL", () => {
    expect(parsePublicHttpsUrl("https://clinic.example.com/hours?x=1").hostname).toBe("clinic.example.com");
  });

  it.each([
    ["http://clinic.example.com", /https/],
    ["ftp://clinic.example.com", /https/],
    ["not a url", /valid URL/],
    ["https://user:pw@clinic.example.com", /credentials/],
    ["https://localhost/x", /Internal/],
    ["https://printer.local/x", /Internal/],
    ["https://db.internal/x", /Internal/],
    ["https://intranet/x", /public hostname/],
    ["https://127.0.0.1/x", /not publicly reachable/],
    ["https://[::1]/x", /not publicly reachable/],
    ["https://169.254.169.254/latest/meta-data", /not publicly reachable/],
  ])("rejects %s", (raw, message) => {
    expect(() => parsePublicHttpsUrl(raw)).toThrow(UnsafeUrlError);
    expect(() => parsePublicHttpsUrl(raw)).toThrow(message);
  });
});

describe("assertPublicHttpsUrl", () => {
  const resolveTo = (...addresses: string[]) => async () => addresses;

  it("passes when every resolved address is public", async () => {
    await expect(assertPublicHttpsUrl("https://clinic.example.com", resolveTo("93.184.216.34", "2606:4700::1"))).resolves.toBeInstanceOf(URL);
  });

  it("fails when ANY resolved address is private (mixed answers)", async () => {
    await expect(
      assertPublicHttpsUrl("https://rebind.example.com", resolveTo("93.184.216.34", "10.0.0.5")),
    ).rejects.toThrow(/not publicly reachable/);
  });

  it("fails when the name does not resolve", async () => {
    await expect(assertPublicHttpsUrl("https://nope.example.com", async () => [])).rejects.toThrow(/resolved/);
    await expect(
      assertPublicHttpsUrl("https://nope.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/resolved/);
  });

  it("does not need DNS for a public IP literal", async () => {
    await expect(
      assertPublicHttpsUrl("https://8.8.8.8/x", async () => {
        throw new Error("should not resolve");
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});
