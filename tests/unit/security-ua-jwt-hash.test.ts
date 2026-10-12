import { describe, expect, it } from "vitest";

import { hmacHash } from "@/lib/security/hash";
import { readTokenClaims } from "@/lib/security/jwt";
import { safeNextPath } from "@/lib/security/next-path";
import { uaFamily } from "@/lib/security/ua";

describe("uaFamily", () => {
  it("reduces a user agent to browser and system, with no version numbers", () => {
    expect(
      uaFamily(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
    expect(
      uaFamily(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      uaFamily(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0",
      ),
    ).toBe("Edge on macOS");
    expect(uaFamily("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe(
      "Firefox on Linux",
    );
    expect(
      uaFamily(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
  });

  it("copes with empty, missing and hostile input", () => {
    expect(uaFamily(null)).toBe("Unknown device");
    expect(uaFamily("")).toBe("Unknown device");
    expect(uaFamily("curl/8.0")).toBe("Unknown device");
    expect(uaFamily("x".repeat(100_000)).length).toBeLessThanOrEqual(40);
  });
});

describe("readTokenClaims", () => {
  const token = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  it("reads the session id and assurance level", () => {
    expect(readTokenClaims(token({ session_id: "abc-123", aal: "aal2" }))).toEqual({
      sessionId: "abc-123",
      aal: "aal2",
    });
    expect(readTokenClaims(token({ session_id: "abc", aal: "aal1" }))).toEqual({
      sessionId: "abc",
      aal: "aal1",
    });
  });
  it("returns nothing for junk instead of throwing", () => {
    const none = { sessionId: null, aal: null };
    expect(readTokenClaims(null)).toEqual(none);
    expect(readTokenClaims("not.a.jwt")).toEqual(none);
    expect(readTokenClaims("onlyone")).toEqual(none);
    expect(readTokenClaims(token({ session_id: 42, aal: "aal9" }))).toEqual(none);
    expect(readTokenClaims(token({ session_id: "x".repeat(500) }))).toEqual(none);
  });
});

describe("hmacHash", () => {
  it("is keyed, stable, case/space-insensitive and does not contain the input", () => {
    const a = hmacHash(" Alice@Example.com ", "secret-1");
    expect(a).toBe(hmacHash("alice@example.com", "secret-1"));
    expect(a).not.toBe(hmacHash("alice@example.com", "secret-2"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("alice");
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths and refuses open redirects and the MFA/login pages", () => {
    expect(safeNextPath("/inbox?c=1")).toBe("/inbox?c=1");
    expect(safeNextPath("//evil.test")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.test")).toBe("/dashboard");
    expect(safeNextPath("https://evil.test")).toBe("/dashboard");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("/mfa/verify")).toBe("/dashboard");
    expect(safeNextPath("/login")).toBe("/dashboard");
  });
});
