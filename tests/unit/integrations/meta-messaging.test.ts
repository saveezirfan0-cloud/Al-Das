import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { allFields, integrationDef, validateFields } from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { createMessagingClient, sendFailureText } from "@/lib/integrations/meta-messaging/client";
import {
  messagingWebhookBase,
  readMessagingConfig,
} from "@/lib/integrations/meta-messaging/config";
import {
  handshakeChallenge,
  parseMessagingEvents,
  verifyMetaMessagingSignature,
} from "@/lib/integrations/meta-messaging/webhook";
import { readinessProblems } from "@/lib/integrations/readiness";

const SECRET = "app-secret-test-only";
const sign = (raw: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

const PAGE = "100000000000001";
const IG = "17841400000000001";

function payload(object: string, recipient: string, messaging: unknown[]) {
  return JSON.stringify({ object, entry: [{ id: recipient, time: 1761600000000, messaging }] });
}
const msg = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
  sender: { id: "900000000000001" },
  recipient: { id: PAGE },
  timestamp: 1761600000000,
  message: { mid: "m_abc", text: "Hello", ...message },
  ...over,
});

describe("signature (X-Hub-Signature-256)", () => {
  const raw = payload("page", PAGE, [msg()]);

  it("accepts the HMAC of the exact body with the app secret", () => {
    expect(verifyMetaMessagingSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(
      verifyMetaMessagingSignature(
        raw,
        sign(raw).toUpperCase().replace("SHA256=", "sha256="),
        SECRET,
      ),
    ).toBe(true);
  });

  it("refuses a tampered body, another secret, a missing or malformed header and no stored secret", () => {
    expect(verifyMetaMessagingSignature(raw + " ", sign(raw), SECRET)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, sign(raw, "other"), SECRET)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, null, SECRET)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, "sha1=abc", SECRET)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, sign(raw).slice(0, -2), SECRET)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, sign(raw), undefined)).toBe(false);
    expect(verifyMetaMessagingSignature(raw, sign(raw), "")).toBe(false);
  });
});

describe("subscription handshake", () => {
  const p = (o: Record<string, string>) => new URLSearchParams(o);

  it("echoes the challenge only for subscribe with the stored token", () => {
    expect(
      handshakeChallenge(
        p({
          "hub.mode": "subscribe",
          "hub.verify_token": "tok-123",
          "hub.challenge": "1158201444",
        }),
        "tok-123",
      ),
    ).toBe("1158201444");
    expect(
      handshakeChallenge(
        p({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }),
        "tok-123",
      ),
    ).toBeNull();
    expect(
      handshakeChallenge(
        p({ "hub.mode": "unsubscribe", "hub.verify_token": "tok-123", "hub.challenge": "1" }),
        "tok-123",
      ),
    ).toBeNull();
    expect(
      handshakeChallenge(p({ "hub.mode": "subscribe", "hub.challenge": "1" }), undefined),
    ).toBeNull();
  });

  it("never reflects markup or long values", () => {
    expect(
      handshakeChallenge(
        p({
          "hub.mode": "subscribe",
          "hub.verify_token": "t",
          "hub.challenge": "<script>alert(1)</script>",
        }),
        "t",
      ),
    ).toBeNull();
    expect(
      handshakeChallenge(
        p({ "hub.mode": "subscribe", "hub.verify_token": "t", "hub.challenge": "a".repeat(201) }),
        "t",
      ),
    ).toBeNull();
  });
});

