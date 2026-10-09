import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptJson, decryptSecret, encryptJson, encryptSecret } from "@/lib/crypto";

const key = randomBytes(32);
const otherKey = randomBytes(32);

describe("crypto JSON helpers", () => {
  it("round-trips JSON and never stores plaintext", () => {
    const enc = encryptJson({ app_key: "SECRET-KEY" }, key);
    expect(enc).not.toContain("SECRET-KEY");
    expect(decryptJson<{ app_key: string }>(enc, key)).toEqual({ app_key: "SECRET-KEY" });
  });

  it("rejects the wrong key and tampering", () => {
    const enc = encryptSecret("secret-value", key);
    expect(() => decryptSecret(enc, otherKey)).toThrow();
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });
});
