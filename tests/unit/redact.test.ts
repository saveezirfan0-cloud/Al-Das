import { describe, expect, it } from "vitest";

import { redactMeta, redactPhone, redactText } from "@/lib/redact";

describe("redactPhone", () => {
  it("keeps only the last three digits", () => {
    expect(redactPhone("+971501234567")).toBe("+•••••••••567");
    expect(redactPhone("0501234567")).toBe("•••••••567");
  });
  it("handles empty and short input", () => {
    expect(redactPhone(null)).toBe("");
    expect(redactPhone("12")).toBe("•••");
  });
});

describe("redactText", () => {
  it("removes Meta tokens, bearer headers and JWTs", () => {
    const token = "EAAG" + "x".repeat(40);
    expect(redactText(`failed with ${token}`)).not.toContain(token);
    expect(redactText("Authorization: Bearer abc123def456ghi")).toBe("Authorization: Bearer [token]");
    expect(redactText("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl end")).toContain("[jwt]");
  });
  it("removes query-string secrets", () => {
    expect(redactText("GET /x?access_token=abc123&fields=id")).toBe("GET /x?access_token=[redacted]&fields=id");
  });
  it("redacts encrypted blobs, emails and long digit runs but not short numbers", () => {
    expect(redactText("blob v1:QUJDREVGR0g=:QUJDREVGR0g=:QUJD")).toContain("[encrypted]");
    expect(redactText("mail jane.doe@example.com")).toBe("mail [email]");
    expect(redactText("to +971 50 123 4567 failed")).not.toMatch(/971|123 4567/);
    expect(redactText("to +971 50 123 4567 failed")).toMatch(/567 failed$/);
    expect(redactText("status 131047 after 3 tries")).toBe("status 131047 after 3 tries");
  });
  it("accepts errors and truncates", () => {
    expect(redactText(new Error("boom"))).toBe("boom");
    expect(redactText("a".repeat(400), 50)).toHaveLength(51);
    expect(redactText(undefined)).toBe("");
  });
});

describe("redactMeta", () => {
  it("redacts string values and leaves other values alone", () => {
    const out = redactMeta({ error: "Bearer abcdefghijkl failed", queue: "outbound", n: 3, ok: true });
    expect(out).toEqual({ error: "Bearer [token] failed", queue: "outbound", n: 3, ok: true });
    expect(redactMeta(undefined)).toBeUndefined();
  });
});