describe("parsing events", () => {
  const now = new Date("2026-10-28T10:00:00Z");

  it("extracts person-to-business text messages for our Page", () => {
    const events = parseMessagingEvents("messenger", payload("page", PAGE, [msg()]), PAGE, now);
    expect(events).toEqual([
      {
        key: "messenger:m_abc",
        platform: "messenger",
        senderId: "900000000000001",
        messageId: "m_abc",
        kind: "text",
        text: "Hello",
        at: new Date(1761600000000),
      },
    ]);
  });

  it("uses the Instagram account id for Instagram", () => {
    const raw = payload("instagram", IG, [msg({ recipient: { id: IG } }, { mid: "ig_mid_1" })]);
    expect(parseMessagingEvents("instagram", raw, IG, now).map((e) => e.key)).toEqual([
      "instagram:ig_mid_1",
    ]);
    // the same body is not a Messenger payload
    expect(parseMessagingEvents("messenger", raw, IG, now)).toEqual([]);
  });

  it("stores an attachment as unsupported without its link", () => {
    const [e] = parseMessagingEvents(
      "messenger",
      payload("page", PAGE, [
        msg(
          {},
          {
            text: undefined,
            attachments: [{ type: "image", payload: { url: "https://cdn.example.test/x.jpg" } }],
          },
        ),
      ]),
      PAGE,
      now,
    );
    expect(e.kind).toBe("unsupported");
    expect(e.text).toBeNull();
    expect(JSON.stringify(e)).not.toContain("cdn.example.test");
  });

  it("skips echoes, deletions, reads, other recipients, our own page as sender and bad ids", () => {
    const raw = payload("page", PAGE, [
      msg({}, { is_echo: true }),
      msg({}, { is_deleted: true }),
      { sender: { id: "900000000000001" }, recipient: { id: PAGE }, read: { watermark: 1 } },
      msg({ recipient: { id: "100000000000999" } }),
      msg({ sender: { id: PAGE } }),
      msg({ sender: { id: "+971500000000" } }),
      msg({}, { mid: "" }),
    ]);
    expect(parseMessagingEvents("messenger", raw, PAGE, now)).toEqual([]);
    expect(
      parseMessagingEvents("messenger", payload("page", "100000000000999", [msg()]), PAGE, now),
    ).toEqual([]);
    expect(
      parseMessagingEvents("messenger", JSON.stringify({ object: "page" }), PAGE, now),
    ).toEqual([]);
    expect(() => parseMessagingEvents("messenger", "not json", PAGE, now)).toThrow();
  });

  it("does not trust a timestamp from the future", () => {
    const [e] = parseMessagingEvents(
      "messenger",
      payload("page", PAGE, [msg({ timestamp: 4102444800000 })]),
      PAGE,
      now,
    );
    expect(e.at).toEqual(now);
  });
});

describe("Send API adapter", () => {
  function client(
    responses: Array<{ status: number; body?: unknown } | "timeout">,
    log: CallRecord[] = [],
  ) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const c = createMessagingClient({
      platform: "instagram",
      pageId: PAGE,
      accessToken: "page-token-secret",
      graphVersion: "v21.0",
      sleep: async () => undefined,
      sink: { record: (r) => void log.push(r) },
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r === "timeout") {
          const e = new Error("timeout");
          e.name = "TimeoutError";
          throw e;
        }
        return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
          status: r.status,
        });
      }) as typeof fetch,
    });
    return { c, calls };
  }

  it("sends text to the platform-scoped id with a bearer header and nothing else", async () => {
    const log: CallRecord[] = [];
    const { c, calls } = client(
      [{ status: 200, body: { recipient_id: "900000000000001", message_id: "m_1" } }],
      log,
    );
    expect(await c.sendText("900000000000001", "See you at 10")).toEqual({
      ok: true,
      messageId: "m_1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v21.0/${PAGE}/messages`);
    expect(calls[0].url).not.toContain("page-token-secret");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer page-token-secret",
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      recipient: { id: "900000000000001" },
      messaging_type: "RESPONSE",
      message: { text: "See you at 10" },
    });
    expect(JSON.stringify(log)).not.toMatch(/page-token-secret|See you at 10|900000000000001/);
    expect(log[0]).toMatchObject({
      provider: "instagram",
      operation: "instagram.send",
      outcome: "ok",
    });
  });

  it("reports the 24-hour window refusal as windowClosed, not as a credentials problem", async () => {
    const { c } = client([
      {
        status: 400,
        body: { error: { code: 10, error_subcode: 2018278, message: "outside window" } },
      },
    ]);
    const r = await c.sendText("900000000000001", "Hi");
    expect(r).toMatchObject({
      ok: false,
      windowClosed: true,
      auth: false,
      retryable: false,
      ambiguous: false,
    });
    if (!r.ok) expect(sendFailureText("instagram", r)).toMatch(/24 hours/);
  });

  it("maps bad tokens, throttling and an unreachable person", async () => {
    const auth = await client([{ status: 400, body: { error: { code: 190 } } }]).c.sendText(
      "900000000000001",
      "x",
    );
    expect(auth).toMatchObject({ ok: false, auth: true });
    const gone = await client([{ status: 400, body: { error: { code: 551 } } }]).c.sendText(
      "900000000000001",
      "x",
    );
    expect(gone).toMatchObject({ ok: false, code: "graph_551", auth: false });
    if (!gone.ok) expect(sendFailureText("messenger", gone)).toMatch(/cannot receive/);
    const slow = await client([{ status: 400, body: { error: { code: 613 } } }]).c.sendText(
      "900000000000001",
      "x",
    );
    expect(slow).toMatchObject({ ok: false, retryable: true });
  });

  it("retries a 429 (Meta took nothing) but never resends after a 5xx or a timeout", async () => {
    const r429 = client([{ status: 429 }, { status: 200, body: { message_id: "m_2" } }]);
    expect(await r429.c.sendText("900000000000001", "x")).toEqual({ ok: true, messageId: "m_2" });
    expect(r429.calls).toHaveLength(2);
    const r500 = client([{ status: 500 }, { status: 200, body: { message_id: "m_3" } }]);
    expect(await r500.c.sendText("900000000000001", "x")).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: false,
    });
    expect(r500.calls).toHaveLength(1);
    const timeout = client(["timeout", { status: 200, body: { message_id: "m_4" } }]);
    expect(await timeout.c.sendText("900000000000001", "x")).toMatchObject({
      ok: false,
      ambiguous: true,
    });
    expect(timeout.calls).toHaveLength(1);
  });

  it("refuses a recipient that is not a platform id without calling Meta", async () => {
    const { c, calls } = client([{ status: 200, body: { message_id: "x" } }]);
    expect(await c.sendText("+971500000000", "x")).toMatchObject({
      ok: false,
      code: "bad_recipient",
    });
    expect(calls).toHaveLength(0);
  });

  it("verifies credentials with a read-only GET", async () => {
    const { c, calls } = client([{ status: 200, body: { id: PAGE } }]);
    expect(await c.verify()).toEqual({ ok: true });
    expect(calls[0].init.method).toBe("GET");
    expect(await client([{ status: 400, body: { error: { code: 190 } } }]).c.verify()).toEqual({
      ok: false,
      code: "auth",
    });
  });
});

