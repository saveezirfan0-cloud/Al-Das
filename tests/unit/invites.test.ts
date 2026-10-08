import { describe, expect, it } from "vitest";

import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteState,
  inviteUrl,
} from "@/lib/invites/token";

describe("invite tokens", () => {
  it("generates url-safe tokens whose hash is stable", () => {
    const { token, hash } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(hash).toBe(hashInviteToken(token));
    expect(hash).toHaveLength(64);
    expect(generateInviteToken().token).not.toBe(token);
  });

  it("builds the accept link without double slashes", () => {
    expect(inviteUrl("https://app.example.com/", "abc")).toBe("https://app.example.com/invite/abc");
  });

  it("expires 7 days out by default", () => {
    const from = new Date("2026-10-08T00:00:00Z");
    expect(inviteExpiry(from).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("derives the invite state in priority order", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const future = "2026-10-09T00:00:00Z";
    const past = "2026-10-07T00:00:00Z";
    expect(inviteState({ expires_at: future, accepted_at: null, revoked_at: null }, now)).toBe(
      "valid",
    );
    expect(inviteState({ expires_at: past, accepted_at: null, revoked_at: null }, now)).toBe(
      "expired",
    );
    expect(inviteState({ expires_at: future, accepted_at: past, revoked_at: null }, now)).toBe(
      "accepted",
    );
    expect(inviteState({ expires_at: future, accepted_at: past, revoked_at: past }, now)).toBe(
      "revoked",
    );
  });
});
