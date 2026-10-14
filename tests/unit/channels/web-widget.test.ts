import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHANNEL_TYPE_LABEL,
  channelRef,
  channelTypeOf,
  hasWhatsAppFeatures,
  replyWindow,
  SOCIAL_REPLY_WINDOW_MS,
  windowClosedMessage,
} from "@/lib/channels/types";
import {
  bearerToken,
  corsHeaders,
  hashVisitorToken,
  newVisitorToken,
  originAllowed,
  parseAfter,
  parseAllowedDomains,
  parseVisitorMessage,
  WIDGET_DEFAULTS,
  WIDGET_RATE_RULES,
  widgetDisplay,
  widgetGate,
} from "@/lib/channels/web/policy";
import { widgetSnippet, WIDGET_SCRIPT_PATH } from "@/lib/channels/web/snippet";

describe("allowed websites", () => {
  it("normalises host names and accepts sub-domain wildcards", () => {
    expect(parseAllowedDomains("WWW.Example.com, booking.example.com ; *.clinic.test")).toEqual([
      "www.example.com",
      "booking.example.com",
      "*.clinic.test",
    ]);
    expect(parseAllowedDomains("https://www.example.com/")).toEqual(["www.example.com"]);
    expect(parseAllowedDomains("a.example.com a.example.com")).toEqual(["a.example.com"]);
  });

  it("refuses anything that is not a plain host name", () => {
    for (const bad of [
      "",
      "   ",
      "localhost",
      "127.0.0.1",
      "https://example.com:8443",
      "https://example.com/path",
      "https://user:pw@example.com",
      "exa mple.com",
      "*.com",
      "example.*",
      "javascript:alert(1)",
      "<script>.com",
      null,
      42,
    ])
      expect(parseAllowedDomains(bad), String(bad)).toBeNull();
    expect(
      parseAllowedDomains(Array.from({ length: 21 }, (_, i) => `s${i}.example.com`).join(",")),
    ).toBeNull();
  });

  it("checks the Origin exactly (https only; a wildcard covers sub-domains, not the apex)", () => {
    const allowed = ["www.example.com", "*.clinic.test"];
    expect(originAllowed("https://www.example.com", allowed)).toBe(true);
    expect(originAllowed("https://WWW.EXAMPLE.COM", allowed)).toBe(true);
    expect(originAllowed("https://www.example.com:443", allowed)).toBe(true);
    expect(originAllowed("https://a.clinic.test", allowed)).toBe(true);
    expect(originAllowed("https://a.b.clinic.test", allowed)).toBe(true);
    for (const bad of [
      "http://www.example.com",
      "https://example.com",
      "https://www.example.com.evil.test",
      "https://evilwww.example.com",
      "https://clinic.test",
      "https://xclinic.test",
      "https://www.example.com:8443",
      "null",
      "",
      null,
      undefined,
    ])
      expect(originAllowed(bad, allowed), String(bad)).toBe(false);
    expect(originAllowed("https://www.example.com", [])).toBe(false);
  });
});

describe("gate", () => {
  const base = {
    exists: true,
    enabled: true,
    training: false,
    origin: "https://www.example.com",
    allowedDomains: ["www.example.com"],
  };

  it("answers the same 404 for unknown, switched-off and training workspaces", () => {
    expect(widgetGate(base)).toEqual({ ok: true });
    for (const over of [{ exists: false }, { enabled: false }, { training: true }])
      expect(widgetGate({ ...base, ...over })).toEqual({
        ok: false,
        status: 404,
        reason: "not_found",
      });
  });

  it("refuses another website or a missing Origin with 403", () => {
    expect(widgetGate({ ...base, origin: "https://other.test" })).toEqual({
      ok: false,
      status: 403,
      reason: "origin",
    });
    expect(widgetGate({ ...base, origin: null }).ok).toBe(false);
    expect(widgetGate({ ...base, allowedDomains: null }).ok).toBe(false);
  });

  it("never allows any origin or credentials in CORS", () => {
    const h = corsHeaders("https://www.example.com");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://www.example.com");
    expect(Object.keys(h)).not.toContain("Access-Control-Allow-Credentials");
    expect(h.Vary).toBe("Origin");
  });
});

