import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptJson, decryptSecret, encryptJson, encryptSecret } from "@/lib/crypto";

const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips and uses a fresh iv each time", () => {
    const a = encryptSecret("hello", key);
    const b = encryptSecret("hello", key);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("hello");
    expect(decryptSecret(a, key)).toBe("hello");
  });

  it("round-trips JSON", () => {
    expect(decryptJson<{ a: number }>(encryptJson({ a: 1 }, key), key)).toEqual({ a: 1 });
  });

  it("rejects the wrong key, tampering and bad formats without leaking content", () => {
    const enc = encryptSecret("secret-value", key);
    expect(() => decryptSecret(enc, otherKey)).toThrow(/could not decrypt/);
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow(/could not decrypt/);
    expect(() => decryptSecret("garbage", key)).toThrow(/unsupported/);
  });

  it("requires a 32 byte key", () => {
    expect(() => encryptSecret("x", "c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => encryptSecret("x", undefined)).toThrow(/32 bytes/);
  });
});
