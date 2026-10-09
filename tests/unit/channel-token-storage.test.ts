import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret } from "@/lib/crypto";
import { channelAccessToken, storeChannelToken } from "@/lib/whatsapp/channel";

const KEY = randomBytes(32).toString("base64");

function fakeAdmin() {
  const stored: Array<Record<string, unknown>> = [];
  const admin = {
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>) => {
        expect(table).toBe("channel_secrets");
        stored.push(row);
        return { error: null };
      },
      delete: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: stored[0] ? { access_token_enc: stored[0].access_token_enc } : null }) }),
      }),
    }),
  };
  return { admin: admin as never, stored };
}

describe("channel token storage", () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.JOB_SECRET = "j".repeat(24);
    delete process.env.META_SYSTEM_USER_TOKEN;
  });
  afterEach(() => {
    process.env = { ...prev };
    vi.restoreAllMocks();
  });

  it("stores only an AES-256-GCM blob, never the plaintext, and round-trips", async () => {
    const { admin, stored } = fakeAdmin();
    const token = "EAAG" + "z".repeat(60);
    await storeChannelToken(admin, "chan-1", token);
    const blob = String(stored[0].access_token_enc);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob.split(":")).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(decryptSecret(blob)).toBe(token);
    expect(await channelAccessToken(admin, "chan-1")).toBe(token);
  });

  it("uses a fresh IV per write", async () => {
    const { admin, stored } = fakeAdmin();
    await storeChannelToken(admin, "c", "same-token");
    await storeChannelToken(admin, "c", "same-token");
    expect(stored[0].access_token_enc).not.toBe(stored[1].access_token_enc);
  });

  it("refuses to run without ENCRYPTION_KEY instead of storing plaintext", async () => {
    delete process.env.ENCRYPTION_KEY;
    const { admin, stored } = fakeAdmin();
    await expect(storeChannelToken(admin, "c", "tok")).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(stored).toHaveLength(0);
  });

  it("rejects a tampered ciphertext (GCM authentication)", async () => {
    const { admin, stored } = fakeAdmin();
    await storeChannelToken(admin, "c", "secret-token-value");
    const parts = String(stored[0].access_token_enc).split(":");
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], data.toString("base64")].join(":"))).toThrow();
  });
});
