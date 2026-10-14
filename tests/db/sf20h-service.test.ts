/**
 * Phase 20h (docs/30_PHASE_20H_SMS_MMLITE_NOTES.md) against a real Postgres through PostgREST:
 *   - the generic HTTP SMS gateway: settings stored with the token encrypted, the SMS job sending through it (fake fetch),
 *     the call log without address, number or text, an ambiguous answer never sent twice, receipts refused for it;
 *   - MM Lite: a campaign's Marketing template goes to /marketing_messages only while `wa_mm_lite` is on; everything else
 *     still goes to /messages; stop_marketing and training mode still stop it before Meta.
 * Nothing leaves the machine: `fetch` is spied and answers for the reserved gateway host and Meta's Graph host only
 * (tests/setup.ts blocks both). Synthetic data only. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAccount, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { queueSmsFallback } from "@/lib/integrations/sms/fallback";
import { smsWebhookSpec } from "@/lib/integrations/sms/receipts";
import { processSmsJob } from "@/lib/integrations/sms/send";
import { twilioSignature } from "@/lib/integrations/sms/twilio";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import type { JobContext } from "@/lib/jobs/types";
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
const APP_URL = "https://pulse.test";
const GATEWAY = "https://sms.gateway.example/v1/send";
const log = { info() {}, warn() {}, error() {} };

type Seen = { url: string; method: string; body: string; headers: Record<string, string> };

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 20h: generic SMS gateway and MM Lite (db)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let channel: string;
    let n = 0;
    const seen: Seen[] = [];
    let gatewayReplies: Array<{ status: number; body: unknown }> = [];
    let spy: MockInstance;
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await asServiceRole(c, () => c.query<T>(sql, params))).rows;
    const one = async (sql: string, params: unknown[] = []) =>
      (await q<{ id: string }>(sql + " returning id::text as id", params))[0]!.id;
    const phone = () => `+447700900${String(300 + ++n).padStart(3, "0")}`;
    // The SMS policy texts mobile numbers only; the reserved UK drama range is not one, so SMS rows use synthetic UAE mobiles.
    const mobile = () => `+97150112${String(100 + ++n).padStart(4, "0")}`;
    const ctx = {
      queue: "outbound",
      msgId: 1,
      readCt: 1,
      enqueuedAt: new Date(),
      log,
    } as unknown as JobContext;

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = APP_URL;
      process.env.META_SYSTEM_USER_TOKEN = "test-token-not-real";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice-20h@example.test");
      org = await createOrg(c, "Org 20h", "org-20h", alice);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      (ctx as { admin: AdminClient }).admin = admin;
      await q("update public.orgs set timezone = 'Asia/Dubai' where id = $1", [org]);
      channel = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id, status) values ($1, 'Main', 'waba-20h', 'pn-20h', 'active')",
        [org],
      );

      const realFetch = globalThis.fetch;
      spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const record = () =>
          seen.push({
            url,
            method: init?.method ?? "GET",
            body: String(init?.body ?? ""),
            headers: (init?.headers ?? {}) as Record<string, string>,
          });
        if (url.startsWith("https://sms.gateway.example/")) {
          record();
          const r = gatewayReplies.shift() ?? { status: 200, body: { id: `gw-${seen.length}` } };
          return new Response(JSON.stringify(r.body), {
            status: r.status,
            headers: { "content-type": "application/json" },
          });
        }
        if (/graph\.facebook\.com/.test(url)) {
          record();
          return new Response(
            JSON.stringify({
              messaging_product: "whatsapp",
              messages: [{ id: `wamid.T20H${seen.length}${Math.random().toString(36).slice(2)}` }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return realFetch(input, init);
      }) as typeof fetch);
    });
    afterAll(async () => {
      spy?.mockRestore();
      await resetDb(c);
      await c.end();
    });

    // ---------------------------------------------------------------------------------------------------------------
    describe("generic HTTP SMS gateway", () => {
      const NOW = new Date("2026-10-18T08:00:00Z");
      let loc: string;
      let spec: string;
      let accountId: string;

      async function failedReminder(): Promise<{
        appt: string;
        reminder: string;
        contact: string;
      }> {
        const contact = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, language) values ($1, 'Layla', 'Demo-20', $2, 'en')",
          [org, mobile()],
        );
        const appt = await one(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, starts_at, ends_at, status) values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', 'confirmed')",
          [org, contact, loc, spec, new Date(NOW.getTime() + 48 * 3_600_000).toISOString()],
        );
        const reminder = await one(
          "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status) values ($1, $2, 1, now(), 'failed')",
          [org, appt],
        );
        return { appt, reminder, contact };
      }
      async function queued(): Promise<string> {
        const r = await failedReminder();
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: r.appt,
            reminderId: r.reminder,
            now: NOW,
          }),
        ).toBe("queued");
        const rows = await q<{ id: string }>(
          "select id::text from public.sms_messages where appointment_id = $1",
          [r.appt],
        );
        return rows[0]!.id;
      }
      const sms = async (id: string) =>
        (
          await q<{
            status: string;
            provider: string;
            provider_message_id: string | null;
            error_code: string | null;
          }>(
            "select status, provider, provider_message_id, error_code from public.sms_messages where id = $1",
            [id],
          )
        )[0]!;

      beforeAll(async () => {
        loc = await one("insert into public.locations (org_id, name) values ($1, 'Demo Clinic')", [
          org,
        ]);
        spec = await one("insert into public.specialists (org_id, name) values ($1, 'Dr Demo')", [
          org,
        ]);
        await saveSettings(admin, {
          orgId: org,
          kind: "sms",
          provider: "http",
          secrets: { gateway_secret: "gw_secret_value" },
          config: {
            http_url: GATEWAY,
            http_auth: "bearer",
            http_encoding: "json",
            http_body: "to={to}&sender={from}&message={text}",
            http_id_field: "id",
            http_username: "",
            http_test_url: "",
            sender: "DEMOCLINIC",
            clinic_name: "Demo Clinic",
            callback_phone: "+97140000000",
            rate_per_sec: 1000,
            daily_cap: 200,
            segment_price: "",
          },
        });
        accountId = (await loadAccount(admin, org, "sms"))!.id;
      });

      it("stores the token encrypted only", async () => {
        const [row] = await q<{ config_enc: string; config: string }>(
          "select config_enc, config::text as config from public.integration_accounts where id = $1",
          [accountId],
        );
        expect(row!.config_enc).not.toContain("gw_secret_value");
        expect(row!.config).not.toContain("gw_secret_value");
        expect(row!.config).toContain('"provider": "http"');
      });

      it("sends nothing while switched off", async () => {
        const r = await failedReminder();
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: r.appt,
            reminderId: r.reminder,
            now: NOW,
          }),
        ).toBe("off");
      });

      it("sends the reminder through the configured gateway once, and logs the call without address, number or text", async () => {
        await setEnabled(admin, { orgId: org, kind: "sms", userId: alice, enabled: true });
        const id = await queued();
        seen.length = 0;
        gatewayReplies = [{ status: 200, body: { id: "gw-abc-1" } }];
        expect(await processSmsJob(admin, id, { readCt: 1, now: NOW })).toBe("sent");
        expect(await processSmsJob(admin, id, { readCt: 2, now: NOW })).toBe("skipped");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe(GATEWAY);
        expect(seen[0]!.method).toBe("POST");
        expect(seen[0]!.headers.Authorization).toBe("Bearer gw_secret_value");
        const body = JSON.parse(seen[0]!.body) as Record<string, string>;
        expect(Object.keys(body).sort()).toEqual(["message", "sender", "to"]);
        expect(body.sender).toBe("DEMOCLINIC");
        expect(body.to).toMatch(/^\+97150112\d{4}$/);
        expect(body.message).toContain("Demo Clinic: reminder of your appointment");
        expect(body.message).not.toContain("Layla");
        expect(await sms(id)).toMatchObject({
          status: "sent",
          provider: "http",
          provider_message_id: "gw-abc-1",
        });
        const calls = await q<Record<string, unknown>>(
          "select * from public.integration_calls where org_id = $1 and provider = 'sms_http'",
          [org],
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ operation: "sms.send", outcome: "ok", http_status: 200 });
        const logged = JSON.stringify(calls);
        for (const leak of ["gateway.example", body.to.slice(1), "reminder", "gw_secret_value"])
          expect(logged).not.toContain(leak);
      });

      it("never sends twice after an ambiguous answer, and fails closed on a 4xx", async () => {
        const id = await queued();
        seen.length = 0;
        gatewayReplies = [{ status: 502, body: {} }];
        expect(await processSmsJob(admin, id, { readCt: 1, now: NOW })).toBe("failed");
        expect(seen).toHaveLength(1);
        expect(await sms(id)).toMatchObject({ status: "failed", error_code: "unknown_delivery" });
        expect(await processSmsJob(admin, id, { readCt: 2, now: NOW })).toBe("skipped");
        expect(seen).toHaveLength(1);

        const id2 = await queued();
        gatewayReplies = [{ status: 422, body: { error: "invalid" } }];
        expect(await processSmsJob(admin, id2, { readCt: 1, now: NOW })).toBe("failed");
        expect(await sms(id2)).toMatchObject({ status: "failed", error_code: "http_422" });
      });

      it("marks a sent SMS sent even when the gateway repeats a message id (the row id stands in)", async () => {
        const first = await queued();
        const second = await queued();
        gatewayReplies = [
          { status: 200, body: { id: "gw-same" } },
          { status: 200, body: { id: "gw-same" } },
        ];
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          expect(await processSmsJob(admin, first, { readCt: 1, now: NOW })).toBe("sent");
          expect(await processSmsJob(admin, second, { readCt: 1, now: NOW })).toBe("sent");
        } finally {
          warn.mockRestore();
        }
        expect(await sms(first)).toMatchObject({ status: "sent", provider_message_id: "gw-same" });
        expect(await sms(second)).toMatchObject({
          status: "sent",
          provider_message_id: `dup:${second}`,
        });
      });

      it("refuses delivery receipts for the generic gateway (it has none), whatever the signature", async () => {
        const url = `${APP_URL}/api/webhooks/integrations/sms/${accountId}`;
        const params = { MessageSid: "gw-abc-1", MessageStatus: "delivered" };
        const res = await receiveIntegrationWebhook(
          new Request(url, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": twilioSignature("gw_secret_value", url, params),
              "x-forwarded-for": "198.51.100.20",
            },
            body: new URLSearchParams(params).toString(),
          }),
          accountId,
          "sms",
          smsWebhookSpec(),
        );
        expect(res.status).toBe(401);
      });

      it("is refused in a training workspace before the gateway is called", async () => {
        const id = await queued();
        seen.length = 0;
        await q("update public.orgs set is_training = true where id = $1", [org]);
        try {
          expect(await processSmsJob(admin, id, { readCt: 1, now: NOW })).toBe("failed");
        } finally {
          await q("update public.orgs set is_training = false where id = $1", [org]);
        }
        expect(seen).toHaveLength(0);
        expect(await sms(id)).toMatchObject({ status: "failed", error_code: "training_mode" });
      });
    });

    // ---------------------------------------------------------------------------------------------------------------
    describe("MM Lite for campaign marketing templates", () => {
      let marketing: string;
      let utility: string;

      async function campaignMessage(
        tpl: string,
        over: { stop?: boolean; campaign?: boolean } = {},
      ) {
        const contact = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in, stop_marketing) values ($1, 'Omar', 'Demo-21', $2, true, $3)",
          [org, phone(), over.stop ?? false],
        );
        const conversation = await one(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [org, channel, contact],
        );
        let recipient: string | null = null;
        if (over.campaign !== false) {
          const campaign = await one(
            "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, started_at, guard_since, quality_at_start, variable_map, created_by) values ($1, $2, $3, $4, 'csv', 'sending', now(), now(), 'GREEN', '{\"body.1\":\"contact.first_name\"}', $5)",
            [org, `20h camp ${++n}`, channel, tpl, alice],
          );
          recipient = await one(
            "insert into public.campaign_recipients (org_id, campaign_id, contact_id) values ($1, $2, $3)",
            [org, campaign, contact],
          );
        }
        const message = await one(
          `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, campaign_recipient_id)
           values ($1, $2, 'out', 'template', 'Hello Omar', jsonb_build_object('send', jsonb_build_object('type', 'template', 'template_id', $3::text, 'values', jsonb_build_object('body.1', 'Omar'))), 'queued', $4)`,
          [org, conversation, tpl, recipient],
        );
        if (recipient)
          await q("update public.campaign_recipients set message_id = $2 where id = $1", [
            recipient,
            message,
          ]);
        return message;
      }
      const deliver = async (messageId: string) => {
        seen.length = 0;
        await deliverOutbound(admin, messageId, ctx);
        const [m] = await q<{ status: string; wa_message_id: string | null }>(
          "select status, wa_message_id from public.messages where id = $1",
          [messageId],
        );
        return { message: m, urls: seen.map((s) => s.url) };
      };

      beforeAll(async () => {
        marketing = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components)
           values ($1, $2, 'waba-20h', 'offer_20h', 'en', 'APPROVED', 'MARKETING', '[{"type":"BODY","text":"Hello {{1}}"}]')`,
          [org, channel],
        );
        utility = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components)
           values ($1, $2, 'waba-20h', 'notice_20h', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]')`,
          [org, channel],
        );
      });

      it("uses /messages while the switch is off (the default)", async () => {
        expect(await loadAccount(admin, org, "wa_mm_lite")).toBeNull();
        const r = await deliver(await campaignMessage(marketing));
        expect(r.message!.status).toBe("sent");
        expect(r.urls).toEqual(["https://graph.facebook.com/v21.0/pn-20h/messages"]);
      });

      it("sends a campaign's Marketing template to /marketing_messages once switched on, with the normal body", async () => {
        await setEnabled(admin, { orgId: org, kind: "wa_mm_lite", userId: alice, enabled: true });
        const id = await campaignMessage(marketing);
        const r = await deliver(id);
        expect(r.message!.status).toBe("sent");
        expect(r.message!.wa_message_id).toMatch(/^wamid\.T20H/);
        expect(r.urls).toEqual(["https://graph.facebook.com/v21.0/pn-20h/marketing_messages"]);
        const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
        expect(body).toMatchObject({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          type: "template",
          template: { name: "offer_20h", language: { code: "en" } },
        });
        // a repeat delivery of the same job sends nothing (wa_message_id is set)
        expect((await deliver(id)).urls).toEqual([]);
      });

      it("leaves everything else on /messages: a Utility campaign template and a one-off Marketing template", async () => {
        expect((await deliver(await campaignMessage(utility))).urls).toEqual([
          "https://graph.facebook.com/v21.0/pn-20h/messages",
        ]);
        expect((await deliver(await campaignMessage(marketing, { campaign: false }))).urls).toEqual(
          ["https://graph.facebook.com/v21.0/pn-20h/messages"],
        );
      });

      it("still honours stop_marketing and training mode before anything reaches Meta", async () => {
        const stopped = await deliver(await campaignMessage(marketing, { stop: true }));
        expect(stopped.urls).toEqual([]);
        const training = await campaignMessage(marketing);
        await q("update public.orgs set is_training = true where id = $1", [org]);
        try {
          const r = await deliver(training);
          expect(r.urls).toEqual([]);
          expect(r.message!.wa_message_id).toMatch(/^training:/);
        } finally {
          await q("update public.orgs set is_training = false where id = $1", [org]);
        }
      });

      it("goes back to /messages when switched off", async () => {
        await setEnabled(admin, { orgId: org, kind: "wa_mm_lite", userId: alice, enabled: false });
        expect((await deliver(await campaignMessage(marketing))).urls).toEqual([
          "https://graph.facebook.com/v21.0/pn-20h/messages",
        ]);
      });
    });
  },
);
