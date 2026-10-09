import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "@/lib/public-api/cursor";
import { API_KEY_SCOPES, generateApiKey, hashApiKey, hasScope, isApiKeyScope, looksLikeApiKey, parseBearer } from "@/lib/public-api/keys";

describe("API keys", () => {
  it("generates a well-formed key whose hash (not the key) is what gets stored", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^pk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeApiKey(key)).toBe(true);
    expect(key.startsWith(prefix + "_")).toBe(true);
    expect(prefix).toMatch(/^pk_[0-9a-f]{8}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key.slice(-10));
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key));
    expect(keys.size).toBe(500);
  });

  it("rejects malformed keys before any lookup", () => {
    for (const bad of ["", "pk_", "pk_abcd1234", "pk_abcd1234_short", "sk_abcd1234_" + "a".repeat(43), "pk_ABCD1234_" + "a".repeat(43), "pk_abcd1234_" + "a".repeat(44), "pk_abcd1234_" + "a".repeat(42) + "!"]) {
      expect(looksLikeApiKey(bad), bad).toBe(false);
    }
  });

  it("parses the Authorization header", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer   abc  ")).toBe("abc");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });

  it("checks scopes exactly", () => {
    expect(API_KEY_SCOPES).toEqual(["contacts:read", "contacts:write", "messages:send_template"]);
    expect(hasScope(["contacts:read"], "contacts:read")).toBe(true);
    expect(hasScope(["contacts:read"], "contacts:write")).toBe(false);
    expect(hasScope([], "contacts:read")).toBe(false);
    expect(isApiKeyScope("contacts:read")).toBe(true);
    expect(isApiKeyScope("admin")).toBe(false);
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    const c = { t: "2026-01-10T23:30:00.123456+00:00", id: "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("not-base64-json")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: "yesterday", id: "x" })).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: c.t, id: "'; drop table contacts;--" })).toString("base64url"))).toBeNull();
  });
});