describe("catalogue entries", () => {
  it("are off by default behind typed words, with every credential secret", () => {
    for (const kind of ["instagram", "messenger"] as const) {
      const def = integrationDef(kind);
      expect(def.contactsPatients).toBe(true);
      expect(def.confirmWord).toMatch(/^ENABLE /);
      expect(def.viewPermission).toBe("integrations.manage");
      const secret = allFields(kind, "meta")
        .filter((f) => f.secret)
        .map((f) => f.key)
        .sort();
      expect(secret).toEqual(["app_secret", "page_access_token", "verify_token"]);
    }
  });

  it("validates ids and reports what is missing", () => {
    const fields = allFields("instagram", "meta");
    expect(
      validateFields(fields, {
        page_id: "abc",
        ig_account_id: IG,
        page_access_token: "t",
        app_secret: "s",
        verify_token: "v",
      }).ok,
    ).toBe(false);
    expect(
      validateFields(fields, {
        page_id: PAGE,
        ig_account_id: IG,
        page_access_token: "t",
        app_secret: "s",
        verify_token: "v",
      }).ok,
    ).toBe(true);
    expect(
      readinessProblems({
        kind: "messenger",
        provider: "meta",
        config: { page_id: PAGE },
        secretsStored: { page_access_token: true },
      }),
    ).toEqual(["App secret is missing.", "Webhook verify token is missing."]);
  });

  it("reads the settings and builds the callback address", () => {
    expect(readMessagingConfig("instagram", { page_id: PAGE, ig_account_id: IG })).toEqual({
      platform: "instagram",
      pageId: PAGE,
      recipientId: IG,
      graphVersion: "v21.0",
    });
    expect(
      readMessagingConfig("messenger", { page_id: PAGE, graph_version: "v22.0" })?.recipientId,
    ).toBe(PAGE);
    expect(
      readMessagingConfig("messenger", { page_id: PAGE, graph_version: "v22.0" })?.graphVersion,
    ).toBe("v22.0");
    expect(readMessagingConfig("instagram", { page_id: PAGE })).toBeNull();
    expect(readMessagingConfig("messenger", { page_id: "1; drop" })).toBeNull();
    expect(messagingWebhookBase("https://pulse.example.test/", "instagram", "abc")).toBe(
      "https://pulse.example.test/api/webhooks/integrations/instagram/abc",
    );
  });
});