describe("visitor token", () => {
  it("is 256 random bits; only its SHA-256 is stored", () => {
    const a = newVisitorToken();
    const b = newVisitorToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashVisitorToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });

  it("reads only a well-formed bearer token", () => {
    const { token } = newVisitorToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(` Bearer ${token} `)).toBe(token);
    for (const bad of [
      null,
      "",
      token,
      `bearer ${token}`,
      `Bearer ${token}x`,
      "Bearer abc",
      `Bearer ${token.slice(1)}=`,
    ])
      expect(bearerToken(bad)).toBeNull();
  });
});

describe("visitor messages", () => {
  it("accepts text, a client id and an optional name", () => {
    expect(parseVisitorMessage({ text: "  Hello\r\nthere  ", client_id: "abcdef12" })).toEqual({
      ok: true,
      value: { text: "Hello\nthere", clientId: "abcdef12", name: null },
    });
    expect(
      parseVisitorMessage({ text: "Hi", client_id: "abcdef12", name: "  Layla   Demo-07 " }),
    ).toEqual({
      ok: true,
      value: { text: "Hi", clientId: "abcdef12", name: "Layla Demo-07" },
    });
  });

  it("refuses empty, oversized, binary and malformed input", () => {
    const ok = { text: "Hi", client_id: "abcdef12" };
    expect(parseVisitorMessage(null)).toEqual({ ok: false, error: "invalid" });
    expect(parseVisitorMessage([])).toEqual({ ok: false, error: "invalid" });
    expect(parseVisitorMessage({ ...ok, text: "   " })).toEqual({ ok: false, error: "empty" });
    expect(parseVisitorMessage({ ...ok, text: "x".repeat(2001) })).toEqual({
      ok: false,
      error: "too_long",
    });
    expect(parseVisitorMessage({ ...ok, text: "a\u0000b" }).ok).toBe(false);
    expect(parseVisitorMessage({ ...ok, client_id: "short" }).ok).toBe(false);
    expect(parseVisitorMessage({ ...ok, client_id: "has space!" }).ok).toBe(false);
    expect(parseVisitorMessage({ ...ok, name: "<b>x</b>" }).ok).toBe(false);
    expect(parseVisitorMessage({ ...ok, name: "x".repeat(61) }).ok).toBe(false);
    expect(parseVisitorMessage({ ...ok, name: 7 }).ok).toBe(false);
  });

  it("only accepts a recent ISO cursor", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    expect(parseAfter("2026-10-28T09:00:00.000Z", now)).toBe("2026-10-28T09:00:00.000Z");
    expect(parseAfter("2026-10-28T09:00:00+00:00", now)).toBe("2026-10-28T09:00:00.000Z");
    for (const bad of [
      null,
      "",
      "yesterday",
      "2030-01-01T00:00:00Z",
      "2020-01-01T00:00:00Z",
      "x".repeat(50),
    ])
      expect(parseAfter(bad, now)).toBeNull();
  });
});

