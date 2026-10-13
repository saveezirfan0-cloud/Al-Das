/**
 * Phase 19b: Meta ad attribution and the Conversions API against a real Postgres through PostgREST. Nothing leaves the machine: the
 * Graph client is a fake and the inbound WhatsApp path is driven with a webhook fixture. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { patchConfig, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { createFakeCapiClient } from "@/lib/integrations/capi/fake";
import { sha256Hex } from "@/lib/integrations/capi/hash";
import {
  loadAdReport,
  processCapiEvent,
  queueCapiEvent,
  sweepCapi,
} from "@/lib/integrations/capi/server";
import { processInbound } from "@/lib/inbox/inbound";
import { parseWebhookBody } from "@/lib/whatsapp/parse";
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
const WABA = "102290129340398";
const CLICK = (n: number) => `ARAk-synthetic-click-id-${n}`;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 19b: meta ad attribution and the conversions api",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let other: string;
    const id: Record<string, string> = {};
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) =>
      (await q(sql + " returning id::text", params)).rows[0].id as string;
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), "scripts/wa-fixtures/message-text.json"), "utf8"),
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let wamid = 0;

    /** An inbound WhatsApp message from `phone`, optionally from a click-to-WhatsApp ad. */
    async function inbound(
      phone: string,
      referral: Record<string, unknown> | null,
      at = new Date(),
    ) {
      const body = structuredClone(fixture);
      const value = body.entry[0].changes[0].value;
      body.entry[0].id = WABA;
      value.metadata.phone_number_id = "pn-capi";
      value.contacts[0].wa_id = phone.replace("+", "");
      value.messages[0].from = phone.replace("+", "");
      value.messages[0].id = `wamid.CAPI_${++wamid}`;
      value.messages[0].timestamp = String(Math.floor(at.getTime() / 1000));
      if (referral) value.messages[0].referral = referral;
      const parsed = parseWebhookBody(body);
      if (!parsed.ok) throw new Error("fixture did not parse");
      const event = parsed.events.find((e) => e.kind === "message");
      if (!event || event.kind !== "message") throw new Error("no message event");
      return processInbound(admin, event, log);
    }
    const referral = (n: number, over: Record<string, unknown> = {}) => ({
      source_url: "https://fb.me/synthetic",
      source_id: "120211111111111",
      source_type: "ad",
      headline: "Synthetic check-up offer",
      body: "AD BODY MUST NOT BE STORED",
      image_url: "https://cdn.example.test/ad.jpg",
      ctwa_clid: CLICK(n),
      ...over,
    });
    async function person(over: {
      phone: string;
      optIn?: boolean;
      stop?: boolean;
      first?: string;
    }) {
      return svc(() =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in, stop_marketing) values ($1, $2, 'Synthetic', $3, $4, $5)",
          [org, over.first ?? "Layla", over.phone, over.optIn ?? true, over.stop ?? false],
        ),
      );
    }
    const attributions = async () =>
      (
        await svc(() =>
          q("select * from public.ad_attributions where org_id = $1 order by created_at", [org]),
        )
      ).rows;
    const events = async () =>
      (
        await svc(() =>
          q("select * from public.capi_events where org_id = $1 order by created_at", [org]),
        )
      ).rows;
    const wipe = async () => {
      await svc(async () => {
        await q("delete from public.capi_events where org_id = $1", [org]);
        await q("delete from public.ad_attributions where org_id = $1", [org]);
      });
      await q("delete from pgmq.q_capi_events");
    };
    const setMode = (
      mode: "report_only" | "send_events",
      extra: Record<string, string | number | null> = {},
    ) => patchConfig(admin, org, "meta_capi", { mode, ...extra });

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      other = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await svc(async () => {
        id.channel = await one(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, status) values ($1, 'Main', $2, 'pn-capi', 'active')",
          [org, WABA],
        );
        id.pipeline = await one(
          "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true)",
          [org],
        );
        id.stage = await one(
          "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
          [org, id.pipeline],
        );
      });
      await saveSettings(admin, {
        orgId: org,
        kind: "meta_capi",
        provider: "meta_capi",
        secrets: { access_token: "EAAB-SYNTHETIC-TOKEN" },
        config: { dataset_id: "9988776655", mode: "report_only", window_days: 7 },
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("records nothing while the integration is off", async () => {
      expect(await inbound("+971501110001", referral(1))).toMatchObject({ outcome: "stored" });
      expect(await attributions()).toHaveLength(0);
      await setEnabled(admin, { orgId: org, kind: "meta_capi", userId: alice, enabled: true });
    });

    it("report-only: records the click id and three ad fields from an inbound referral, and sends nothing", async () => {
      await wipe();
      expect(await inbound("+971501110002", referral(2))).toMatchObject({ outcome: "stored" });
      const rows = await attributions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ctwa_clid: CLICK(2),
        source_id: "120211111111111",
        source_type: "ad",
        headline: "Synthetic check-up offer",
        waba_id: WABA,
      });
      expect(rows[0].contact_id).toBeTruthy();
      expect(rows[0].conversation_id).toBeTruthy();
      expect(JSON.stringify(rows)).not.toMatch(/AD BODY|cdn\.example|fb\.me/);
      expect(await events()).toHaveLength(0);
      expect((await q("select count(*)::int as n from pgmq.q_capi_events")).rows[0].n).toBe(0);
      // the same click id again is not recorded twice; a message without a click id records nothing
      await inbound("+971501110002", referral(2));
      await inbound("+971501110002", { source_id: "1" });
      await inbound("+971501110002", null);
      expect(await attributions()).toHaveLength(1);
    });

    it("reports conversations, enquiries and bookings per ad, within the window, without names", async () => {
      await wipe();
      await inbound("+971501110003", referral(3));
      const contact = (await attributions())[0].contact_id as string;
      await svc(async () => {
        await q(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'Enquiry', $4)",
          [org, id.pipeline, id.stage, contact],
        );
        await q(
          "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')",
          [org, contact],
        );
        await q(
          "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '3 days', now() + interval '3 days 30 minutes', 'cancelled')",
          [org, contact],
        );
        // booked long after the window
        await q(
          "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status, created_at) values ($1, $2, now() + interval '4 days', now() + interval '4 days 30 minutes', 'confirmed', now() + interval '20 days')",
          [org, contact],
        );
      });
      const rows = await loadAdReport(admin, org, 30, 7);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source_id: "120211111111111",
        source_type: "ad",
        headline: "Synthetic check-up offer",
        conversations: 1,
        patients: 1,
        enquiries: 1,
        appointments: 1,
      });
      expect(JSON.stringify(rows)).not.toMatch(/Synthetic\b(?! check)|Layla|CLICK|\+971/);
    });

    describe("sending events", () => {
      const NOW = () => new Date();

      beforeAll(async () => {
        await setMode("send_events");
      });

      it("queues a Contact event for an opted-in patient and sends only the allow-listed payload", async () => {
        await wipe();
        await person({ phone: "+971501110010", optIn: true });
        await inbound("+971501110010", referral(10));
        const ev = await events();
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ event_name: "Contact", status: "queued", reason: null });
        expect(ev[0].event_id).toMatch(/^[0-9a-f]{40}$/);
        expect((await q("select count(*)::int as n from pgmq.q_capi_events")).rows[0].n).toBe(1);

        const fake = createFakeCapiClient();
        expect(await processCapiEvent(admin, ev[0].id, { readCt: 1, client: fake })).toBe("sent");
        expect(fake.sent).toHaveLength(1);
        const e = fake.sent[0].data[0];
        expect(e).toMatchObject({
          event_name: "Contact",
          event_id: ev[0].event_id,
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: { whatsapp_business_account_id: WABA, ctwa_clid: CLICK(10) },
        });
        expect(Object.keys(e.user_data).sort()).toEqual([
          "ctwa_clid",
          "whatsapp_business_account_id",
        ]);
        expect(JSON.stringify(fake.sent)).not.toMatch(
          /971501110010|Layla|Synthetic|custom_data|value/,
        );
        expect((await events())[0]).toMatchObject({ status: "sent", attempts: 1 });
        // delivered twice by the queue: nothing is sent again
        expect(await processCapiEvent(admin, ev[0].id, { readCt: 2, client: fake })).toBe(
          "not_queued",
        );
        expect(fake.sent).toHaveLength(1);
      });

      it("does not send for a patient who has not opted in, or who stopped marketing, but records why", async () => {
        await wipe();
        await person({ phone: "+971501110011", optIn: false });
        await person({ phone: "+971501110012", optIn: true, stop: true });
        await inbound("+971501110011", referral(11));
        await inbound("+971501110012", referral(12));
        const ev = await events();
        expect(ev.map((e) => [e.status, e.reason]).sort()).toEqual([
          ["skipped", "no_consent"],
          ["skipped", "stopped"],
        ]);
        expect((await q("select count(*)::int as n from pgmq.q_capi_events")).rows[0].n).toBe(0);
      });

      it("checks consent again when it sends: an opt-out since queueing stops it", async () => {
        await wipe();
        const p = await person({ phone: "+971501110013", optIn: true });
        await inbound("+971501110013", referral(13));
        const ev = (await events())[0];
        await svc(() => q("update public.contacts set stop_marketing = true where id = $1", [p]));
        const fake = createFakeCapiClient();
        expect(await processCapiEvent(admin, ev.id, { readCt: 1, client: fake })).toBe("skipped");
        expect(fake.sent).toHaveLength(0);
        expect((await events())[0]).toMatchObject({ status: "skipped", reason: "stopped" });
      });

      it("uses the administrator's confirmed basis only when it is set, and still honours a stop", async () => {
        await wipe();
        await person({ phone: "+971501110014", optIn: false });
        await person({ phone: "+971501110015", optIn: false, stop: true });
        await patchConfig(admin, org, "meta_capi", {
          ad_attribution_consent_basis: "admin_declared",
        });
        try {
          await inbound("+971501110014", referral(14));
          await inbound("+971501110015", referral(15));
          expect((await events()).map((e) => [e.status, e.reason]).sort()).toEqual([
            ["queued", null],
            ["skipped", "stopped"],
          ]);
        } finally {
          await patchConfig(admin, org, "meta_capi", {
            ad_attribution_consent_basis: "contact_opt_in",
          });
        }
      });

      it("sends Lead and Schedule for an attributed patient from the sweep, once, inside the window, and never for a cancelled booking", async () => {
        await wipe();
        await svc(() =>
          q(
            "update public.integration_accounts set enabled_at = now() - interval '1 hour' where org_id = $1 and kind = 'meta_capi'",
            [org],
          ),
        );
        const p = await person({ phone: "+971501110016", optIn: true });
        const plain = await person({ phone: "+971501110017", optIn: true });
        await inbound("+971501110016", referral(16));
        await svc(async () => {
          id.enq = await one(
            "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'Enquiry', $4)",
            [org, id.pipeline, id.stage, p],
          );
          id.appt = await one(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')",
            [org, p],
          );
          await q(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '3 days', now() + interval '3 days 30 minutes', 'cancelled')",
            [org, p],
          );
          await q(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')",
            [org, plain],
          );
        });
        const first = await sweepCapi(admin, NOW());
        expect(first.queued).toBe(2);
        const ev = await events();
        expect(ev.map((e) => e.event_name).sort()).toEqual(["Contact", "Lead", "Schedule"]);
        expect((await sweepCapi(admin, NOW())).queued).toBe(0); // idempotent
        expect(await events()).toHaveLength(3);

        const fake = createFakeCapiClient();
        for (const e of ev.filter((x) => x.status === "queued"))
          expect(await processCapiEvent(admin, e.id, { readCt: 1, client: fake })).toBe("sent");
        for (const sent of fake.sent) {
          expect(["Lead", "Schedule", "Contact"]).toContain(sent.data[0].event_name);
          expect(JSON.stringify(sent)).not.toMatch(
            /service|doctor|specialist|value|currency|Layla|\"ph\"/i,
          );
        }
      });

      it("skips a booking made outside the attribution window, and never backfills before the switch was turned on", async () => {
        await wipe();
        const p = await person({ phone: "+971501110018", optIn: true });
        await inbound("+971501110018", referral(18));
        const attr = (await attributions())[0];
        await svc(() =>
          q(
            "update public.ad_attributions set clicked_at = now() - interval '9 days' where id = $1",
            [attr.id],
          ),
        );
        const late = await svc(() =>
          one(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')",
            [org, p],
          ),
        );
        expect(
          await queueCapiEvent(admin, {
            orgId: org,
            attributionId: attr.id,
            eventName: "Schedule",
            subjectId: late,
            eventTime: new Date(),
          }),
        ).toBe("skipped:outside_window");
        // before the switch: the sweep ignores things created earlier
        await svc(() =>
          q(
            "update public.integration_accounts set enabled_at = now() + interval '1 hour' where org_id = $1 and kind = 'meta_capi'",
            [org],
          ),
        );
        expect((await sweepCapi(admin, NOW())).queued).toBe(0);
        await svc(() =>
          q(
            "update public.integration_accounts set enabled_at = now() - interval '1 hour' where org_id = $1 and kind = 'meta_capi'",
            [org],
          ),
        );
      });

      it("skips events Meta would reject for age", async () => {
        await wipe();
        await person({ phone: "+971501110019", optIn: true });
        await inbound("+971501110019", referral(19), new Date(Date.now() - 9 * 86_400_000));
        // received 9 days ago: too old to send, but the click is still reported
        expect(await attributions()).toHaveLength(1);
        expect((await events()).map((e) => [e.status, e.reason])).toEqual([["skipped", "too_old"]]);
      });

      it("retries throttling and outages through the queue, and fails a bad token without retrying", async () => {
        await wipe();
        await person({ phone: "+971501110020", optIn: true });
        await inbound("+971501110020", referral(20));
        const ev = (await events())[0];
        const slow = createFakeCapiClient({
          results: [{ ok: false, code: "graph_17", retryable: true, auth: false }],
        });
        expect(await processCapiEvent(admin, ev.id, { readCt: 1, client: slow })).toBe("retry");
        expect((await events())[0]).toMatchObject({ status: "queued", attempts: 1 });
        expect(await processCapiEvent(admin, ev.id, { readCt: 2, client: slow })).toBe("sent");
        expect((await events())[0]).toMatchObject({ status: "sent", attempts: 2 });

        await wipe();
        await inbound("+971501110020", referral(21));
        const ev2 = (await events())[0];
        const bad = createFakeCapiClient({
          results: [{ ok: false, code: "graph_190", retryable: false, auth: true }],
        });
        expect(await processCapiEvent(admin, ev2.id, { readCt: 1, client: bad })).toBe("failed");
        expect((await events())[0]).toMatchObject({ status: "failed", reason: "auth" });
        const acct = await svc(() =>
          q(
            "select last_error from public.integration_accounts where org_id = $1 and kind = 'meta_capi'",
            [org],
          ),
        );
        expect(acct.rows[0].last_error).toContain("graph_190");
        expect(acct.rows[0].last_error).not.toMatch(/EAAB|SYNTHETIC/);
        // gives up after five reads
        await wipe();
        await inbound("+971501110020", referral(22));
        const ev3 = (await events())[0];
        const down = createFakeCapiClient({
          results: [{ ok: false, code: "timeout", retryable: true, auth: false }],
        });
        expect(await processCapiEvent(admin, ev3.id, { readCt: 5, client: down })).toBe("failed");
      });

      it("carries the test event code and a hashed phone only when chosen", async () => {
        await wipe();
        await person({ phone: "+971501110023", optIn: true });
        await setMode("send_events", { test_event_code: "TEST48123", include_phone: "yes" });
        try {
          await inbound("+971501110023", referral(23));
          const ev = (await events())[0];
          expect(ev.is_test).toBe(true);
          const fake = createFakeCapiClient();
          await processCapiEvent(admin, ev.id, { readCt: 1, client: fake });
          expect(fake.sent[0].test_event_code).toBe("TEST48123");
          expect(fake.sent[0].data[0].user_data.ph).toEqual([sha256Hex("971501110023")]);
          expect(JSON.stringify(fake.sent)).not.toContain("971501110023");
        } finally {
          await setMode("send_events", { test_event_code: null, include_phone: "no" });
        }
      });

      it("sends nothing from a training workspace", async () => {
        await wipe();
        await person({ phone: "+971501110024", optIn: true });
        await inbound("+971501110024", referral(24));
        const ev = (await events())[0];
        await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
        try {
          const fake = createFakeCapiClient();
          expect(await processCapiEvent(admin, ev.id, { readCt: 1, client: fake })).toBe("skipped");
          expect(fake.sent).toHaveLength(0);
          expect((await events())[0]).toMatchObject({ status: "skipped", reason: "training" });
          const blocked = await queueCapiEvent(admin, {
            orgId: org,
            attributionId: ev.attribution_id,
            eventName: "Lead",
            subjectId: ev.attribution_id,
            eventTime: new Date(),
          });
          expect(blocked).toBe("training");
        } finally {
          await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
        }
      });

      it("stops everything when switched off, and does not send in report-only mode", async () => {
        await wipe();
        await person({ phone: "+971501110025", optIn: true });
        await inbound("+971501110025", referral(25));
        const ev = (await events())[0];
        await setMode("report_only");
        const fake = createFakeCapiClient();
        expect(await processCapiEvent(admin, ev.id, { readCt: 1, client: fake })).toBe("skipped");
        expect(fake.sent).toHaveLength(0);
        await setMode("send_events");
        await wipe();
        await setEnabled(admin, { orgId: org, kind: "meta_capi", userId: alice, enabled: false });
        await inbound("+971501110025", referral(26));
        expect(await attributions()).toHaveLength(0);
        await setEnabled(admin, { orgId: org, kind: "meta_capi", userId: alice, enabled: true });
      });
    });

    it("keeps the same click id separate per workspace and refuses a contact from another workspace", async () => {
      await svc(async () => {
        const foreign = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'X', 'Y')",
          [other],
        );
        await q(
          "insert into public.ad_attributions (org_id, ctwa_clid) values ($1, 'shared-click')",
          [org],
        );
        await q(
          "insert into public.ad_attributions (org_id, ctwa_clid) values ($1, 'shared-click')",
          [other],
        );
        await expect(
          q("insert into public.ad_attributions (org_id, ctwa_clid) values ($1, 'shared-click')", [
            org,
          ]),
        ).rejects.toMatchObject({ code: "23505" });
        await expect(
          q(
            "insert into public.ad_attributions (org_id, ctwa_clid, contact_id) values ($1, 'x2', $2)",
            [org, foreign],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      });
    });
  },
);
