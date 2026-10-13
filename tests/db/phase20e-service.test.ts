/**
 * Phase 20e service paths against a real Postgres through PostgREST: the public website chat routes (gate, visitor token, rate
 * limits, polling), the Instagram webhook (signature, handshake, claim), outbound delivery on the new channels (24-hour refusal,
 * the website chat, training mode) and the Google Calendar busy sync (OAuth state, encrypted tokens, pull and push, disconnect).
 * Every provider is a fake fetch; nothing leaves the machine. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { createHmac, randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deliverChannelOutbound } from "@/lib/channels/outbound";
import { widgetConfig, widgetPoll, widgetPost, widgetPreflight } from "@/lib/channels/web/server";
import { addNote, queueOutbound } from "@/lib/inbox/send";
import { saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { gcalEventId } from "@/lib/integrations/gcal/event";
import {
  disconnect,
  finishConnect,
  startConnect,
  sweepGcal,
  syncConnection,
  type ConnectionRow,
} from "@/lib/integrations/gcal/server";
import { readGcalConfig } from "@/lib/integrations/gcal/config";
import { messagingHandshake, messagingWebhookSpec } from "@/lib/integrations/meta-messaging/server";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const ORIGIN = "https://www.clinic-example.test";
const PAGE = "100000000000001";
const IG = "17841400000000001";
const APP_SECRET = "app-secret-test-only";

const log: JobLogger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as JobLogger;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 20e: service paths",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let orgB: string;
    let widgetKey: string;
    let widgetKeyB: string;
    let igAccount: string;
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
    let ipSeq = 0;
    const req = (
      path: string,
      init: {
        method?: string;
        origin?: string | null;
        token?: string | null;
        body?: unknown;
        ip?: string;
      } = {},
    ) => {
      const headers: Record<string, string> = {
        "x-real-ip": init.ip ?? `198.51.100.${++ipSeq % 250}`,
      };
      if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      return new Request(`https://pulse.test${path}`, {
        method: init.method ?? "GET",
        headers,
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === "string"
              ? init.body
              : JSON.stringify(init.body),
      });
    };
    const clientId = () => randomBytes(8).toString("hex");

    async function enable(
      o: string,
      kind: Parameters<typeof saveSettings>[1]["kind"],
      config: Record<string, string | number>,
      secrets: Record<string, string> = {},
      provider: string | null = null,
    ) {
      const saved = await saveSettings(admin, { orgId: o, kind, provider, secrets, config });
      expect(saved).toEqual({ ok: true });
      expect(await setEnabled(admin, { orgId: o, kind, userId: alice, enabled: true })).toEqual({
        ok: true,
      });
      const { data } = await admin
        .from("integration_accounts")
        .select("id")
        .eq("org_id", o)
        .eq("kind", kind)
        .single();
      return data!.id;
    }

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      await q("delete from public.rate_limit_hits");
      alice = await createAuthUser(c, "alice@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      orgB = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      widgetKey = await enable(org, "web_chat", {
        allowed_domains: "www.clinic-example.test",
        title: "Chat with Al Das",
        colour: "#123456",
        welcome: "Hello",
      });
      widgetKeyB = await enable(orgB, "web_chat", {
        allowed_domains: "www.other-example.test",
        title: "B",
        colour: "#654321",
        welcome: "Hi",
      });
      igAccount = await enable(
        org,
        "instagram",
        { page_id: PAGE, ig_account_id: IG },
        {
          page_access_token: "page-token-test",
          app_secret: APP_SECRET,
          verify_token: "verify-test-123",
        },
        "meta",
      );
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    describe("website chat", () => {
      it("serves its display settings only to an allowed website", async () => {
        const ok = await widgetConfig(req(`/api/widget/${widgetKey}/config`), widgetKey, { admin });
        expect(ok.status).toBe(200);
        expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
        expect(await ok.json()).toEqual({
          title: "Chat with Al Das",
          colour: "#123456",
          welcome: "Hello",
        });
        const other = await widgetConfig(req("/x", { origin: "https://evil.test" }), widgetKey, {
          admin,
        });
        expect(other.status).toBe(403);
        expect(other.headers.get("access-control-allow-origin")).toBeNull();
        expect((await widgetConfig(req("/x", { origin: null }), widgetKey, { admin })).status).toBe(
          403,
        );
        expect(
          (await widgetConfig(req("/x"), "00000000-0000-4000-8000-000000000000", { admin })).status,
        ).toBe(404);
        expect((await widgetConfig(req("/x"), "not-a-uuid", { admin })).status).toBe(404);
        const pre = await widgetPreflight(req("/x", { method: "OPTIONS" }), widgetKey, { admin });
        expect(pre.status).toBe(204);
        expect(pre.headers.get("access-control-allow-headers")).toBe("content-type, authorization");
      });

      it("answers 404 when switched off or in a training workspace", async () => {
        await setEnabled(admin, { orgId: orgB, kind: "web_chat", userId: alice, enabled: false });
        expect(
          (
            await widgetConfig(
              req("/x", { origin: "https://www.other-example.test" }),
              widgetKeyB,
              { admin },
            )
          ).status,
        ).toBe(404);
        await setEnabled(admin, { orgId: orgB, kind: "web_chat", userId: alice, enabled: true });
        await svc(() => q("update public.orgs set is_training = true where id = $1", [orgB]));
        expect(
          (
            await widgetConfig(
              req("/x", { origin: "https://www.other-example.test" }),
              widgetKeyB,
              { admin },
            )
          ).status,
        ).toBe(404);
        await svc(() => q("update public.orgs set is_training = false where id = $1", [orgB]));
      });

      it("creates the visitor on the first message, returns the token once, and keeps the conversation", async () => {
        const first = await widgetPost(
          req("/m", {
            method: "POST",
            body: {
              text: "Hello, do you open on Friday?",
              client_id: clientId(),
              name: "Layla Demo-07",
            },
          }),
          widgetKey,
          { admin },
        );
        expect(first.status).toBe(200);
        const body = (await first.json()) as { token: string; message: { id: string } };
        expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const { rows: s } = await svc(() =>
          q(
            "select s.token_hash, s.conversation_id, ct.first_name, ct.phone_e164, ct.source, ch.type from public.web_chat_sessions s join public.contacts ct on ct.id = s.contact_id join public.channels ch on ch.id = s.channel_id where ct.org_id = $1",
            [org],
          ),
        );
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({
          first_name: "Layla Demo-07",
          phone_e164: null,
          source: "web_chat",
          type: "web",
        });
        expect(s[0].token_hash).not.toContain(body.token);

        const second = await widgetPost(
          req("/m", {
            method: "POST",
            token: body.token,
            body: { text: "Second message", client_id: clientId() },
          }),
          widgetKey,
          { admin },
        );
        expect(second.status).toBe(200);
        expect(((await second.json()) as { token?: string }).token).toBeUndefined();
        const { rows: n } = await svc(() =>
          q("select count(*)::int as n from public.messages where conversation_id = $1", [
            s[0].conversation_id,
          ]),
        );
        expect(n[0].n).toBe(2);
      });

      it("delivers staff replies to that visitor only, never notes, and marks them delivered", async () => {
        const a = (await (
          await widgetPost(
            req("/m", { method: "POST", body: { text: "Visitor A", client_id: clientId() } }),
            widgetKey,
            { admin },
          )
        ).json()) as { token: string };
        const b = (await (
          await widgetPost(
            req("/m", { method: "POST", body: { text: "Visitor B", client_id: clientId() } }),
            widgetKey,
            { admin },
          )
        ).json()) as { token: string };
        const { rows } = await svc(() =>
          q(
            "select conversation_id from public.web_chat_sessions where token_hash = encode(sha256($1::bytea), 'hex')",
            [a.token],
          ),
        );
        const conv = rows[0].conversation_id as string;
        await addNote(admin, {
          orgId: org,
          conversationId: conv,
          body: "internal: VIP",
          userId: alice,
        });
        const reply = await queueOutbound(admin, {
          orgId: org,
          conversationId: conv,
          spec: { type: "text", body: "Yes, we open at 9." },
          body: "Yes, we open at 9.",
          sentByUserId: alice,
        });
        await deliverOutbound(admin, reply.id, {
          queue: "outbound_priority",
          msgId: 1,
          readCt: 1,
          enqueuedAt: new Date(),
          admin,
          log,
        });
        const { rows: sent } = await svc(() =>
          q("select status, wa_message_id from public.messages where id = $1", [reply.id]),
        );
        expect(sent[0]).toEqual({ status: "sent", wa_message_id: `web:${reply.id}` });

        const poll = await widgetPoll(req("/m", { token: a.token }), widgetKey, { admin });
        expect(poll.status).toBe(200);
        const msgs = ((await poll.json()) as { messages: Array<{ from: string; text: string }> })
          .messages;
        expect(msgs.map((m) => [m.from, m.text])).toEqual([
          ["visitor", "Visitor A"],
          ["clinic", "Yes, we open at 9."],
        ]);
        expect(JSON.stringify(msgs)).not.toMatch(/internal|VIP|alice/);
        const { rows: d } = await svc(() =>
          q("select status from public.messages where id = $1", [reply.id]),
        );
        expect(d[0].status).toBe("delivered");

        const pollB = (await (
          await widgetPoll(req("/m", { token: b.token }), widgetKey, { admin })
        ).json()) as {
          messages: Array<{ text: string }>;
        };
        expect(pollB.messages.map((m) => m.text)).toEqual(["Visitor B"]);
        // no token, a made-up token, or the token at another workspace's widget: nothing
        expect((await widgetPoll(req("/m"), widgetKey, { admin })).status).toBe(401);
        expect(
          (await widgetPoll(req("/m", { token: "A".repeat(43) }), widgetKey, { admin })).status,
        ).toBe(401);
        expect(
          (
            await widgetPoll(
              req("/m", { token: a.token, origin: "https://www.other-example.test" }),
              widgetKeyB,
              { admin },
            )
          ).status,
        ).toBe(401);
      });

      it("refuses bad bodies and limits each visitor", async () => {
        expect(
          (await widgetPost(req("/m", { method: "POST", body: "not json" }), widgetKey, { admin }))
            .status,
        ).toBe(400);
        expect(
          (
            await widgetPost(
              req("/m", {
                method: "POST",
                body: { text: "x".repeat(9000), client_id: clientId() },
              }),
              widgetKey,
              { admin },
            )
          ).status,
        ).toBe(413);
        const t = (await (
          await widgetPost(
            req("/m", { method: "POST", body: { text: "one", client_id: clientId() } }),
            widgetKey,
            { admin },
          )
        ).json()) as { token: string };
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++)
          statuses.push(
            (
              await widgetPost(
                req("/m", {
                  method: "POST",
                  token: t.token,
                  body: { text: `m${i}`, client_id: clientId() },
                }),
                widgetKey,
                { admin },
              )
            ).status,
          );
        expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
        expect(statuses[10]).toBe(429);
      });

      it("refuses a reply once the website chat is switched off", async () => {
        const t = (await (
          await widgetPost(
            req("/m", { method: "POST", body: { text: "late", client_id: clientId() } }),
            widgetKey,
            { admin },
          )
        ).json()) as { token: string };
        const { rows } = await svc(() =>
          q(
            "select conversation_id from public.web_chat_sessions where token_hash = encode(sha256($1::bytea), 'hex')",
            [t.token],
          ),
        );
        await setEnabled(admin, { orgId: org, kind: "web_chat", userId: alice, enabled: false });
        const reply = await queueOutbound(admin, {
          orgId: org,
          conversationId: rows[0].conversation_id,
          spec: { type: "text", body: "Hi" },
          body: "Hi",
          sentByUserId: alice,
        });
        await deliverOutbound(admin, reply.id, {
          queue: "outbound_priority",
          msgId: 1,
          readCt: 1,
          enqueuedAt: new Date(),
          admin,
          log,
        });
        const { rows: m } = await svc(() =>
          q("select status, error_message from public.messages where id = $1", [reply.id]),
        );
        expect(m[0]).toEqual({ status: "failed", error_message: "Website chat is switched off." });
        await setEnabled(admin, { orgId: org, kind: "web_chat", userId: alice, enabled: true });
      });
    });

    describe("Instagram", () => {
      const raw = (mid: string, sender = "900000000000001", text = "Hi, price of a check-up?") =>
        JSON.stringify({
          object: "instagram",
          entry: [
            {
              id: IG,
              time: Date.now(),
              messaging: [
                {
                  sender: { id: sender },
                  recipient: { id: IG },
                  timestamp: Date.now(),
                  message: { mid, text },
                },
              ],
            },
          ],
        });
      const post = (body: string, secret = APP_SECRET) =>
        receiveIntegrationWebhook(
          new Request(`https://pulse.test/api/webhooks/integrations/instagram/${igAccount}`, {
            method: "POST",
            headers: {
              "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
              "x-real-ip": "203.0.113.9",
            },
            body,
          }),
          igAccount,
          "instagram",
          messagingWebhookSpec("instagram"),
          { admin },
        );

      it("verifies the subscription with the stored token only", async () => {
        const ok = await messagingHandshake(
          new Request(
            `https://pulse.test/x?hub.mode=subscribe&hub.verify_token=verify-test-123&hub.challenge=987654`,
          ),
          igAccount,
          "instagram",
          { admin },
        );
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("987654");
        const bad = await messagingHandshake(
          new Request(
            `https://pulse.test/x?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=987654`,
          ),
          igAccount,
          "instagram",
          { admin },
        );
        expect(bad.status).toBe(404);
        expect(
          (
            await messagingHandshake(
              new Request(
                `https://pulse.test/x?hub.mode=subscribe&hub.verify_token=verify-test-123&hub.challenge=1`,
              ),
              igAccount,
              "messenger",
              { admin },
            )
          ).status,
        ).toBe(404);
      });

      it("stores a signed message once, matched by the Instagram id, and refuses a bad signature", async () => {
        const r = await post(raw("ig_mid_1"));
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true, processed: 1, duplicates: 0 });
        const again = await post(raw("ig_mid_1"));
        expect(await again.json()).toEqual({ ok: true, processed: 0, duplicates: 1 });
        expect((await post(raw("ig_mid_2"), "wrong-secret")).status).toBe(401);
        const { rows } = await svc(() =>
          q(
            "select i.external_id, ct.phone_e164, ct.source, m.body, m.wa_message_id, ch.type from public.contact_channel_identities i join public.contacts ct on ct.id = i.contact_id join public.conversations cv on cv.contact_id = ct.id join public.messages m on m.conversation_id = cv.id join public.channels ch on ch.id = cv.channel_id where i.org_id = $1",
            [org],
          ),
        );
        expect(rows).toEqual([
          {
            external_id: "900000000000001",
            phone_e164: null,
            source: "instagram",
            body: "Hi, price of a check-up?",
            wa_message_id: "ig:ig_mid_1",
            type: "instagram",
          },
        ]);
      });

      it("replies inside 24 hours through the Send API, and refuses outside it without calling Meta", async () => {
        await post(raw("ig_mid_3", "900000000000002", "Can I book?"));
        const { rows } = await svc(() =>
          q(
            "select cv.id, cv.contact_id, cv.last_inbound_at, ch.id as channel_id, ch.type, ch.status from public.contact_channel_identities i join public.conversations cv on cv.contact_id = i.contact_id join public.channels ch on ch.id = cv.channel_id where i.external_id = '900000000000002'",
          ),
        );
        const conv = rows[0];
        const calls: Array<{ url: string; body: string }> = [];
        const fetchFn = (async (url: string, init: RequestInit) => {
          calls.push({ url, body: String(init.body) });
          return new Response(
            JSON.stringify({ recipient_id: "900000000000002", message_id: "m_out_1" }),
            { status: 200 },
          );
        }) as typeof fetch;
        const send = async (text: string) => {
          const m = await queueOutbound(admin, {
            orgId: org,
            conversationId: conv.id,
            spec: { type: "text", body: text },
            body: text,
            sentByUserId: alice,
          });
          await deliverChannelOutbound(
            admin,
            {
              message: { id: m.id, org_id: org },
              conversation: {
                id: conv.id,
                last_inbound_at: (
                  await svc(() =>
                    q("select last_inbound_at from public.conversations where id = $1", [conv.id]),
                  )
                ).rows[0].last_inbound_at.toISOString(),
              },
              contactId: conv.contact_id,
              channel: { id: conv.channel_id, type: conv.type, status: conv.status },
              spec: { type: "text", body: text },
            },
            { log, readCt: 1 },
            { fetchFn },
          );
          return (
            await svc(() =>
              q(
                "select status, wa_message_id, error_code, error_message from public.messages where id = $1",
                [m.id],
              ),
            )
          ).rows[0];
        };
        expect(await send("Yes, tomorrow at 10?")).toMatchObject({
          status: "sent",
          wa_message_id: "ig:m_out_1",
        });
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].body)).toEqual({
          recipient: { id: "900000000000002" },
          messaging_type: "RESPONSE",
          message: { text: "Yes, tomorrow at 10?" },
        });
        await svc(() =>
          q(
            "update public.conversations set last_inbound_at = now() - interval '25 hours' where id = $1",
            [conv.id],
          ),
        );
        const late = await send("Still there?");
        expect(late).toMatchObject({ status: "failed", error_code: 2018278 });
        expect(late.error_message).toMatch(/24 hours/);
        expect(calls).toHaveLength(1);
      });

      it("never reaches Meta from a training workspace", async () => {
        const { rows } = await svc(() =>
          q(
            "select cv.id from public.conversations cv join public.channels ch on ch.id = cv.channel_id where ch.type = 'instagram' and cv.org_id = $1 limit 1",
            [org],
          ),
        );
        await svc(() =>
          q("update public.conversations set last_inbound_at = now() where id = $1", [rows[0].id]),
        );
        await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
        const m = await queueOutbound(admin, {
          orgId: org,
          conversationId: rows[0].id,
          spec: { type: "text", body: "x" },
          body: "x",
          sentByUserId: alice,
        });
        await deliverOutbound(admin, m.id, {
          queue: "outbound_priority",
          msgId: 1,
          readCt: 1,
          enqueuedAt: new Date(),
          admin,
          log,
        });
        const r = (
          await svc(() =>
            q("select status, wa_message_id from public.messages where id = $1", [m.id]),
          )
        ).rows[0];
        expect(r).toEqual({ status: "sent", wa_message_id: `training:${m.id}` });
        await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
      });
    });

    describe("Google Calendar", () => {
      let spec: string;
      let specB: string;
      const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

      function fakeGoogle(events: unknown[] = []) {
        const calls: Array<{ method: string; url: string; body: string }> = [];
        const fetchFn = (async (url: string, init: RequestInit) => {
          calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? "") });
          if (url.startsWith("https://oauth2.googleapis.com/token"))
            return new Response(
              JSON.stringify({
                access_token: "at-test",
                expires_in: 3599,
                refresh_token: "rt-test",
              }),
              { status: 200 },
            );
          if (url.startsWith("https://oauth2.googleapis.com/revoke"))
            return new Response(null, { status: 200 });
          if (init.method === "GET")
            return new Response(JSON.stringify({ items: events }), { status: 200 });
          if (init.method === "DELETE") return new Response(null, { status: 204 });
          return new Response("{}", { status: 200 });
        }) as typeof fetch;
        return { calls, fetchFn };
      }

      beforeAll(async () => {
        await enable(
          org,
          "google_calendar",
          { client_id: "123-abc.apps.googleusercontent.com" },
          { client_secret: "client-secret-test" },
          "google",
        );
        spec = (
          await svc(() =>
            q(
              "insert into public.specialists (org_id, name) values ($1, 'Dr Sync') returning id::text",
              [org],
            ),
          )
        ).rows[0].id;
        specB = (
          await svc(() =>
            q(
              "insert into public.specialists (org_id, name) values ($1, 'Dr Other') returning id::text",
              [orgB],
            ),
          )
        ).rows[0].id;
      });

      it("connects only through a fresh state started by the same person, storing tokens encrypted", async () => {
        const redirectUri = "https://pulse.test/api/integrations/google-calendar/callback";
        expect(
          await startConnect(admin, {
            orgId: org,
            specialistId: specB,
            userId: alice,
            redirectUri,
          }),
        ).toEqual({
          ok: false,
          error: "Specialist not found.",
        });
        const started = await startConnect(admin, {
          orgId: org,
          specialistId: spec,
          userId: alice,
          redirectUri,
        });
        expect(started.ok).toBe(true);
        const state = new URL((started as { url: string }).url).searchParams.get("state")!;
        const g = fakeGoogle();
        expect(
          await finishConnect(
            admin,
            {
              orgId: org,
              userId: "00000000-0000-4000-8000-000000000001",
              state,
              code: "c1",
              redirectUri,
            },
            { fetchFn: g.fetchFn },
          ),
        ).toMatchObject({ ok: false });
        expect(
          await finishConnect(
            admin,
            { orgId: org, userId: alice, state, code: "c1", redirectUri },
            { fetchFn: g.fetchFn },
          ),
        ).toEqual({
          ok: true,
          specialistId: spec,
        });
        expect(
          await finishConnect(
            admin,
            { orgId: org, userId: alice, state, code: "c1", redirectUri },
            { fetchFn: g.fetchFn },
          ),
        ).toMatchObject({ ok: false });
        expect(g.calls.filter((x) => x.url.includes("/token"))).toHaveLength(1);
        const { rows } = await svc(() =>
          q(
            "select status, refresh_enc, access_enc from public.gcal_connections where specialist_id = $1",
            [spec],
          ),
        );
        expect(rows[0].status).toBe("active");
        expect(rows[0].refresh_enc).not.toContain("rt-test");
        expect(rows[0].access_enc).not.toContain("at-test");
      });

      it("pulls busy times in and pushes appointments out as 'Busy' with no patient detail, idempotently", async () => {
        const patient = (
          await svc(() =>
            q(
              "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Demo-07', '+447700900007') returning id::text",
              [org],
            ),
          )
        ).rows[0].id;
        const appt = (
          await svc(() =>
            q(
              "insert into public.appointments (org_id, contact_id, specialist_id, starts_at, ends_at, status, notes) values ($1, $2, $3, $4, $5, 'confirmed', 'Diabetes review') returning id::text",
              [org, patient, spec, at(48), at(48.5)],
            ),
          )
        ).rows[0].id;
        const g = fakeGoogle([
          {
            id: "personal1",
            status: "confirmed",
            start: { dateTime: at(24) },
            end: { dateTime: at(25) },
            summary: "Dentist",
          },
          {
            id: gcalEventId(org, appt),
            status: "confirmed",
            start: { dateTime: at(48) },
            end: { dateTime: at(48.5) },
            extendedProperties: { private: { pulse: "1" } },
          },
        ]);
        const account = (
          await admin
            .from("integration_accounts")
            .select("*")
            .eq("org_id", org)
            .eq("kind", "google_calendar")
            .single()
        ).data!;
        const conn = async () =>
          (
            await admin
              .from("gcal_connections")
              .select("*")
              .eq("specialist_id", spec)
              .neq("status", "revoked")
              .single()
          ).data as ConnectionRow;
        const cfg = readGcalConfig({ client_id: "123-abc.apps.googleusercontent.com" });
        const r1 = await syncConnection(admin, await conn(), account, cfg, "Asia/Dubai", {
          fetchFn: g.fetchFn,
        });
        expect(r1).toMatchObject({
          pulled: { inserted: 1, updated: 0, deleted: 0 },
          pushed: 1,
          removed: 0,
          failed: 0,
          error: null,
        });
        const insert = g.calls.find((x) => x.method === "POST" && x.url.includes("/events"))!;
        const sent = JSON.parse(insert.body);
        expect(sent.summary).toBe("Busy");
        expect(sent.id).toBe(gcalEventId(org, appt));
        expect(insert.body).not.toMatch(/Layla|Demo-07|447700900007|Diabetes/);
        const { rows: blocks } = await svc(() =>
          q("select reason, source from public.time_blocks where specialist_id = $1", [spec]),
        );
        expect(blocks).toEqual([{ reason: "Busy (Google Calendar)", source: "google" }]);

        const writesBefore = g.calls.filter((x) => x.method !== "GET").length;
        const r2 = await syncConnection(admin, await conn(), account, cfg, "Asia/Dubai", {
          fetchFn: g.fetchFn,
        });
        expect(r2).toMatchObject({
          pulled: { inserted: 0, updated: 0, deleted: 0 },
          pushed: 0,
          removed: 0,
        });
        expect(g.calls.filter((x) => x.method !== "GET").length).toBe(writesBefore);

        // moved, then cancelled
        await svc(() =>
          q("update public.appointments set starts_at = $2, ends_at = $3 where id = $1", [
            appt,
            at(50),
            at(50.5),
          ]),
        );
        expect(
          await syncConnection(admin, await conn(), account, cfg, "Asia/Dubai", {
            fetchFn: g.fetchFn,
          }),
        ).toMatchObject({ pushed: 1 });
        expect(g.calls.at(-1)).toMatchObject({ method: "PUT" });
        await svc(() =>
          q("update public.appointments set status = 'cancelled' where id = $1", [appt]),
        );
        expect(
          await syncConnection(admin, await conn(), account, cfg, "Asia/Dubai", {
            fetchFn: g.fetchFn,
          }),
        ).toMatchObject({ removed: 1 });
        expect(g.calls.at(-1)).toMatchObject({ method: "DELETE" });
        const { rows: link } = await svc(() =>
          q("select status from public.gcal_event_links where appointment_id = $1", [appt]),
        );
        expect(link[0].status).toBe("deleted");
      });

      it("never changes the mirror from an incomplete read", async () => {
        const account = (
          await admin
            .from("integration_accounts")
            .select("*")
            .eq("org_id", org)
            .eq("kind", "google_calendar")
            .single()
        ).data!;
        const conn = (
          await admin
            .from("gcal_connections")
            .select("*")
            .eq("specialist_id", spec)
            .neq("status", "revoked")
            .single()
        ).data as ConnectionRow;
        const failing = (async () =>
          new Response(JSON.stringify({ error: { code: 403 } }), {
            status: 403,
          })) as unknown as typeof fetch;
        const r = await syncConnection(
          admin,
          conn,
          account,
          readGcalConfig({ client_id: "x" }),
          "Asia/Dubai",
          { fetchFn: failing },
        );
        expect(r.error).toBe("http_403");
        const { rows } = await svc(() =>
          q(
            "select count(*)::int as n from public.time_blocks where specialist_id = $1 and source = 'google'",
            [spec],
          ),
        );
        expect(rows[0].n).toBe(1);
        const { rows: s } = await svc(() =>
          q(
            "select status, consecutive_failures, next_sync_at > now() as later from public.gcal_connections where id = $1",
            [conn.id],
          ),
        );
        expect(s[0]).toEqual({ status: "error", consecutive_failures: 1, later: true });
      });

      it("clears the mirror without calling Google when the integration is off", async () => {
        await setEnabled(admin, {
          orgId: org,
          kind: "google_calendar",
          userId: alice,
          enabled: false,
        });
        await svc(() =>
          q(
            "update public.gcal_connections set next_sync_at = now() - interval '1 minute' where specialist_id = $1",
            [spec],
          ),
        );
        const spy = vi.spyOn(globalThis, "fetch");
        const r = await sweepGcal(admin);
        expect(r.skipped_off).toBe(1);
        expect(
          spy.mock.calls.filter(([u]) => /googleapis\.com|accounts\.google\.com/.test(String(u))),
        ).toHaveLength(0);
        spy.mockRestore();
        const { rows } = await svc(() =>
          q(
            "select count(*)::int as n from public.time_blocks where specialist_id = $1 and source = 'google'",
            [spec],
          ),
        );
        expect(rows[0].n).toBe(0);
        await setEnabled(admin, {
          orgId: org,
          kind: "google_calendar",
          userId: alice,
          enabled: true,
        });
      });

      it("disconnect revokes at Google, wipes the tokens and stops the sync", async () => {
        const g = fakeGoogle();
        expect(
          await disconnect(admin, { orgId: org, specialistId: spec }, { fetchFn: g.fetchFn }),
        ).toMatchObject({ ok: true });
        expect(g.calls.some((x) => x.url.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(
          true,
        );
        const { rows } = await svc(() =>
          q(
            "select status, refresh_enc, access_enc from public.gcal_connections where specialist_id = $1",
            [spec],
          ),
        );
        expect(rows).toEqual([{ status: "revoked", refresh_enc: null, access_enc: null }]);
        const before = g.calls.length;
        await sweepGcal(admin, { fetchFn: g.fetchFn });
        expect(g.calls.length).toBe(before);
      });
    });
  },
);