describe("display settings and limits", () => {
  it("only passes safe title, colour and welcome text (defaults otherwise)", () => {
    expect(
      widgetDisplay({ title: "Al Das chat", colour: "#ABCDEF", welcome: "Hello", secret: "x" }),
    ).toEqual({
      title: "Al Das chat",
      colour: "#abcdef",
      welcome: "Hello",
    });
    expect(widgetDisplay({ title: "<img src=x>", colour: "red", welcome: "" })).toEqual(
      WIDGET_DEFAULTS,
    );
  });

  it("limits sending harder than polling, and never fails open on sends", () => {
    expect(WIDGET_RATE_RULES.sendPerSession.limit).toBeLessThan(
      WIDGET_RATE_RULES.pollPerSession.limit,
    );
    expect(WIDGET_RATE_RULES.sendPerIp.failOpen).toBe(false);
    expect(WIDGET_RATE_RULES.sendPerSession.failOpen).toBe(false);
    expect(WIDGET_RATE_RULES.newSessionPerIp.failOpen).toBe(false);
    // the widget polls every 5 s while open: 12 a minute, under the per-visitor limit
    expect(WIDGET_RATE_RULES.pollPerSession.limit).toBeGreaterThanOrEqual(12);
  });

  it("builds the embed line from the app address and the widget key only", () => {
    expect(
      widgetSnippet("https://pulse.example.test/", "0f9b6a3e-1c1d-4e8b-9a77-2f6b1c3d4e5f"),
    ).toBe(
      `<script src="https://pulse.example.test${WIDGET_SCRIPT_PATH}" data-pulse-chat="0f9b6a3e-1c1d-4e8b-9a77-2f6b1c3d4e5f" async></script>`,
    );
    expect(() => widgetSnippet("https://pulse.example.test", '"><script>')).toThrow();
  });
});

describe("widget script (public/widget/pulse-chat.js)", () => {
  const src = readFileSync(join(__dirname, "../../../public", WIDGET_SCRIPT_PATH), "utf8");

  it("sets no cookie, sends no credentials and renders text only", () => {
    expect(src).not.toMatch(/document\.cookie/);
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).toMatch(/credentials: "omit"/);
    expect(src).toMatch(/textContent/);
    expect(src).toMatch(/localStorage/);
  });

  it("talks only to the Pulse origin it was loaded from", () => {
    expect(src).toMatch(/new URL\(script\.src\)\.origin/);
    expect(src.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).toEqual([]);
  });
});

describe("channel types and reply windows", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  it("treats unknown values as WhatsApp and keeps WhatsApp features to WhatsApp", () => {
    expect(channelTypeOf(undefined)).toBe("whatsapp");
    expect(channelTypeOf("telegram")).toBe("whatsapp");
    expect(channelTypeOf("instagram")).toBe("instagram");
    expect(hasWhatsAppFeatures("whatsapp")).toBe(true);
    for (const t of ["web", "instagram", "messenger"] as const)
      expect(hasWhatsAppFeatures(t)).toBe(false);
    expect(channelRef("web", "abc")).toBe("web:abc");
    expect(CHANNEL_TYPE_LABEL.messenger).toBe("Messenger");
  });

  it("Instagram and Messenger: open 24 hours after the person's last message, closed after, closed with none", () => {
    for (const t of ["instagram", "messenger"] as const) {
      expect(replyWindow(t, { lastInboundAt: hoursAgo(23.9), now }).open).toBe(true);
      expect(replyWindow(t, { lastInboundAt: hoursAgo(24), now }).open).toBe(false);
      expect(replyWindow(t, { lastInboundAt: hoursAgo(30), now })).toMatchObject({
        open: false,
        reason: "closed",
        kind: "social",
      });
      expect(replyWindow(t, { lastInboundAt: null, now })).toMatchObject({
        open: false,
        reason: "never_inbound",
      });
      // an ad referral does not extend these windows (that is a WhatsApp rule)
      expect(
        replyWindow(t, { lastInboundAt: hoursAgo(30), adOpenedAt: hoursAgo(30), now }).open,
      ).toBe(false);
      expect(windowClosedMessage(t)).toMatch(/24 hours/);
    }
    expect(SOCIAL_REPLY_WINDOW_MS).toBe(86_400_000);
  });

  it("website chat is always open; WhatsApp keeps its own rule (72 h ad window included)", () => {
    expect(replyWindow("web", { lastInboundAt: null, now })).toMatchObject({
      open: true,
      kind: "none",
    });
    expect(replyWindow("whatsapp", { lastInboundAt: hoursAgo(30), now }).open).toBe(false);
    expect(
      replyWindow("whatsapp", { lastInboundAt: hoursAgo(30), adOpenedAt: hoursAgo(30), now }).open,
    ).toBe(true);
  });
});
