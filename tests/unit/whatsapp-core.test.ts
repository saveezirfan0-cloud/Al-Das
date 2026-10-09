import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, loadEncryptionKey, maskSecret } from "@/lib/crypto";
import { mapMetaError, WhatsAppApiError } from "@/lib/whatsapp/errors";
import { e164ToWaId, looksLikeBsuid, redactPhone, toE164, waIdToE164 } from "@/lib/whatsapp/phone";
import { signMetaPayload, verifyMetaSignature } from "@/lib/whatsapp/signature";
import { fromWebhookStatus, nextMessageStatus } from "@/lib/whatsapp/status";
import { canSendFreeForm, formatRemaining, serviceWindow } from "@/lib/whatsapp/window";

describe("signature", () => {
  const secret = "app-secret-for-tests";
  it("verifies the HMAC over the raw body", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = signMetaPayload(body, secret);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=00", secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, "")).toBe(false);
  });
});

describe("crypto", () => {
  const key = Buffer.alloc(32, 7);
  it("round-trips and authenticates", () => {
    const blob = encryptSecret("EAAB-token-value", key);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("EAAB");
    expect(decryptSecret(blob, key)).toBe("EAAB-token-value");
    expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key)); // random IV
    const tampered = blob.slice(0, -2) + (blob.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(blob, Buffer.alloc(32, 8))).toThrow();
    expect(() => decryptSecret("nope", key)).toThrow(/malformed/);
  });
  it("validates the key", () => {
    expect(() => loadEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => loadEncryptionKey("c2hvcnQ=")).toThrow(/32 bytes/);
    expect(loadEncryptionKey(Buffer.alloc(32, 1).toString("base64")).length).toBe(32);
  });
  it("masks", () => {
    expect(maskSecret("abcdef1234")).toBe("••••1234");
    expect(maskSecret(null)).toBe("");
  });
});

describe("error map", () => {
  it("maps the important codes", () => {
    expect(mapMetaError(131050)).toMatchObject({
      stopMarketing: true,
      retryable: false,
      category: "recipient",
    });
    expect(mapMetaError(131047)).toMatchObject({ requiresTemplate: true, retryable: false });
    expect(mapMetaError(130429)).toMatchObject({ retryable: true, category: "rate_limit" });
    expect(mapMetaError(131056)).toMatchObject({ retryable: true });
    expect(mapMetaError(131026)).toMatchObject({ retryable: false, category: "recipient" });
    expect(mapMetaError(132001)).toMatchObject({ category: "template" });
    expect(mapMetaError(190)).toMatchObject({ category: "auth" });
    expect(mapMetaError(250)).toMatchObject({ category: "auth" });
    expect(mapMetaError(503)).toMatchObject({ category: "transient", retryable: true });
    expect(mapMetaError(999999, "custom text")).toMatchObject({
      category: "unknown",
      message: "custom text",
    });
    expect(mapMetaError(null)).toMatchObject({ code: -1, category: "unknown" });
  });
  it("WhatsAppApiError carries the mapped error", () => {
    const err = new WhatsAppApiError(400, {
      error: {
        message: "(#131047) Re-engagement",
        code: 131047,
        fbtrace_id: "X",
        error_data: { details: "24h" },
      },
    });
    expect(err.code).toBe(131047);
    expect(err.mapped.requiresTemplate).toBe(true);
    expect(err.fbtraceId).toBe("X");
    expect(err.details).toBe("24h");
    expect(err.message).toContain("131047");
    const srv = new WhatsAppApiError(502, null);
    expect(srv.mapped.retryable).toBe(true);
  });
});

describe("status ladder", () => {
  it("moves forward only", () => {
    expect(nextMessageStatus("queued", "sent")).toBe("sent");
    expect(nextMessageStatus("delivered", "sent")).toBe("delivered");
    expect(nextMessageStatus("read", "delivered")).toBe("read");
    expect(nextMessageStatus("sent", "failed")).toBe("failed");
    expect(nextMessageStatus("read", "failed")).toBe("read");
    expect(nextMessageStatus("failed", "delivered")).toBe("failed");
    expect(nextMessageStatus("sent", "sent")).toBe("sent");
  });
  it("maps webhook statuses", () => {
    expect(fromWebhookStatus("read")).toBe("read");
    expect(fromWebhookStatus("deleted")).toBeNull();
    expect(fromWebhookStatus("warning")).toBeNull();
  });
});

describe("24h window", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("is open within 24h of the last inbound", () => {
    const w = serviceWindow({ lastInboundAt: "2026-01-01T00:00:00Z", now });
    expect(w.open).toBe(true);
    expect(w.reason).toBe("service");
    expect(w.remainingMs).toBe(12 * 3600 * 1000);
    expect(w.closesAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
  it("closes after 24h and never opens without an inbound", () => {
    expect(serviceWindow({ lastInboundAt: "2025-12-31T11:59:00Z", now })).toMatchObject({
      open: false,
      reason: "closed",
    });
    expect(serviceWindow({ lastInboundAt: null, now })).toMatchObject({
      open: false,
      reason: "never_inbound",
    });
    expect(canSendFreeForm({ lastInboundAt: "2025-12-30T00:00:00Z", now })).toBe(false);
  });
  it("CTWA free-entry gives 72h", () => {
    const w = serviceWindow({
      lastInboundAt: "2025-12-30T00:00:00Z",
      adOpenedAt: "2025-12-30T00:00:00Z",
      now,
    });
    expect(w.open).toBe(true);
    expect(w.reason).toBe("free_entry");
  });
  it("formats remaining time", () => {
    expect(formatRemaining(0)).toBe("closed");
    expect(formatRemaining(90 * 60000)).toBe("1h 30m");
    expect(formatRemaining(5 * 60000)).toBe("5m");
    expect(formatRemaining(50 * 3600 * 1000)).toBe("2d 2h");
  });
});

describe("phone helpers", () => {
  it("converts wa_id and user input to E.164", () => {
    expect(waIdToE164("971500000001")).toBe("+971500000001");
    expect(waIdToE164("+971500000001")).toBe("+971500000001");
    expect(waIdToE164("BSUID_123")).toBeNull();
    expect(waIdToE164("12")).toBeNull();
    expect(toE164("050 000 0001")).toBe("+971500000001");
    expect(toE164("+44 7700 900123")).toBe("+447700900123");
    expect(toE164("hello")).toBeNull();
    expect(e164ToWaId("+971500000001")).toBe("971500000001");
  });
  it("redacts and detects BSUIDs", () => {
    expect(redactPhone("+971500000001")).toBe("+9715•••••01");
    expect(redactPhone("")).toBe("");
    expect(looksLikeBsuid("ABC123")).toBe(true);
    expect(looksLikeBsuid("971500000001")).toBe(false);
  });
});

import { isMarketingBlocked } from "@/lib/whatsapp/templates";

describe("isMarketingBlocked (CLAUDE.md rule 11)", () => {
  it("blocks marketing templates for opted-out contacts only", () => {
    expect(isMarketingBlocked("MARKETING", true)).toBe(true);
    expect(isMarketingBlocked("MARKETING", false)).toBe(false);
    expect(isMarketingBlocked("UTILITY", true)).toBe(false);
    expect(isMarketingBlocked("AUTHENTICATION", true)).toBe(false);
    expect(isMarketingBlocked(null, true)).toBe(false);
    expect(isMarketingBlocked("MARKETING", null)).toBe(false);
    expect(isMarketingBlocked(undefined, undefined)).toBe(false);
  });
});
