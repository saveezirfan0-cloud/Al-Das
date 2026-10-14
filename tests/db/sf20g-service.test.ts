/**
 * Phase 20g (G9) campaign A/B tests through the real engine and PostgREST: the fanout sends each recipient its own
 * version (another template, or the same template with another mapping), a retry round re-sends the same version,
 * a version B template that stops being approved pauses the campaign, and the campaign list / drawer queries (which
 * embed wa_templates from campaigns) still resolve with the new table. Nothing reaches Meta (messages are only
 * queued; tests/setup.ts blocks the host). Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT (supabase/test/README.md).
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { guardCampaignMessage, runFanout } from "@/lib/campaigns/engine";
import { getCampaignDetail, listCampaigns } from "@/lib/campaigns/queries";
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
const log = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 20g A/B campaigns through the engine (db)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let alice: string;
    let channel: string;
    let tplA: string;
    let tplB: string;
    let n = 0;
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await asServiceRole(c, () => c.query<T>(sql, params))).rows;
    const one = async (sql: string, params: unknown[] = []) =>
      (await q<{ id: string }>(sql + " returning id::text as id", params))[0]!.id;
    const phone = () => `+447700900${String(300 + ++n).padStart(3, "0")}`;

    /** A sending campaign with variant B (added before the audience) and `size` opted-in recipients. */
    async function abCampaign(
      name: string,
      b: { template: string; map: object },
      size = 16,
      optIn = true,
    ) {
      const id = await one(
        `insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, started_at, guard_since, quality_at_start, variable_map, retry_rounds, created_by)
         values ($1, $2, $3, $4, 'csv', 'sending', now(), now(), 'GREEN', '{"body.1":"contact.first_name"}', 1, $5)`,
        [org, name, channel, tplA, alice],
      );
      await q(
        "insert into public.campaign_ab_variants (org_id, campaign_id, template_id, variable_map, split_pct) values ($1, $2, $3, $4, 50)",
        [org, id, b.template, JSON.stringify(b.map)],
      );
      for (let i = 0; i < size; i++) {
        const k = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in) values ($1, $2, 'Demo', $3, $4)",
          [org, `Layla${i}`, phone(), optIn],
        );
        await q(
          "insert into public.campaign_recipients (org_id, campaign_id, contact_id) values ($1, $2, $3)",
          [org, id, k],
        );
      }
      return id;
    }
    const sent = (campaignId: string) =>
      q<{
        recipient: string;
        variant: string;
        first_name: string;
        template_id: string;
        body1: string;
        message_id: string;
      }>(
        `select r.id::text as recipient, r.variant, k.first_name, m.id::text as message_id,
                m.payload -> 'send' ->> 'template_id' as template_id,
                m.payload -> 'send' -> 'values' ->> 'body.1' as body1
           from public.campaign_recipients r
           join public.contacts k on k.id = r.contact_id
           join public.messages m on m.id = r.message_id
          where r.campaign_id = $1
          order by r.id`,
        [campaignId],
      );

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice-20gs@example.test");
      org = await createOrg(c, "Org 20g S", "org-20g-s", alice);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      channel = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id, quality_rating) values ($1, 'Main', 'waba-20gs', 'pn-20gs', 'GREEN')",
        [org],
      );
      tplA = await one(
        `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, variable_map)
         values ($1, $2, 'waba-20gs', 'flu_a_20g', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]', '{"body.1":"contact.first_name"}')`,
        [org, channel],
      );
      tplB = await one(
        `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, variable_map)
         values ($1, $2, 'waba-20gs', 'flu_b_20g', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hi {{1}}, your flu jab is due"}]', '{}')`,
        [org, channel],
      );
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("sends version B's template and mapping to B recipients and A's to the rest", async () => {
      const id = await abCampaign("Two templates", {
        template: tplB,
        map: { "body.1": "text:Friend" },
      });
      const r = await runFanout(admin, id, log);
      expect(r.dispatched).toBe(16);
      const rows = await sent(id);
      expect(rows).toHaveLength(16);
      const bs = rows.filter((x) => x.variant === "b");
      expect(bs.length).toBeGreaterThan(0);
      expect(bs.length).toBeLessThan(16);
      for (const x of rows)
        expect({ t: x.template_id, v: x.body1 }).toEqual(
          x.variant === "b" ? { t: tplB, v: "Friend" } : { t: tplA, v: x.first_name },
        );
    });

    it("re-sends the same version in a retry round", async () => {
      const id = await abCampaign("Retry keeps version", {
        template: tplB,
        map: { "body.1": "text:Friend" },
      });
      await runFanout(admin, id, log);
      const first = await sent(id);
      const pickB = first.find((x) => x.variant === "b")!;
      const pickA = first.find((x) => x.variant === "a")!;
      await q(
        "update public.messages set status = 'failed', error_code = 131049 where id = any ($1::uuid[])",
        [[pickB.message_id, pickA.message_id]],
      );
      const [{ requeued }] = await q<{ requeued: number }>(
        "select public.campaign_requeue_failed($1, array[131049]) as requeued",
        [id],
      );
      expect(requeued).toBe(2);
      expect((await runFanout(admin, id, log)).dispatched).toBe(2);
      const again = await sent(id);
      for (const pick of [pickA, pickB]) {
        const now = again.find((x) => x.recipient === pick.recipient)!;
        expect(now.message_id).not.toBe(pick.message_id);
        expect({ variant: now.variant, t: now.template_id }).toEqual({
          variant: pick.variant,
          t: pick.template_id,
        });
      }
    });

    it("tests the same template with another mapping", async () => {
      const id = await abCampaign("Same template", {
        template: tplA,
        map: { "body.1": "text:there" },
      });
      await runFanout(admin, id, log);
      for (const x of await sent(id))
        expect({ t: x.template_id, v: x.body1 }).toEqual({
          t: tplA,
          v: x.variant === "b" ? "there" : x.first_name,
        });
    });

    it("pauses when version B's template is no longer approved", async () => {
      const id = await abCampaign("B paused", { template: tplB, map: { "body.1": "text:Friend" } });
      await q("update public.wa_templates set status = 'PAUSED' where id = $1", [tplB]);
      try {
        const r = await runFanout(admin, id, log);
        expect(r.state).toBe("paused");
        expect(r.dispatched).toBe(0);
      } finally {
        await q("update public.wa_templates set status = 'APPROVED' where id = $1", [tplB]);
      }
    });

    it("decides consent by each recipient's own version: B recategorised to MARKETING skips people without opt-in", async () => {
      // A stays UTILITY; Meta moves B to MARKETING after the campaign was created (template_category webhook).
      const id = await abCampaign(
        "B became marketing",
        { template: tplB, map: { "body.1": "text:Friend" } },
        16,
        false,
      );
      await q("update public.wa_templates set category = 'MARKETING' where id = $1", [tplB]);
      try {
        await runFanout(admin, id, log);
        const rows = await q<{ variant: string; status: string; skip_reason: string | null }>(
          "select variant, status, skip_reason from public.campaign_recipients where campaign_id = $1",
          [id],
        );
        const bs = rows.filter((r) => r.variant === "b");
        const as = rows.filter((r) => r.variant === "a");
        expect(bs.length).toBeGreaterThan(0);
        expect(as.length).toBeGreaterThan(0);
        for (const r of bs)
          expect(r).toMatchObject({ status: "skipped", skip_reason: "no_opt_in" });
        for (const r of as) expect(r.status).toBe("queued");

        // The outbound guard also reads the recipient's own template: a B message to someone who opted out of
        // marketing is withdrawn, an A (utility) message is not.
        const guardId = await abCampaign("Guard B marketing", {
          template: tplB,
          map: { "body.1": "text:Friend" },
        });
        await runFanout(admin, guardId, log);
        const sentRows = await sent(guardId);
        const b = sentRows.find((x) => x.variant === "b")!;
        const a = sentRows.find((x) => x.variant === "a")!;
        expect(
          await guardCampaignMessage(admin, a.message_id, a.recipient, { stop_marketing: true }),
        ).toBe("send");
        expect(
          await guardCampaignMessage(admin, b.message_id, b.recipient, { stop_marketing: true }),
        ).toBe("released");
        const [after] = await q<{ status: string; skip_reason: string }>(
          "select status, skip_reason from public.campaign_recipients where id = $1",
          [b.recipient],
        );
        expect(after).toEqual({ status: "skipped", skip_reason: "stop_marketing" });
      } finally {
        await q("update public.wa_templates set category = 'UTILITY' where id = $1", [tplB]);
      }
    });

    it("keeps the list, the drawer and the outbound guard queries working, with A vs B numbers", async () => {
      const id = await abCampaign("Drawer", { template: tplB, map: { "body.1": "text:Friend" } });
      await runFanout(admin, id, log);
      const user = admin as unknown as Parameters<typeof listCampaigns>[0];
      const list = await listCampaigns(user, org);
      expect(list.rows.find((r) => r.id === id)?.template?.id).toBe(tplA);
      const detail = (await getCampaignDetail(user, admin, org, id))!;
      expect(detail.template?.id).toBe(tplA);
      expect(detail.ab).toMatchObject({ splitPct: 50, template: { id: tplB } });
      expect(detail.ab!.variableMap).toEqual({ "body.1": "text:Friend" });
      const rows = await sent(id);
      const bCount = rows.filter((x) => x.variant === "b").length;
      expect(detail.ab!.funnel.b.total).toBe(bCount);
      expect(detail.ab!.funnel.a.total).toBe(16 - bCount);
      expect(detail.ab!.funnel.a.eligible + detail.ab!.funnel.b.eligible).toBe(16);

      const plain = await one(
        `insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'Plain', $2, $3, 'csv')`,
        [org, channel, tplA],
      );
      expect((await getCampaignDetail(user, admin, org, plain))!.ab).toBeNull();

      const pick = rows[0]!;
      expect(
        await guardCampaignMessage(admin, pick.message_id, pick.recipient, {
          stop_marketing: false,
        }),
      ).toBe("send");
    });
  },
);
