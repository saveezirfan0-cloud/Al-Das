import { describe, expect, it } from "vitest";
import webpush from "web-push";

import {
  MAX_CONSECUTIVE_FAILURES,
  deliverPush,
  type PushStore,
  type StoredSubscription,
} from "@/lib/push/deliver";
import {
  endpointHash,
  isAllowedPushEndpoint,
  parseSubscription,
  topicFor,
} from "@/lib/push/endpoint";
import type { PushSender, PushSendResult, PushSubscriptionData } from "@/lib/push/types";
import { generateVapidKeys } from "@/lib/push/vapid";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV = "22222222-2222-4222-8222-222222222222";
const P256 = "B".repeat(87); // shape only: 65 bytes base64url
const AUTH = "a".repeat(22);

const sub = (host: string): PushSubscriptionData => ({
  endpoint: `https://${host}/send/abc`,
  keys: { p256dh: P256, auth: AUTH },
});

function setup(devices: StoredSubscription[], results: PushSendResult[]) {
  const removed: string[] = [];
  const recorded: Array<{ id: string; ok: boolean; failures: number }> = [];
  const sentBodies: string[] = [];
  const calls: Array<{ endpoint: string; topic?: string; urgency: string }> = [];
  const store: PushStore = {
    list: async () => devices,
    remove: async (id) => void removed.push(id),
    record: async (id, ok, failures) => void recorded.push({ id, ok, failures }),
  };
  let i = 0;
  const sender: PushSender = {
    async send(s, payload, options) {
      sentBodies.push(payload);
      calls.push({ endpoint: s.endpoint, topic: options.topic, urgency: options.urgency });
      return results[Math.min(i++, results.length - 1)];
    },
  };
  // The "encryption" in tests is a stub: the real AES-GCM round trip is covered in the database test.
  const decrypt = (blob: string) => {
    if (blob === "bad") throw new Error("cannot decrypt");
    return sub(blob);
  };
  return { deps: { store, sender, decrypt }, removed, recorded, sentBodies, calls };
}

const device = (id: string, host = "fcm.googleapis.com", failures = 0): StoredSubscription => ({
  id,
  subscription_enc: host,
  failure_count: failures,
});

describe("deliverPush", () => {
  it("sends the generic payload to every device and records success", async () => {
    const t = setup(
      [device("d1"), device("d2", "updates.push.services.mozilla.com")],
      [{ ok: true }],
    );
    const out = await deliverPush(t.deps, {
      org_id: ORG,
      user_id: USER,
      event: "inbox.message",
      ids: { conversation_id: CONV },
    });
    expect(out).toMatchObject({ sent: 2, removed: 0, failed: 0 });
    expect(t.recorded).toEqual([
      { id: "d1", ok: true, failures: 0 },
      { id: "d2", ok: true, failures: 0 },
    ]);
    const body = JSON.parse(t.sentBodies[0]);
    expect(body).toMatchObject({
      v: 1,
      event: "inbox.message",
      url: `/inbox?c=${CONV}`,
      ids: { conversation_id: CONV },
    });
    expect(Object.keys(body).sort()).toEqual(["body", "event", "ids", "tag", "title", "url", "v"]);
    expect(t.calls[0].topic).toBe(topicFor(`inbox.message:${CONV}`));
    expect(t.calls[0].topic!.length).toBeLessThanOrEqual(32);
  });

  it("removes a device the push service says is gone (404 and 410) and keeps the others", async () => {
    const t = setup(
      [device("gone404"), device("gone410"), device("ok")],
      [
        { ok: false, status: 404, gone: true },
        { ok: false, status: 410, gone: true },
        { ok: true },
      ],
    );
    const out = await deliverPush(t.deps, { org_id: ORG, user_id: USER, event: "task.due" });
    expect(out).toMatchObject({ sent: 1, removed: 2, failed: 0 });
    expect(t.removed).toEqual(["gone404", "gone410"]);
  });

  it("counts other failures and drops a device after too many in a row", async () => {
    const t = setup(
      [
        device("flaky", "fcm.googleapis.com", 2),
        device("dying", "fcm.googleapis.com", MAX_CONSECUTIVE_FAILURES - 1),
      ],
      [{ ok: false, status: 503, gone: false }],
    );
    const out = await deliverPush(t.deps, { org_id: ORG, user_id: USER, event: "task.due" });
    expect(out).toMatchObject({ sent: 0, removed: 1, failed: 1 });
    expect(t.recorded).toEqual([{ id: "flaky", ok: false, failures: 3 }]);
    expect(t.removed).toEqual(["dying"]);
  });

  it("removes a device it can no longer decrypt, without calling the push service", async () => {
    const t = setup([device("x", "bad")], [{ ok: true }]);
    const out = await deliverPush(t.deps, { org_id: ORG, user_id: USER, event: "task.due" });
    expect(out.removed).toBe(1);
    expect(t.sentBodies).toEqual([]);
  });

  it("does nothing for an unknown event or a person with no devices", async () => {
    const none = setup([], [{ ok: true }]);
    expect(
      (await deliverPush(none.deps, { org_id: ORG, user_id: USER, event: "task.due" })).skipped,
    ).toBe("no_devices");
    const bad = setup([device("d")], [{ ok: true }]);
    expect(
      (await deliverPush(bad.deps, { org_id: ORG, user_id: USER, event: "made.up" })).skipped,
    ).toBe("no_payload");
    expect(bad.sentBodies).toEqual([]);
  });

  it("marks escalations high urgency with a longer life", async () => {
    const t = setup([device("d")], [{ ok: true }]);
    await deliverPush(t.deps, {
      org_id: ORG,
      user_id: USER,
      event: "escalation",
      ids: { conversation_id: CONV },
    });
    expect(t.calls[0].urgency).toBe("high");
  });
});

describe("push endpoints and subscriptions", () => {
  it("accepts only the real browser push services over https", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/Qx",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://evil.example/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "not a url",
      "",
    ])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });

  it("shape-checks what the browser sends", () => {
    expect(parseSubscription(sub("fcm.googleapis.com"))).toEqual(sub("fcm.googleapis.com"));
    expect(
      parseSubscription({ endpoint: "https://evil.example/x", keys: { p256dh: P256, auth: AUTH } }),
    ).toBeNull();
    expect(
      parseSubscription({
        endpoint: "https://fcm.googleapis.com/x",
        keys: { p256dh: "short", auth: AUTH },
      }),
    ).toBeNull();
    expect(
      parseSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: P256 } }),
    ).toBeNull();
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription("x")).toBeNull();
  });

  it("hashes endpoints to 64 hex characters (the column's check constraint)", () => {
    expect(endpointHash("https://fcm.googleapis.com/x")).toMatch(/^[0-9a-f]{64}$/);
    expect(endpointHash("a")).not.toBe(endpointHash("b"));
  });
});

describe("VAPID keys (pnpm push:keys)", () => {
  it("always returns a 32-byte private key (Node drops leading zero bytes, about 1 key in 256)", () => {
    for (let i = 0; i < 2000; i++) {
      expect(Buffer.from(generateVapidKeys().privateKey, "base64url")).toHaveLength(32);
    }
  });

  it("generates a pair in the format push services expect", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // web-push's own validation accepts the pair.
    expect(() =>
      webpush.setVapidDetails("mailto:it@example.test", publicKey, privateKey),
    ).not.toThrow();
    expect(generateVapidKeys().publicKey).not.toBe(publicKey);
  });
});
