/**
 * Sending through Sanoflow (OQ-182) against a real Postgres through PostgREST: the transport constraints, the outbound job's
 * hand-over (template sent with Make's request shape, opt-out re-checked, switched off, ambiguous answers never re-sent), the
 * Meta guard, and the "replied / booked" webhook crediting the newest recall send. Sanoflow is a fake fetch; nothing leaves the
 * machine. Synthetic data only (reserved +44 7700 900xxx numbers).
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { SANOFLOW_SEND_TEMPLATE_URL } from "@/lib/integrations/sanoflow/config";
import { sanoflowWebhookSpec } from "@/lib/integrations/sanoflow/server";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { clientForChannel, SanoflowNumberError } from "@/lib/whatsapp/channel";

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
const KEY = "sanoflow-key-test-only";
const TOKEN = "w".repeat(40);
const passthrough = globalThis.fetch;
const log: JobLogger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as JobLogger;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "sanoflow: service paths",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let channel: string;
    let accountId: string;
    let reminder: string;
    let promo: string;
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
    let calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let answers: Array<{ status: number; json?: unknown }> = [];

    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Everything else (PostgREST) goes to the real fetch; only Sanoflow is faked.
      if (!url.includes("sanoflow.io")) return passthrough(input, init);
      calls.push({
        url,
        body: String(init?.body ?? ""),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const a = answers.shift() ?? { status: 200, json: { status: true, message_id: "sf-1" } };
      return new Response(a.json === undefined ? "" : JSON.stringify(a.json), { status: a.status });
    }) as typeof fetch;

    async function contact(phone: string, over: Record<string, unknown> = {}) {
      const { rows } = await svc(() =>
        q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, stop_marketing) values ($1, 'Layla', 'Demo-07', $2, $3) returning id",
          [org, phone, over.stop_marketing ?? false],
        ),
      );
      return rows[0].id as string;
    }

    async function send(contactId: string, templateId: string, values: Record<string, string>) {
      const conv = await ensureConversation(admin, org, contactId, channel);
      const m = await queueOutbound(admin, {
        orgId: org,
        conversationId: conv.id,
        spec: { type: "template", template_id: templateId, values },
        body: "x",
        sentByUserId: null,
        priority: false,
      });
      return m.id;
    }

    const run = (id: string) =>
      deliverOutbound(admin, id, {
        queue: "outbound",
        msgId: 1,
        readCt: 1,
        enqueuedAt: new Date(),
        admin,
        log,
      });

    const row = async (id: string) =>
      (
        await svc(() =>
          q(
            "select status, wa_message_id, error_code, error_message from public.messages where id = $1",
            [id],
          ),
        )
      ).rows[0];

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
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;

      const saved = await saveSettings(admin, {
        orgId: org,
        kind: "sanoflow",
        provider: "sanoflow",
        secrets: { access_token: KEY, webhook_token: TOKEN },
        config: { phone_format: "digits" },
      });
      expect(saved).toEqual({ ok: true });
      expect(
        await setEnabled(admin, { orgId: org, kind: "sanoflow", userId: alice, enabled: true }),
      ).toEqual({
        ok: true,
      });
      accountId = (
        await svc(() =>
          q("select id from public.integration_accounts where org_id = $1 and kind = 'sanoflow'", [
            org,
          ]),
        )
      ).rows[0].id;

      channel = (
        await svc(() =>
          q(
            "insert into public.channels (org_id, type, transport, name, waba_id, phone_number_id, send_rate_per_sec) values ($1, 'whatsapp', 'sanoflow', 'Main', 'sanoflow', 'sanoflow:' || gen_random_uuid(), 1000) returning id",
            [org],
          ),
        )
      ).rows[0].id;
      const tpl = async (name: string, category: string, text: string, sf: number | null) =>
        (
          await svc(() =>
            q(
              "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components, sanoflow_template_id) values ($1, $2, 'sanoflow', $3, 'en', $4, 'APPROVED', $5, $6) returning id",
              [org, channel, name, category, JSON.stringify([{ type: "BODY", text }]), sf],
            ),
          )
        ).rows[0].id as string;
      reminder = await tpl(
        "appointment_reminder",
        "UTILITY",
        "Dear {{1}}, tomorrow at {{2}} with {{3}}.",
        11885,
      );
      promo = await tpl("birthday_men_30", "MARKETING", "Happy birthday {{1}}", 12295);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      calls = [];
      answers = [];
    });

    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    describe("constraints", () => {
      it("a Sanoflow number carries no Meta ids, and a number's transport cannot change", async () => {
        await expect(
          svc(() =>
            q(
              "insert into public.channels (org_id, type, transport, name, waba_id, phone_number_id) values ($1, 'whatsapp', 'sanoflow', 'x', '1234', '5678')",
              [org],
            ),
          ),
        ).rejects.toThrow(/channels_sanoflow_ref_check/);
        await expect(
          svc(() =>
            q(
              "insert into public.channels (org_id, type, transport, name, waba_id, phone_number_id) values ($1, 'web', 'sanoflow', 'x', 'sanoflow', 'sanoflow:x')",
              [org],
            ),
          ),
        ).rejects.toThrow();
        await expect(
          svc(() => q("update public.channels set transport = 'meta' where id = $1", [channel])),
        ).rejects.toThrow(/transport cannot change/);
        await expect(
          svc(() =>
            q("update public.wa_templates set sanoflow_template_id = 0 where id = $1", [reminder]),
          ),
        ).rejects.toThrow(/wa_templates_sanoflow_id_check/);
      });

      it("no Meta client is ever built for a Sanoflow number", async () => {
        const { rows } = await svc(() =>
          q("select id, phone_number_id, waba_id from public.channels where id = $1", [channel]),
        );
        await expect(clientForChannel(admin, rows[0])).rejects.toBeInstanceOf(SanoflowNumberError);
      });
    });

    describe("outbound job", () => {
      it("sends a template through Sanoflow with Make's request shape and marks it sent", async () => {
        vi.stubGlobal("fetch", fake);
        const who = await contact("+447700900101");
        const id = await send(who, reminder, {
          "body.1": "Layla",
          "body.2": "10:30",
          "body.3": "the doctor",
        });
        await run(id);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(SANOFLOW_SEND_TEMPLATE_URL);
        expect(calls[0]!.headers["access-token"]).toBe(KEY);
        expect(JSON.parse(calls[0]!.body)).toEqual({
          template_id: 11885,
          phone: "447700900101",
          mapper_value: ["Layla", "10:30", "the doctor"],
        });
        expect(await row(id)).toMatchObject({ status: "sent", wa_message_id: "sanoflow:sf-1" });
        // The call log has the operation and outcome only.
        const { rows: logRows } = await svc(() =>
          q("select provider, operation, outcome from public.integration_calls where org_id = $1", [
            org,
          ]),
        );
        expect(logRows).toContainEqual({
          provider: "sanoflow",
          operation: "sanoflow.send_template",
          outcome: "ok",
        });
      });

      it("re-checks the opt-out at send time: a Marketing template never reaches stop_marketing", async () => {
        vi.stubGlobal("fetch", fake);
        const who = await contact("+447700900102", { stop_marketing: true });
        const id = await send(who, promo, { "body.1": "Layla" });
        await run(id);
        expect(calls).toHaveLength(0);
        expect(await row(id)).toMatchObject({ status: "failed", error_code: 131050 });
      });

      it("refuses text, a template without a Sanoflow number, and missing values without calling Sanoflow", async () => {
        vi.stubGlobal("fetch", fake);
        const who = await contact("+447700900103");
        const conv = await ensureConversation(admin, org, who, channel);
        await svc(() =>
          q("update public.conversations set last_inbound_at = now() where id = $1", [conv.id]),
        );
        const text = await queueOutbound(admin, {
          orgId: org,
          conversationId: conv.id,
          spec: { type: "text", body: "hello" },
          body: "hello",
          sentByUserId: alice,
        });
        await run(text.id);
        expect((await row(text.id)).error_message).toMatch(/approved templates only/);

        await svc(() =>
          q("update public.wa_templates set sanoflow_template_id = null where id = $1", [promo]),
        );
        const noNumber = await send(who, promo, { "body.1": "Layla" });
        await run(noNumber);
        expect((await row(noNumber)).error_message).toMatch(/no Sanoflow template number/);
        await svc(() =>
          q("update public.wa_templates set sanoflow_template_id = 12295 where id = $1", [promo]),
        );

        const missing = await send(who, promo, {});
        await run(missing);
        expect(await row(missing)).toMatchObject({ status: "failed" });
        expect(calls).toHaveLength(0);
      });

      it("an ambiguous answer is never sent again, and a message already 'sending' is not re-posted", async () => {
        vi.stubGlobal("fetch", fake);
        const who = await contact("+447700900104");
        answers = [{ status: 502 }];
        const id = await send(who, reminder, {
          "body.1": "Layla",
          "body.2": "10:30",
          "body.3": "the doctor",
        });
        await run(id);
        expect(calls).toHaveLength(1);
        expect(await row(id)).toMatchObject({ status: "failed" });
        expect((await row(id)).error_message).toMatch(/may have arrived/);

        const id2 = await send(who, reminder, {
          "body.1": "Layla",
          "body.2": "11:00",
          "body.3": "the doctor",
        });
        await svc(() => q("update public.messages set status = 'sending' where id = $1", [id2]));
        await run(id2);
        expect(calls).toHaveLength(1);
        expect((await row(id2)).error_message).toMatch(/interrupted/);
      });

      it("does nothing while the integration is switched off", async () => {
        vi.stubGlobal("fetch", fake);
        await setEnabled(admin, { orgId: org, kind: "sanoflow", userId: alice, enabled: false });
        try {
          const who = await contact("+447700900105");
          const id = await send(who, reminder, {
            "body.1": "Layla",
            "body.2": "10:30",
            "body.3": "the doctor",
          });
          await run(id);
          expect(calls).toHaveLength(0);
          expect((await row(id)).error_message).toMatch(/switched off/);
        } finally {
          await setEnabled(admin, { orgId: org, kind: "sanoflow", userId: alice, enabled: true });
        }
      });
    });

    describe("replied / booked webhook", () => {
      const post = (body: unknown, token: string | null = TOKEN) =>
        receiveIntegrationWebhook(
          new Request(`https://pulse.test/api/webhooks/integrations/sanoflow/${accountId}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-real-ip": `198.51.100.${Math.floor(Math.random() * 200)}`,
              ...(token ? { "x-pulse-token": token } : {}),
            },
            body: JSON.stringify(body),
          }),
          accountId,
          "sanoflow",
          sanoflowWebhookSpec(),
          { admin },
        );

      it("credits the patient's newest open recall send, once, and refuses a wrong token", async () => {
        const who = await contact("+447700900106");
        await svc(() => q("select public.seed_recall_programmes($1)", [org]));
        const { rows: prog } = await svc(() =>
          q("select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'", [
            org,
          ]),
        );
        const { rows: sends } = await svc(() =>
          q(
            "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status, sent_at, send_mode) values ($1, $2, $3, '2026-07-01', 'sent', now() - interval '2 days', 'live'), ($1, $2, $3, '2026-01-01', 'sent', now() - interval '5 days', 'live') returning id, cycle_key",
            [org, prog[0].id, who],
          ),
        );
        const newest = sends.find((s) => s.cycle_key === "2026-07-01")!.id;

        expect(
          (await post({ Mobile: "+447700900106", Status: "Replied" }, "x".repeat(40))).status,
        ).toBe(401);
        expect((await post({ Mobile: "+447700900106", Status: "Replied" }, null)).status).toBe(401);

        const ok = await post({ Mobile: "+447700900106", Status: "Replied", "Trigger Data": "{}" });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({ processed: 1, duplicates: 0 });
        const again = await post({
          Mobile: "+447700900106",
          Status: "Replied",
          "Trigger Data": "{}",
        });
        expect(await again.json()).toMatchObject({ processed: 0, duplicates: 1 });

        const booked = await post({ Mobile: "+447700900106", Status: "Booked" });
        expect(booked.status).toBe(200);
        const { rows } = await svc(() =>
          q(
            "select id, replied_at is not null as replied, booked_at is not null as booked, follow_up_status from public.recall_sends where contact_id = $1 order by sent_at desc",
            [who],
          ),
        );
        expect(rows).toEqual([
          { id: newest, replied: true, booked: true, follow_up_status: "booked" },
          { id: expect.any(String), replied: false, booked: false, follow_up_status: null },
        ]);
        const { rows: outcomes } = await svc(() =>
          q(
            "select outcome from public.integration_webhook_events where org_id = $1 and provider = 'sanoflow' order by outcome",
            [org],
          ),
        );
        expect(outcomes.map((o) => o.outcome)).toEqual(["booked_credited", "replied_credited"]);
      });

      it("an unknown number or status changes nothing", async () => {
        const r = await post({ Mobile: "+447700900999", Status: "Replied" });
        expect(await r.json()).toMatchObject({ processed: 1 });
        const ignored = await post({ Mobile: "+447700900106", Status: "Opened" });
        expect(await ignored.json()).toMatchObject({ processed: 0 });
      });
    });
  },
);
